const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const runnerPath = path.resolve(__dirname, "..", "scripts", "codex-runner.mjs");

async function loadRunner() {
  return import(runnerPath);
}

function fakeRunner({ changed = " M file.js", failOn } = {}) {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    if (failOn === command) throw new Error(`${command} failed`);
    if (command === "git" && args[0] === "status") return changed;
    return "";
  };
  return { calls, runner };
}

function tempPackage(scripts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-runner-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }));
  return root;
}

test("accepts a valid READY_TO_COMMIT response", async () => {
  const { parseResponse } = await loadRunner();
  assert.deepEqual(parseResponse("AUTORUN_STATUS: READY_TO_COMMIT\nTASK: BBX-12: add storage\n"), {
    status: "READY_TO_COMMIT",
    taskId: "BBX-12",
  });
});

test("rejects missing or invalid task IDs and statuses", async () => {
  const { parseResponse } = await loadRunner();
  assert.throws(() => parseResponse("AUTORUN_STATUS: READY_TO_COMMIT\nTASK: storage"), /valid BBX task ID/);
  assert.throws(() => parseResponse("TASK: BBX-1"), /missing or invalid AUTORUN_STATUS/);
});

test("verification failure prevents staging and committing", async () => {
  const { verifyAndCommit } = await loadRunner();
  const { calls, runner } = fakeRunner({ failOn: "npm" });
  assert.throws(() => verifyAndCommit({ status: "READY_TO_COMMIT", taskId: "BBX-1", repoRoot: tempPackage(), runner }), /npm failed/);
  assert.equal(calls.some(([, args]) => args[0] === "add" || args[0] === "commit"), false);
});

test("runs lint and typecheck only when configured", async () => {
  const { verifyAndCommit } = await loadRunner();
  const configured = fakeRunner();
  verifyAndCommit({ status: "COMPLETE", taskId: "BBX-1", repoRoot: tempPackage({ lint: "x", typecheck: "y" }), runner: configured.runner });
  assert.deepEqual(configured.calls.filter(([command]) => command === "npm").map(([, args]) => args), [["test"], ["run", "lint"], ["run", "typecheck"]]);

  const defaulted = fakeRunner();
  verifyAndCommit({ status: "COMPLETE", taskId: "BBX-1", repoRoot: tempPackage(), runner: defaulted.runner });
  assert.deepEqual(defaulted.calls.filter(([command]) => command === "npm").map(([, args]) => args), [["test"]]);
});

test("empty working tree does not create a commit", async () => {
  const { verifyAndCommit } = await loadRunner();
  const { calls, runner } = fakeRunner({ changed: "" });
  assert.equal(verifyAndCommit({ status: "COMPLETE", taskId: "BBX-1", repoRoot: tempPackage(), runner }), false);
  assert.equal(calls.some(([, args]) => args[0] === "commit"), false);
});

test("verification preserves existing gitignore entries and excludes Codex runs", async () => {
  const { verifyAndCommit } = await loadRunner();
  const root = tempPackage();
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  verifyAndCommit({ status: "COMPLETE", taskId: "BBX-1", repoRoot: root, runner: fakeRunner({ changed: "" }).runner });
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "dist/\n.codex-runs/\n");
});

test("successful verification stages and creates exactly one commit", async () => {
  const { verifyAndCommit } = await loadRunner();
  const { calls, runner } = fakeRunner();
  assert.equal(verifyAndCommit({ status: "READY_TO_COMMIT", taskId: "BBX-42", repoRoot: tempPackage(), runner }), true);
  assert.deepEqual(calls.filter(([command]) => command === "git").map(([, args]) => args.slice(0, 2)), [["diff", "--check"], ["status", "--porcelain"], ["add", "-A"], ["commit", "-m"]]);
  assert.equal(calls.filter(([command], index) => command === "git" && calls[index][1][0] === "commit").length, 1);
});

test("the protocol documents that Codex does not commit or write .git", async () => {
  const { INITIAL_PROMPT, CONTINUATION_PROMPT } = await loadRunner();
  for (const prompt of [INITIAL_PROMPT, CONTINUATION_PROMPT]) {
    assert.match(prompt, /parent Node runner owns Git staging and commits/);
    assert.match(prompt, /Do not run git add, git commit, or any command that writes inside \.git/);
    assert.match(prompt, /Failure to write \.git is expected/);
  }
});

test("genuine BLOCKED status remains a stop status", async () => {
  const { parseResponse } = await loadRunner();
  assert.equal(parseResponse("AUTORUN_STATUS: BLOCKED\nBLOCKER: missing API\n").status, "BLOCKED");
});
