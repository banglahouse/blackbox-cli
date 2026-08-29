# Product Requirements Document — Blackbox

**Product:** Blackbox
**Category:** Developer Tooling / AI Coding Provenance
**Version:** v1 Draft
**Status:** Proposed
**Primary Interface:** CLI
**Initial Agent Support:** Claude Code, OpenAI Codex
**Storage:** Fully local
**Repository Requirement:** Git repository required

---

# 1. Product Summary

Blackbox is a lightweight local developer tool that records the provenance of AI-assisted code changes.

It wraps supported AI coding agents such as Claude Code and Codex and creates an immutable history connecting:

* user prompts
* AI coding sessions
* commands executed
* stdout/stderr
* files changed
* exact file state before a prompt
* exact file state after a prompt
* Git branch and commit context
* line-level source provenance

The primary purpose is to answer questions such as:

* Why does this line exist?
* Which prompt introduced this code?
* What did the agent change for this prompt?
* What did this file look like before that prompt?
* Which agent changed this file?
* What commands or tests were executed?
* Can I safely restore the repository to the state before a specific prompt?

Blackbox is not a replacement for Git.

Git tracks developer commits.

Blackbox tracks the relationship between AI prompts, agent actions and source-code changes, including changes that were never committed.

---

# 2. Problem Statement

AI coding agents increasingly make large and frequent modifications across repositories.

Git provides strong source-control history when developers create meaningful commits, but AI workflows often contain many prompts between commits.

Example:

```text
Git Commit A

Prompt 1
→ modifies service.py

Prompt 2
→ modifies service.py again
→ modifies controller.py

Prompt 3
→ modifies service.py again

Git Commit B
```

Git can show:

```text
Commit A → Commit B
```

but cannot reliably answer:

```text
Which lines came from Prompt 1?

What exactly changed during Prompt 2?

What did service.py look like before Prompt 3?

Why was line 287 introduced?

Which command or test caused the agent to make this change?
```

Agent conversation history may contain some of this information, but it is:

* vendor-specific
* difficult to query
* disconnected from Git history
* not designed for source-code provenance
* sometimes unavailable after sessions end
* insufficient for reliable restoration

Developers therefore lack a dependable audit trail between:

```text
intent → agent action → source-code change
```

Blackbox solves this problem.

---

# 3. Product Vision

Blackbox should become:

> Git blame for AI-assisted development.

A developer should be able to inspect any current line of code and trace it back through:

```text
Current line
    ↓
Blackbox checkpoint
    ↓
AI turn
    ↓
Original prompt
    ↓
Agent
    ↓
Commands executed
    ↓
Tests/results
    ↓
Previous source version
```

The system should work across multiple AI coding agents while keeping all provenance in one unified local history.

---

# 4. Goals

Blackbox v1 must support four equally important workflows.

## 4.1 Prompt provenance

Determine which prompt introduced or last modified a line or section of code.

Example:

```bash
blackbox why src/backtests/service.py:287
```

---

## 4.2 Prompt-specific code history

Determine exactly what changed during one AI prompt, regardless of whether the developer committed those changes.

Example:

```bash
blackbox diff BBX-428
```

---

## 4.3 Historical restoration

Restore files to their state before or after a specific Blackbox turn.

Example:

```bash
blackbox restore BBX-428 --before
```

The restore operation must show affected files before making changes and require confirmation.

---

## 4.4 AI coding audit trail

Inspect the full observable execution history associated with a prompt.

This includes:

* prompt
* visible agent responses
* commands
* command output
* errors
* tests
* files changed
* before/after snapshots
* branch
* Git HEAD
* timestamps
* agent identity

---

# 5. Non-Goals

The following are explicitly outside the scope of v1.

## 5.1 Hidden model chain-of-thought

Blackbox does not attempt to capture private or hidden model reasoning.

It records only information exposed through supported agent interfaces.

This may include:

* visible plans
* agent responses
* tool events
* commands
* outputs
* file changes

---

## 5.2 Non-Git repositories

Blackbox must only operate inside a valid Git repository.

Running Blackbox outside Git should return an error.

Example:

```text
Blackbox requires a Git repository.

Run:
git init

or execute Blackbox from an existing repository.
```

---

## 5.3 Cloud synchronization

v1 is completely local.

No Blackbox service, hosted database or cloud account is required.

---

## 5.4 Team collaboration

