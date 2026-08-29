const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const { getDatabasePath, verifyAuditChain } = require("./storage");

function verifyRepository(blackboxRoot, repositoryId) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) return { valid: false, reason: `foreign key violation in ${foreignKeys[0].table}` };
    const missingTurnCheckpoint = database.prepare("SELECT t.id FROM turns t JOIN sessions s ON s.id = t.session_id LEFT JOIN checkpoints b ON b.id = t.before_checkpoint_id LEFT JOIN checkpoints a ON a.id = t.after_checkpoint_id WHERE s.repository_id = ? AND (b.id IS NULL OR a.id IS NULL) LIMIT 1").get(repositoryId);
    if (missingTurnCheckpoint) return { valid: false, reason: `missing checkpoint reference in turn ${missingTurnCheckpoint.id}` };
    const checkpoints = database.prepare("SELECT id, snapshot_id AS snapshotId FROM checkpoints WHERE repository_id = ?").all(repositoryId);
    const shadowRoot = path.join(blackboxRoot, "snapshots.git");
    for (const checkpoint of checkpoints) {
      const object = spawnSync("git", ["--git-dir", shadowRoot, "cat-file", "-e", `${checkpoint.snapshotId}^{tree}`], { encoding: "utf8" });
      if (object.status !== 0) return { valid: false, reason: `missing snapshot ${checkpoint.snapshotId} for checkpoint ${checkpoint.id}` };
    }
    const audit = verifyAuditChain(blackboxRoot, repositoryId);
    if (!audit.valid) return { valid: false, reason: `broken audit chain at ${audit.eventId}` };
    return { valid: true };
  } finally {
    database.close();
  }
}

module.exports = { verifyRepository };
