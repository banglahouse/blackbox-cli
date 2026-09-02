# Blackbox v1 PRD Traceability

Independent audit date: 2026-08-30. Evidence below comes from source inspection, the existing Node test suite, and clean-room temporary Git repositories. Plan and prior runner statuses were not used as acceptance evidence.

| Requirement | Implementation evidence | Test evidence | Manual verification | Status |
|---|---|---|---|---|
| Operates only inside Git repositories | `index.js` resolves `git rev-parse` before repository commands | `init fails outside a git repository` | Clean-room non-Git `init` failed with the required error | PASS |
| Local-only storage under Git dir | `getBlackboxRoot()` uses the canonical common Git directory; SQLite and shadow Git are local | `init scaffolds...` | Clean-room init created only `.git/blackbox`; source tree stayed unpolluted | PASS |
| Idempotent init with baseline state | `initRepository()` creates directories/schema and preserves `repository.json` | `init scaffolds...` | Repeated init preserved metadata and Git status | PARTIAL |
| Initial baseline checkpoint | No baseline checkpoint is created by `initRepository()` | None | Clean-room database had no baseline checkpoint after init | NOT_IMPLEMENTED |
| SQLite core data model | `storage.js` creates repositories, sessions, turns, checkpoints, commands, payloads, file_changes, audit_events | schema and append-only tests | Clean-room database contained the eight tables | PASS |
| Append-only historical records | SQLite update/delete triggers cover most history tables | append-only test covers repositories | Direct inspection shows `payloads` has no delete trigger and some fields are mutable by ordinary SQL | PARTIAL |
| Shadow Git snapshots | `snapshot.js` writes blobs and trees to `snapshots.git` using a temporary index | snapshot repeatability test | Repeated snapshots returned the same tree and did not change developer Git state | PASS |
| Exact before/after snapshots for each AI turn | `codex-app-server.js` creates BEFORE/AFTER checkpoints around each structured `turn/start`/completion | wrapped-agent checkpoint/provenance test | Non-interactive fake wrapper produced both checkpoints; interactive proxy could not bind loopback in this sandbox | PARTIAL |
| `.gitignore` filtering | `git check-ignore --no-index` is used before blob creation | snapshot filtering test | Ignored fixture was absent from shadow tree | PASS |
| `.blackboxignore` and built-in sensitive filtering | `collectFiles()` applies rules and patterns for `.env`, keys, PEMs, credentials, secrets | snapshot filtering test | `.env`, PEM, and ignored private fixture were absent | PASS |
| Symlink, outside-repository, binary, and large-file behavior | Symlink contents are stored as link blobs; no explicit size limit; traversal is root-bounded | No complete CLI acceptance test | Source inspection only; outside links/large-file policy is not fully specified or verified | PARTIAL |
| One unified turn per prompt | `codex-app-server.js` maps each app-server `turn/start` to one Blackbox turn within one session | adapter tests; real interactive test pending | Interactive two-prompt acceptance could not run because loopback networking is denied | PARTIAL |
| Observable command capture | Async adapter streams stdout/stderr to bounded chunk rows and app-server records structured command items | large-output and failure-finalization tests | Interactive real command capture remains unrun in this sandbox | PARTIAL |
| Visible agent response/event normalization | App-server proxy persists user prompts and visible agent-message deltas without hidden reasoning | normalization assertions | Protocol shape verified against official documentation; real interactive stream remains unrun | PARTIAL |
| Codex interactive adapter | `runCodex()` routes plain `blackbox codex` through `codex-app-server.js`; optional `exec` remains process-based | forwarding and wrapped-agent tests | Official app-server protocol was inspected; macOS terminal acceptance remains unrun because this sandbox denies loopback and Codex runtime initialization | PARTIAL |
| Claude transparent wrapper | `runClaude()` forwards args and records session start/end | forwarding unit test with Node fixture | `claude` is not installed; no actual Claude CLI verification possible; no event parsing | PARTIAL |
| Log/show/diff/file inspection | Implemented in `inspect.js` and exposed by `index.js` | inspection and wrapped-agent provenance tests | Clean-room failed Codex turn appeared in `blackbox log`; fake wrapped change appeared in show/diff | PASS |
| `status` command | `index.js` reports repository and recorded-turn count | CLI smoke coverage | Clean-room status returned JSON after init | PASS |
| Line-level provenance and manual attribution | `blame()` and `why()` map added/modified lines from the latest checkpoint diff; untouched lines remain `MANUAL` | wrapped-agent provenance test | Fake wrapped change mapped changed line to Codex and unchanged line to MANUAL | PASS |
| `why` required context | `why()` returns prompt, agent, timestamp, commands, previous checkpoint, branch, and HEAD when captured | basic why and wrapped-agent tests | Real interactive context remains unrun in this sandbox | PARTIAL |
| Local search | No `search` implementation or FTS table | None | Clean-room `blackbox search` returned unknown command | NOT_IMPLEMENTED |
| Branch and Git context | App-server prompt events capture active branch, HEAD, and working-tree state; metadata keeps worktree root and common Git dir | worktree and wrapped-agent tests | Real interactive context remains unrun in this sandbox | PARTIAL |
| Restore preview and confirmation | `restoreTurn()` creates a PRE_RESTORE checkpoint, previews changed paths, and requires `--yes` | restore preview test | Preview left source unchanged; confirmed restore changed the target file and created PRE_RESTORE | PASS |
| Restore dirty-tree safety | Restore compares current snapshot but does not reject or separately protect unrelated dirty files; filtered files can disappear from snapshots | None | Source inspection shows no dirty-tree confirmation/report and no failure rollback | PARTIAL |
| Restore failure/interruption recovery | No transactional file application or post-restore checkpoint | None | Source inspection found partial-write risk on interruption | NOT_IMPLEMENTED |
| Audit SHA-256 chain | `appendAuditEvent()` chains canonical event envelopes | audit-chain test | Untampered chain verified; controlled tampered record failed verification | PASS |
| Complete relationship verification | `verifyRepository()` checks foreign keys, checkpoint references, snapshot trees, and audit chain | verify test | Primary store remained intact; copied-store tamper detection was reproduced by the same verifier logic | PASS |
| Payload hash/purge retention | Payload rows can be pruned if unreferenced and a purge event is appended; no payload hash/status fields | maintenance test | Preview/execution worked for an unreferenced payload; retained output hash and `PURGED BY USER` metadata are absent | PARTIAL |
| Size reporting | Recursive filesystem size in `maintenance.js` | maintenance test | `blackbox size` reports bytes for local state | PASS |
| Snapshot pruning | No snapshot pruning command | None | CLI exposes only payload pruning | NOT_IMPLEMENTED |
| Password-protected clear | scrypt verifier, wrong-password rejection, preview, `--yes` deletion | maintenance test | Password path worked; clear removes the entire Blackbox root after confirmation | PASS |
| Concurrency and locking | `locks/` directory is created but unused; DB writes have no repository lock | None | Concurrent-writer protection was not demonstrated | NOT_IMPLEMENTED |
| Failure isolation and incomplete turns | Async adapter finalizes failed, spawn-error, and signal-terminated turns with AFTER checkpoints | streamed failure/signal test | Interactive Ctrl+C remains unrun in this sandbox | PARTIAL |
| No credential/CoT interception | Adapters use inherited stdio and do not read provider stores | forwarding tests | Source inspection confirms no token or hidden-reasoning capture | PASS |

## Audit conclusion

Blackbox has a connected adapter-to-turn/checkpoint/file-change pipeline. Real installed-agent acceptance remains blocked by the audit environment's Codex app-server permission failure; this document does not mark that requirement PASS based on mocks.