Shared organization histories, remote synchronization and team dashboards are not part of v1.

---

## 5.5 IDE UI

v1 is CLI-only.

Possible future interfaces include:

* VS Code extension
* local web UI
* terminal TUI

---

## 5.6 External research provenance

v1 does not archive:

* websites
* MCP responses
* external documents
* browser research
* API responses unrelated to command execution

These can be introduced later.

---

# 6. Product Principles

Blackbox must follow the following principles.

## 6.1 Zero-friction workflow

The developer should continue using their normal coding agent.

Instead of:

```bash
claude
```

they run:

```bash
blackbox claude
```

Instead of:

```bash
codex
```

they run:

```bash
blackbox codex
```

All agent CLI arguments should pass through transparently.

Example:

```bash
blackbox claude --model opus
```

---

## 6.2 Local-first

All Blackbox data must remain on the developer's machine.

Blackbox must not require a hosted service.

---

## 6.3 No credential interception

Blackbox must not:

* proxy model API traffic unnecessarily
* read provider API keys
* capture authentication tokens
* inject itself into provider authentication
* transmit code or prompts externally

---

## 6.4 Agent-neutral core

Claude and Codex integrations must be implemented as adapters.

Blackbox core must not depend on Claude-specific or Codex-specific data structures.

---

## 6.5 Append-only history

Historical Blackbox records must never be modified in-place.

Allowed operations:

```text
CREATE
DELETE
```

Not allowed:

```text
UPDATE historical records
```

Corrections must be represented as new events.

---

## 6.6 Tamper-evident history

Blackbox must detect historical modification using a cryptographic hash chain.

Blackbox is tamper-evident rather than OS-level tamper-proof.

---

# 7. Core Concepts

## 7.1 Repository

A Git repository initialized for Blackbox.

Each repository has one unified Blackbox history.

---

## 7.2 Session

An invocation of a supported coding agent.

Example:

```bash
blackbox claude
```

creates a Blackbox session.

A session may contain multiple user prompts.

---

## 7.3 Turn

A Turn is the fundamental Blackbox unit.

One user prompt corresponds to one Blackbox Turn.

Example:

```text
BBX-0042

Prompt:
"Fix pagination handling..."

Agent:
Claude

Before checkpoint:
CP-102

After checkpoint:
CP-103
```

---

## 7.4 Checkpoint

A snapshot of the repository's tracked Blackbox state at a particular moment.

Checkpoints may be generated by:

* AI turns
* manual/external modifications
* restore operations

---

## 7.5 Manual checkpoint

If the repository changes between AI turns outside Blackbox, those changes must not be attributed to the next agent prompt.

Example:

```text
BBX-40 finishes
       ↓
Developer manually edits service.py
       ↓
BBX-41 begins
```

Blackbox detects the difference and inserts:

```text
MANUAL CHECKPOINT
```

Result:

```text
BBX-40
  ↓
MANUAL
  ↓
BBX-41
```

Line provenance can therefore distinguish:

```text
AI-generated code
vs
manual/external changes
```

---

# 8. High-Level Architecture

```text
                  Blackbox CLI
                       │
              ┌────────┴────────┐
              │                 │
       Claude Adapter       Codex Adapter
              │                 │
              └────────┬────────┘
                       │
                Normalized Events
                       │
        ┌──────────────┴──────────────┐
        │                             │
 Snapshot Engine                 Event Recorder
        │                             │
 Shadow Git                         SQLite
        │                             │
        └──────────────┬──────────────┘
                       │
                 Audit Ledger
                 SHA-256 Chain
```

---

# 9. Adapter Architecture

Blackbox must expose an internal generic adapter interface.

Conceptually:

```text
AgentAdapter

start_session()
stop_session()
subscribe_events()
get_agent_metadata()
```

Agents should normalize vendor events into Blackbox events.

Initial normalized event types:

```text
SESSION_STARTED

SESSION_ENDED

PROMPT_SUBMITTED

AGENT_MESSAGE

COMMAND_STARTED

COMMAND_COMPLETED

TURN_COMPLETED

TURN_FAILED
```

Future adapters should be possible without modifying the storage or provenance layers.

Potential future adapters:

```text
Gemini
Cursor
Aider
OpenCode
GitHub Copilot
```

---

# 10. Turn Lifecycle

The expected lifecycle of one prompt is:

