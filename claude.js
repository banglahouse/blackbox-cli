const { runAgent } = require("./adapter");

const CLAUDE_EVENT_TYPES = Object.freeze({
  session_started: "SESSION_STARTED",
  session_ended: "SESSION_ENDED",
  prompt_submitted: "PROMPT_SUBMITTED",
  agent_message: "AGENT_MESSAGE",
  command_started: "COMMAND_STARTED",
  command_completed: "COMMAND_COMPLETED",
  turn_completed: "TURN_COMPLETED",
  turn_failed: "TURN_FAILED",
});

function normalizeClaudeEvent(event) {
  const type = CLAUDE_EVENT_TYPES[String(event.type || "").toLowerCase()];
  return type ? { ...event, type } : null;
}

function runClaude({ args = [], cwd = process.cwd(), executable = "claude", spawn, prompt } = {}) {
  return runAgent({ agent: "claude", args, cwd, executable, spawnProcess: spawn, prompt });
}

module.exports = { normalizeClaudeEvent, runClaude };
