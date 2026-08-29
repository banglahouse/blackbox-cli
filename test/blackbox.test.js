const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { appendAuditEvent, verifyAuditChain } = require("../storage");
const { captureSnapshot, createCheckpoint } = require("../snapshot");
const { captureCommand, normalizeEvent, recordSession, recordTurn } = require("../events");
const { normalizeCodexEvent, runCodex } = require("../codex");
const { normalizeClaudeEvent, runClaude } = require("../claude");
const { restoreTurn } = require("../restore");

const cliPath = path.resolve(__dirname, "..", "index.js");

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-"));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("init fails outside a git repository", () => {
  const dir = mkTempDir();
  const result = runCli(["init"], dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Blackbox requires a Git repository\./);
});

test("init scaffolds the blackbox root inside git", () => {
  const dir = mkTempDir();
  const gitInit = spawnSync("git", ["init"], {
    cwd: dir,
    encoding: "utf8",
  });

  assert.equal(gitInit.status, 0, gitInit.stderr);

  const result = runCli(["init"], dir);
  assert.equal(result.status, 0, result.stderr);

  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  const blackboxRoot = path.resolve(dir, gitDir, "blackbox");

  assert.ok(fs.existsSync(blackboxRoot));
  assert.ok(fs.existsSync(path.join(blackboxRoot, "runtime")));
  assert.ok(fs.existsSync(path.join(blackboxRoot, "locks")));
  assert.ok(fs.existsSync(path.join(blackboxRoot, "snapshots.git")));
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["audit_events", "checkpoints", "commands", "file_changes", "payloads", "repositories", "sessions", "turns"]);
  database.close();
  const metadataPath = path.join(blackboxRoot, "repository.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.root, fs.realpathSync(dir));
  assert.equal(metadata.gitDir, fs.realpathSync(path.resolve(dir, gitDir)));
  assert.match(metadata.id, /^[a-f0-9]{64}$/);

  const before = fs.readFileSync(metadataPath, "utf8");
  const second = runCli(["init"], dir);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(metadataPath, "utf8"), before);
});

test("database schema creation is idempotent and historical rows are append-only", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const first = runCli(["init"], dir);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(["init"], dir);
  assert.equal(second.status, 0, second.stderr);

  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const database = new DatabaseSync(path.resolve(dir, gitDir, "blackbox", "blackbox.sqlite"));
  database.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  assert.throws(() => database.exec("UPDATE repositories SET root = 'changed' WHERE id = 'r'"), /append-only/);
  assert.throws(() => database.exec("DELETE FROM repositories WHERE id = 'r'"), /append-only/);
  database.close();
});

test("audit events form a verifiable hash chain", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const blackboxRoot = path.resolve(dir, gitDir, "blackbox");
  const setup = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  setup.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  setup.close();

  const first = appendAuditEvent(blackboxRoot, { id: "e1", repositoryId: "r", eventType: "SESSION_STARTED", payload: { agent: "codex" }, createdAt: "2026-01-01T00:00:00.000Z" });
  const second = appendAuditEvent(blackboxRoot, { id: "e2", repositoryId: "r", eventType: "PROMPT_SUBMITTED", payload: "fix it", createdAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(first.previousHash, null);
  assert.equal(second.previousHash, first.eventHash);
  assert.deepEqual(verifyAuditChain(blackboxRoot, "r"), { valid: true, events: 2 });

  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.prepare("INSERT INTO audit_events (id, repository_id, event_type, payload, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("e3", "r", "TURN_COMPLETED", "{}", second.eventHash, "tampered", "2026-01-01T00:00:02.000Z");
  database.close();
  assert.deepEqual(verifyAuditChain(blackboxRoot, "r"), { valid: false, eventId: "e3" });
});

test("snapshots are repeatable and recorded without changing developer git state", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(dir, ".blackboxignore"), "private/\n!private/keep.txt\n");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "ignored\n");
  fs.writeFileSync(path.join(dir, ".env"), "secret\n");
  fs.writeFileSync(path.join(dir, "certificate.pem"), "secret\n");
  fs.mkdirSync(path.join(dir, "private"));
  fs.writeFileSync(path.join(dir, "private", "data.txt"), "private\n");
  fs.writeFileSync(path.join(dir, "private", "keep.txt"), "kept\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const beforeStatus = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
  const first = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  const second = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  assert.match(first, /^[a-f0-9]{40}$/);
  assert.equal(second, first);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, beforeStatus);
  const shadowTree = spawnSync("git", ["--git-dir", path.join(blackboxRoot, "snapshots.git"), "ls-tree", "-r", "--name-only", first], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(shadowTree.includes("file.txt"));
  assert.ok(shadowTree.includes("private/keep.txt"));
  assert.ok(!shadowTree.includes("ignored.txt"));
  assert.ok(!shadowTree.includes(".env"));
  assert.ok(!shadowTree.includes("certificate.pem"));
  assert.ok(!shadowTree.includes("private/data.txt"));

  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  database.close();
  const checkpoint = createCheckpoint({ repositoryRoot: dir, blackboxRoot, gitDir, repositoryId: "r", id: "cp-1", kind: "BEFORE" });
  assert.deepEqual(checkpoint, { id: "cp-1", snapshotId: first });
});

