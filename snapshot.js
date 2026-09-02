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

function readRules(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function matchesRule(relativePath, rule) {
  const directoryRule = rule.endsWith("/");
  const pattern = directoryRule ? `${rule}**` : rule;
  try {
    return path.matchesGlob(relativePath, pattern) || path.matchesGlob(relativePath, `**/${pattern}`);
  } catch {
    return false;
  }
}

function matchesUserRules(relativePath, rules) {
  let ignored = false;
  for (const rule of rules) {
    const negated = rule.startsWith("!");
    if (matchesRule(relativePath, negated ? rule.slice(1) : rule)) ignored = !negated;
  }
  return ignored;
}

function collectFiles(root, gitDir) {
  const result = spawnSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || "git ls-files failed");
  const rootRules = readRules(path.join(root, ".blackboxignore"));
  const builtInRules = [".env", ".env.*", "*.pem", "*.key", "credentials*", "secrets/"];
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map((relativePath) => path.join(root, relativePath)).filter((filePath) => !matchesUserRules(path.relative(root, filePath).split(path.sep).join("/"), [...builtInRules, ...rootRules]));
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
      let blob;
      try {
        blob = blobForFile(shadowRoot, filePath);
      } catch (error) {
        if (error.code === "EACCES" || error.code === "EPERM") continue;
        throw error;
      }
      const [blobHash, mode] = blob;
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
