const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const { getDatabasePath } = require("./storage");

function database(blackboxRoot) {
  return new DatabaseSync(getDatabasePath(blackboxRoot));
}

function log(blackboxRoot, repositoryId) {
  const db = database(blackboxRoot);
  try {
    return db.prepare("SELECT t.id, t.prompt, t.status, t.started_at, s.agent FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.repository_id = ? ORDER BY t.started_at, t.rowid").all(repositoryId);
  } finally {
    db.close();
  }
}

function show(blackboxRoot, turnId) {
  const db = database(blackboxRoot);
  try {
    const turn = db.prepare("SELECT t.*, s.agent, s.repository_id AS repositoryId FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?").get(turnId);
    if (!turn) throw new Error(`Turn not found: ${turnId}`);
    turn.commands = db.prepare("SELECT sequence, command, cwd, stdout, stderr, exit_code AS exitCode, started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs FROM commands WHERE turn_id = ? ORDER BY sequence").all(turnId);
    return turn;
  } finally {
    db.close();
  }
}

function diff(blackboxRoot, turnId) {
  const turn = show(blackboxRoot, turnId);
  const db = database(blackboxRoot);
  let checkpoints;
  try {
    checkpoints = db.prepare("SELECT id, snapshot_id AS snapshotId FROM checkpoints WHERE id IN (?, ?)").all(turn.before_checkpoint_id, turn.after_checkpoint_id);
  } finally {
    db.close();
  }
  const snapshots = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.snapshotId]));
  if (!snapshots.has(turn.before_checkpoint_id) || !snapshots.has(turn.after_checkpoint_id)) throw new Error(`Turn ${turnId} has incomplete checkpoints.`);
  const shadowRoot = path.join(blackboxRoot, "snapshots.git");
  const result = spawnSync("git", ["--git-dir", shadowRoot, "diff", "--no-ext-diff", snapshots.get(turn.before_checkpoint_id), snapshots.get(turn.after_checkpoint_id)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to calculate turn diff.");
  return result.stdout;
}

function fileHistory(blackboxRoot, repositoryId, filePath) {
  const db = database(blackboxRoot);
  try {
    return db.prepare("SELECT f.path, f.change_kind AS changeKind, f.before_payload_id AS beforePayloadId, f.after_payload_id AS afterPayloadId, f.turn_id AS turnId, t.prompt, s.agent, t.started_at AS startedAt FROM file_changes f JOIN turns t ON t.id = f.turn_id JOIN sessions s ON s.id = t.session_id WHERE s.repository_id = ? AND f.path = ? ORDER BY t.started_at, f.rowid").all(repositoryId, filePath);
  } finally {
    db.close();
  }
}

module.exports = { diff, fileHistory, log, show };
