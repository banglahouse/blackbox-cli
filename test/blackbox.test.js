const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

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
});

test("help prints usage", () => {
  const result = runCli(["--help"], mkTempDir());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /blackbox <command>/);
});