test("normalized turns and commands capture observable output", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  database.exec("INSERT INTO repositories (id, root, git_dir) VALUES ('r', 'root', 'git')");
  database.close();
  const sessionId = recordSession(blackboxRoot, { id: "s1", repositoryId: "r", agent: "codex" });
  const turnId = recordTurn(blackboxRoot, { id: "t1", sessionId, repositoryId: "r", prompt: "run a check" });
  const result = captureCommand(blackboxRoot, { turnId, repositoryId: "r", command: process.execPath, args: ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"], cwd: dir });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  const commandDatabase = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const command = commandDatabase.prepare("SELECT sequence, cwd, stdout, stderr, exit_code, duration_ms FROM commands WHERE id = ?").get(result.commandId);
  assert.equal(command.sequence, 1);
  assert.equal(command.cwd, dir);
  assert.equal(command.stdout, "ok");
  assert.equal(command.stderr, "warn");
  assert.equal(command.exit_code, 0);
  assert.ok(command.duration_ms >= 0);
  commandDatabase.close();
  assert.deepEqual(normalizeEvent("AGENT_MESSAGE", { text: "visible" }), { type: "AGENT_MESSAGE", text: "visible" });
});

test("Codex adapter forwards arguments and records lifecycle events", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const marker = path.join(dir, "args.txt");
  const result = runCodex({
    cwd: dir,
    executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join('|'))`, "--", "--model", "mini"],
  });
  assert.equal(result, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "--model|mini");
  assert.deepEqual(normalizeCodexEvent({ type: "agent_message", text: "visible" }), { type: "AGENT_MESSAGE", text: "visible" });
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const types = database.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((row) => row.event_type);
  assert.deepEqual(types, ["SESSION_STARTED", "SESSION_ENDED"]);
  database.close();
});

test("Claude adapter forwards arguments and records lifecycle events", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const marker = path.join(dir, "args.txt");
  const result = runClaude({
    cwd: dir,
    executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join('|'))`, "--", "--model", "sonnet"],
  });
  assert.equal(result, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "--model|sonnet");
  assert.deepEqual(normalizeClaudeEvent({ type: "agent_message", text: "visible" }), { type: "AGENT_MESSAGE", text: "visible" });
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const types = database.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((row) => row.event_type);
  assert.deepEqual(types, ["SESSION_STARTED", "SESSION_ENDED"]);
  database.close();
});

test("inspection commands read turns, file history, and checkpoint diffs", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const before = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  fs.writeFileSync(path.join(dir, "file.txt"), "after\n");
  const after = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES ('s1', '" + repo + "', 'codex', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO checkpoints (id, repository_id, kind, snapshot_id) VALUES ('cp-before', '" + repo + "', 'BEFORE', '" + before + "'), ('cp-after', '" + repo + "', 'AFTER', '" + after + "')");
  database.exec("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id, after_checkpoint_id) VALUES ('t1', 's1', 'change file', 'COMPLETED', '2026-01-01T00:00:01.000Z', 'cp-before', 'cp-after')");
  database.exec("INSERT INTO file_changes (id, turn_id, path, change_kind) VALUES ('fc1', 't1', 'file.txt', 'MODIFIED')");
  database.close();
  assert.match(runCli(["log"], dir).stdout, /change file/);
  assert.match(runCli(["show", "t1"], dir).stdout, /codex/);
  assert.match(runCli(["file", "file.txt"], dir).stdout, /MODIFIED/);
  assert.match(runCli(["diff", "t1"], dir).stdout, /-before/);
  assert.match(runCli(["diff", "t1"], dir).stdout, /\+after/);
});

