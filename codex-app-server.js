const crypto = require("node:crypto");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createCheckpoint } = require("./snapshot");
const { appendAuditEvent, getDatabasePath } = require("./storage");
const { recordCommand, recordSession, updateTurn } = require("./events");

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const debug = (...parts) => { if (process.env.BLACKBOX_DEBUG) process.stderr.write(`[blackbox-codex] ${parts.join(" ")}\n`); };

function createSocketWriter(socket, label, onFailure) {
  const queue = [];
  let closed = false;
  let draining = false;
  const fail = (error) => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    onFailure?.(error, label);
  };
  socket.on("error", fail);
  socket.on("end", () => { closed = true; queue.length = 0; });
  socket.on("close", () => { closed = true; queue.length = 0; });
  function flush() {
    if (closed || draining || socket.destroyed || !socket.writable || socket.writableEnded) return false;
    while (queue.length) {
      try {
        if (!socket.write(queue.shift())) {
          draining = true;
          socket.once("drain", () => { draining = false; flush(); });
          return true;
        }
      } catch (error) {
        fail(error);
        return false;
      }
    }
    return true;
  }
  return {
    write(data) {
      if (closed || socket.destroyed || !socket.writable || socket.writableEnded) return false;
      queue.push(data);
      return flush();
    },
    end() {
      if (!closed && !socket.destroyed && socket.writable && !socket.writableEnded) {
        try { socket.end(); } catch (error) { fail(error); }
      }
    },
  };
}

function frame(data, opcode = 1) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length <= 0xffff) header = Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([(payload.length >> 8) & 255, payload.length & 255])]);
  else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

class JsonlDecoder {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  feed(chunk) {
    this.buffer += this.decoder.write(chunk);
    const messages = [];
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      messages.push(JSON.parse(line));
    }
    return messages;
  }

  feedRecords(chunk) {
    this.buffer += this.decoder.write(chunk);
    const records = [];
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      records.push({ value: JSON.parse(raw), raw });
    }
    return records;
  }

  end() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new SyntaxError("Incomplete JSONL message");
  }
}

class WebSocketDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
        length = Number(longLength);
        headerLength = 10;
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + length;
      if (this.buffer.length < frameLength) break;
      const opcode = first & 0x0f;
      const fin = Boolean(first & 0x80);
      if (opcode >= 8 && (!fin || length > 125)) throw new Error("Invalid WebSocket control frame");
      const maskStart = headerLength;
      const mask = masked ? this.buffer.subarray(maskStart, maskStart + 4) : null;
      const payloadStart = maskStart + maskLength;
      const payload = Buffer.from(this.buffer.subarray(payloadStart, frameLength));
      this.buffer = this.buffer.subarray(frameLength);
      if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0) {
        if (!this.fragments) throw new Error("Unexpected WebSocket continuation frame");
        this.fragments.payload.push(payload);
        if (fin) {
          messages.push({ opcode: this.fragments.opcode, payload: Buffer.concat(this.fragments.payload) });
          this.fragments = null;
        }
      } else if (opcode === 1 || opcode === 2) {
        if (this.fragments) throw new Error("Nested WebSocket fragmented message");
        if (fin) messages.push({ opcode, payload });
        else this.fragments = { opcode, payload: [payload] };
      } else {
        messages.push({ opcode, payload });
      }
    }
    return messages;
  }
}

