# Blackbox development instructions

## Source of truth

- Read `docs/PRD.md` before planning or implementing product behavior.
- The PRD is the product-level source of truth.
- Existing repository architecture and tests are the implementation-level source of truth.
- Ask before making a decision that materially conflicts with the PRD.

## Working method

- Implement exactly one small task per run.
- Inspect existing code before changing it.
- Keep changes narrowly scoped.
- Do not redesign unrelated code.
- Do not implement later milestones early.
- Do not perform destructive Git operations.
- Do not commit unless explicitly instructed.

## Completion requirements

Before declaring a task complete:

1. Run relevant tests.
2. Run type-checking and linting when configured.
3. Review the final diff.
4. Confirm every acceptance criterion.
5. Report:
   - files changed
   - behavior implemented
   - commands run
   - test results
   - remaining limitations

## Product constraints

- Blackbox v1 is fully local.
- It only operates inside Git repositories.
- It must not capture hidden chain-of-thought.
- Restore operations require a preview and confirmation.
- Preserve user files and unrelated working-tree changes.
- Never use destructive Git commands such as `git reset --hard`.