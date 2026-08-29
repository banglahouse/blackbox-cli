# Blackbox Decisions

## D-001: Blackbox state root

- Decision: Store all Blackbox runtime state under the repository Git directory returned by `git rev-parse --git-dir`, rooted at `<git-dir>/blackbox`.
- Rationale: This respects the PRD, avoids polluting the source tree, and works with normal repositories and git worktrees.

## D-002: Initial implementation style

- Decision: Use the existing CommonJS module convention and only Node.js standard library code for the first task.
- Rationale: The repo already declares `"type": "commonjs"`, and no external dependency is required for CLI bootstrap or Git directory discovery.

## D-003: `blackbox init` staging

- Decision: In BBX-001, `blackbox init` only validates the Git repository and scaffolds the Blackbox directory layout.
- Rationale: SQLite, audit hashing, snapshot storage, and baseline checkpoints are separate tasks with their own verification.
- Ceiling: This is intentionally incomplete relative to the final PRD `init` behavior and will be expanded by later tasks.

## D-004: CLI exit behavior

- Decision: `blackbox` with no subcommand prints usage and exits successfully; unknown subcommands print usage and fail.
- Rationale: This is the smallest predictable interface for the bootstrap CLI and keeps later command additions straightforward.
