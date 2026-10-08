# agent-provider-switch v0.4.1 Design Document

**Lock and backup safety.** Second of two releases on the `0.3.x → 0.4.x` line. Two P0 items, both
stateful, both touching lock discipline. No architecture change: both registries, the projection
model, and the `0.3.1` security contracts are untouched.

Its companion documents are `docs/Design/agent-provider-switch-v0.4.0-design.md` (CI, test portability, boolean
flags, exit codes) and the roadmap's Phase 2b section.

**Depends on `0.4.0`.** Both items are verified with fixtures that release builds: a deterministic
crash-in-the-critical-section process, and a teardown that does not delete the directory under test.
Neither exists today.

**Citation convention.** This document names symbols (`releaseLock()`, `createTimestamp()`) rather
than line numbers. Every `file:line` citation in the roadmap drifted within a single release, and a
document that is wrong within one commit is worse than one that is vague.

Source of record: `docs/agent-provider-switch-2.x-roadmap.md` §2 — `P0-5`, `P0-2`, `P0-3`.

## Overview

Both items are about what happens when something has already gone wrong. A process was killed
holding the lock; backups have accumulated for four months. The failure mode they share is that the
tool currently has **no recovery path at all** for either — the only remedies are deleting a lock
file or a directory by hand.

The risk they share is that the fix is worse than the problem. Taking over a lock another process
actually holds means two concurrent writers, which corrupts state where the current behaviour merely
blocks. Deleting a backup directory that a surviving manifest still references turns a working
`rollback` into one that fails after a partial restore. Both sections below are shaped by that: every
rule here fails closed, and the escape hatch is explicit rather than automatic.

---

## 1. Stale-lock recovery

### Current state

`withToolLock()` wraps every mutation: `acquireLock()`, run, `releaseLock()` in a `finally`. The
lock record is `{ pid, operation, createdAt }`, written with `fs.writeFileSync(..., { flag: "wx" })`
so a second writer fails on the exclusive-create. On failure the code reads the record back and
throws `LOCK_CONFLICT` carrying the active pid, operation, and age. `readLockRecord()` is called
from exactly one place — that error path — so the pid is recorded and read purely to build a
message. Nothing probes it for liveness. There is no TTL, no force path, and no `unlock` command;
the only recovery is deleting the lock file by hand.

### The probe

`process.kill(pid, 0)`. Semantics verified on this machine (Node 24, Windows 11):

| Input | Result | Meaning |
|---|---|---|
| a live pid | no throw | alive |
| a pid that does not exist | `ESRCH` | dead |
| a live pid owned by another user | `EPERM` | **alive** — not distinguishable from a live operation, never taken over |
| `0` | **no throw** | would read as alive; must be rejected as a malformed record, not probed |

On POSIX a zombie still occupies its pid, so the probe succeeds and the lock reads as alive. That is
the correct direction: a false "alive" is a recoverable annoyance, a false "dead" is two writers.

Non-integer and negative pids are treated as a malformed record rather than probed.

### Four record states, not two

A record is **live**, **dead**, **unreadable**, or **malformed**. The third exists because
`writeFileSync` of a JSON record is not atomic across a hard kill: a truncated file parses to
nothing, and `readLockRecord()` already returns `null` for that case. If an unreadable record fell
into the fail-closed branch, the permanent lockout `P0-5` describes would survive this fix in exactly
the situation most likely to produce it. An unreadable record is treated as recoverable — the same
remedy as an absent one.

A **malformed** record — one that parses but whose `pid` could not have been written by a running
process, so not a positive integer — is recoverable for the same reason, and this is the one state
the probe table above does not by itself decide. `writeLockRecord()` only ever writes `process.pid`,
so a pid the writer would never produce cannot belong to a live writer; a torn write lands in
`unreadable` instead, because the JSON does not parse. Malformed therefore means hand-edited or
corrupted, and routing it to the fail-closed branch would restore the permanent lockout for a record
no live process can own.

### Takeover protocol

**Verify-then-claim, never read-then-delete.** Re-read the record immediately before removing it and
compare both `pid` and `createdAt` against what was verified; if either moved, another process
already took over and this one backs off with `LOCK_CONFLICT`. Remove, then recreate with the same
exclusive-create flag, so the loser of that race receives `LOCK_CONFLICT` rather than proceeding. A
failed removal is never followed by a mutation.

**`releaseLock()` must verify ownership.** Today it deletes whatever is at the lock path. That is
harmless while only the holder can reach the release path — and becomes a correctness bug the moment
takeover exists:

```
B reads a stale record (pid X, dead)
A verifies X is dead, takes over, writes pid A
B deletes the file, believing it is removing X's lock
   → A and B both mutate
```