test("blame and why use recorded file provenance", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "one\ntwo\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES ('s1', '" + repo + "', 'claude', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id) VALUES ('t1', 's1', 'add file', 'COMPLETED', '2026-01-01T00:00:01.000Z', 'cp-before')");
  database.exec("INSERT INTO file_changes (id, turn_id, path, change_kind) VALUES ('fc1', 't1', 'file.txt', 'CREATED')");
  database.close();
  const blame = runCli(["blame", "file.txt"], dir);
  assert.equal(blame.status, 0, blame.stderr);
  assert.match(blame.stdout, /t1/);
  const why = runCli(["why", "file.txt:2"], dir);
  assert.equal(why.status, 0, why.stderr);
  assert.match(why.stdout, /add file/);
  assert.match(why.stdout, /claude/);
  assert.match(why.stdout, /cp-before/);
});

test("restore previews first, checkpoints current state, and requires confirmation", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  fs.writeFileSync(path.join(dir, "file.txt"), "before\n");
  assert.equal(runCli(["init"], dir).status, 0);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const blackboxRoot = path.join(gitDir, "blackbox");
  const before = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  fs.writeFileSync(path.join(dir, "file.txt"), "after\n");
  const after = captureSnapshot({ repositoryRoot: dir, blackboxRoot, gitDir });
  const database = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.exec("INSERT INTO sessions (id, repository_id, agent, started_at) VALUES ('s1', '" + repo + "', 'codex', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO checkpoints (id, repository_id, kind, snapshot_id) VALUES ('cp-before', '" + repo + "', 'BEFORE', '" + before + "'), ('cp-after', '" + repo + "', 'AFTER', '" + after + "')");
  database.exec("INSERT INTO turns (id, session_id, prompt, status, started_at, before_checkpoint_id, after_checkpoint_id) VALUES ('t1', 's1', 'change file', 'COMPLETED', '2026-01-01T00:00:01.000Z', 'cp-before', 'cp-after')");
  database.close();
  const preview = restoreTurn({ repositoryRoot: dir, blackboxRoot, gitDir, turnId: "t1", side: "before" });
  assert.equal(preview.confirmed, false);
  assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "after\n");
  assert.match(preview.preview, /file.txt/);
  const restored = restoreTurn({ repositoryRoot: dir, blackboxRoot, gitDir, turnId: "t1", side: "before", confirm: true });
  assert.equal(restored.confirmed, true);
  assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "before\n");
  const kinds = new DatabaseSync(path.join(blackboxRoot, "blackbox.sqlite")).prepare("SELECT kind FROM checkpoints WHERE kind = 'PRE_RESTORE'").all();
  assert.equal(kinds.length, 2);
});

test("verify reports valid history and concrete integrity failures", () => {
  const dir = mkTempDir();
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(runCli(["init"], dir).status, 0);
  const valid = runCli(["verify"], dir);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /VALID/);
  const gitDir = fs.realpathSync(path.resolve(dir, spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim()));
  const database = new DatabaseSync(path.join(gitDir, "blackbox", "blackbox.sqlite"));
  const repo = database.prepare("SELECT id FROM repositories LIMIT 1").get().id;
  database.prepare("INSERT INTO audit_events (id, repository_id, event_type, payload, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?)").run("bad", repo, "PROMPT_SUBMITTED", "{}", null, "broken");
  database.close();
  const invalid = runCli(["verify"], dir);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /INVALID/);
  assert.match(invalid.stdout, /broken audit chain/);
});

test("help prints usage", () => {
  const result = runCli(["--help"], mkTempDir());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /blackbox <command>/);
});
