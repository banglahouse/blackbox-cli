const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { appendAuditEvent, ensureRepository, initializeDatabase, verifyAuditChain } = require("../storage");
const { captureSnapshot, createCheckpoint } = require("../snapshot");
const { captureCommand, normalizeEvent, recordSession, recordTurn } = require("../events");
const { normalizeCodexEvent, runCodex } = require("../codex");
const { promptFromArgs, runAgent } = require("../adapter");
const { normalizeClaudeEvent, runClaude } = require("../claude");
const { JsonlDecoder, WebSocketDecoder, createSocketWriter, createWebSocketProxy, frame, recordCodexThread, resumeScope, scopedThreadList, threadBelongsToRepository } = require("../codex-app-server");
const { restoreTurn } = require("../restore");
const { clearRepository, hasPassword, prunePayloads, setPassword, size } = require("../maintenance");

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

const initializeRequest = JSON.stringify({ id: "initialize", method: "initialize", params: { clientInfo: { name: "codex-tui", version: "0.147.0" }, capabilities: { experimentalApi: true }, cwd: "/tmp/blackbox" } });

function maskedFrame(data, opcode = 1, fin = true) {
  const payload = Buffer.from(data);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = payload.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, encoded]);
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
  assert.deepEqual(tables, ["audit_events", "checkpoints", "codex_threads", "command_output_chunks", "commands", "file_changes", "payloads", "repositories", "sessions", "turns"]);
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

test("snapshot skips an inaccessible directory instead of failing a checkpoint", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "success\n");
  fs.mkdirSync(path.join(dir, ".Trash"));
  assert.equal(runCli(["init"], dir).status, 0);
  const originalReadDir = fs.readdirSync;
  fs.readdirSync = (target, options) => {
    if (path.basename(target) === ".Trash") {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    }
    return originalReadDir(target, options);
  };
  try {
    const metadata = require("../index").getRepositoryMetadata(dir);
    const blackboxRoot = require("../index").getBlackboxRoot(dir);
    assert.doesNotThrow(() => captureSnapshot({ repositoryRoot: metadata.root, blackboxRoot, gitDir: metadata.gitDir }));
  } finally {
    fs.readdirSync = originalReadDir;
  }
});

test("snapshot skips an inaccessible file instead of failing a checkpoint", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "success\n");
  fs.writeFileSync(path.join(dir, "protected.txt"), "protected\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const originalReadFile = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (path.basename(target) === "protected.txt") {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    }
    return originalReadFile(target, ...args);
  };
  try {
    const metadata = require("../index").getRepositoryMetadata(dir);
    const blackboxRoot = require("../index").getBlackboxRoot(dir);
    assert.doesNotThrow(() => captureSnapshot({ repositoryRoot: metadata.root, blackboxRoot, gitDir: metadata.gitDir }));
  } finally {
    fs.readFileSync = originalReadFile;
  }
});

test("normalized turns and commands capture observable output", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  database.close();
  const sessionId = recordSession(blackboxRoot, { id: "s1", repositoryId: "r", agent: "codex" });
  const turnId = recordTurn(blackboxRoot, { id: "t1", sessionId, repositoryId: "r", prompt: "run a check" });
  const result = captureCommand(blackboxRoot, { turnId, repositoryId: "r", command: process.execPath, args: ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"], cwd: dir });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  const commandDatabase = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const command = commandDatabase.prepare("SELECT sequence, cwd, stdout, stderr, exit_code, duration_ms FROM commands WHERE id = ?").get(result.commandId);
  assert.equal(command.sequence, 1);
  assert.equal(command.cwd, dir);
  assert.equal(command.stdout, "ok");
  assert.equal(command.stderr, "warn");
  assert.equal(command.exit_code, 0);
  assert.ok(command.duration_ms >= 0);
  commandDatabase.close();
  assert.deepEqual(normalizeEvent("AGENT_MESSAGE", { text: "visible" }), { type: "AGENT_MESSAGE", text: "visible" });
});

test("Codex adapter forwards arguments and records lifecycle events", async () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const marker = path.join(dir, "args.txt");
  const result = runCodex({
    cwd: dir,
    executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join('|'))`, "--", "--model", "mini"],
  });
  const awaited = await result;
  assert.equal(awaited, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "--model|mini");
  assert.deepEqual(normalizeCodexEvent({ type: "agent_message", text: "visible" }), { type: "AGENT_MESSAGE", text: "visible" });
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const types = database.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((row) => row.event_type);
  assert.deepEqual(types, ["SESSION_STARTED", "PROMPT_SUBMITTED", "TURN_COMPLETED", "COMMAND_COMPLETED", "SESSION_ENDED"]);
  database.close();
});

test("Claude adapter forwards arguments and records lifecycle events", async () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const marker = path.join(dir, "args.txt");
  const result = runClaude({
    cwd: dir,
    executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join('|'))`, "--", "--model", "sonnet"],
  });
  assert.equal(await result, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "--model|sonnet");
  assert.deepEqual(normalizeClaudeEvent({ type: "agent_message", text: "visible" }), { type: "AGENT_MESSAGE", text: "visible" });
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const types = database.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((row) => row.event_type);
  assert.deepEqual(types, ["SESSION_STARTED", "PROMPT_SUBMITTED", "TURN_COMPLETED", "COMMAND_COMPLETED", "SESSION_ENDED"]);
  database.close();
});