```text
PROMPT RECEIVED
       │
       ▼
Detect external/manual changes
       │
       ▼
Create BEFORE checkpoint
       │
       ▼
Record prompt
       │
       ▼
Agent operates normally
       │
       ├── commands
       ├── command outputs
       ├── visible responses
       └── source modifications
       │
       ▼
Agent turn completes
       │
       ▼
Create AFTER checkpoint
       │
       ▼
Calculate exact diff
       │
       ▼
Record affected files
       │
       ▼
Append audit event
```

---

# 11. Source Snapshot Model

Blackbox must not rely on:

```bash
git diff HEAD
```

for prompt provenance.

Consider:

```text
HEAD

Prompt A
→ file.py changes

Prompt B
→ file.py changes again

Prompt C
→ file.py changes again

No Git commits
```

Blackbox must independently preserve:

```text
Prompt A
Checkpoint 1 → Checkpoint 2

Prompt B
Checkpoint 2 → Checkpoint 3

Prompt C
Checkpoint 3 → Checkpoint 4
```

Therefore:

```bash
blackbox diff BBX-A
```

must return only changes created during Prompt A.

---

# 12. Shadow Git Repository

Blackbox should use an independent internal Git object store for repository snapshots.

Suggested layout:

```text
.git/
    blackbox/
        blackbox.db
        snapshots.git/
        runtime/
        locks/
```

The shadow repository must not modify:

```text
.git/HEAD
.git/index
developer branches
staging area
Git remotes
developer commits
```

The shadow Git repository exists exclusively for Blackbox checkpoint storage.

Benefits:

* content-addressed storage
* efficient deduplication
* exact historical reconstruction
* proven diff algorithms
* proven blame algorithms
* storage efficiency across similar snapshots

---

# 13. File Filtering

Blackbox must respect:

```text
.gitignore
+
.blackboxignore
+
Blackbox built-in exclusions
```

Ignored files must never enter the Blackbox snapshot object store.

Filtering must occur before snapshot storage.

Default sensitive exclusions should include common patterns such as:

```text
.env
.env.*
*.pem
*.key
credentials*
secrets/
```

Users may extend exclusions through:

```text
.blackboxignore
```

Example:

```text
fixtures/
large-data/
private/
tmp/
production.sql
```

---

# 14. File Changes

For every Turn, Blackbox must determine:

```text
created files
modified files
deleted files
renamed files when detectable
```

For each affected file:

```text
path
change type
before object hash
after object hash
diff
```

File reads do not need to be captured in v1.

---

# 15. Commands and Output

Blackbox must record observable commands executed by the AI agent.

For each command:

```text
sequence
command
working directory
started_at
completed_at
exit_code
stdout
stderr
duration
```

Examples include:

```text
pytest
npm test
npm run build
git diff
database migrations
lint commands
formatters
shell scripts
```

Large command output may be stored separately from core metadata to support future pruning.

---

# 16. Line-Level Provenance

Blackbox must provide line-level attribution for current files.

Command:

```bash
blackbox blame src/service.py
```

Example output:

```text
12  BBX-0037  Claude  add pagination
13  BBX-0037  Claude  add pagination
14  BBX-0051  Codex   fix cursor handling
15  BBX-0051  Codex   fix cursor handling
16  MANUAL    user    external modification
17  BBX-0062  Claude  null cursor fix
```

Blackbox should derive provenance from checkpoint diffs and snapshot history.

---

# 17. Why Command

One of the primary product workflows is:

```bash
blackbox why <path>:<line>
```

Example:

```bash
blackbox why src/backtests/service.py:287
```

Expected output:

```text
src/backtests/service.py:287

Last changed:
BBX-428

Agent:
Claude

Branch:
feat/backtest-pagination

Prompt:
"Move trade pagination to backend."

Changed:
2026-08-19 14:32

Commands:
pytest tests/backtest/test_trades.py

Result:
14 passed

Previous checkpoint:
BBX-407
```

Optional contextual diff should also be displayed.

---

# 18. Search

Blackbox must provide local search.

Example:

```bash
blackbox search "backtest pagination"
```

Searchable content should include:

* prompts
* visible agent responses
* file paths
* diff text
* commands
* stdout
* stderr
* agent
* branch
* checkpoint IDs

SQLite FTS5 should be sufficient for v1.

Embeddings, semantic search and local LLM search are outside the initial MVP.

---

# 19. Git Branch Handling

Blackbox should follow the developer's existing Git branches.

