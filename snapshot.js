const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

function runGit(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function ensureShadowRepository(shadowRoot) {
  fs.mkdirSync(shadowRoot, { recursive: true });
  if (!fs.existsSync(path.join(shadowRoot, "HEAD"))) runGit(["init", "--bare", shadowRoot]);
}

function collectFiles(root, gitDir) {
  const files = [];
  const excludedRoot = fs.realpathSync(gitDir);
  function visit(current) {
    if (path.resolve(current) === excludedRoot) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (path.resolve(filePath) === excludedRoot || filePath.startsWith(`${excludedRoot}${path.sep}`)) continue;
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(filePath);
    }
  }
  visit(root);
  return files;
}

function blobForFile(shadowRoot, filePath) {
  const entry = fs.lstatSync(filePath);
  const content = entry.isSymbolicLink() ? Buffer.from(fs.readlinkSync(filePath)) : fs.readFileSync(filePath);
  const blobHash = runGit(["--git-dir", shadowRoot, "hash-object", "-w", "--stdin"], { input: content });
  return [blobHash, entry.isSymbolicLink() ? "120000" : entry.mode & 0o111 ? "100755" : "100644"];
}

function captureSnapshot({ repositoryRoot, blackboxRoot, gitDir }) {
  const shadowRoot = path.join(blackboxRoot, "snapshots.git");
  ensureShadowRepository(shadowRoot);
  repositoryRoot = fs.realpathSync(repositoryRoot);
  gitDir = fs.realpathSync(gitDir);
  const indexDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-index-"));
  const indexPath = path.join(indexDirectory, "index");
  try {
    for (const filePath of collectFiles(repositoryRoot, gitDir)) {
      const relativePath = path.relative(repositoryRoot, filePath);
      const [blobHash, mode] = blobForFile(shadowRoot, filePath);
      runGit(["--git-dir", shadowRoot, "update-index", "--add", "--cacheinfo", `${mode},${blobHash},${relativePath}`], { env: { ...process.env, GIT_INDEX_FILE: indexPath } });
    }
    return runGit(["--git-dir", shadowRoot, "write-tree"], { env: { ...process.env, GIT_INDEX_FILE: indexPath } });
  } finally {
    fs.rmSync(indexDirectory, { recursive: true, force: true });
  }
}

function createCheckpoint({ repositoryRoot, blackboxRoot, gitDir, repositoryId, id = crypto.randomUUID(), kind = "SNAPSHOT", createdAt = new Date().toISOString() }) {
  const snapshotId = captureSnapshot({ repositoryRoot, blackboxRoot, gitDir });
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  try {
    database.prepare("INSERT INTO checkpoints (id, repository_id, kind, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, repositoryId, kind, snapshotId, createdAt);
    return { id, snapshotId };
  } finally {
    database.close();
  }
}

module.exports = { captureSnapshot, createCheckpoint };
