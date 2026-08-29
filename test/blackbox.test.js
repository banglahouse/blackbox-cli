const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

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

test("help prints usage", () => {
  const result = runCli(["--help"], mkTempDir());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /blackbox <command>/);
});
