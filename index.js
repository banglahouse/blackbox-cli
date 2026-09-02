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
  const result = runGit(["rev-parse", "--git-common-dir"], cwd);

  if (result.status !== 0) {
    throw new Error("Blackbox requires a Git repository.");
  }

  const gitDir = result.stdout.trim();
  if (!gitDir) {
    throw new Error("Blackbox requires a Git repository.");
  }

  return fs.realpathSync(path.resolve(cwd, gitDir));
}

function getWorktreeGitDir(cwd = process.cwd()) {
  const result = runGit(["rev-parse", "--git-dir"], cwd);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Blackbox requires a Git repository.");
  return fs.realpathSync(path.resolve(cwd, result.stdout.trim()));
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
  const gitDir = getGitDir(cwd);
  const metadataPath = path.join(gitDir, "blackbox", "repository.json");
  let stored;
  if (fs.existsSync(metadataPath)) {
    try { stored = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch {}
  }

  return {
    // repository.json lives below the canonical common directory, so an
    // existing ID is safe to reuse even when it was created by the old
    // worktree-root identity scheme.
    id: stored?.id || crypto.createHash("sha256").update(gitDir).digest("hex"),
    root: repositoryRoot,
    gitDir,
    worktreeGitDir: getWorktreeGitDir(cwd),
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
    "  status",
    "  codex [args...]",
    "  claude [args...]",
    "  log",
    "  show <turn-id>",
    "  diff <turn-id>",
    "  file <path>",
    "  blame <path>",
    "  why <file>:<line>",
    "  restore <turn-id> --before|--after [--yes]",
    "  verify",
  ].join("\n"));
  stream.write("\n");
}

function requireArgument(rest, usage) {
  if (!rest[0]) throw new Error(`Usage: ${usage}`);
  return rest[0];
}

async function main(argv = process.argv.slice(2), cwd = process.cwd(), io = console) {
  const [command, ...rest] = argv;

  if (command === "--version" || command === "-v") {
    io.log(require("./package.json").version);
    return 0;
  }

  if (!command || command === "-h" || command === "--help") {
    printUsage(process.stdout);
    return 0;
  }

  if (command === "init") {
    const passwordIndex = rest.indexOf("--password");
    if (rest.length > 0 && (passwordIndex < 0 || rest.length !== 2 || !rest[passwordIndex + 1])) {
      io.error("blackbox init accepts only --password <password>.");
      return 1;
    }

    const blackboxRoot = initRepository(cwd);
    if (passwordIndex >= 0) require("./maintenance").setPassword(blackboxRoot, rest[passwordIndex + 1]);
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

  if (["log", "show", "diff", "file", "blame", "why"].includes(command)) {
    const { diff, fileHistory, log, show } = require("./inspect");
    const metadata = getRepositoryMetadata(cwd);
    const blackboxRoot = getBlackboxRoot(cwd);
    const { blame, why } = require("./provenance");
    if (command === "log") {
      io.log(JSON.stringify(log(blackboxRoot, metadata.id), null, 2));
      return 0;
    }
    const target = requireArgument(rest, `blackbox ${command} <${command === "why" ? "file:line" : command === "show" || command === "diff" ? "turn-id" : "path"}>`);
    let value;
    if (command === "show") value = show(blackboxRoot, target);
    else if (command === "diff") value = diff(blackboxRoot, target);
    else if (command === "file") value = fileHistory(blackboxRoot, metadata.id, target);
    else if (command === "blame") value = blame(blackboxRoot, metadata.id, metadata.root, target);
    else {
      const separator = target.lastIndexOf(":");
      const line = Number(target.slice(separator + 1));
      if (separator <= 0 || !Number.isInteger(line) || line < 1) throw new Error("Usage: blackbox why <file>:<line>");
      value = why(blackboxRoot, metadata.id, target.slice(0, separator), line);
    }
    io.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return 0;
  }

  if (command === "restore") {
    requireArgument(rest, "blackbox restore <turn-id> --before|--after [--yes]");
    const side = rest.includes("--after") ? "after" : "before";
    const { restoreTurn } = require("./restore");
    const metadata = getRepositoryMetadata(cwd);
    const result = restoreTurn({ repositoryRoot: metadata.root, blackboxRoot: getBlackboxRoot(cwd), gitDir: metadata.gitDir, turnId: rest[0], side, confirm: rest.includes("--yes") });
    io.log(result.preview);
    return result.confirmed ? 0 : 1;
  }

  if (command === "verify") {
    const { verifyRepository } = require("./verify");
    const metadata = getRepositoryMetadata(cwd);
    const result = verifyRepository(getBlackboxRoot(cwd), metadata.id);
    io.log(result.valid ? "VALID" : `INVALID\n${result.reason}`);
    return result.valid ? 0 : 1;
  }

  if (command === "status") {
    const metadata = getRepositoryMetadata(cwd);
    const blackboxRoot = getBlackboxRoot(cwd);
    const { log } = require("./inspect");
    io.log(JSON.stringify({ repository: metadata.root, turns: log(blackboxRoot, metadata.id).length }, null, 2));
    return 0;
  }

  if (command === "size") {
    const { size } = require("./maintenance");
    io.log(`${size(getBlackboxRoot(cwd))} bytes`);
    return 0;
  }

  if (command === "prune") {
    if (rest[0] !== "outputs" || rest[1] !== "--before" || !rest[2]) throw new Error("Usage: blackbox prune outputs --before <date> [--yes]");
    const { prunePayloads } = require("./maintenance");
    const metadata = getRepositoryMetadata(cwd);
    const result = prunePayloads(getBlackboxRoot(cwd), metadata.id, { before: rest[2], confirm: rest.includes("--yes") });
    io.log(result.preview);
    return result.confirmed ? 0 : 1;
  }

  if (command === "clear") {
    const passwordIndex = rest.indexOf("--password");
    if (passwordIndex < 0 || !rest[passwordIndex + 1]) throw new Error("Usage: blackbox clear --password <password> [--yes]");
    const { clearRepository } = require("./maintenance");
    const metadata = getRepositoryMetadata(cwd);
    const result = clearRepository(getBlackboxRoot(cwd), metadata.id, { password: rest[passwordIndex + 1], confirm: rest.includes("--yes") });
    io.log(result.preview);
    return result.confirmed ? 0 : 1;
  }

  io.error(`Unknown command: ${command}`);
  printUsage(process.stderr);
  return 1;
}

module.exports = {
  getBlackboxRoot,
  getGitDir,
  getWorktreeGitDir,
  getRepositoryMetadata,
  initRepository,
  main,
  runGit,
};

if (require.main === module) {
  try {
    Promise.resolve(main()).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
