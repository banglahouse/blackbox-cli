#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runGit(args, cwd = process.cwd()) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

function getGitDir(cwd = process.cwd()) {
  const result = runGit(["rev-parse", "--git-dir"], cwd);

  if (result.status !== 0) {
    throw new Error("Blackbox requires a Git repository.");
  }

  const gitDir = result.stdout.trim();
  if (!gitDir) {
    throw new Error("Blackbox requires a Git repository.");
  }

  return path.resolve(cwd, gitDir);
}

function getBlackboxRoot(cwd = process.cwd()) {
  return path.join(getGitDir(cwd), "blackbox");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function initRepository(cwd = process.cwd()) {
  const blackboxRoot = getBlackboxRoot(cwd);
  ensureDir(blackboxRoot);
  ensureDir(path.join(blackboxRoot, "runtime"));
  ensureDir(path.join(blackboxRoot, "locks"));
  ensureDir(path.join(blackboxRoot, "snapshots.git"));

  return blackboxRoot;
}

function printUsage(stream = process.stdout) {
  stream.write([
    "blackbox <command>",
    "",
    "Commands:",
    "  init",
  ].join("\n"));
  stream.write("\n");
}

function main(argv = process.argv.slice(2), cwd = process.cwd(), io = console) {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    printUsage(process.stdout);
    return 0;
  }

  if (command === "init") {
    if (rest.length > 0) {
      io.error("blackbox init does not accept extra arguments yet.");
      return 1;
    }

    const blackboxRoot = initRepository(cwd);
    io.log(`Initialized Blackbox at ${blackboxRoot}`);
    return 0;
  }

  io.error(`Unknown command: ${command}`);
  printUsage(process.stderr);
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  getBlackboxRoot,
  getGitDir,
  initRepository,
  main,
  runGit,
};