This is not only a lock defect. It re-breaks §2's same-second collision fix and can put two writers
on `backups/latest.json`. `releaseLock()` re-reads and removes only when the record's pid is
`process.pid`, and leaves a record it does not own alone.

### Error classification

`acquireLock()` currently reports `LOCK_CONFLICT` for **any** thrown code from the write — including
`EACCES`, `EROFS`, `ENOSPC`, and `ENOENT`. On a read-only tool home that produces "another operation
is already running", then probes a pid that is absent or foreign, and points at the wrong remedy.
Only `EEXIST` is a conflict; everything else rethrows as an I/O error.

### No TTL takeover

A TTL that can seize a lock from a live process will eventually seize it from a `migrate` that is
simply slow, and a false takeover corrupts state where a false conflict only inconveniences. So the
age of a lock never authorizes takeover on its own — it is reported, not acted on.

The consequence must be stated rather than implied: **a recycled pid is fail-closed permanently.** A
pid recycled onto an unrelated live process resolves as alive forever. This is rare — a few thousand
processes must start in the window between the lock write and the next mutation — but it is
unrecoverable without help, so:

- the record gains `hostname`, because a `~/.config` synced by OneDrive or a dotfiles repository
  would otherwise name a foreign machine's pid that resolves as alive locally;
- the `LOCK_CONFLICT` message names the recycled-pid possibility and `aps unlock --force`
  explicitly, since that is the only way out.

`hostname` sharpens the first of those into a state of its own. A record whose `hostname` differs
from `os.hostname()` is **foreign**: its pid cannot be probed here at all, so it is neither taken
over automatically nor trusted as alive. It is refused with `LOCK_CONFLICT` naming the foreign host
and pointing at `aps unlock --force`. A record with **no** `hostname` predates the field and is
treated as local, which is what keeps existing lock files recoverable.

This is the fail-closed reading, and it is deliberate rather than incidental. A tool home shared
between machines therefore costs one explicit `aps unlock --force` instead of an automatic
takeover racing a genuine write on the other machine — the same trade the recycled pid makes, and
the same escape hatch. `aps doctor` reports the state as `LOCK_OCCUPIED` so it is discoverable
before a write fails on it.

### `aps unlock`

A new command, in the `recovery` group beside `backups list`. It removes the lock record and reports
what it removed — pid, operation, age.

- Without `--force` it clears the lock only when the owner is provably gone. A live owner is refused,
  and the refusal explains why.
- `--force` clears it regardless, which is the documented path for a recycled pid.
- It is idempotent: no lock present is success, not an error.
- It does not take the lock to do its job — acquiring would be the thing it exists to fix.

### Discovery

`doctor` is the issue-first diagnostics command and is where a stuck lock should surface. It gains a
report of an occupied or stale lock, naming the owner, the operation, the age, and the remedy. This
is what turns `P0-5`'s "no supported way back" into something a user finds without reading the
source.

### No audit file

The roadmap asks for an audit line on takeover. There is no log destination in the tool home, and
adding one would introduce a file with its own unbounded-growth problem and its own redaction
surface — it would hold paths and pids. The takeover emits a warning through the existing result
payload instead, which is already the structured channel and already renders in both output modes.

---

## 2. Backup retention

### Current state

`createBackup()` builds a directory named `${createTimestamp()}-${reason}` under `backups/`, copies
the flattened managed files in, and writes a `manifest.json` holding an absolute `backupDir`. Names
have one-second resolution. Creation uses `ensureDir()`, which is `mkdirSync` with `recursive: true`
— and `recursive: true` **does not throw when the directory already exists**. So a second mutation
in the same second silently reuses the directory and `copyFileSync` overwrites the first backup's
files and manifest. That is `P0-3`, and its failure mode is silent backup loss: `rollback` then
restores a state that is not the one it claims.

Nothing deletes a backup directory. `restoreManifest()` reads sources from `manifest.backupDir`, and
`rollback <id>` resolves through `loadManifestById()`, which also reads `manifest.backupDir` — so a
manifest is a live reference to its directory from two paths, not one.

### Naming

`createTimestamp()` gains zero-padded milliseconds, and creation becomes **exclusive**: create the
parent with `ensureDir()` as today, then `mkdirSync(candidate, { mode: 0o700 })` **non-recursively**
in a bounded retry loop on `EEXIST`, bumping a suffix.

