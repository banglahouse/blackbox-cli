const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { appendAuditEvent, getDatabasePath } = require("./storage");

function passwordPath(blackboxRoot) {
  return path.join(blackboxRoot, "password.json");
}

function setPassword(blackboxRoot, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  if (!fs.existsSync(passwordPath(blackboxRoot))) fs.writeFileSync(passwordPath(blackboxRoot), `${JSON.stringify({ salt, hash })}\n`);
}

function hasPassword(blackboxRoot, password) {
  if (!password || !fs.existsSync(passwordPath(blackboxRoot))) return false;
  const { salt, hash } = JSON.parse(fs.readFileSync(passwordPath(blackboxRoot), "utf8"));
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(password, salt, 32));
}

function storageSize(root) {
  return fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(root, entry.name);
    return total + (entry.isDirectory() ? storageSize(entryPath) : fs.statSync(entryPath).size);
  }, 0);
}

function size(blackboxRoot) {
  return storageSize(blackboxRoot);
}

function prunePayloads(blackboxRoot, repositoryId, { before, confirm = false } = {}) {
  const database = new DatabaseSync(getDatabasePath(blackboxRoot));
  try {
    const rows = database.prepare("SELECT id FROM payloads WHERE created_at < ? AND id NOT IN (SELECT before_payload_id FROM file_changes WHERE before_payload_id IS NOT NULL) AND id NOT IN (SELECT after_payload_id FROM file_changes WHERE after_payload_id IS NOT NULL)").all(before);
    const preview = `Prune payloads before ${before}\n\n${rows.length} payload(s) will be removed.\n`;
    if (!confirm) return { confirmed: false, preview, count: rows.length };
    database.exec("BEGIN");
    for (const row of rows) database.prepare("DELETE FROM payloads WHERE id = ?").run(row.id);
    database.exec("COMMIT");
    appendAuditEvent(blackboxRoot, { repositoryId, eventType: "PAYLOADS_PURGED", payload: { before, count: rows.length } });
    return { confirmed: true, preview, count: rows.length };
  } finally {
    database.close();
  }
}

function clearRepository(blackboxRoot, repositoryId, { password, confirm = false } = {}) {
  if (!hasPassword(blackboxRoot, password)) throw new Error("Invalid or unconfigured Blackbox password.");
  const preview = `Clear Blackbox history\n\nThis will permanently delete ${blackboxRoot}.\n`;
  if (!confirm) return { confirmed: false, preview };
  appendAuditEvent(blackboxRoot, { repositoryId, eventType: "HISTORY_CLEARED", payload: { reason: "user-confirmed clear" } });
  fs.rmSync(blackboxRoot, { recursive: true, force: true });
  return { confirmed: true, preview };
}

module.exports = { clearRepository, hasPassword, prunePayloads, setPassword, size };
