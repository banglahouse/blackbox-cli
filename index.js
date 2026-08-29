#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { ensureRepository, initializeDatabase } = require("./storage");

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

  return fs.realpathSync(path.resolve(cwd, gitDir));
}

function getBlackboxRoot(cwd = process.cwd()) {
  return path.join(getGitDir(cwd), "blackbox");
}

function getRepositoryMetadata(cwd = process.cwd()) {
  const root = runGit(["rev-parse", "--show-toplevel"], cwd).stdout.trim();

  if (!root) {
    throw new Error("Blackbox requires a Git repository.");
  }

  const repositoryRoot = fs.realpathSync(path.resolve(cwd, root));

  return {
    id: crypto.createHash("sha256").update(repositoryRoot).digest("hex"),
    root: repositoryRoot,
    gitDir: getGitDir(cwd),
  };
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
  initializeDatabase(blackboxRoot);

  const metadataPath = path.join(blackboxRoot, "repository.json");
  if (!fs.existsSync(metadataPath)) {
    fs.writeFileSync(metadataPath, `${JSON.stringify(getRepositoryMetadata(cwd), null, 2)}\n`, "utf8");
  }
  ensureRepository(blackboxRoot, getRepositoryMetadata(cwd));

  return blackboxRoot;
}

function printUsage(stream = process.stdout) {
  stream.write([
    "blackbox <command>",
    "",
    "Commands:",
    "  init",
    "  codex [args...]",
    "  claude [args...]",
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

  if (command === "codex") {
    const { runCodex } = require("./codex");
    return runCodex({ args: rest, cwd });
  }

  if (command === "claude") {
    const { runClaude } = require("./claude");
    return runClaude({ args: rest, cwd });
  }

  if (["log", "show", "diff", "file"].includes(command)) {
    const { diff, fileHistory, log, show } = require("./inspect");
    const metadata = getRepositoryMetadata(cwd);
    const blackboxRoot = getBlackboxRoot(cwd);
    const value = command === "log" ? log(blackboxRoot, metadata.id) : command === "show" ? show(blackboxRoot, rest[0]) : command === "diff" ? diff(blackboxRoot, rest[0]) : fileHistory(blackboxRoot, metadata.id, rest[0]);
    io.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
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
  getRepositoryMetadata,
  initRepository,
  main,
  runGit,
};
