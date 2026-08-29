const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { appendAuditEvent, verifyAuditChain } = require("../storage");
const { captureSnapshot, createCheckpoint } = require("../snapshot");

const cliPath = path.resolve(__dirname, "..", "index.js");

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-"));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("init fails outside a git repository", () => {
  const dir = mkTempDir();
  const result = runCli(["init"], dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Blackbox requires a Git repository\./);
});

test("init scaffolds the blackbox root inside git", () => {
  const dir = mkTempDir();
  const gitInit = spawnSync("git", ["init"], {
    cwd: dir,
    encoding: "utf8",
  });

  assert.equal(gitInit.status, 0, gitInit.stderr);

  const result = runCli(["init"], dir);
  assert.equal(result.status, 0, result.stderr);

  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  const blackboxRoot = path.resolve(dir, gitDir, "blackbox");

  assert.ok(fs.existsSync(blackboxRoot));
  assert.ok(fs.existsSync(path.join(blackboxRoot, "runtime")));
  assert.ok(fs.existsSync(path.join(blackboxRoot, "locks")));
  assert.ok(fs.existsSync(path.join(blackboxRoot, "snapshots.git")));
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["audit_events", "checkpoints", "commands", "file_changes", "payloads", "repositories", "sessions", "turns"]);
  database.close();
  const metadataPath = path.join(blackboxRoot, "repository.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.root, fs.realpathSync(dir));
  assert.equal(metadata.gitDir, fs.realpathSync(path.resolve(dir, gitDir)));
  assert.match(metadata.id, /^[a-f0-9]{64}$/);

  const before = fs.readFileSync(metadataPath, "utf8");
  const second = runCli(["init"], dir);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(metadataPath, "utf8"), before);
});

test("database schema creation is idempotent and historical rows are append-only", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const first = runCli(["init"], dir);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(["init"], dir);
  assert.equal(second.status, 0, second.stderr);

  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const database = new DatabaseSync(path.resolve(dir, gitDir, "blackbox", "blackbox.sqlite"));
  database.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  assert.throws(() => database.exec("UPDATE repositories SET root = 'changed' WHERE id = 'r'"), /append-only/);
  assert.throws(() => database.exec("DELETE FROM repositories WHERE id = 'r'"), /append-only/);
  database.close();
});

test("audit events form a verifiable hash chain", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const blackboxRoot = path.resolve(dir, gitDir, "blackbox");
  const setup = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  setup.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  setup.close();

  const first = appendAuditEvent(blackboxRoot, { id: "e1", repositoryId: "r", eventType: "SESSION_STARTED", payload: { agent: "codex" }, createdAt: "2026-01-01T00:00:00.000Z" });
  const second = appendAuditEvent(blackboxRoot, { id: "e2", repositoryId: "r", eventType: "PROMPT_SUBMITTED", payload: "fix it", createdAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(first.previousHash, null);
  assert.equal(second.previousHash, first.eventHash);
  assert.deepEqual(verifyAuditChain(blackboxRoot, "r"), { valid: true, events: 2 });

  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.prepare("INSERT INTO audit_events (id, repository_id, event_type, payload, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("e3", "r", "TURN_COMPLETED", "{}", second.eventHash, "tampered", "2026-01-01T00:00:02.000Z");
  database.close();
  assert.deepEqual(verifyAuditChain(blackboxRoot, "r"), { valid: false, eventId: "e3" });
});

test("snapshots are repeatable and recorded without changing developer git state", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(dir, ".blackboxignore"), "private/\n!private/keep.txt\n");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "ignored\n");
  fs.writeFileSync(path.join(dir, ".env"), "secret\n");
  fs.writeFileSync(path.join(dir, "certificate.pem"), "secret\n");
  fs.mkdirSync(path.join(dir, "private"));
  fs.writeFileSync(path.join(dir, "private", "data.txt"), "private\n");
  fs.writeFileSync(path.join(dir, "private", "keep.txt"), "kept\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const beforeStatus = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
  const first = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  const second = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  assert.match(first, /^[a-f0-9]{40}$/);
  assert.equal(second, first);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, beforeStatus);
  const shadowTree = spawnSync("git", ["--git-dir", path.join(blackboxRoot, "snapshots.git"), "ls-tree", "-r", "--name-only", first], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(shadowTree.includes("file.txt"));
  assert.ok(shadowTree.includes("private/keep.txt"));
  assert.ok(!shadowTree.includes("ignored.txt"));
  assert.ok(!shadowTree.includes(".env"));
  assert.ok(!shadowTree.includes("certificate.pem"));
  assert.ok(!shadowTree.includes("private/data.txt"));

  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  database.close();
  const checkpoint = createCheckpoint({ repositoryRoot: dir, blackboxRoot, gitDir, repositoryId: "r", id: "cp-1", kind: "BEFORE" });
  assert.deepEqual(checkpoint, { id: "cp-1", snapshotId: first });
});

test("help prints usage", () => {
  const result = runCli(["--help"], mkTempDir());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /blackbox <command>/);
});
