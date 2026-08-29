# Blackbox Implementation Plan

Task status values:

- `PENDING`
- `IN_PROGRESS`
- `COMPLETE`
- `BLOCKED`

## BBX-001
- Status: `COMPLETE`
- Scope: Add a runnable CommonJS CLI entrypoint, wire `blackbox` into `package.json`, parse the initial command surface, validate that the current directory is inside a Git repository, and implement `blackbox init` as the first local Blackbox scaffold.
- Dependencies: none
- Acceptance criteria:
  - `blackbox` is executable from the repo.
  - `blackbox init` refuses to run outside a Git repository.
  - `blackbox init` creates the Blackbox storage root under the repository Git directory.
  - The first scaffold is idempotent and does not modify unrelated tracked files.

## BBX-002
- Status: `COMPLETE`
- Scope: Add repository metadata persistence and path helpers for the local Blackbox root, including stable discovery of the Git dir and repository identity.
- Dependencies: `BBX-001`
- Acceptance criteria:
  - Blackbox can resolve and reuse the repository Git dir consistently.
  - Repository metadata is stored under the Blackbox root.
  - Re-running init preserves existing metadata without corruption.

## BBX-003
- Status: `COMPLETE`
- Scope: Initialize SQLite storage and the first immutable tables for repositories, sessions, turns, checkpoints, commands, payloads, file changes, and audit events.
- Dependencies: `BBX-002`
- Acceptance criteria:
  - SQLite database file exists under `.git/blackbox/`.
  - Schema creation is idempotent.
  - Core tables exist with append-only semantics for historical records.

## BBX-004
- Status: `COMPLETE`
- Scope: Add the append-only audit ledger and SHA-256 hash-chain helpers.
- Dependencies: `BBX-003`
- Acceptance criteria:
  - New events append without updating historical rows.
  - Event hashes chain from the previous hash.
  - Verification can detect a broken chain.

## BBX-005
- Status: `COMPLETE`
- Scope: Add the shadow Git snapshot store and exact before/after checkpoint capture.
- Dependencies: `BBX-003`, `BBX-004`
- Acceptance criteria:
  - Snapshot storage lives under the Blackbox root and does not modify developer Git state.
  - Checkpoints capture exact repository state for later diffing and restore.
  - Snapshot creation is content-addressed and repeatable.

## BBX-006
- Status: `COMPLETE`
- Scope: Add file filtering for `.gitignore`, `.blackboxignore`, and built-in sensitive exclusions.
- Dependencies: `BBX-005`
- Acceptance criteria:
  - Ignored files do not enter snapshot storage.
  - Built-in sensitive patterns are excluded by default.
  - User ignore rules are respected.

## BBX-007
- Status: `COMPLETE`
- Scope: Add the normalized turn/session/command event model and local capture of command execution.
- Dependencies: `BBX-004`, `BBX-005`, `BBX-006`
- Acceptance criteria:
  - Turns record prompts, commands, outputs, and timings.
  - Session and turn IDs are unified across agents.
  - Captured command output is linked to the correct turn.

## BBX-008
- Status: `PENDING`
- Scope: Add the Codex adapter and translate observable Codex events into normalized Blackbox events.
- Dependencies: `BBX-007`
- Acceptance criteria:
  - `blackbox codex` forwards CLI args transparently.
  - Codex session lifecycle events are recorded.
  - Command and message events normalize into Blackbox events.

## BBX-009
- Status: `PENDING`
- Scope: Add the Claude adapter and translate observable Claude events into normalized Blackbox events.
- Dependencies: `BBX-007`
- Acceptance criteria:
  - `blackbox claude` forwards CLI args transparently.
  - Claude session lifecycle events are recorded.
  - Command and message events normalize into Blackbox events.

## BBX-010
- Status: `PENDING`
- Scope: Add `blackbox log`, `blackbox show`, `blackbox diff`, and `blackbox file`.
- Dependencies: `BBX-005`, `BBX-007`, `BBX-008`, `BBX-009`
- Acceptance criteria:
  - Each command reads only local Blackbox data.
  - `diff` is turn-specific, not Git-commit-specific.
  - `file` shows the history of events affecting one path.

## BBX-011
- Status: `PENDING`
- Scope: Add `blackbox blame` and `blackbox why` for line-level provenance.
- Dependencies: `BBX-010`
- Acceptance criteria:
  - `blame` maps current lines to Blackbox turns or manual checkpoints.
  - `why` shows prompt, agent, branch, timestamp, commands, and previous checkpoint.
  - Provenance is derived from checkpoint history, not Git commit history.

## BBX-012
- Status: `PENDING`
- Scope: Add preview-first restore with automatic pre-restore checkpointing and confirmation.
- Dependencies: `BBX-005`, `BBX-007`, `BBX-010`
- Acceptance criteria:
  - Restore shows affected files before changing anything.
  - Restore creates a PRE_RESTORE checkpoint first.
  - Restore requires explicit confirmation.

## BBX-013
- Status: `PENDING`
- Scope: Add `blackbox verify` for audit-chain and relationship integrity checks.
- Dependencies: `BBX-004`, `BBX-005`, `BBX-007`
- Acceptance criteria:
  - Verification reports `VALID` when chain and references are intact.
  - Verification reports a concrete failure when integrity breaks.

## BBX-014
- Status: `PENDING`
- Scope: Add `blackbox size`, pruning, and password-protected `blackbox clear`.
- Dependencies: `BBX-003`, `BBX-004`, `BBX-007`, `BBX-013`
- Acceptance criteria:
  - Size reporting is local and accurate enough for repository storage.
  - Pruning is explicit, previewed, and auditable.
  - `clear` requires password authorization and leaves no silent bypass.
