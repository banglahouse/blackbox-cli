const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getDatabasePath } = require("./storage");

function db(blackboxRoot) {
  return new DatabaseSync(getDatabasePath(blackboxRoot));
}

function currentLines(repositoryRoot, filePath) {
  const absolutePath = path.resolve(repositoryRoot, filePath);
  if (absolutePath !== repositoryRoot && !absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("File must be inside the repository.");
  const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function latestChange(blackboxRoot, repositoryId, filePath) {
  const database = db(blackboxRoot);
  try {
    return database.prepare("SELECT f.turn_id AS turnId, t.prompt, t.before_checkpoint_id AS previousCheckpoint, t.started_at AS changedAt, s.agent FROM file_changes f JOIN turns t ON t.id = f.turn_id JOIN sessions s ON s.id = t.session_id WHERE s.repository_id = ? AND f.path = ? ORDER BY t.started_at DESC, f.rowid DESC LIMIT 1").get(repositoryId, filePath);
  } finally {
    database.close();
  }
}

function blame(blackboxRoot, repositoryId, repositoryRoot, filePath) {
  const lines = currentLines(repositoryRoot, filePath);
  const change = latestChange(blackboxRoot, repositoryId, filePath);
  return lines.map((text, index) => ({ line: index + 1, text, turnId: change?.turnId ?? "MANUAL", agent: change?.agent ?? "user" }));
}

function why(blackboxRoot, repositoryId, filePath, line) {
  const change = latestChange(blackboxRoot, repositoryId, filePath);
  if (!change) return { filePath, line, turnId: "MANUAL", agent: "user", prompt: null, branch: "unknown", commands: [], previousCheckpoint: null };
  const database = db(blackboxRoot);
  try {
    const commands = database.prepare("SELECT command, stdout, stderr, exit_code AS exitCode FROM commands WHERE turn_id = ? ORDER BY sequence").all(change.turnId);
    return { filePath, line, turnId: change.turnId, agent: change.agent, prompt: change.prompt, branch: "current", changedAt: change.changedAt, commands, previousCheckpoint: change.previousCheckpoint };
  } finally {
    database.close();
  }
}

module.exports = { blame, why };
