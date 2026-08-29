const path = require("node:path");
const crypto = require("node:crypto");
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
  sequence INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER
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
  const columns = database.prepare("PRAGMA table_info(commands)").all().map((column) => column.name);
  for (const [name, definition] of [["sequence", "INTEGER NOT NULL DEFAULT 0"], ["cwd", "TEXT NOT NULL DEFAULT ''"], ["duration_ms", "INTEGER"]]) {
    if (!columns.includes(name)) database.exec(`ALTER TABLE commands ADD COLUMN ${name} ${definition}`);
  }
  database.close();
  return getDatabasePath(blackboxRoot);
}

function ensureRepository(blackboxRoot, { id, root, gitDir }) {
  const database = openDatabase(blackboxRoot);
  try {
    database.prepare("INSERT OR IGNORE INTO repositories (id, root, git_dir) VALUES (?, ?, ?)").run(id, root, gitDir);
  } finally {
    database.close();
  }
}

function openDatabase(blackboxRoot) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function serializePayload(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function hashEvent(event) {
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function appendAuditEvent(blackboxRoot, { id = crypto.randomUUID(), repositoryId, eventType, payload, createdAt = new Date().toISOString() }) {
  const database = openDatabase(blackboxRoot);
  const eventPayload = serializePayload(payload);
  database.exec("BEGIN IMMEDIATE");
  try {
    const previousHash = database.prepare("SELECT event_hash FROM audit_events WHERE repository_id = ? ORDER BY rowid DESC LIMIT 1").get(repositoryId)?.event_hash ?? null;
    const eventHash = hashEvent({ id, repositoryId, eventType, payload: eventPayload, createdAt, previousHash });
    database.prepare("INSERT INTO audit_events (id, repository_id, event_type, payload, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, repositoryId, eventType, eventPayload, previousHash, eventHash, createdAt);
    database.exec("COMMIT");
    return { id, eventHash, previousHash };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function verifyAuditChain(blackboxRoot, repositoryId) {
  const database = openDatabase(blackboxRoot);
  try {
    const events = database.prepare("SELECT id, repository_id AS repositoryId, event_type AS eventType, payload, previous_hash AS previousHash, event_hash AS eventHash, created_at AS createdAt FROM audit_events WHERE repository_id = ? ORDER BY rowid").all(repositoryId);
    let previousHash = null;
    for (const event of events) {
      if (event.previousHash !== previousHash || event.eventHash !== hashEvent({
        id: event.id,
        repositoryId: event.repositoryId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt,
        previousHash,
      })) return { valid: false, eventId: event.id };
      previousHash = event.eventHash;
    }
    return { valid: true, events: events.length };
  } finally {
    database.close();
  }
}

module.exports = { appendAuditEvent, ensureRepository, getDatabasePath, initializeDatabase, schema, verifyAuditChain };
