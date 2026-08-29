const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const { appendAuditEvent, getDatabasePath } = require("./storage");
const { createCheckpoint } = require("./snapshot");

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to read snapshot.");
  return result.stdout;
}

function getRestoreTarget(blackboxRoot, turnId, side) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  try {
    const turn = database.prepare("SELECT t.before_checkpoint_id AS beforeId, t.after_checkpoint_id AS afterId, s.repository_id AS repositoryId FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?").get(turnId);
    if (!turn) throw new Error(`Turn not found: ${turnId}`);
    const checkpointId = side === "before" ? turn.beforeId : turn.afterId;
    const checkpoint = database.prepare("SELECT snapshot_id AS snapshotId FROM checkpoints WHERE id = ?").get(checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`);
    return { repositoryId: turn.repositoryId, checkpointId, snapshotId: checkpoint.snapshotId };
  } finally {
    database.close();
  }
}

function changedFiles(shadowRoot, currentSnapshot, targetSnapshot) {
  return git(["--git-dir", shadowRoot, "diff", "--no-ext-diff", "--name-status", "--no-renames", currentSnapshot, targetSnapshot]).trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [status, filePath] = line.split("\t");
    return { status, path: filePath };
  });
}

function targetFiles(shadowRoot, snapshotId) {
  return new Map(git(["--git-dir", shadowRoot, "ls-tree", "-r", snapshotId]).trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^(\d+) \w+ [a-f0-9]+\t(.+)$/);
    return [match[2], match[1]];
  }));
}

function writeTargetFile(repositoryRoot, shadowRoot, snapshotId, filePath, mode) {
  const absolutePath = path.resolve(repositoryRoot, filePath);
  if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("Snapshot contains an unsafe path.");
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const content = git(["--git-dir", shadowRoot, "show", `${snapshotId}:${filePath}`], { encoding: null });
  if (mode === "120000") {
    if (fs.existsSync(absolutePath) || fs.lstatSync(absolutePath, { throwIfNoEntry: false })) fs.unlinkSync(absolutePath);
    fs.symlinkSync(content.toString(), absolutePath);
  } else {
    fs.writeFileSync(absolutePath, content);
    fs.chmodSync(absolutePath, mode === "100755" ? 0o755 : 0o644);
  }
}

function restoreTurn({ repositoryRoot, blackboxRoot, gitDir, turnId, side = "before", confirm = false }) {
  if (!["before", "after"].includes(side)) throw new Error("Restore side must be before or after.");
  const target = getRestoreTarget(blackboxRoot, turnId, side);
  const currentSnapshot = createCheckpoint({ repositoryRoot, blackboxRoot, gitDir, repositoryId: target.repositoryId, id: `pre-restore-${crypto.randomUUID()}`, kind: "PRE_RESTORE" });
  const shadowRoot = path.join(blackboxRoot, "snapshots.git");
  const files = changedFiles(shadowRoot, currentSnapshot.snapshotId, target.snapshotId);
  const preview = `Restore ${side.toUpperCase()} ${turnId}\n\n${files.length ? files.map((file) => `${file.status} ${file.path}`).join("\n") : "No files will change."}\n\n${files.length} file(s) will change.\n`;
  if (!confirm) return { confirmed: false, preview, files };
  const filesInTarget = targetFiles(shadowRoot, target.snapshotId);
  for (const file of files) {
    const absolutePath = path.resolve(repositoryRoot, file.path);
    if (filesInTarget.has(file.path)) writeTargetFile(repositoryRoot, shadowRoot, target.snapshotId, file.path, filesInTarget.get(file.path));
    else if (fs.lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile() || fs.lstatSync(absolutePath, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(absolutePath);
  }
  appendAuditEvent(blackboxRoot, { repositoryId: target.repositoryId, eventType: "RESTORE_COMPLETED", payload: { turnId, side, checkpointId: target.checkpointId, preRestoreCheckpointId: currentSnapshot.id, files: files.map((file) => file.path) } });
  return { confirmed: true, preview, files, checkpointId: currentSnapshot.id };
}

module.exports = { restoreTurn };
