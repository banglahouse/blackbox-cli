import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TASKS = 30;
const repoRoot = process.cwd();
const prdPath = path.join(repoRoot, "docs", "PRD.md");

export const INITIAL_PROMPT = `
You are the autonomous implementation agent for Blackbox.

Read completely:
- docs/PRD.md
- AGENTS.md
- package.json
- the entire current repository

The user has explicitly authorized unattended implementation inside this repository.

Your objective is to complete Blackbox v1 through small, dependency-ordered,
individually verified tasks.

First-run responsibilities:

1. Create docs/IMPLEMENTATION_PLAN.md.
2. Convert the PRD into small tasks with stable IDs such as BBX-001.
3. Give every task scope, dependencies, acceptance criteria, and status:
   PENDING, IN_PROGRESS, COMPLETE, or BLOCKED.
4. Choose conservative v1 defaults and record them in docs/DECISIONS.md.
5. Implement only the first eligible task.
6. Run its tests, lint, type-check, relevant CLI smoke tests, and review git diff.
7. Update docs/IMPLEMENTATION_PLAN.md and docs/DECISIONS.md as needed.
8. Mark the task COMPLETE only if every acceptance criterion passes.

The parent Node runner owns Git staging and commits. Do not run git add, git commit, or any command that writes inside .git. Failure to write .git is expected inside the Codex sandbox and must not be treated as a blocker.

After successful implementation and verification, return exactly:

AUTORUN_STATUS: READY_TO_COMMIT
TASK: <BBX task ID and description>
TESTS: <summary>
NEXT_TASK: <next task>
BLOCKER: none

You may create and edit files inside this repository, add needed dependencies,
and run local verification commands. Do not push, publish, access credentials,
modify remotes, use destructive Git commands, or overwrite unrelated changes.
Never capture hidden chain-of-thought. Restore remains preview-first and
confirmation-protected. Keep implementation fully local.
`;

export const CONTINUATION_PROMPT = `
Continue autonomous Blackbox implementation.

Read docs/PRD.md, docs/IMPLEMENTATION_PLAN.md, docs/DECISIONS.md, AGENTS.md,
package.json, and the current working tree.

Select exactly one smallest eligible PENDING task whose dependencies are COMPLETE.
Mark it IN_PROGRESS, inspect the relevant implementation, implement only its
scope, add or update tests, run tests/lint/type-check/smoke tests, review the
complete diff, verify every acceptance criterion, and mark it COMPLETE only
after verification passes. Keep docs/IMPLEMENTATION_PLAN.md and
docs/DECISIONS.md current.

The parent Node runner owns Git staging and commits. Do not run git add, git commit, or any command that writes inside .git. Failure to write .git is expected inside the Codex sandbox and must not be treated as a blocker.

After successful implementation and verification, return exactly:

AUTORUN_STATUS: READY_TO_COMMIT
TASK: <BBX task ID and description>
TESTS: <summary>
NEXT_TASK: <next task>
BLOCKER: none

Use BLOCKED only for a genuine implementation blocker. Do not push, publish,
access credentials, modify remotes, use destructive Git commands, or modify
unrelated user work. Work on one task only.
`;

export function parseResponse(response) {
  const match = response.match(/^AUTORUN_STATUS:\s*(READY_TO_COMMIT|COMPLETE|BLOCKED)\s*$/m);
  if (!match) throw new Error("Protocol error: missing or invalid AUTORUN_STATUS");
  const status = match[1];
  const task = response.match(/^TASK:\s*(BBX-\d+)\b[^\n]*$/m);
  if ((status === "READY_TO_COMMIT" || status === "COMPLETE") && !task) {
    throw new Error("Protocol error: TASK must contain a valid BBX task ID");
  }
  return { status, taskId: task?.[1] };
}

function run(command, args, cwd, runner = execFileSync) {
  return runner(command, args, { cwd, encoding: "utf8", stdio: "pipe" }).toString();
}

function ensureRunsIgnored(root) {
  const ignorePath = path.join(root, ".gitignore");
  const current = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  if (!current.split(/\r?\n/).some((line) => line.trim() === ".codex-runs/")) {
    fs.appendFileSync(ignorePath, `${current && !current.endsWith("\n") ? "\n" : ""}.codex-runs/\n`);
  }
}

export function verifyAndCommit({ status, taskId, repoRoot: root = repoRoot, runner = execFileSync } = {}) {
  if (!taskId || !/^BBX-\d+$/.test(taskId)) {
    throw new Error("Protocol error: TASK must contain a valid BBX task ID");
  }

  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
  ensureRunsIgnored(root);
  run("npm", ["test"], root, runner);
  if (scripts.lint) run("npm", ["run", "lint"], root, runner);
  if (scripts.typecheck) run("npm", ["run", "typecheck"], root, runner);
  run("git", ["diff", "--check"], root, runner);

  const porcelain = run("git", ["status", "--porcelain"], root, runner).trim();
  if (!porcelain) {
    console.log("Verification passed; no changes to commit.");
    if (status === "READY_TO_COMMIT") {
      throw new Error("Protocol error: READY_TO_COMMIT reported with no changes");
    }
    return false;
  }

  run("git", ["add", "-A"], root, runner);
  run("git", ["commit", "-m", `${taskId}: complete verified implementation task`], root, runner);
  return true;
}

async function main() {
  if (!fs.existsSync(prdPath)) throw new Error(`PRD not found: ${prdPath}`);

  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: repoRoot,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });

  let result = await thread.run(INITIAL_PROMPT);
  for (let iteration = 1; iteration <= MAX_TASKS; iteration += 1) {
    console.log(`\n========== TASK RUN ${iteration} ==========\n`);
    console.log(result.finalResponse);
    const parsed = parseResponse(result.finalResponse ?? "");
    if (parsed.status === "BLOCKED") {
      console.error("\nCodex encountered a genuine implementation blocker.");
      process.exitCode = 2;
      return;
    }
    verifyAndCommit(parsed);
    if (parsed.status === "COMPLETE") {
      console.log("\nBlackbox v1 implementation completed.");
      return;
    }
    result = await thread.run(CONTINUATION_PROMPT);
  }
  throw new Error(`Stopped after the safety limit of ${MAX_TASKS} tasks.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