function createWebSocketProxy({ onMessage, onError } = {}) {
  let client;
  const connections = new Set();
  const pendingRequests = new Map();
  const deferredMessages = [];
  const writeFailures = [];
  const requestKey = (connection, id) => `${connection.id}:${typeof id}:${JSON.stringify(id)}`;
  const server = net.createServer((socket) => {
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    let websocket;
    const writer = createSocketWriter(socket, "TUI<-proxy", (error, label) => {
      writeFailures.push({ error: error.message, label });
      if (writeFailures.length > 20) writeFailures.shift();
    });
    const connection = { id: crypto.randomUUID(), socket, writer, upgraded: false };
    connections.add(connection);
    debug("connection-open", connection.id);
    socket.on("data", (chunk) => {
      try {
        handshake = Buffer.concat([handshake, chunk]);
        if (!upgraded) {
          const end = handshake.indexOf("\r\n\r\n");
          if (end < 0) return;
          const headers = handshake.subarray(0, end).toString("latin1");
          const key = headers.match(/^Sec-WebSocket-Key:\s*(.+)$/im)?.[1]?.trim();
          if (!key) throw new Error("WebSocket upgrade omitted Sec-WebSocket-Key");
          writer.write(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + MAGIC).digest("base64")}\r\n\r\n`));
          upgraded = true;
          connection.upgraded = true;
          client = connection;
          debug("connection-upgraded", connection.id);
          websocket = new WebSocketDecoder();
          handshake = handshake.subarray(end + 4);
          while (deferredMessages.length) writer.write(frame(deferredMessages.shift()));
        }
        for (const message of websocket.feed(handshake)) {
          if (message.opcode === 8) { writer.write(frame(message.payload, 8)); return writer.end(); }
          if (message.opcode === 9) { writer.write(frame(message.payload, 10)); continue; }
          if (message.opcode === 10) continue;
          if (message.opcode !== 1 && message.opcode !== 2) throw new Error("Codex remote connection sent an unsupported message");
          const text = message.payload.toString("utf8");
          const parsed = JSON.parse(text);
          debug("client-message", connection.id, parsed.method || "response", parsed.id === undefined ? "notification" : `${typeof parsed.id}:${String(parsed.id)}`);
          if (parsed.id !== undefined) {
            const key = requestKey(connection, parsed.id);
            if (parsed.method) pendingRequests.set(key, { request: parsed, connection });
            else pendingRequests.delete(key);
          }
          onMessage(parsed, socket, text);
        }
        handshake = Buffer.alloc(0);
      } catch (error) {
        onError?.(error);
        socket.destroy();
      }
    });
    socket.on("close", () => {
      connections.delete(connection);
      debug("connection-close", connection.id, `remaining=${connections.size}`);
      // Keep request affinity across the picker handoff. Codex can close the
      // picker socket before its replacement is fully initialized; dropping
      // these entries loses the response correlation and makes the TUI report
      // only "failed to connect to remote app server".
      if (client === connection) client = [...connections].reverse().find((candidate) => candidate.upgraded) || null;
      debug("active-connection", client?.id || "none");
    });
  });
  return {
    server,
    send(message, socket = client?.socket) { return this.sendTo(socket, message); },
    sendTo(socket, message) {
      const target = [...connections].find((candidate) => candidate.socket === socket);
      return target?.writer.write(frame(JSON.stringify(message))) ?? false;
    },
    sendRaw(message) {
      if (client && client.upgraded) {
        let target = client;
        try {
          const parsed = JSON.parse(message);
          debug("server-message", parsed.method || "response", parsed.id === undefined ? "notification" : `${typeof parsed.id}:${String(parsed.id)}`);
          if (parsed.id !== undefined) {
            if (!parsed.method) {
              const pending = [...pendingRequests.entries()].find(([key]) => key.endsWith(`:${typeof parsed.id}:${JSON.stringify(parsed.id)}`));
              if (pending) {
                target = pending[1].connection && connections.has(pending[1].connection) ? pending[1].connection : target;
                pendingRequests.delete(pending[0]);
              }
            } else pendingRequests.set(requestKey(target, parsed.id), { request: parsed, connection: target });
          }
        } catch {}
        return target.writer.write(frame(message));
      }
      deferredMessages.push(message);
      return true;
    },
    pendingRequests,
    writeFailures,
    close() { for (const connection of connections) connection.socket.destroy(); connections.clear(); client = null; server.close(); },
  };
}

function resumeScope(args = []) {
  const resumeIndex = args.indexOf("resume");
  return { resume: resumeIndex >= 0, all: args.includes("--all") };
}

function scopedThreadList(message, cwd, all = false) {
  if (all || message.method !== "thread/list") return message;
  return { ...message, params: { ...(message.params || {}), cwd } };
}

function recordCodexThread(blackboxRoot, { threadId, repositoryId, sessionId, worktreeRoot, cwd, timestamp = new Date().toISOString() }) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  try {
    database.prepare("INSERT INTO codex_threads (thread_id, repository_id, session_id, worktree_root, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET repository_id = excluded.repository_id, session_id = excluded.session_id, worktree_root = excluded.worktree_root, cwd = excluded.cwd, updated_at = excluded.updated_at").run(threadId, repositoryId, sessionId, worktreeRoot, cwd, timestamp, timestamp);
  } finally { database.close(); }
}

function threadBelongsToRepository(blackboxRoot, threadId, repositoryId) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  try {
    const row = database.prepare("SELECT repository_id AS repositoryId FROM codex_threads WHERE thread_id = ?").get(threadId);
    return row ? row.repositoryId === repositoryId : null;
  } finally { database.close(); }
}

async function runInteractiveCodex({ args = [], cwd = process.cwd(), executable = "codex", spawnProcess = spawn } = {}) {
  const { getRepositoryMetadata, initRepository } = require("./index");
  const metadata = getRepositoryMetadata(cwd);
  const blackboxRoot = initRepository(cwd);
  const sessionId = crypto.randomUUID();
  const invocationCwd = path.resolve(cwd);
  const scope = resumeScope(args);
  recordSession(blackboxRoot, { id: sessionId, repositoryId: metadata.id, agent: "codex" });
  const appServer = spawnProcess(executable, ["app-server"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
  const appInput = createSocketWriter(appServer.stdin, "proxy->app-server", (error) => {
    process.stderr.write(`Blackbox App Server input closed: ${error.message}\n`);
  });
  const turns = new Map();
  let initializeResponse;
  let appInitialized = false;
  let activeCodexThreadId;
  const socketPath = `${os.tmpdir()}/blackbox-codex-${process.pid}.sock`;
  const appOutput = new JsonlDecoder();

  function beginTurn(message) {
    const input = message.params?.input?.find((item) => item.type === "text");
    if (!input) return;
    const turnId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const before = createCheckpoint({ repositoryRoot: metadata.root, blackboxRoot, gitDir: metadata.gitDir, repositoryId: metadata.id, id: `${turnId}-before`, kind: "BEFORE", createdAt: startedAt });
    const database = new DatabaseSync(getDatabasePath(blackboxRoot));
    try {
      database.prepare("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id) VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)").run(turnId, sessionId, input.text, startedAt, before.id);
    } finally {
      database.close();
    }
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    const workingTree = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "PROMPT_SUBMITTED", payload: { turnId, sessionId, prompt: input.text, branch: branch.status === 0 ? branch.stdout.trim() : "unknown", head: head.status === 0 ? head.stdout.trim() : "unknown", workingTree: workingTree.stdout || "", worktreeRoot: metadata.root, worktreeGitDir: metadata.worktreeGitDir }, createdAt: startedAt });
    turns.set(message.id, { id: turnId, startedAt, before });
  }

  function finishTurn(codexTurnId, status) {
    const turn = [...turns.values()].find((candidate) => candidate.codexId === codexTurnId) || [...turns.values()].at(-1);
    if (!turn || turn.after) return;
    const endedAt = new Date().toISOString();
    turn.after = createCheckpoint({ repositoryRoot: metadata.root, blackboxRoot, gitDir: metadata.gitDir, repositoryId: metadata.id, id: `${turn.id}-after`, kind: "AFTER", createdAt: endedAt });
    updateTurn(blackboxRoot, { id: turn.id, status, endedAt, afterCheckpointId: turn.after.id });
    const diff = require("./adapter").changedFilesForSnapshots(blackboxRoot, turn.before.snapshotId, turn.after.snapshotId);
    require("./adapter").recordFileChangesForTurn(blackboxRoot, turn.id, diff);
    appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: status === "FAILED" ? "TURN_FAILED" : "TURN_COMPLETED", payload: { turnId: turn.id, status }, createdAt: endedAt });
  }

  function currentTurn(codexTurnId) {
    return [...turns.values()].find((candidate) => candidate.codexId === codexTurnId) || [...turns.values()].at(-1);
  }

  let stop;
  const proxy = createWebSocketProxy({
    onMessage(message, socket, text) {
      if (message.method === "initialize" && initializeResponse) {
        proxy.send({ ...initializeResponse, id: message.id }, socket);
        debug("reused-initialize", message.id === undefined ? "notification" : `${typeof message.id}:${String(message.id)}`);
        return;
      }
      if (message.method === "initialized") appInitialized = true;
      if (message.method === "thread/resume" && message.params?.threadId) activeCodexThreadId = message.params.threadId;
      if (message.method === "turn/start") {
        if (scope.resume && activeCodexThreadId && message.params?.threadId !== activeCodexThreadId) {
          if (message.id !== undefined) proxy.send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Follow-up turn targets a different Codex thread than the resumed session." } }, socket);
          return;
        }
        try {
          beginTurn(message);
        } catch (error) {
          appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "TURN_FAILED", payload: { sessionId, requestId: message.id ?? null, error: error.message }, createdAt: new Date().toISOString() });
          if (message.id !== undefined) proxy.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Blackbox before-checkpoint failed: ${error.message}` } }, socket);
          return;
        }
      }
      if (message.method === "thread/resume" && !scope.all && message.params?.threadId) {
        const belongs = threadBelongsToRepository(blackboxRoot, message.params.threadId, metadata.id);
        if (belongs === false) {
          proxy.send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Codex session belongs to a different repository; use --all to override." } }, socket);
          return;
        }
        if (belongs === null && args.some((arg) => arg === message.params.threadId)) {
          proxy.send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Codex session is not associated with the current repository; use --all to override." } }, socket);
          return;
        }
      }
      const forwarded = scopedThreadList(message, invocationCwd, !scope.resume || scope.all);
      const accepted = appInput.write(Buffer.from(`${forwarded === message ? text : JSON.stringify(forwarded)}\n`));
      debug("forward", message.method || "response", accepted ? "accepted" : "rejected", `stdinDestroyed=${Boolean(appServer.stdin?.destroyed)}`, `stdinWritable=${Boolean(appServer.stdin?.writable)}`);
      if (!accepted && message.id !== undefined) {
        proxy.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Blackbox App Server connection is closed; restart the resumed session." } }, socket);
      }
    },
    onError(error) {
      // A picker connection may fail while the TUI is reconnecting. Keep the
      // shared App Server and listener alive; the owning TUI exit performs
      // final cleanup.
      process.stderr.write(`Blackbox Codex proxy connection closed: ${error.message}\n`);
    },
  });
  const server = proxy.server;
  appServer.stdout.on("data", (chunk) => {
    try {
      for (const { value: message, raw } of appOutput.feedRecords(chunk)) {
      if (message.id === "initialize" || (message.id !== undefined && message.result?.capabilities)) initializeResponse = message;
      if (message.method === "turn/started") {
        const turn = [...turns.values()].at(-1);
        if (turn) turn.codexId = message.params?.turn?.id;
      }
      const threadId = message.result?.thread?.id || message.params?.thread?.id;
      if (threadId) {
        if (message.method === "thread/started" || message.result?.thread?.id) activeCodexThreadId = threadId;
        recordCodexThread(blackboxRoot, { repositoryId: metadata.id, sessionId, threadId, worktreeRoot: metadata.root, cwd: invocationCwd });
        appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "THREAD_STARTED", payload: { sessionId, threadId, cwd: invocationCwd } });
      }
      if (message.method === "item/completed" && message.params?.item?.type === "commandExecution") {
        const turn = currentTurn(message.params.item.turnId);
        if (turn) recordCommand(blackboxRoot, { turnId: turn.id, repositoryId: metadata.id, command: message.params.item.command || "", cwd: metadata.root, stdout: message.params.item.aggregatedOutput || "", stderr: "", exitCode: message.params.item.exitCode ?? null, sequence: (turn.commandSequence = (turn.commandSequence || 0) + 1) });
      }
      if (message.method === "item/commandExecution/outputDelta") appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "COMMAND_COMPLETED", payload: { turnId: currentTurn(message.params?.turnId)?.id, output: message.params?.delta || "" } });
      if (message.method === "turn/completed" || message.method === "turn/failed") {
        const terminalStatus = String(message.params?.turn?.status || "").toLowerCase();
        finishTurn(message.params?.turn?.id, message.method === "turn/failed" || ["failed", "interrupted", "cancelled"].includes(terminalStatus) ? "FAILED" : "COMPLETED");
      }
      if (message.method === "item/agentMessage/delta") appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "AGENT_MESSAGE", payload: { turnId: [...turns.values()].at(-1)?.id, text: message.params?.delta || "" } });
        proxy.sendRaw(raw);
      }
    } catch (error) {
      stop?.(error);
    }
  });
  const returnCode = await new Promise((resolve) => {
    let finished = false;
    stop = (error) => {
      if (finished) return;
      finished = true;
      process.stderr.write(`Blackbox interactive Codex unavailable: ${error.message}\n`);
      proxy.close();
      appServer.kill();
      try { require("node:fs").unlinkSync(socketPath); } catch {}
      appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "SESSION_ENDED", payload: { sessionId, error: error.message }, createdAt: new Date().toISOString() });
      resolve(1);
    };
    const fail = stop;
    appServer.once("error", fail);
    appServer.once("exit", (code, signal) => {
      debug("app-server-exit", `code=${code ?? "unknown"}`, `signal=${signal || "none"}`);
      if (!finished && code !== 0) fail(new Error(`Codex App Server exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
    });
    server.once("error", fail);
    server.listen(socketPath, () => {
      const cliArgs = args.filter((arg) => arg !== "--all");
      const cli = spawnProcess(executable, [...cliArgs, "--remote", `unix://${socketPath}`], { cwd: invocationCwd, stdio: "inherit" });
      cli.on("error", fail);
      cli.on("exit", (code) => { if (finished) return; finished = true; proxy.close(); appServer.kill(); try { require("node:fs").unlinkSync(socketPath); } catch {} appendAuditEvent(blackboxRoot, { repositoryId: metadata.id, eventType: "SESSION_ENDED", payload: { sessionId }, createdAt: new Date().toISOString() }); resolve(code ?? 1); });
    });
  });
  try { appOutput.end(); } catch (error) { process.stderr.write(`Blackbox interactive Codex protocol warning: ${error.message}\n`); }
  return returnCode;
}

module.exports = { JsonlDecoder, WebSocketDecoder, createSocketWriter, createWebSocketProxy, frame, recordCodexThread, resumeScope, scopedThreadList, threadBelongsToRepository, runInteractiveCodex };

if (require.main === module) runInteractiveCodex({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
