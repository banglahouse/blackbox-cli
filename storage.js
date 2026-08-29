const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  git_dir TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  agent TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  before_checkpoint_id TEXT,
  after_checkpoint_id TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  command TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS payloads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  path TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  before_payload_id TEXT REFERENCES payloads(id),
  after_payload_id TEXT REFERENCES payloads(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sessions_repository_id ON sessions(repository_id);
CREATE INDEX IF NOT EXISTS turns_session_id ON turns(session_id);
CREATE INDEX IF NOT EXISTS commands_turn_id ON commands(turn_id);
CREATE INDEX IF NOT EXISTS file_changes_turn_id ON file_changes(turn_id);

CREATE TRIGGER IF NOT EXISTS repositories_append_only_update
BEFORE UPDATE ON repositories BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS repositories_append_only_delete
BEFORE DELETE ON repositories BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS sessions_append_only_update
BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS sessions_append_only_delete
BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS turns_append_only_update
BEFORE UPDATE ON turns BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS turns_append_only_delete
BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS checkpoints_append_only_update
BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS checkpoints_append_only_delete
BEFORE DELETE ON checkpoints BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS commands_append_only_update
BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS commands_append_only_delete
BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS payloads_append_only_update
BEFORE UPDATE ON payloads BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS payloads_append_only_delete
BEFORE DELETE ON payloads BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS file_changes_append_only_update
BEFORE UPDATE ON file_changes BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS file_changes_append_only_delete
BEFORE DELETE ON file_changes BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'historical records are append-only'); END;
`;

function getDatabasePath(blackboxRoot) {
  return path.join(blackboxRoot, "blackbox.sqlite");
}

function initializeDatabase(blackboxRoot) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  database.exec(schema);
  database.close();
  return getDatabasePath(blackboxRoot);
}

module.exports = { getDatabasePath, initializeDatabase, schema };
