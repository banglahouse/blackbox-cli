const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { appendAuditEvent, getDatabasePath } = require("./storage");
const fs = require("node:fs");

const EVENT_TYPES = Object.freeze([
  "SESSION_STARTED", "SESSION_ENDED", "PROMPT_SUBMITTED", "AGENT_MESSAGE",
  "COMMAND_STARTED", "COMMAND_COMPLETED", "TURN_COMPLETED", "TURN_FAILED",
]);

function normalizeEvent(type, data = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  return { type, ...data };
}

function openDatabase(blackboxRoot) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function recordSession(blackboxRoot, { id = crypto.randomUUID(), repositoryId, agent, startedAt = new Date().toISOString(), endedAt = null }) {
  const database = openDatabase(blackboxRoot);
  try {
    database.prepare("INSERT INTO sessions (id, repository_id, agent, started_at, ended_at) VALUES (?, ?, ?, ?, ?)").run(id, repositoryId, agent, startedAt, endedAt);
  } finally {
    database.close();
  }
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: "SESSION_STARTED", payload: normalizeEvent("SESSION_STARTED", { sessionId: id, agent }), createdAt: startedAt });
  if (endedAt) appendAuditEvent(blackboxRoot, { repositoryId, eventType: "SESSION_ENDED", payload: normalizeEvent("SESSION_ENDED", { sessionId: id }), createdAt: endedAt });
  return id;
}

function recordTurn(blackboxRoot, { id = crypto.randomUUID(), sessionId, repositoryId, prompt, status = "COMPLETED", startedAt = new Date().toISOString(), endedAt = startedAt, beforeCheckpointId = null, afterCheckpointId = null }) {
  const database = openDatabase(blackboxRoot);
  try {
    database.prepare("INSERT INTO turns (id, session_id, prompt, status, started_at, ended_at, before_checkpoint_id, after_checkpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, sessionId, prompt, status, startedAt, endedAt, beforeCheckpointId, afterCheckpointId);
  } finally {
    database.close();
  }
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: "PROMPT_SUBMITTED", payload: normalizeEvent("PROMPT_SUBMITTED", { turnId: id, sessionId: sessionId, prompt }), createdAt: startedAt });
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: status === "FAILED" ? "TURN_FAILED" : "TURN_COMPLETED", payload: normalizeEvent(status === "FAILED" ? "TURN_FAILED" : "TURN_COMPLETED", { turnId: id, status }), createdAt: endedAt });
  return id;
}

function updateTurn(blackboxRoot, { id, status, endedAt, afterCheckpointId }) {
  const database = openDatabase(blackboxRoot);
  try {
    database.prepare("UPDATE turns SET status = ?, ended_at = ?, after_checkpoint_id = ? WHERE id = ?").run(status, endedAt, afterCheckpointId, id);
  } finally {
    database.close();
  }
  return id;
}

function startTurn(blackboxRoot, { id = crypto.randomUUID(), sessionId, repositoryId, prompt, startedAt = new Date().toISOString(), beforeCheckpointId }) {
  const database = openDatabase(blackboxRoot);
  try { database.prepare("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id) VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)").run(id, sessionId, prompt, startedAt, beforeCheckpointId); }
  finally { database.close(); }
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: "PROMPT_SUBMITTED", payload: { type: "PROMPT_SUBMITTED", turnId: id, sessionId, prompt, captureLimitation: prompt.startsWith("(prompt unavailable:") ? "prompt was not supplied as a supported argument" : null }, createdAt: startedAt });
  return id;
}

function recordCommandFromFiles(blackboxRoot, { id = crypto.randomUUID(), turnId, repositoryId, command, cwd, stdoutPath, stderrPath, exitCode, signal = null, startedAt, endedAt, durationMs, sequence = 1 }) {
  const database = openDatabase(blackboxRoot);
  try {
    database.prepare("INSERT INTO commands (id, turn_id, command, sequence, cwd, stdout, stderr, exit_code, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)").run(id, turnId, command, sequence, cwd, exitCode, startedAt, endedAt, durationMs);
    const insert = database.prepare("INSERT INTO command_output_chunks (command_id, stream, sequence, content) VALUES (?, ?, ?, ?)");
    for (const [stream, filePath] of [["stdout", stdoutPath], ["stderr", stderrPath]]) {
      const size = fs.statSync(filePath).size;
      let sequenceNumber = 0;
      const descriptor = fs.openSync(filePath, "r");
      try {
        for (let offset = 0; offset < size; offset += 64 * 1024) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, size - offset));
          fs.readSync(descriptor, buffer, 0, buffer.length, offset);
          insert.run(id, stream, sequenceNumber++, buffer.toString("utf8"));
        }
      } finally { fs.closeSync(descriptor); }
    }
  } finally { database.close(); }
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: "COMMAND_COMPLETED", payload: { type: "COMMAND_COMPLETED", commandId: id, turnId, exitCode, signal }, createdAt: endedAt });
  return id;
}

function recordCommand(blackboxRoot, { id = crypto.randomUUID(), turnId, repositoryId, command, cwd, stdout = "", stderr = "", exitCode = null, startedAt = new Date().toISOString(), endedAt = startedAt, durationMs = 0, sequence }) {
  const database = openDatabase(blackboxRoot);
  try {
    if (sequence === undefined) sequence = (database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM commands WHERE turn_id = ?").get(turnId)).next;
    database.prepare("INSERT INTO commands (id, turn_id, command, sequence, cwd, stdout, stderr, exit_code, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, turnId, command, sequence, cwd, stdout, stderr, exitCode, startedAt, endedAt, durationMs);
  } finally {
    database.close();
  }
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: "COMMAND_COMPLETED", payload: normalizeEvent("COMMAND_COMPLETED", { commandId: id, turnId, command, exitCode, durationMs }), createdAt: endedAt });
  return id;
}

function captureCommand(blackboxRoot, { turnId, repositoryId, command, args = [], cwd = process.cwd(), id, sequence }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  const endedAt = new Date().toISOString();
  return {
    ...result,
    commandId: recordCommand(blackboxRoot, {
      id, sequence, turnId, repositoryId, command: [command, ...args].join(" "), cwd,
      stdout: result.stdout || "", stderr: result.stderr || "", exitCode: result.status,
      startedAt, endedAt, durationMs: Date.now() - started,
    }),
  };
}

module.exports = { EVENT_TYPES, captureCommand, normalizeEvent, recordCommand, recordCommandFromFiles, recordSession, recordTurn, startTurn, updateTurn };
