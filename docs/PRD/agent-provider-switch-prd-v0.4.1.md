# codex-switch v0.4.1 PRD

## Summary

`0.4.1` is the second of two releases on the `0.3.x → 0.4.x` line of `@minniexcode/codex-switch`. It
carries the two stateful P0 items from Phase 2:

1. A killed process leaves a lock that blocks every future write, permanently.
2. Backups grow without bound and duplicate secrets; same-second mutations silently overwrite each
   other's backup.

Two commands are added: `codexs unlock [--force]` and `codexs backups prune [--keep N]`.

It ships **after** `0.4.0` deliberately. Both items change a recovery path — one takes over a lock
another process left behind, the other deletes directories — and both need the deterministic crash
fixture and reliable temp-directory teardown that `0.4.0` built. Landing them on the old harness
would mean the riskiest change in the line arriving with the least reliable verification.

Source of record for the findings: `docs/agent-provider-switch-2.x-roadmap.md` §2 — `P0-5` (stale lock),
`P0-2` (unbounded backups), `P0-3` (same-second collision). Design detail:
`docs/Design/agent-provider-switch-v0.4.1-design.md`.

## Version

- Version line: `0.4.1`
- Predecessor: `0.4.0`
- Status: **planned.** This document and its Design are the review artifacts; implementation begins
  only after they are approved and `0.4.0` has shipped. Nothing described here exists in the tree
  yet.

## Goals

- **Recover from a stale lock without manual file deletion.** A process killed between lock acquire
  and release must not lock the user out of their own tool.
- **Take over a lock only when the owner is provably gone.** A live owner — including one that is not
  distinguishable from live — is never seized from. A false takeover corrupts state where a false
  conflict only inconveniences.
- **Bound backup growth.** Ship a retention policy with both an automatic and a manual path, make
  same-second mutations produce distinct backups, and stop failed mutations from accumulating
  directories.
- **Never delete a backup that is still a recovery route.** The retention rule is derived from every
  surviving manifest, not only the newest one.

## Non-Goals

- **No TTL-based takeover.** A slow `migrate` can exceed any timer. The consequence is stated rather
  than hidden: a recycled pid is fail-closed, and `codexs unlock --force` is the documented way out.
- **No audit-log subsystem.** The takeover reports through the existing result payload. A new
  on-disk log would carry its own unbounded-growth and redaction problems.
- **No change to the lock's location or to the one-lock-for-both-targets model.** Codex and Claude
  operations continue to share one lock file and one `backups/` directory.
- **No change to the backup manifest format.** Only the directory naming and the lifecycle around it.
- **No `runMutation()` restructure beyond the failed-mutation cleanup and the automatic prune call.**
  The wrapper's lock → backup → mutate → rollback shape is unchanged.
- **Unchanged from `0.3.1`:** the secret-handling contract, the file-permission model, and rollback
  containment.

## Command Surface

**New:**

- `codexs unlock [--force]` — clears a lock left by a process that no longer exists. Refuses when the
  recorded owner is still alive unless `--force` is given. Idempotent: no lock present is success.
- `codexs backups prune [--keep N]` — deletes old backup directories, newest-first, keeping `N`
  (default 20). Never deletes a directory a surviving manifest still names.

**Changed:**

- Backup directory names gain zero-padded milliseconds, and creation becomes exclusive.
- Every mutating command reports how many backups retention removed.
- A mutation that fails and rolls back successfully no longer leaves its backup directory behind.
- `doctor` reports an occupied or stale lock.

**Unchanged:** the existing command set, the JSON envelope shape, and every successful write path.

## Stale-Lock Recovery

Both targets share one lock file. Today the lock records its owner's pid but nothing ever reads it
for liveness, and there is no force path — the only recovery is deleting the file by hand.

- On conflict, the recorded pid is probed. A pid that does not exist means the owner is gone, so the
  lock is taken over with a warning naming what was removed.
