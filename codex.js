const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { getRepositoryMetadata, initRepository } = require("./index");
const { appendAuditEvent } = require("./storage");
const { recordSession } = require("./events");

const CODEX_EVENT_TYPES = Object.freeze({
  session_started: "SESSION_STARTED",
  session_ended: "SESSION_ENDED",
  prompt_submitted: "PROMPT_SUBMITTED",
  agent_message: "AGENT_MESSAGE",
  command_started: "COMMAND_STARTED",
  command_completed: "COMMAND_COMPLETED",
  turn_completed: "TURN_COMPLETED",
  turn_failed: "TURN_FAILED",
});

function normalizeCodexEvent(event) {
  const type = CODEX_EVENT_TYPES[String(event.type || "").toLowerCase()];
  return type ? { ...event, type } : null;
}

function recordSessionEnded(blackboxRoot, repositoryId, sessionId, createdAt = new Date().toISOString()) {
  return appendAuditEvent(blackboxRoot, { repositoryId, eventType: "SESSION_ENDED", payload: { type: "SESSION_ENDED", sessionId }, createdAt });
}

function runCodex({ args = [], cwd = process.cwd(), executable = "codex", spawn = spawnSync } = {}) {
  const metadata = getRepositoryMetadata(cwd);
  const blackboxRoot = initRepository(cwd);
  const sessionId = crypto.randomUUID();
  recordSession(blackboxRoot, { id: sessionId, repositoryId: metadata.id, agent: "codex" });
  const result = spawn(executable, args, { cwd, stdio: "inherit" });
  recordSessionEnded(blackboxRoot, metadata.id, sessionId);
  return result.status ?? 1;
}

module.exports = { normalizeCodexEvent, runCodex };
