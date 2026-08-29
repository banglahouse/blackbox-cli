import { Codex } from "@openai/codex-sdk";
import fs from "node:fs";
import path from "node:path";

const MAX_TASKS = 30;
const repoRoot = process.cwd();
const prdPath = path.join(repoRoot, "docs", "PRD.md");

if (!fs.existsSync(prdPath)) {
  throw new Error(`PRD not found: ${prdPath}`);
}

const codex = new Codex();

const thread = codex.startThread({
  workingDirectory: repoRoot,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
});

const initialPrompt = `
You are the autonomous implementation agent for Blackbox.

Read completely:
- docs/PRD.md
- AGENTS.md
- package.json
- the entire current repository

The user has explicitly authorized unattended implementation inside this
repository.

Your objective is to complete Blackbox v1 through small, dependency-ordered,
individually verified tasks.

First-run responsibilities:

1. Create docs/IMPLEMENTATION_PLAN.md.
2. Convert the PRD into small tasks with stable IDs such as BBX-001.
3. Give every task:
   - scope
   - dependencies
   - acceptance criteria
   - status: PENDING, IN_PROGRESS, COMPLETE, or BLOCKED
4. Choose conservative v1 defaults for non-critical ambiguities.
5. Record those defaults in docs/DECISIONS.md.
6. Implement only the first eligible task.
7. Run its tests, lint, type-check, and relevant CLI smoke tests.
8. Review git diff.
9. Mark the task COMPLETE only if every acceptance criterion passes.
10. Create a Git commit for the completed task.

Autonomous authority:

- You may create and edit files inside this repository.
- You may add well-maintained dependencies required by the PRD.
- You may run build, test, lint, Git inspection, and local CLI commands.
- You may create one commit for each verified task.
- Do not push commits.
- Do not access credentials.
- Do not publish packages.
- Do not modify Git remotes.
- Do not use destructive Git commands.
- Do not delete or overwrite unrelated user changes.
- Do not claim a task is complete when tests fail.

Architecture defaults:

- Node.js CLI.
- Prefer the package's existing module convention unless changing it is
  necessary and documented.
- Store Blackbox runtime state under the repository Git directory.
- Use SQLite only when the relevant storage task is reached.
- Prefer structured agent events when available.
- Never capture hidden chain-of-thought.
- Restore must remain preview-first and confirmation-protected.
- Keep all implementation fully local.

If a requirement is unclear:

- Choose the smallest reversible option consistent with the PRD.
- Record it in docs/DECISIONS.md.
- Continue unless the choice risks data loss, credentials, external
  publication, or an irreversible architectural commitment.

At the end output exactly one status marker:

AUTORUN_STATUS: CONTINUE
AUTORUN_STATUS: COMPLETE
AUTORUN_STATUS: BLOCKED

Also include:
TASK:
COMMIT:
TESTS:
NEXT_TASK:
BLOCKER:
`;

let result = await thread.run(initialPrompt);
console.log(result.finalResponse);

for (let iteration = 1; iteration < MAX_TASKS; iteration += 1) {
  const response = result.finalResponse ?? "";

  if (response.includes("AUTORUN_STATUS: COMPLETE")) {
    console.log("\nBlackbox v1 implementation completed.");
    process.exit(0);
  }

  if (response.includes("AUTORUN_STATUS: BLOCKED")) {
    console.error("\nCodex encountered a blocker. Check the report above.");
    process.exit(2);
  }

  if (!response.includes("AUTORUN_STATUS: CONTINUE")) {
    console.error("\nCodex returned an invalid status marker.");
    process.exit(3);
  }

  result = await thread.run(`
Continue autonomous Blackbox implementation.

Read:
- docs/PRD.md
- docs/IMPLEMENTATION_PLAN.md
- docs/DECISIONS.md
- AGENTS.md
- current Git status and recent commits

Select exactly one smallest eligible PENDING task whose dependencies are
COMPLETE.

For that one task:

1. Mark it IN_PROGRESS.
2. Inspect the relevant implementation.
3. Implement only its defined scope.
4. Add or update tests.
5. Run relevant tests, lint, type-check, and CLI smoke tests.
6. Review the complete diff.
7. Fix any failures caused by the task.
8. Verify every acceptance criterion.
9. Mark it COMPLETE only after verification passes.
10. Commit the verified task using:
    <task-id>: <concise description>

If the implementation plan is missing a PRD requirement, add a suitably small
task without silently expanding the current task.

Do not push.
Do not publish.
Do not access credentials.
Do not use destructive Git operations.
Do not modify unrelated user work.
Do not work on multiple implementation tasks in this turn.

At the end output exactly one status marker:

AUTORUN_STATUS: CONTINUE
AUTORUN_STATUS: COMPLETE
AUTORUN_STATUS: BLOCKED

Use COMPLETE only when all PRD v1 tasks are implemented and the complete
repository verification suite passes.

Also include:
TASK:
COMMIT:
TESTS:
NEXT_TASK:
BLOCKER:
`);

  console.log(`\n========== TASK RUN ${iteration + 1} ==========\n`);
  console.log(result.finalResponse);
}

console.error(`Stopped after the safety limit of ${MAX_TASKS} tasks.`);
process.exit(4);