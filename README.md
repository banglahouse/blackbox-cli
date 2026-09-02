# Blackbox

Blackbox is a local CLI prototype for recording provenance around AI-assisted Git changes. It stores state under `.git/blackbox`

## Current v1 status

The verified implementation provides repository initialization, local SQLite storage, filtered shadow-Git snapshots, a SHA-256 audit ledger, inspection, preview-first restore, verification, maintenance, and wrapped-agent turn capture. A wrapped run records its prompt, agent, command output, BEFORE/AFTER checkpoints, changed files, and diff-based line provenance. Directly launching an agent bypasses Blackbox.

## Prerequisites and installation

- Node.js 24 or newer (`node:sqlite` is required)
- Git
- A Git repository
- Codex or Claude CLI for the corresponding adapter command

From this checkout:

```bash
npm link
blackbox --version
```

## Quick start

```bash
cd your-repository
blackbox init
blackbox codex
blackbox log
blackbox show <turn-id>
blackbox diff <turn-id>
blackbox why config.js:1
blackbox blame config.js
blackbox restore <turn-id> --before
blackbox verify
```

Install from this checkout with `npm link`, then run this sequence from a Git repository with an authenticated `codex` executable. In the interactive Codex session, submit prompts normally; each Codex turn becomes one Blackbox turn. Replace `<turn-id>` with the ID printed by `blackbox log`. Launching `codex` directly is not captured.

Initialization creates `.git/blackbox/` with `blackbox.sqlite`, `snapshots.git/`, `runtime/`, `locks/`, and `repository.json`. It does not modify Git HEAD, the index, branches, remotes, or source files. Re-running it is idempotent.

To configure the destructive-operation password during initialization:

```bash
blackbox init --password 'choose-a-password'
```

## Supported commands

```text
blackbox --help
blackbox --version
blackbox init [--password <password>]
blackbox status
blackbox codex [args...]
blackbox claude [args...]
blackbox log
blackbox show <turn>
blackbox diff <turn>
blackbox file <path>
blackbox blame <path>
blackbox why <path>:<line>
blackbox restore <turn> --before|--after [--yes]
blackbox verify
blackbox size
blackbox prune outputs --before <date> [--yes]
blackbox clear --password <password> [--yes]
```

`log`, `show`, `diff`, `file`, `blame`, and `why` read local SQLite/shadow-Git data. Targeted commands require their documented arguments; `why` requires `<file>:<line>`. `restore` without `--yes` is preview-only and exits non-zero; confirmation is required before file mutation.

Examples:

```bash
blackbox codex --version
blackbox claude --model opus
blackbox log
blackbox diff <turn-id>
blackbox blame src/service.py
blackbox why src/service.py:27
blackbox restore <turn-id> --before
blackbox restore <turn-id> --before --yes
blackbox prune outputs --before 2026-01-01 --yes
blackbox clear --password 'choose-a-password' --yes
```

## Agents and manual edits

`blackbox codex` connects the normal interactive Codex terminal UI to a local Codex app-server through a local Unix-WebSocket proxy. Codex thread maps to a Blackbox session and each Codex turn maps to a separate Blackbox turn. Structured user, visible agent, command, file-change, and completion events are captured incrementally. `blackbox codex exec "<prompt>"` remains available for one non-interactive turn. `blackbox claude` remains a process wrapper. No credentials or hidden chain-of-thought are captured.

Resume is repository-scoped by default:

```sh
blackbox codex resume
blackbox codex resume --last
blackbox codex resume --all
blackbox codex resume <session-id>
```

The wrapper passes the invocation directory to the Codex TUI and App Server. Default `resume` adds that directory to `thread/list`; `--all` opts into global discovery. A known session belonging to another repository is rejected unless `--all` is used. Linked worktrees share the Blackbox repository identity, while the saved worktree and session cwd remain separate.

Supported non-interactive forms are `blackbox codex exec "fix the bug"`, `blackbox codex exec --model mini "fix the bug"`, `blackbox codex exec "fix the bug" --model mini`, `blackbox codex exec --model=mini "fix the bug"`, `blackbox codex exec --sandbox workspace-write "fix the bug"`, and `blackbox codex exec -- "fix the bug"`. Claude prompt capture supports `blackbox claude -p "fix the bug"`, `blackbox claude --model sonnet -p "fix the bug"`, and `blackbox claude --print "fix the bug"`. Option values are never used as prompts; unsupported or prompt-less invocations record an explicit unavailable-prompt limitation.

Agent stdout and stderr are streamed live and persisted as bounded chunks. Child exit codes, signals, spawn failures, and failed turns are retained.

Edits made outside a wrapped agent invocation are not observable by Blackbox. They may be reported as `MANUAL`, but Blackbox cannot recover a prompt for them. A wrapped agent change is attributed to its real turn when its checkpoint diff contains the requested line.

## Filtering and Git worktrees

Snapshots exclude the repository Git directory, `.gitignore` matches, `.blackboxignore` matches, and built-in sensitive patterns including `.env`, `.env.*`, `*.pem`, `*.key`, `credentials*`, and `secrets/`. Symlinks are stored as symlink entries. State is rooted at the common Git directory returned by `git rev-parse --git-common-dir`, so linked worktrees share the initialized store rather than creating a second history. Existing `repository.json` IDs are retained during this upgrade so old turns are not orphaned.

## Restore safety

Restore first creates a `PRE_RESTORE` snapshot and prints changed paths. Without `--yes` it does not modify source files. Confirmed restore writes files from the selected shadow snapshot and appends a `RESTORE_COMPLETED` audit event. The current implementation does not provide a transactional rollback for an interrupted write and does not fully protect unrelated dirty-tree changes; use a clean working tree and retain the pre-restore checkpoint.

## Integrity and maintenance

`blackbox verify` checks SQLite relationships, referenced shadow trees, and the audit hash chain. `size` reports local storage bytes. `prune outputs` removes only unreferenced old payload rows after preview and `--yes`, then appends a purge event. `clear` requires the configured scrypt-verified password and `--yes`; it permanently deletes the repository's Blackbox directory. Snapshot pruning and local full-text search are not implemented.

## Troubleshooting and limitations

- Run commands from inside the intended Git repository.
- If `node:sqlite` is unavailable, upgrade to Node.js 24+.
- If an adapter executable is missing, install that vendor CLI and verify it independently.
- Unknown commands fail with usage text.
- `search` is not implemented. `status` reports the repository and recorded-turn count.
- The installed Codex in this audit environment failed before editing with `failed to initialize in-process app-server client: Operation not permitted`. Run the quick start where Codex can initialize and authenticate.
- The interactive app-server proxy requires a local Unix socket, which this sandbox denies; the normal macOS terminal remains the required acceptance environment.

## Development

```bash
npm test
npm run lint
git diff --check
```

There is no configured typecheck script. The test suite uses Node's built-in test runner and isolated temporary Git repositories.
