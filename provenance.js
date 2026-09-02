const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("node:child_process");
const { getDatabasePath } = require("./storage");

function db(blackboxRoot) {
  return new DatabaseSync(getDatabasePath(blackboxRoot));
}

function currentLines(repositoryRoot, filePath) {
  const absolutePath = path.resolve(repositoryRoot, filePath);
  if (absolutePath !== repositoryRoot && !absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("File must be inside the repository.");
  const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function latestChange(blackboxRoot, repositoryId, filePath) {
  const database = db(blackboxRoot);
  try {
    return database.prepare("SELECT f.turn_id AS turnId, t.prompt, t.before_checkpoint_id AS previousCheckpoint, t.started_at AS changedAt, s.agent FROM file_changes f JOIN turns t ON t.id = f.turn_id JOIN sessions s ON s.id = t.session_id WHERE s.repository_id = ? AND f.path = ? ORDER BY t.started_at DESC, f.rowid DESC LIMIT 1").get(repositoryId, filePath);
  } finally {
    database.close();
  }
}

function changedLines(blackboxRoot, change, filePath) {
  const database = db(blackboxRoot);
  let snapshots;
  try {
    snapshots = database.prepare("SELECT b.snapshot_id AS beforeId, a.snapshot_id AS afterId FROM turns t JOIN checkpoints b ON b.id = t.before_checkpoint_id JOIN checkpoints a ON a.id = t.after_checkpoint_id WHERE t.id = ?").get(change.turnId);
  } finally {
    database.close();
  }
  if (!snapshots) return null;
  const result = spawnSync("git", ["--git-dir", path.join(blackboxRoot, "snapshots.git"), "diff", "--unified=0", snapshots.beforeId, snapshots.afterId, "--", filePath], { encoding: "utf8" });
  const lines = new Set();
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^@@ .* \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = Number(match[2] || 1);
    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) lines.add(lineNumber);
  }
  return lines;
}

function blame(blackboxRoot, repositoryId, repositoryRoot, filePath) {
  const lines = currentLines(repositoryRoot, filePath);
  const change = latestChange(blackboxRoot, repositoryId, filePath);
  const changed = change ? changedLines(blackboxRoot, change, filePath) : new Set();
  return lines.map((text, index) => {
    const attributed = changed === null || changed.has(index + 1);
    return { line: index + 1, text, turnId: attributed ? change.turnId : "MANUAL", agent: attributed ? change.agent : "user" };
  });
}

function why(blackboxRoot, repositoryId, filePath, line) {
  const change = latestChange(blackboxRoot, repositoryId, filePath);
  const changed = change && changedLines(blackboxRoot, change, filePath);
  if (!change || (changed && !changed.has(line))) return { filePath, line, turnId: "MANUAL", agent: "user", prompt: null, branch: "unknown", commands: [], previousCheckpoint: null };
  const database = db(blackboxRoot);
  try {
    const commands = database.prepare("SELECT command, stdout, stderr, exit_code AS exitCode FROM commands WHERE turn_id = ? ORDER BY sequence").all(change.turnId);
    const context = database.prepare("SELECT payload FROM audit_events WHERE event_type = 'PROMPT_SUBMITTED' AND payload LIKE ? ORDER BY rowid DESC LIMIT 1").get(`%${change.turnId}%`);
    const details = context ? JSON.parse(context.payload) : {};
    return { filePath, line, turnId: change.turnId, agent: change.agent, prompt: change.prompt, branch: details.branch || "unknown", head: details.head || "unknown", changedAt: change.changedAt, commands, previousCheckpoint: change.previousCheckpoint };
  } finally {
    database.close();
  }
}

module.exports = { blame, why };