test("CLI adapters launch from the packaged entrypoint", () => {
  for (const agent of ["codex", "claude"]) {
    const dir = mkTempDir();
    assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
    const marker = path.join(dir, `${agent}.txt`);
    const bin = path.join(dir, agent);
    fs.writeFileSync(bin, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
    fs.chmodSync(bin, 0o755);
    const result = spawnSync(process.execPath, [cliPath, agent, "--version"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "ran");
  }
});

test("wrapped agent changes create real turn checkpoints and line provenance", async () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "baseline\nunchanged\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const result = runCodex({
    cwd: dir,
    executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync('file.txt', 'captured\\nunchanged\\n')`], prompt: "captured prompt",
  });
  assert.equal(await result, 0);
  const log = JSON.parse(runCli(["log"], dir).stdout);
  assert.equal(log.length, 1);
  assert.equal(log[0].agent, "codex");
  assert.equal(log[0].prompt, "captured prompt");
  const turnId = log[0].id;
  assert.match(runCli(["show", turnId], dir).stdout, /file\.txt/);
  assert.match(runCli(["diff", turnId], dir).stdout, /-baseline/);
  assert.match(runCli(["diff", turnId], dir).stdout, /\+captured/);
  assert.equal(JSON.parse(runCli(["why", "file.txt:1"], dir).stdout).turnId, turnId);
  assert.equal(JSON.parse(runCli(["why", "file.txt:2"], dir).stdout).turnId, "MANUAL");
  assert.match(runCli(["blame", "file.txt"], dir).stdout, new RegExp(turnId));
});

test("non-interactive prompt parsing ignores trailing option values", () => {
  const codexForms = [
    [["exec", "fix the bug"], "fix the bug"],
    [["exec", "--model", "mini", "fix the bug"], "fix the bug"],
    [["exec", "fix the bug", "--model", "mini"], "fix the bug"],
    [["exec", "--model=mini", "fix the bug"], "fix the bug"],
    [["exec", "--sandbox", "workspace-write", "fix the bug"], "fix the bug"],
    [["exec", "fix the bug", "--sandbox", "workspace-write"], "fix the bug"],
    [["exec", "--", "fix the bug"], "fix the bug"],
    [["exec"], null],
  ];
  for (const [args, prompt] of codexForms) assert.equal(promptFromArgs(args, "codex"), prompt);
  assert.equal(promptFromArgs(["--model", "sonnet", "-p", "fix the bug"], "claude"), "fix the bug");
  assert.equal(promptFromArgs(["-p", "fix the bug", "--model", "sonnet"], "claude"), "fix the bug");
  assert.equal(promptFromArgs(["--print", "fix the bug"], "claude"), "fix the bug");
  assert.equal(promptFromArgs(["-p", "--model", "sonnet"], "claude"), null);
  assert.equal(promptFromArgs([], "claude"), null);
});

test("resume scopes thread/list to invocation cwd and preserves explicit global mode", () => {
  const request = { jsonrpc: "2.0", id: "list-1", method: "thread/list", params: { cursor: "next", unknown: { keep: true } } };
  assert.deepEqual(resumeScope(["resume"]), { resume: true, all: false });
  assert.deepEqual(scopedThreadList(request, "/tmp/repo-a"), { ...request, params: { cursor: "next", unknown: { keep: true }, cwd: "/tmp/repo-a" } });
  assert.deepEqual(scopedThreadList(request, "/tmp/repo-a", true), request);
  assert.deepEqual(scopedThreadList({ method: "thread/start" }, "/tmp/repo-a"), { method: "thread/start" });
});

test("socket writer absorbs EPIPE without crashing and labels the direction", () => {
  class BrokenSocket extends EventEmitter {
    destroyed = false;
    writable = true;
    writableEnded = false;
    write() { const error = new Error("write EPIPE"); error.code = "EPIPE"; throw error; }
    end() { this.writableEnded = true; }
  }
  const failures = [];
  const writer = createSocketWriter(new BrokenSocket(), "TUI<-proxy", (error, label) => failures.push({ code: error.code, label }));
  assert.equal(writer.write(Buffer.from("resume")), false);
  assert.deepEqual(failures, [{ code: "EPIPE", label: "TUI<-proxy" }]);
});

test("Codex thread mappings keep three real repositories separate", () => {
  const repositories = ["repo-a", "repo-b", "repo-c"].map((name) => {
    const dir = path.join(mkTempDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
    assert.equal(runCli(["init"], dir).status, 0);
    const metadata = require("../index").getRepositoryMetadata(dir);
    const sessionId = recordSession(require("../index").getBlackboxRoot(dir), { repositoryId: metadata.id, agent: "codex" });
    recordCodexThread(require("../index").getBlackboxRoot(dir), { threadId: `thread-${name}`, repositoryId: metadata.id, sessionId, worktreeRoot: metadata.root, cwd: dir });
    return { dir, metadata };
  });
  for (const [index, repository] of repositories.entries()) {
    const root = require("../index").getBlackboxRoot(repository.dir);
    assert.equal(threadBelongsToRepository(root, `thread-repo-${["a", "b", "c"][index]}`, repository.metadata.id), true);
    assert.equal(threadBelongsToRepository(root, `thread-repo-${["a", "b", "c"][((index + 1) % 3)]}`, repository.metadata.id), null);
  }
});

test("JSONL decoder handles the Codex 0.147.0 initialize request at every split", () => {
  const record = `${initializeRequest}\r\n`;
  for (let split = 0; split <= Buffer.byteLength(record); split += 1) {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from(record);
    const messages = [...decoder.feed(bytes.subarray(0, split)), ...decoder.feed(bytes.subarray(split))];
    assert.deepEqual(messages, [JSON.parse(initializeRequest)]);
  }
  const oneByte = new JsonlDecoder();
  const messages = [];
  for (const byte of Buffer.from(record)) messages.push(...oneByte.feed(Buffer.from([byte])));
  assert.deepEqual(messages, [JSON.parse(initializeRequest)]);
  const combined = new JsonlDecoder();
  assert.deepEqual(combined.feed(Buffer.from(`${initializeRequest}\n${JSON.stringify({ id: "initialized", method: "initialized" })}\n`)), [JSON.parse(initializeRequest), { id: "initialized", method: "initialized" }]);
  const unicode = `${JSON.stringify({ ...JSON.parse(initializeRequest), params: { prompt: "café 🚀" } })}\n`;
  const unicodeBytes = Buffer.from(unicode);
  const unicodeDecoder = new JsonlDecoder();
  const unicodeMessages = [];
  for (let index = 0; index < unicodeBytes.length; index += 1) unicodeMessages.push(...unicodeDecoder.feed(unicodeBytes.subarray(index, index + 1)));
  assert.equal(unicodeMessages[0].params.prompt, "café 🚀");
});

test("Unix WebSocket proxy completes an initialize handshake with fragmented frames", async (t) => {
  const socketPath = path.join(mkTempDir(), "codex.sock");
  const received = [];
  const rawReceived = [];
  const proxy = createWebSocketProxy({ onMessage(message, socket, raw) { received.push(message); rawReceived.push(raw); proxy.send({ id: message.id, result: { ok: true } }); } });
  try {
    await new Promise((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(socketPath, resolve);
    });
  } catch (error) {
    proxy.close();
    if (error.code === "EPERM") return t.skip("sandbox disallows Unix socket listeners");
    throw error;
  }
  const client = net.createConnection(socketPath);
  const response = new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    client.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.includes(Buffer.from("\r\n\r\n"))) resolve(data.toString("latin1"));
    });
    client.on("error", reject);
  });
  client.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  assert.match(await response, /101 Switching Protocols/);
  const reply = new Promise((resolve, reject) => {
    const decoder = new WebSocketDecoder();
    client.on("data", (chunk) => { try { const message = decoder.feed(chunk).find((item) => item.opcode === 1); if (message) resolve(JSON.parse(message.payload)); } catch (error) { reject(error); } });
    client.on("error", reject);
  });
  const bytes = Buffer.from(initializeRequest);
  const middle = Math.floor(bytes.length / 2);
  client.write(maskedFrame(bytes.subarray(0, middle), 1, false));
  client.write(maskedFrame(bytes.subarray(middle), 0, true));
  assert.deepEqual(await reply, { id: "initialize", result: { ok: true } });
  assert.deepEqual(received, [JSON.parse(initializeRequest)]);
  const turnStart = JSON.stringify({ jsonrpc: "2.0", id: "turn-request", method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "deterministic" }], cwd: "/tmp/blackbox", sandboxPolicy: { type: "workspace-write" }, unknownField: { keep: true } } });
  const turnReply = new Promise((resolve, reject) => {
    const decoder = new WebSocketDecoder();
    client.on("data", (chunk) => { try { const message = decoder.feed(chunk).find((item) => item.opcode === 1); if (message) resolve(JSON.parse(message.payload)); } catch (error) { reject(error); } });
    client.on("error", reject);
  });
  client.write(maskedFrame(turnStart));
  assert.deepEqual(await turnReply, { id: "turn-request", result: { ok: true } });
  assert.equal(rawReceived[1], turnStart);
  assert.deepEqual(received[1], JSON.parse(turnStart));
  client.destroy();
  await new Promise((resolve) => client.once("close", resolve));
  const replacement = net.createConnection(socketPath);
  const replacementHandshake = new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    replacement.on("data", (chunk) => { data = Buffer.concat([data, chunk]); if (data.includes(Buffer.from("\r\n\r\n"))) resolve(data.toString("latin1")); });
    replacement.on("error", reject);
  });
  replacement.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: c2Vjb25kIGNsaWVudA==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  assert.match(await replacementHandshake, /101 Switching Protocols/);
  const replacementReply = new Promise((resolve, reject) => {
    const decoder = new WebSocketDecoder();
    replacement.on("data", (chunk) => { try { const message = decoder.feed(chunk).find((item) => item.opcode === 1); if (message) resolve(JSON.parse(message.payload)); } catch (error) { reject(error); } });
    replacement.on("error", reject);
  });
  replacement.write(maskedFrame(initializeRequest));
  assert.deepEqual(await replacementReply, { id: "initialize", result: { ok: true } });
  replacement.destroy();
  client.destroy();
  proxy.close();
});

test("streamed output exceeds the old sync buffer and preserves stdout/stderr", async () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const output = new PassThrough();
  const error = new PassThrough();
  const stdout = [], stderr = [];
  output.on("data", (chunk) => stdout.push(chunk));
  error.on("data", (chunk) => stderr.push(chunk));
  const result = await runAgent({ agent: "codex", cwd: dir, executable: process.execPath, args: ["-e", "process.stdout.write('o'.repeat(2*1024*1024)); process.stderr.write('e'.repeat(2*1024*1024))", "large output"], terminal: { stdout: output, stderr: error } });
  assert.equal(result, 0);
  const database = new DatabaseSync(path.join(require("../index").getBlackboxRoot(dir), "blackbox.sqlite"));
  const sizes = database.prepare("SELECT stream, SUM(length(content)) AS size FROM command_output_chunks GROUP BY stream ORDER BY stream").all();
  assert.deepEqual(sizes.map((row) => ({ stream: row.stream, size: row.size })), [{ stream: "stderr", size: 2 * 1024 * 1024 }, { stream: "stdout", size: 2 * 1024 * 1024 }]);
  database.close();
  assert.equal(Buffer.concat(stdout).length, 2 * 1024 * 1024);
  assert.equal(Buffer.concat(stderr).length, 2 * 1024 * 1024);
});

test("streamed non-zero, spawn failure, and signal termination finalize failed turns", async () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const failed = await runAgent({ agent: "claude", cwd: dir, executable: process.execPath, args: ["-e", "process.stderr.write('failed'); process.exit(7)"], prompt: "bad turn", terminal: { stdout: new PassThrough(), stderr: new PassThrough() } });
  assert.equal(failed, 7);
  assert.equal(await runAgent({ agent: "claude", cwd: dir, executable: "missing-blackbox-agent", args: [], prompt: "bad spawn" }), 1);
  const interrupted = await runAgent({ agent: "claude", cwd: dir, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], prompt: "interrupted", spawnProcess: (...args) => { const child = spawn(...args); setTimeout(() => child.kill("SIGTERM"), 25); return child; }, terminal: { stdout: new PassThrough(), stderr: new PassThrough() } });
  assert.equal(interrupted, 1);
  const database = new DatabaseSync(path.join(require("../index").getBlackboxRoot(dir), "blackbox.sqlite"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM turns WHERE status = 'FAILED'").get().count, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM turns WHERE after_checkpoint_id IS NOT NULL").get().count, 3);
  assert.match(database.prepare("SELECT payload FROM audit_events WHERE event_type = 'COMMAND_COMPLETED' ORDER BY rowid DESC LIMIT 1").get().payload, /SIGTERM/);
  database.close();
});

test("inspection commands read turns, file history, and checkpoint diffs", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const before = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  fs.writeFileSync(path.join(dir, "file.txt"), "after\n");
  const after = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES ('s1', '" + repo + "', 'codex', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO checkpoints (id, repository_id, kind, snapshot_id) VALUES ('cp-before', '" + repo + "', 'BEFORE', '" + before + "'), ('cp-after', '" + repo + "', 'AFTER', '" + after + "')");
  database.exec("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id, after_checkpoint_id) VALUES ('t1', 's1', 'change file', 'COMPLETED', '2026-01-01T00:00:01.000Z', 'cp-before', 'cp-after')");
  database.exec("INSERT INTO file_changes (id, turn_id, path, change_kind) VALUES ('fc1', 't1', 'file.txt', 'MODIFIED')");
  database.close();
  assert.match(runCli(["log"], dir).stdout, /change file/);
  assert.match(runCli(["show", "t1"], dir).stdout, /codex/);
  assert.match(runCli(["file", "file.txt"], dir).stdout, /MODIFIED/);
  assert.match(runCli(["diff", "t1"], dir).stdout, /-before/);
  assert.match(runCli(["diff", "t1"], dir).stdout, /\+after/);
});

test("blame and why use recorded file provenance", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "one\ntwo\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES ('s1', '" + repo + "', 'claude', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id) VALUES ('t1', 's1', 'add file', 'COMPLETED', '2026-01-01T00:00:01.000Z', 'cp-before')");
  database.exec("INSERT INTO file_changes (id, turn_id, path, change_kind) VALUES ('fc1', 't1', 'file.txt', 'CREATED')");
  database.close();
  const blame = runCli(["blame", "file.txt"], dir);
  assert.equal(blame.status, 0, blame.stderr);
  assert.match(blame.stdout, /t1/);
  const why = runCli(["why", "file.txt:2"], dir);
  assert.equal(why.status, 0, why.stderr);
  assert.match(why.stdout, /add file/);
  assert.match(why.stdout, /claude/);
  assert.match(why.stdout, /cp-before/);
});

test("restore previews first, checkpoints current state, and requires confirmation", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const before = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  fs.writeFileSync(path.join(dir, "file.txt"), "after\n");
  const after = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES ('s1', '" + repo + "', 'codex', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO checkpoints (id, repository_id, kind, snapshot_id) VALUES ('cp-before', '" + repo + "', 'BEFORE', '" + before + "'), ('cp-after', '" + repo + "', 'AFTER', '" + after + "')");
  database.exec("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id, after_checkpoint_id) VALUES ('t1', 's1', 'change file', 'COMPLETED', '2026-01-01T00:00:01.000Z', 'cp-before', 'cp-after')");
  database.close();
  const preview = restoreTurn({ repositoryRoot: dir, blackboxRoot, gitDir, turnId: "t1", side: "before" });
  assert.equal(preview.confirmed, false);
  assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "after\n");
  assert.match(preview.preview, /file.txt/);
  const restored = restoreTurn({ repositoryRoot: dir, blackboxRoot, gitDir, turnId: "t1", side: "before", confirm: true });
  assert.equal(restored.confirmed, true);
  assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "before\n");
  const kinds = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite")).prepare("SELECT kind FROM checkpoints WHERE kind = 'PRE_RESTORE'").all();
  assert.equal(kinds.length, 2);
});

test("verify reports valid history and concrete integrity failures", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const valid = runCli(["verify"], dir);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /VALID/);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.prepare("INSERT INTO audit_events (id, repository_id, event_type, payload, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?)").run("bad", repo, "PROMPT_SUBMITTED", "{}", null, "broken");
  database.close();
  const invalid = runCli(["verify"], dir);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /INVALID/);
  assert.match(invalid.stdout, /broken audit chain/);
});

test("maintenance reports size, previews audited pruning, and protects clear with a password", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init", "--password", "secret"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  assert.ok(size(blackboxRoot) > 0);
  assert.equal(hasPassword(blackboxRoot, "secret"), true);
  assert.equal(hasPassword(blackboxRoot, "wrong"), false);
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO payloads (id, kind, content, created_at) VALUES ('p1', 'stdout', 'old', '2020-01-01T00:00:00Z')");
  database.close();
  const preview = prunePayloads(blackboxRoot, repo, { before: "2021-01-01T00:00:00Z" });
  assert.equal(preview.confirmed, false);
  assert.match(preview.preview, /1 payload/);
  assert.equal(prunePayloads(blackboxRoot, repo, { before: "2021-01-01T00:00:00Z", confirm: true }).count, 1);
  assert.equal(clearRepository(blackboxRoot, repo, { password: "secret" }).confirmed, false);
  assert.throws(() => clearRepository(blackboxRoot, repo, { password: "wrong", confirm: true }), /Invalid/);
});

test("help prints usage", () => {
  const result = runCli(["--help"], mkTempDir());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /blackbox <command>/);
});

test("commands requiring targets print usage instead of a raw exception", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  for (const args of [["show"], ["diff"], ["file"], ["blame"], ["why"], ["restore"]]) {
    const result = runCli(args, dir);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /Usage: blackbox/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
  }
});

test("subdirectories and linked worktrees discover the shared store", async () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
  assert.equal(spawnSync("git", ["add", "file.txt"], { cwd: dir }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "baseline"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const subdir = path.join(dir, "nested");
  fs.mkdirSync(subdir);
  assert.match(runCli(["log"], subdir).stdout, /\[\]/);
  const worktree = `${dir}-linked`;
  assert.equal(spawnSync("git", ["worktree", "add", "-b", "linked", worktree], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], worktree).status, 0);
  const { getBlackboxRoot, getRepositoryMetadata } = require("../index");
  const mainMetadata = getRepositoryMetadata(dir);
  const linkedMetadata = getRepositoryMetadata(worktree);
  assert.equal(mainMetadata.id, linkedMetadata.id);
  assert.equal(mainMetadata.gitDir, linkedMetadata.gitDir);
  assert.notEqual(mainMetadata.worktreeGitDir, linkedMetadata.worktreeGitDir);
  assert.equal(await runCodex({ cwd: dir, executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('file.txt', 'two\\n')"], prompt: "change from main" }), 0);
  assert.match(runCli(["log"], worktree).stdout, /change from main/);
  assert.equal(getBlackboxRoot(dir), getBlackboxRoot(worktree));
});

test("legacy repository metadata keeps existing turns visible after identity migration", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const { getBlackboxRoot, getGitDir, getRepositoryMetadata, initRepository } = require("../index");
  const blackboxRoot = getBlackboxRoot(dir);
  fs.mkdirSync(blackboxRoot, { recursive: true });
  initializeDatabase(blackboxRoot);
  const legacyId = "legacy-repository-id";
  const commonGitDir = getGitDir(dir);
  ensureRepository(blackboxRoot, { id: legacyId, root: dir, gitDir: path.join(dir, ".git") });
  fs.writeFileSync(path.join(blackboxRoot, "repository.json"), `${JSON.stringify({ id: legacyId, gitDir: path.join(dir, ".git") })}\n`);
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.prepare("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES (?, ?, ?, ?)").run("legacy-session", legacyId, "codex", new Date().toISOString());
  database.prepare("INSERT INTO turns (id, session_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)").run("legacy-turn", "legacy-session", "old history", "COMPLETED", new Date().toISOString());
  database.close();
  initRepository(dir);
  assert.equal(getRepositoryMetadata(dir).id, legacyId);
  assert.match(runCli(["log"], dir).stdout, /old history/);
  assert.equal(getGitDir(dir), commonGitDir);
});