Each Turn must record:

```text
branch
Git HEAD before
Git HEAD after
```

Blackbox should not create or modify developer branches.

The Blackbox audit ledger remains global across branches.

Example:

```text
BBX-100 Claude main
BBX-101 Claude main
BBX-102 Codex feature/foo
BBX-103 Manual feature/foo
BBX-104 Claude feature/foo
BBX-105 Codex main
```

---

# 20. Multi-Agent History

All supported AI coding agents operating on one repository must share the same Blackbox history.

IDs belong to Blackbox, not individual vendors.

Example:

```text
BBX-100 Claude
BBX-101 Claude
BBX-102 Codex
BBX-103 Manual
BBX-104 Codex
BBX-105 Claude
```

This allows provenance to remain consistent even when developers switch agents.

---

# 21. Restore

Blackbox must allow repository restoration to historical checkpoints.

Examples:

```bash
blackbox restore BBX-428 --before
```

and:

```bash
blackbox restore BBX-428 --after
```

Restoration must never modify files immediately.

Blackbox must first show an impact preview.

Example:

```text
Restore checkpoint BEFORE BBX-428

Affected files:

M src/service.py
M src/controller.py
D src/new_helper.py

Current uncommitted changes:
src/controller.py

3 files will change.

Continue? [y/N]
```

The user must explicitly confirm.

---

# 22. Restore Safety

Immediately before any restore operation, Blackbox must create a new checkpoint representing the current repository state.

Example:

```text
Current
   ↓
PRE_RESTORE checkpoint
   ↓
Restore BBX-428
   ↓
RESTORE event
```

This ensures restores themselves can be reversed.

Restore must never rewrite Blackbox history.

---

# 23. Tamper-Evident Audit Ledger

Every important Blackbox event must participate in an append-only SHA-256 hash chain.

Conceptually:

```text
Event 1
hash = H(Event 1)

Event 2
previous_hash = Event 1 hash
hash = H(Event 2 + previous_hash)

Event 3
previous_hash = Event 2 hash
hash = H(Event 3 + previous_hash)
```

Changing an old event invalidates subsequent hashes.

The audit ledger should include hashes representing:

* prompt data
* checkpoint IDs
* snapshot tree hashes
* commands
* outputs
* file mappings
* purge events
* restore events

---

# 24. Verification

Blackbox must expose:

```bash
blackbox verify
```

Verification should inspect:

* audit-chain integrity
* referenced checkpoint existence
* snapshot hashes
* database relationships
* payload hashes where payloads still exist

Possible statuses:

```text
VALID
```

or:

```text
INVALID

Broken chain at:
BBX-387

Expected previous hash:
...

Actual:
...
```

---

# 25. Immutable Data Model

Historical records must never be modified.

Blackbox APIs and internal repositories should enforce:

```text
INSERT allowed
DELETE allowed through explicit purge flows
UPDATE of historical records forbidden
```

If metadata needs correction, a new correcting event must be appended rather than modifying the original record.

---

# 26. Storage Separation

Blackbox should distinguish between:

## Critical immutable metadata

Examples:

```text
turn metadata
prompt
file mapping
checkpoint hashes
audit hashes
purge records
restore records
```

and:

## Large payloads

Examples:

```text
command stdout
command stderr
large agent responses
historical snapshot objects
```

This separation allows disk-space reclamation without silently changing audit history.

---

# 27. Data Pruning

Users must be able to delete stored data to reclaim disk space.

Deletion must be explicit and auditable.

Example:

```bash
blackbox prune outputs --before 2026-01-01
```

Preview:

```text
Will permanently remove:

Command outputs: 4,812
Storage: 2.7 GB

Retained:
Prompt metadata
Turn metadata
File provenance
Snapshot history
Audit hashes

Continue?
```

After deletion, Blackbox must append a purge event.

Historical records should indicate:

```text
Output existed.

SHA256:
abc123...

Payload:
PURGED BY USER
```

rather than pretending the payload never existed.

---

# 28. Snapshot Pruning

Historical source snapshots may also be deleted for disk-space reclamation.

This action is more destructive because it may remove:

* restore capability
* historical source inspection
* historical line provenance

Blackbox must provide a stronger warning.

Example:

```text
WARNING

Deleting these snapshots will remove historical source content.

You may lose:

- restore capability
- source inspection
- line-level provenance

Audit metadata will remain.
```