- A pid that exists — including one owned by another user, which is not distinguishable from a live
  operation — is **never** taken over automatically. A long-running mutation must not be killed by a
  timer, so there is no TTL-based takeover.
- A record that cannot be read (a truncated write from a hard kill) is treated as its own state
  rather than as "unknown owner", because that is the most likely residue of the very crash this
  feature exists to recover from.
- `codexs unlock` is the explicit escape hatch for every remaining case, including a recycled pid
  that now belongs to an unrelated live process. It reports what it removed and is safe to run when
  no lock exists.
- `doctor` reports an occupied or stale lock, with the owner and the remedy, so the condition is
  discoverable rather than mysterious.

**Acceptance:** a process that acquires the lock and exits inside the critical section leaves a lock
that the next mutation takes over automatically. `codexs unlock` clears an occupied lock only with
`--force`, and succeeds when there is nothing to clear.

## Backup Retention

The observed machine holds 97 backup directories spanning four months, every one containing
plaintext provider keys. Nothing ever deletes one, and two mutations in the same second resolve to
the same directory name, so the second silently overwrites the first's files and manifest.

- `codexs backups prune [--keep N]` deletes the oldest directories beyond the retention count.
- The same retention runs automatically after every successful mutation.
- **The first automatic run reduces the existing 97 directories to 20.** This is irreversible. It is
  intended — those copies hold plaintext keys and removing them is the point of `P0-2` — but the
  command reports the number removed as a warning so the effect is disclosed rather than silent.
- A directory that any surviving manifest still names as its own location is never deleted, because
  `rollback` resolves through that path.
- Directories whose manifest is missing or unreadable are reported rather than deleted, so a crash's
  residue is visible instead of accumulating indefinitely.
- New directory names carry milliseconds, and creation is exclusive, so a name that already exists
  causes a new name rather than a silent reuse.
- A mutation that fails and rolls back successfully removes its own backup directory, so failed
  attempts stop accumulating. A mutation whose rollback also failed keeps the directory, because the
  error names it as the manual recovery path.

**Acceptance:** after 25 mutations, `backups/` holds 20 directories. Two mutations in the same
second produce two distinct directories. A `rollback` with no argument still resolves after a prune.
`codexs backups prune --keep 5` on a directory tree with 3 backups removes nothing and exits 0.

## Release Mechanics

- `package.json` and both `package-lock.json` version fields.
- `docs/PRD/agent-provider-switch-prd-v0.4.1.md` and `docs/Design/agent-provider-switch-v0.4.1-design.md` exist, which
  the release contract asserts for the current line.
- `tests/release-contract.spec.js` version assertions and its version regex.
- `CHANGELOG.md` entry.
- Version strings in `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, and
  `docs/Tests/testing.md`, plus the two new commands and the new flags in each.

## Acceptance Criteria

**Lock**

- A process that acquires the lock and exits inside the critical section leaves a lock the next
  mutation takes over, with no manual file deletion.
- A lock whose owner is alive is never taken over automatically.
- `releaseLock()` does not remove a record it does not own.
- An unreadable lock record is recoverable, not a permanent block.
- `codexs unlock` clears an occupied lock only with `--force`; it succeeds and is a no-op when no
  lock exists.
- `codexs doctor` reports an occupied or stale lock.

**Backups**

- After 25 mutations, `backups/` holds 20 directories.
- Two mutations in the same second produce two distinct directories.
- A directory referenced by a surviving manifest is never deleted.
- No-argument `rollback` still resolves after a prune.
- `prune` on an empty or absent `backups/` exits 0.
- `--keep` rejects missing values, `true`, 0, negatives, and non-integers.
- A failed-and-rolled-back mutation leaves no backup directory behind; a failed rollback does.

**Build and test**

- `npx tsc --noEmit` passes.
- The full suite passes on Windows and Linux, Node 20 and 22, with no leftover temporary directories.
- `npm run build` passes without errors.
