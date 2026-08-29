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

## D-005: Repository metadata identity

- Decision: Store canonical repository root, resolved Git directory, and a SHA-256 ID derived from the canonical root in `repository.json`; write it only when absent.
- Rationale: The root path is stable across repeated initialization and avoids identity changes caused by temporary symlink paths.

## D-006: Autonomous runner commit ownership

- Decision: Codex edits and verifies tasks but never stages or commits; the parent Node runner independently verifies and commits them.
- Rationale: Codex's workspace-write sandbox may reject writes to `.git`, while the parent process can safely own Git state transitions.

## D-007: Local SQLite database

- Decision: Store the v1 relational store at `<git-dir>/blackbox/blackbox.sqlite` and create the core tables with Node's built-in `node:sqlite` API.
- Rationale: SQLite is local, transactional, and already available in the supported Node runtime; no dependency or external service is needed.
- Ceiling: Historical-row protection is enforced with SQLite triggers; richer constraints and migrations can be added when the recorder needs them.

## D-008: Audit event hashing

- Decision: Hash each audit event's canonical JSON envelope, including its ID, repository, type, payload, timestamp, and previous hash; append and verify events in SQLite row order.
- Rationale: The previous hash makes insertion, deletion, and mutation detectable while keeping the ledger local and dependency-free.

## D-009: Snapshot identity

- Decision: Store each snapshot as a Git tree in the bare shadow repository and use its tree hash as the content-addressed snapshot ID.
- Rationale: Git trees preserve paths, modes, and blob content without touching the developer's index, branch, or commits; identical states naturally reuse the same objects.
- Ceiling: File filtering is intentionally deferred to BBX-006; this task only excludes Git's private directory from captured paths.

## D-010: Snapshot filtering

- Decision: Use Git's `check-ignore --no-index` for `.gitignore`, and simple last-match-wins glob rules for `.blackboxignore` plus built-in sensitive patterns.
- Rationale: This reuses Git's established ignore behavior, supports local overrides, and keeps secret exclusions dependency-free before blobs are written.

## D-011: Observable event recording

- Decision: Record completed commands as immutable rows and use audit events for normalized session/turn lifecycle events; command execution uses Node's synchronous child-process API.
- Rationale: This captures the full result available at command completion without requiring a mutable in-progress history or agent-specific integration.

## D-012: Codex process boundary

- Decision: The Codex adapter launches the local `codex` executable with inherited stdio and forwards arguments unchanged; lifecycle events are recorded around the process.
- Rationale: Inherited stdio preserves the normal interactive CLI while avoiding credential interception or assumptions about vendor-private protocols.

## D-013: Claude process boundary

- Decision: The Claude adapter uses the same local executable boundary as Codex, with inherited stdio, unchanged arguments, and lifecycle events recorded in the shared ledger.
- Rationale: This keeps both initial adapters agent-neutral at the storage layer and preserves normal interactive use.

## D-014: Inspection data source

- Decision: `log`, `show`, and `file` query local SQLite; `diff` compares the turn's checkpoint tree IDs in the shadow Git repository.
- Rationale: Each command stays local, and turn-specific diffs remain independent of developer commits and working-tree state.

## D-015: Line provenance fallback

- Decision: Attribute every current line in a recorded changed file to its latest file-change turn; files without a mapping are labeled `MANUAL`.
- Rationale: This provides useful provenance from local checkpoint-era mappings without inventing line ownership when detailed diff attribution is unavailable.

## D-016: Restore confirmation

- Decision: Restore always creates a `PRE_RESTORE` checkpoint and returns a preview; the CLI changes files only with explicit `--yes` confirmation.
- Rationale: A non-interactive flag is testable and unambiguous while preserving the PRD's preview-first safety boundary.

## D-017: Verification behavior

- Decision: `blackbox verify` performs read-only SQLite relationship checks, audit-chain validation, and shadow-tree existence checks, returning exit code 0 only when all pass.
- Rationale: These checks cover the integrity boundaries already implemented without attempting repair or rewriting local history.

## D-018: Destructive maintenance

- Decision: Store only a salted scrypt password verifier, require it for `clear`, and require `--yes` after a preview; pruning removes only unreferenced payload rows.
- Rationale: This keeps destructive actions local and explicit while preserving historical metadata and avoiding plaintext credentials.
- Ceiling: Output pruning currently targets standalone payload rows; inline command output migration can be added when payload storage is wired into command capture.