Snapshot pruning should be intentionally conservative in v1.

---

# 29. Full History Deletion

Blackbox must support:

```bash
blackbox clear
```

This permanently removes all Blackbox data for the repository.

Before deletion:

```text
Repository:
algotrader

Sessions:       141
Prompts:        2,984
File versions:  38,241
Commands:       18,937
Storage:        8.4 GB

THIS WILL PERMANENTLY DELETE
THE ENTIRE BLACKBOX HISTORY.

Enter Blackbox password:
```

Full deletion requires the Blackbox password.

There must not be a simple:

```text
--force
```

bypass that avoids password authorization.

---

# 30. Password Usage

The Blackbox password is intended only for destructive history operations.

It should not be required for normal commands such as:

```text
log
show
diff
blame
why
search
verify
```

Password requirements apply to destructive operations such as:

```text
blackbox clear
```

and potentially high-impact pruning operations depending on final security design.

Password storage must use a strong password hashing function rather than storing plaintext.

---

# 31. CLI Commands

The initial CLI should expose:

```text
blackbox init

blackbox claude
blackbox codex

blackbox status

blackbox log

blackbox show <turn>

blackbox diff <turn>

blackbox file <path>

blackbox blame <path>

blackbox why <path>:<line>

blackbox search "<query>"

blackbox restore <turn> --before

blackbox restore <turn> --after

blackbox verify

blackbox size

blackbox prune ...

blackbox clear
```

---

# 32. blackbox init

Running:

```bash
blackbox init
```

must:

1. verify the current directory is inside a Git repository
2. initialize Blackbox repository metadata
3. initialize SQLite
4. initialize shadow Git
5. initialize audit ledger
6. configure `.blackboxignore` if required
7. configure local password if destructive operations require one
8. create initial baseline checkpoint

Blackbox files should not pollute the developer's source tree unnecessarily.

Preferred storage location:

```text
.git/blackbox/
```

---

# 33. blackbox log

Example:

```bash
blackbox log
```

Output:

```text
BBX-105 Claude feat/backtests  Fix selected trade chart
BBX-104 Codex  feat/backtests  Add trades pagination
BBX-103 MANUAL feat/backtests  External modification
BBX-102 Claude feat/backtests  Add trades endpoint
```

Useful filters should eventually include:

```text
--agent
--branch
--file
--since
--until
```

---

# 34. blackbox show

Example:

```bash
blackbox show BBX-104
```

Should display:

```text
Turn
Agent
Session
Branch
Git HEAD
Prompt
Visible response
Files changed
Commands
Results
Before checkpoint
After checkpoint
Audit hash
```

---

# 35. blackbox diff

Example:

```bash
blackbox diff BBX-104
```

Must show only changes introduced during that specific turn.

It must not depend on whether those changes have been committed.

---

# 36. blackbox file

Example:

```bash
blackbox file src/service.py
```

Should show the history of Blackbox events affecting the file.

Example:

```text
BBX-028 created file
BBX-037 modified lines 12-34
BBX-051 modified lines 14-19
MANUAL modified lines 62-66
BBX-062 modified lines 15-17
```

---

# 37. Performance Requirements

Blackbox must have near-zero perceived impact on normal coding-agent usage.

Requirements:

* agent startup overhead should be minimal
* snapshots should reuse Git object deduplication
* hashing should avoid unnecessary repeated work
* expensive operations should occur incrementally
* database writes should use transactions
* normal agent execution must not wait on unnecessary search/index work
* command output capture must stream rather than block execution

The coding workflow must remain functionally identical when Blackbox is enabled.

---

# 38. Failure Isolation

Failure inside Blackbox must not corrupt the developer repository.

Where safe, Blackbox failures should degrade logging rather than modify application source.

Examples:

```text
snapshot recording failed
database temporarily locked
adapter event malformed
```

Blackbox should report the failure clearly.

It must never silently attribute an incomplete turn as fully recorded.

Possible status:

```text
BBX-428
STATUS: INCOMPLETE
```

---

# 39. Concurrency

Blackbox must prevent multiple writers from corrupting one repository history.

A repository-level locking strategy must protect:

* checkpoint creation
* audit-chain append
* database writes
* destructive operations

Read-only commands may operate concurrently where safe.

---

# 40. Suggested Data Model

## repositories

```text
id
repo_root
created_at
```

## sessions

