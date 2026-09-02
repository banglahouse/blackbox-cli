const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createCheckpoint } = require("./snapshot");
const { recordCommandFromFiles, recordSession, startTurn, updateTurn } = require("./events");
const { appendAuditEvent, getDatabasePath } = require("./storage");

function promptFromArgs(args, agent = "codex") {
  const start = agent === "codex" ? args.indexOf("exec") + 1 : 0;
  const valueOptions = new Set(["-c", "--config", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "-p", "--profile", "-i", "--image", "-o", "--output-last-message"]);
  const booleanOptions = new Set(["--oss", "--search", "--no-alt-screen", "--strict-config", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--dangerously-bypass-approvals-and-sandbox"]);
  let prompt;
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return args[index + 1]?.startsWith("-") ? null : args[index + 1] || null;
    if (agent === "claude" && (argument === "-p" || argument === "--print")) {
      return args[index + 1] && !args[index + 1].startsWith("-") ? args[index + 1] : null;
    }
    if (valueOptions.has(argument)) { index += 1; continue; }
    if (argument.startsWith("--") && argument.includes("=")) continue;
    if (booleanOptions.has(argument)) continue;
    if (argument.startsWith("-")) return null;
    if (prompt) return null;
    prompt = argument;
  }
  return prompt || null;
}

function changedFiles(blackboxRoot, before, after) {
  const result = spawnSync("git", ["--git-dir", `${blackboxRoot}/snapshots.git`, "diff", "--name-status", "--no-renames", before, after], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [kind, filePath] = line.split("\t");
    return { changeKind: { A: "CREATED", M: "MODIFIED", D: "DELETED" }[kind] || kind, filePath };
  });
}

function recordFileChanges(blackboxRoot, turnId, changes) {
  if (!changes.length) return;
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  try {
    const insert = database.prepare("INSERT INTO file_changes (id, turn_id, path, change_kind) VALUES (?, ?, ?, ?)");
    for (const change of changes) insert.run(crypto.randomUUID(), turnId, change.filePath, change.changeKind);
  } finally { database.close(); }
}

async function runAgent({ agent, args = [], cwd = process.cwd(), executable = agent, spawnProcess = spawn, terminal = { stdout: process.stdout, stderr: process.stderr }, prompt: suppliedPrompt } = {}) {
  const { getRepositoryMetadata, initRepository } = require("./index");
  const metadata = getRepositoryMetadata(cwd);
  const blackboxRoot = initRepository(cwd);
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  recordSession(blackboxRoot, { id: sessionId, repositoryId: metadata.id, agent, startedAt });
  const before = createCheckpoint({ repositoryRoot: metadata.root, blackboxRoot, gitDir: metadata.gitDir, repositoryId: metadata.id, id: `${turnId}-before`, kind: "BEFORE", createdAt: startedAt });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-output-"));
  const stdoutPath = path.join(tempDir, "stdout");
  const stderrPath = path.join(tempDir, "stderr");
  fs.closeSync(fs.openSync(stdoutPath, "w"));
  fs.closeSync(fs.openSync(stderrPath, "w"));
  const prompt = suppliedPrompt ?? promptFromArgs(args, agent);
  startTurn(blackboxRoot, { id: turnId, sessionId, repositoryId: metadata.id, prompt: prompt || "(prompt unavailable: no prompt argument)", startedAt, beforeCheckpointId: before.id });
  let child;
  let settled = false;
  const finish = (exitCode, signal, spawnError) => {
    if (settled) return;
    settled = true;
    const endedAt = new Date().toISOString();
    const after = createCheckpoint({ repositoryRoot: metadata.root, blackboxRoot, gitDir: metadata.gitDir, repositoryId: metadata.id, id: `${turnId}-after`, kind: "AFTER", createdAt: endedAt });
    const status = exitCode === 0 && !spawnError && !signal ? "COMPLETED" : "FAILED";
    updateTurn(blackboxRoot, { id: turnId, status, endedAt, afterCheckpointId: after.id });
    appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: status === "FAILED" ? "TURN_FAILED" : "TURN_COMPLETED", payload: { turnId, status, signal }, createdAt: endedAt });
    recordCommandFromFiles(blackboxRoot, { turnId, repositoryId: metadata.id, command: [executable, ...args].join(" "), cwd, stdoutPath, stderrPath, exitCode, signal, startedAt, endedAt, durationMs: Date.now() - startedMs });
    recordFileChanges(blackboxRoot, turnId, changedFiles(blackboxRoot, before.snapshotId, after.snapshotId));
    appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "SESSION_ENDED", payload: { sessionId, turnId, signal, spawnError: spawnError?.message || null }, createdAt: endedAt });
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(name, forward[name]);
    resolve(exitCode ?? 1);
  };
  const forward = { SIGINT: () => child?.kill("SIGINT"), SIGTERM: () => child?.kill("SIGTERM"), SIGHUP: () => child?.kill("SIGHUP") };
  let resolve;
  const result = new Promise((done) => { resolve = done; });
  for (const name of Object.keys(forward)) process.once(name, forward[name]);
  try { child = spawnProcess(executable, args, { cwd, stdio: ["inherit", "pipe", "pipe"] }); }
  catch (error) { finish(null, null, error); return result; }
  child.stdout?.on("data", (chunk) => { fs.appendFileSync(stdoutPath, chunk); terminal.stdout.write(chunk); });
  child.stderr?.on("data", (chunk) => { fs.appendFileSync(stderrPath, chunk); terminal.stderr.write(chunk); });
  child.once("error", (error) => finish(null, null, error));
  child.once("close", (code, signal) => finish(code, signal, null));
  return result;
}

module.exports = { changedFilesForSnapshots: changedFiles, promptFromArgs, recordFileChangesForTurn: recordFileChanges, runAgent };