Non-recursive `mkdirSync` is what makes this correct. A check-then-act ("if the directory exists, try
the next name") is only race-free because the shared lock serializes mutations — and §1 is
simultaneously loosening that lock's failure modes. An exclusive create is race-free on its own
property rather than on a neighbour's, and it keeps the `0700` promise that `ensureDir()`'s secure
mode provides.

### The protected set

Prune never deletes a directory that **any** manifest under `backups/` still names as its
`backupDir`.

The obvious invariant — "keep whatever `latest.json` points at" — is not sufficient. `latest.json`
only guards the no-argument `rollback`; `rollback <id>` resolves through `loadManifestById()` and
then reads `manifest.backupDir` too. A directory pruned while its manifest survives leaves a
manifest that resolves into a path that no longer exists. Deriving the protected set from every
surviving manifest is barely more work and removes the anomaly class entirely.

### Enumeration is not `listBackups()`

Prune enumerates `backups/*` itself rather than reusing `listBackups()`, for two reasons:

- `listBackups()` throws `BACKUP_NOT_FOUND` when the directory is absent or holds no valid manifest,
  so `aps backups prune` on a clean machine would exit 1 for having nothing to do.
- It **skips** directories whose manifest is missing or invalid. Those are exactly the entries a
  crash produces, and skipping them would leave the unbounded-growth bug in place for the one case
  that matters most.

Prune therefore deletes only directories it can validate, **reports** the rest rather than deleting
them, and treats "nothing to prune" as success.

### Ordering

Newest-first by the manifest's `createdAt`, matching `sortBackupList()`. Never by directory name:
with suffixes in play, `…-switch-10` sorts before `…-switch-9` lexically.

### Two entry points, one core

The lock is a non-reentrant file created with an exclusive-create flag. A `pruneBackups()` that
acquires it cannot be called from inside `runMutation()`'s critical section — it would always receive
`EEXIST`, and the best-effort wrapper around the automatic call would swallow that, so **automatic
retention would silently never run**. This is the defect most likely to ship unnoticed, because
every manual test of the command would pass.

So:

- a **lock-free core** that performs the enumeration, protection check, ordering, and deletion;
- a **locking command wrapper** for `aps backups prune`, which must hold the lock — otherwise a
  manual prune in one terminal can delete another terminal's in-flight backup, whose rollback then
  fails on a missing backup file after a partial restore;
- the **automatic call** invokes the core directly, already inside the mutation's lock.

The automatic call is best-effort: a prune failure must never fail a mutation that already succeeded.

### Disclosure

The automatic path is where the one-time reduction happens, so it reports: the mutation's result
payload carries the number of directories removed, and the human renderer prints it as a warning.

### Failed mutations

A mutation that fails and rolls back successfully removes its own backup directory. A mutation whose
**rollback also failed** keeps it — the backup is the only manual recovery route.

This collides with the error payload: `runMutation()` reports `backupPath` on both the
rolled-back path and the `ROLLBACK_FAILED` path. Deleting the directory and still reporting its path
hands the user a location that no longer exists. Resolution:

- **rolled back successfully** — delete the directory, and drop `backupPath` from the payload; the
  rollback succeeded, so the path is no longer a recovery route.
- **`ROLLBACK_FAILED`** — keep both the directory and the path.

One honest sentence belongs in the code comment: `restoreManifest()` restores only the files the
manifest lists, so "rolled back successfully" is not provably "the state is pre-mutation". Deleting
the only evidence on that assumption is a judgement call, not a given.

### `--keep` validation

`--keep` is a valued option, so a bare `aps backups prune --keep` parses as `["--keep",
["true"]]`. `parseInt("true")` must be rejected — along with `0`, negatives, and non-integers — as
`INVALID_ARGUMENT`. `--keep 0` in particular must never be allowed to approach the protected set.

Note that this parsing trap is unchanged by `0.4.0`'s boolean-flag work: `--keep` takes a value and
is not in the boolean set, so it keeps the greedy behaviour.

### Documented strings that go stale

The name format change invalidates the `aps rollback 20260511-221457-switch` example in the
command registry and the same example in `README.md`. Both are release-time edits.

### The one-time reduction

The observed machine holds 97 directories spanning 2026-05-19 to 2026-09-16. The first automatic
prune after upgrade reduces them to 20 — irreversibly, as a side effect of whichever command the user
happens to run. This is **intended**: the roadmap already planned that cleanup, and those directories
hold plaintext provider keys, so removing them is the point of `P0-2` rather than a cost of it. The
requirement that follows is disclosure, not gating.

---

## Cross-cutting changes

**Two new commands need a full surface, not just a handler.** `aps unlock` and
`aps backups prune` each require a `CommandId` entry, a `COMMANDS` entry (and `backups prune`
must resolve as exactly `["backups", "prune"]`), a renderer case in `output.ts` — without one the
human view JSON-dumps the payload through the default branch — a nested-help path, and the command
lists in `docs/Tests/testing.md`, `README.md`, and `docs/cli-usage.md`. This is the bulk of the
release's cost, and it is why `0.4.0` deliberately added no commands.

**`runMutation()`'s `lockPath` default becomes a required parameter.** It currently falls back to a
path inside the Codex directory. The whole design rests on there being exactly one shared lock, and
a future caller that omits the argument would silently create a second one. All nine callers pass it
today, so making it required costs nothing.

**Reconciling with the roadmap's Phase 3 rule.** Phase 3 says machine cleanup "needs explicit
confirmation before touching anything outside the repo". §2's automatic prune deletes tool-home
state without asking, so the two read as contradictory unless the distinction is drawn: that rule
covers **foreign** state — `github-token`, `runtime/`, `tmp/isolated-codex-validation/` — whereas
`backups/` is the tool's own managed state under its own retention policy, and unlike the foreign
leftovers the automatic path reports what it removed.

---

## Testing

Beyond the existing suite — and all of it depending on `0.4.0`'s harness work:

- **Lock takeover** — a child process acquires the lock and calls `process.exit(0)` *inside* the
  critical section. `finally` does not run on `process.exit`, so the lock survives with an exited
  pid; the parent then asserts the next mutation takes over. This replaces the roadmap's `kill -9`
  criterion, which is not executable: `kill -9` does not exist in cmd or PowerShell, and Git Bash's
  `kill` addresses MSYS pids rather than Windows ones.
- **Ownership on release** — a lock whose record names a different pid is not removed by
  `releaseLock()`.
- **Live-owner refusal** — `aps unlock` refuses without `--force` when the recorded pid is alive.
- **Unreadable record** — a truncated lock file is recoverable, not a permanent block.
- **Retention** — 25 mutations leave 20 directories; two mutations in one second leave two
  directories; a directory referenced by a surviving manifest is not deleted; no-argument `rollback`
  still resolves after a prune; `prune` on an empty tree exits 0.
- **`--keep` validation** — missing value, `true`, `0`, negative, and non-integer all rejected.

Each of these needs a fixture that a leaked temp directory or a missing teardown would break or
falsify. That is the concrete reason this release follows `0.4.0` rather than preceding it.

## Implementation Notes

Filled in when the work landed.

### Deviations from this design

**No SKIP path was needed for `migrate`, and the plan to report one was wrong.** The design assumed
its happy path needed a real `codex` binary and would be environment-dependent. It does not:
non-interactive `migrate` always throws, because it needs a TTY rather than a CLI, so its **entire
non-interactive surface is deterministic** and is covered outright — including
`MIGRATE_NO_ADOPTABLE_PROFILES`. The runner still prints a skip count, because a silently skipped
case would hide exactly what this suite exists to expose, but nothing uses it today.

**The stale-lock takeover reports through `warnings`, as designed, and `doctor` reports the two
states under separate codes.** `LOCK_STALE` (owner gone, recoverable) and `LOCK_OCCUPIED` (owner
running) are **issue** codes, not error codes — `unlock`'s refusal is `LOCK_CONFLICT`. Naming them
apart is what lets the renderer's next step differ: the stale case names `aps unlock`, the
occupied case warns against `--force` unless nothing is actually running.

**`--keep` needed its own validation rather than reusing a numeric coercion.** Missing value,
`true`, `0`, negative, and non-integer are all rejected with `INVALID_ARGUMENT`. `0` is rejected
rather than treated as "delete everything", which is the reading that would turn a typo into data
loss.

### What the machine showed

**Retention and takeover both had to be proved against a tree the checkout cannot supply**, which is
the concrete debt `0.4.0` paid off: a killed process is simulated with a pid that cannot exist
(`999999999`), and a same-second collision with two mutations issued back to back.

**The `backups list` / `backups prune` asymmetry on an empty tree** — nothing found versus `kept 0`
and exit 0 — is asserted rather than left implicit, because "prune deleted nothing" and "prune
failed" must not look alike to a caller.

**A tampered manifest must be rejected before its contents are read as a path**, and the test for it
had to read the manifest file rather than the `backups list` summary items. The summary is a
projection, not the manifest, so asserting on it proved the wrong thing: the failure came back
`ROLLBACK_FAILED` instead of `ROLLBACK_PATH_REJECTED`. The containment itself was correct; the first
test of it was not.

**Retention is a one-time reduction for existing users.** The first mutating command run against a
tool home with more than 20 backups prunes to 20, irreversibly, and nothing offers to defer it. That
is the policy working as designed and it is why the E2E suite never points at a real tool home.