```text
id
repository_id
agent
agent_version
model
started_at
completed_at
```

## turns

```text
id
session_id
sequence
agent
branch
git_head_before
git_head_after
prompt
visible_response
before_checkpoint_id
after_checkpoint_id
status
started_at
completed_at
```

## checkpoints

```text
id
repository_id
turn_id
checkpoint_type
shadow_commit_hash
tree_hash
created_at
```

Possible checkpoint types:

```text
BASELINE
TURN_BEFORE
TURN_AFTER
MANUAL
PRE_RESTORE
POST_RESTORE
```

## file_changes

```text
id
turn_id
path
change_type
before_blob_hash
after_blob_hash
```

## commands

```text
id
turn_id
sequence
command
cwd
started_at
completed_at
exit_code
stdout_payload_id
stderr_payload_id
```

## payloads

```text
id
payload_type
content_hash
storage_location
size
status
created_at
```

Payload statuses:

```text
AVAILABLE
PURGED
```

## audit_events

```text
id
event_type
entity_type
entity_id
payload_hash
previous_hash
event_hash
created_at
```

## purge_events

```text
id
purge_type
criteria
items_deleted
bytes_reclaimed
authorized_at
audit_event_id
```

---

# 41. Agent Privacy Boundary

Blackbox must interact with agents only through documented or supported local integration surfaces where practical.

Blackbox should avoid:

* keylogging
* terminal-screen scraping where structured events exist
* intercepting provider TLS traffic
* reading agent credential stores
* modifying provider authentication
* storing ignored sensitive files

Adapters are responsible only for translating observable local agent activity into normalized Blackbox events.

---

# 42. MVP Scope

v1 should include:

### Core

* Git repository validation
* `blackbox init`
* local SQLite database
* shadow Git snapshots
* prompt-level before/after checkpoints
* manual change detection
* file-change mapping
* command capture
* stdout/stderr capture
* unified Turn IDs
* Claude adapter
* Codex adapter

### Provenance

* `blackbox log`
* `blackbox show`
* `blackbox diff`
* `blackbox file`
* `blackbox blame`
* `blackbox why`

### Recovery

* preview restore
* before/after restore
* automatic pre-restore checkpoint
* confirmation requirement

### Integrity

* append-only event model
* SHA-256 audit chain
* `blackbox verify`

### Search

* local FTS search

### Storage

* `.gitignore`
* `.blackboxignore`
* output pruning
* size reporting
* password-protected complete history deletion

---

# 43. Post-MVP Features

Potential future features include:

* external MCP provenance
* web/browser context capture
* attached document provenance
* semantic search
* local embeddings
* VS Code extension
* local web dashboard
* terminal TUI
* repository analytics
* agent comparison
* cost/token tracking
* team sync
* encrypted remote backup
* signed audit anchors
* CI integration
* GitHub PR integration
* commit-to-prompt linking
* issue-to-prompt linking
* blame annotations inside editors
* diff visualization
* natural-language history queries

---

# 44. User Stories

## US-1

As a developer, I want to know which AI prompt created a line so that I can understand why the implementation exists.

Acceptance:

```bash
blackbox why file.py:120
```

returns the responsible Blackbox Turn and prompt.

---

## US-2

As a developer, I want to inspect exactly what changed during one prompt even if I did not make a Git commit.

Acceptance:

```bash
blackbox diff BBX-123
```

returns only that Turn's modifications.

---

## US-3

As a developer, I want manual edits to remain distinguishable from AI-generated changes.

Acceptance:

Manual changes between agent Turns are recorded as MANUAL checkpoints.

---

## US-4

As a developer, I want to restore files to their state before an AI prompt.

Acceptance:

Blackbox previews affected files and requires confirmation.

---

## US-5

As a developer, I want restores themselves to be recoverable.

Acceptance:

A PRE_RESTORE checkpoint is always generated before modification.

---

## US-6

As a developer, I want Claude and Codex to share one history.

Acceptance:

Both produce unified sequential BBX Turn IDs.

---

## US-7

As a developer, I want to search old prompts and modifications.

Acceptance:

```bash
blackbox search "pagination"
```

returns relevant Turns.

---

## US-8

As a developer, I want to know whether Blackbox history was altered.

Acceptance:

```bash
blackbox verify
```

validates the append-only cryptographic chain.

---

## US-9

As a developer, I want to free disk space without silently rewriting history.

Acceptance:

