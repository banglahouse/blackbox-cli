const { runAgent } = require("./adapter");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function runCodex({ args = [], cwd = process.cwd(), executable = "codex", spawn, prompt } = {}) {
  if (!args.includes("exec") && !args.includes("--version") && !spawn && executable === "codex") {
    const result = spawnSync(process.execPath, [path.join(__dirname, "codex-app-server.js"), ...args], { cwd, stdio: "inherit" });
    return result.status ?? 1;
  }
  return runAgent({ agent: "codex", args, cwd, executable, spawnProcess: spawn, prompt });
}

module.exports = { normalizeCodexEvent, runCodex };