Large payloads may be purged while their hashes and purge events remain.

---

## US-10

As a developer, I want to permanently destroy Blackbox history if necessary.

Acceptance:

```bash
blackbox clear
```

requires explicit password authorization.

---

# 45. MVP Acceptance Criteria

Blackbox v1 is considered successful when all of the following work.

### Scenario A

```text
Run Claude through Blackbox.

Prompt Claude to modify two files.

Do not commit.

Prompt Claude again to modify one of those files.
```

Expected:

Blackbox produces two distinct Turns with independent exact diffs.

---

### Scenario B

```text
AI Turn completes.

Developer manually edits the same file.

Next AI Turn begins.
```

Expected:

Manual edits are attributed to a MANUAL checkpoint rather than the next AI Turn.

---

### Scenario C

Run:

```bash
blackbox blame file.py
```

Expected:

Current lines correctly map to Claude, Codex or MANUAL provenance.

---

### Scenario D

Run:

```bash
blackbox why file.py:123
```

Expected:

Blackbox returns:

* Turn
* prompt
* agent
* branch
* timestamp
* contextual diff
* relevant commands
* previous checkpoint

---

### Scenario E

Run:

```bash
blackbox restore BBX-42 --before
```

Expected:

Blackbox:

1. calculates affected files
2. displays impact
3. detects current modifications
4. asks for confirmation
5. creates PRE_RESTORE checkpoint
6. performs restore
7. records RESTORE event

---

### Scenario F

Modify Blackbox historical database content manually.

Run:

```bash
blackbox verify
```

Expected:

Verification fails and identifies the integrity break.

---

### Scenario G

Purge command output.

Expected:

Payload is deleted, disk space is reclaimed, but:

* command metadata remains
* original output hash remains
* purge event remains
* audit chain remains valid

---

### Scenario H

Run Blackbox outside Git.

Expected:

Blackbox refuses initialization and execution.

---

# 46. Success Metrics

Initial success should primarily be evaluated through reliability rather than growth metrics.

Important metrics:

```text
Percentage of AI turns successfully captured

Percentage of changed files correctly attributed

Line provenance accuracy

Snapshot reconstruction accuracy

Restore success rate

Integrity verification success rate

Average Turn-recording overhead

Storage consumed per 1,000 Turns

Blackbox-related coding-agent failures
```

Primary technical goal:

```text
Blackbox must never silently provide incorrect provenance.
```

If provenance is incomplete, Blackbox should clearly mark it as incomplete rather than guessing.

---

# 47. Key Risks

## Vendor integration changes

Claude or Codex integration surfaces may change.

Mitigation:

Use isolated adapters.

---

## Performance

Large repositories may make frequent snapshot creation expensive.

Mitigation:

Use Git content-addressed storage and incremental checkpoint calculation.

---

## Disk usage

Command outputs and long histories may become large.

Mitigation:

Separate metadata and payload storage and provide auditable pruning.

---

## Incorrect provenance

External processes may modify files without Blackbox observing them.

Mitigation:

Compare current worktree against the previous Blackbox checkpoint at each Turn boundary and generate MANUAL checkpoints.

---

## Tampering

A process with the same filesystem permissions may directly manipulate Blackbox files.

Mitigation:

Cryptographic tamper evidence.

Hard OS-level tamper prevention is outside v1.

---

# 48. Product Positioning

Blackbox should not position itself as another Git client or AI coding agent.

The core positioning is:

> Blackbox gives every AI-generated code change a traceable origin.

Alternative concise description:

> A local provenance and recovery layer for AI-assisted software development.

The key differentiator is the relationship:

```text
Prompt
→ Agent activity
→ Exact source diff
→ Line provenance
→ Historical checkpoint
→ Restore
```

rather than merely storing conversation logs.

---

# 49. Final Product Definition

Blackbox v1 is a lightweight, fully local CLI wrapper for AI coding agents that creates immutable prompt-level source checkpoints inside Git repositories.

For every supported AI prompt, Blackbox records:

```text
Who changed it
Why it changed
What changed
What existed before
What existed afterward
What commands were executed
Whether those commands succeeded
Where the current lines originated
How to return to the previous state
```

The resulting history remains independent of the developer's Git commit frequency and works across multiple AI agents through a common adapter architecture.

The fundamental promise of Blackbox is:

> No AI-generated line of code should become impossible to trace back to the prompt that caused it.
