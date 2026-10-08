# agent-provider-switch v1.0.0 Design Document

**Tool identity rename.** First release of the `1.x` line, and the only one permitted to break the
interface. No architecture change: both registries, the projection model, the lock discipline, and
the `0.3.1` security contracts are untouched. The command surface, the JSON envelope, and every
successful write path are identical to `0.4.1`.

Its companion is `docs/Design/agent-provider-switch-v0.4.1-design.md` (stale-lock recovery, backup
retention).

**Citation convention.** This document names symbols (`migrateLegacyToolHome()`,
`createToolHomePaths()`) rather than line numbers. Every `file:line` citation in the roadmap drifted
within a single release, and a document that is wrong within one commit is worse than one that is
vague.

This release closes no roadmap finding. It is the change that makes the `2.x` roadmap's
target-generalization items describable without a target name baked into them.

## Overview

The rename is mechanically large and conceptually small: one string becomes another, in every place
the string appears. The two things that make it more than a find-and-replace are the ones that decide
this document's shape.

**The literals are not all in one place.** The tool home is built by `createToolHomePaths()`, but two
call sites rebuilt parts of it by hand: `dispatch.ts` assembled the tool-config path inline, and
`claude-handlers.ts` assembled the lock path, backups directory, and latest-manifest path inline —
including the lock filename as a literal. That duplication is exactly how an identity rename leaves
one spot stale, so it is removed *first*, with every value unchanged, as a behaviour-preserving
commit. Only then does the string actually change.

**One of the old names is on disk, and it holds the user's data.** The pre-`1.0.0` tool home contains
`providers.json`, `claude-providers.json`, `backups/`, and possibly a `github-token`. Renaming the
tool without moving that directory would leave every existing install reading a fresh, empty home —
a data-loss bug wearing a rename's clothes. So this release carries one piece of genuinely new
behaviour: `src/storage/tool-home-migration.ts`.

Everything else follows from a single rule: **long names for the eye, short names for the hand.** The
directory keeps the descriptive name; everything typed (`aps`, `APS_*`) is short. The lock file is
short because it is internal and never typed.

---

## 1. Centralizing the identity

Before any value changes, the naming moves into `src/storage/codex-paths.ts`:

- `TOOL_HOME_DIRNAME`, `TOOL_CONFIG_FILENAME`, `LOCK_FILENAME` — the current names.
- `LEGACY_TOOL_HOME_DIRNAME`, `LEGACY_TOOL_CONFIG_FILENAME`, `LEGACY_LOCK_FILENAME` — the pre-`1.0.0`
  names, **frozen**. They describe a location that already exists on a user's disk. They are only ever
  read.
- `createToolHomePaths()` returns `toolHomeDir`, `toolConfigPath`, `providersPath`, `backupsDir`,
  `latestBackupPath`, `lockPath` — everything derivable from the tool home alone.
- `createCodexPaths()` becomes a thin wrapper that spreads `createToolHomePaths()` and adds
  `codexDir`, `configPath`, `authPath`.

The split matters beyond tidiness. Claude commands need the tool home — the lock and the `backups/`
tree are shared between both targets — but cannot build a `CodexPaths`, which cannot be constructed
without a Codex directory. That is why `claude-handlers.ts` grew its own copies in the first place.

Two things are deliberately *not* folded in: `createClaudePaths`, which owns a different target, and
the resolver `resolveToolHome()` — renamed in this release, but still pure.

The one shared helper the migration needs but `fs-utils.ts` kept private —
`renameWithRetryOnWindows()` — is exported so the migration module reuses the same Windows transient-
rename handling as the atomic writer, rather than growing a second copy.

The dead trees are out of scope. `src/infra/` and the unreachable `src/cli/{args,help,interactive,
prompt,add-interactive}.ts` contain none of the rename literals and are slated for deletion
(`P2-1`). A replacement that reached them would be invisible to the suite and would read as a
regression in the diff.

## 2. The scope of the replacement

**`codex` alone is not in scope.** Only the tool's own name tokens are: the home directory name, the
state filenames, the env-var prefix, and the bin name. A blanket `codex` replacement corrupts the
Codex integration itself: `--codex-dir`, `~/.codex`, `[model_providers.*]`,
`src/runtime/codex-cli.ts`, `MIN_SUPPORTED_CODEX_VERSION`. The word matches both the tool and one of
the two things the tool manages, and the replacement has to know the difference.

The repo-name replacement is likewise word-bounded, so `codex-switcher` — an unrelated third-party
project cited in the product-research doc — is never touched.

## 3. Legacy tool home migration

`migrateLegacyToolHome({ newHomeDir, legacyHomeDir })` takes both directories as arguments so a test
can drive it against temp paths; `ensureLegacyToolHomeMigrated()` is the production wiring, deriving
both the current and the pre-`1.0.0` tool home from `os.homedir()`.

**One hook, both targets.** It is called once at the top of `executeCommand()` in
`src/commands/dispatch.ts`. Dispatch is the single funnel: every registry entry is reached through
`handleRegisteredCommand()`, and `handleClaudeCommand()` only through that, so one hook covers Codex
and Claude alike — including `unlock`, which resolves the lock from the tool home and would otherwise
be recovering the wrong one.

It is explicitly **not** inside `resolveToolHome()`. That resolver is called three or four times per
process (dispatch, the Claude handler, inside `createCodexPaths`, inside `resolveLockPath`); a
mutation there would run repeatedly, add probes to a hot path, have no warning channel, and make a
documented precedence order silently non-idempotent.

### Guards

The migration runs only when **all** of these hold. Anything else is a silent no-op.

1. **`APS_HOME` is unset.** This check happens before any filesystem call, and it is the single thing
   standing between a bug in this module and the developer's real `~/.config`. An explicit override
   always wins. It is also what keeps the test suite honest: `runBuiltCli()` sets `APS_HOME` for every
   invocation, so a spec that never mentions migration cannot reach a real home through this path.
2. **The new home does not exist.** Whether it holds migrated data or is empty, it wins.
3. **The legacy home exists and is a directory.** This is also the check that makes the path
   comparison safe — without it, a typo'd directory would be renamed into existence.
4. **The legacy lock has no live or foreign owner.** `inspectLock()` (the same reader `doctor` uses)
   classifies the record. `dead`, `unreadable`, `malformed`, and `absent` are all residue and move;
   `live` and `foreign` defer.

The live-lock guard exists because a pre-rename process that is still running is a concurrent writer
against this home, and moving the directory out from under it leaves two writers on two different
files. Unlike the both-homes case, this condition is transient and actionable, so it warns: *left the
legacy tool home in place; re-run once that operation has finished.*

### Ordering: files first, directory last

```
renameWithin(legacyHomeDir, LEGACY_TOOL_CONFIG_FILENAME, TOOL_CONFIG_FILENAME)
renameWithin(legacyHomeDir, LEGACY_LOCK_FILENAME, LOCK_FILENAME)
renameWithRetryOnWindows(legacyHomeDir, newHomeDir)
```

This ordering is load-bearing, not stylistic. The directory rename is the only step that cannot be
retried: once it lands, guard 2 sees the new home and every later run is a no-op. Renaming the
directory *first* would be a genuine bug — a failure on the inner file renames would leave the
config under its old name inside a home whose existence permanently satisfies guard 2, so no retry
would ever happen and the tool would read the migrated data as a fresh install. Putting the retryable steps
first means an interrupted run is picked up cleanly next time; both file renames are idempotent
(`existsSync(from) && !existsSync(to)`).

The lock file is **renamed, never deleted**. Deleting it would destroy the record that stale-pid
detection in `lock-repo.ts` reads, which is the one thing that lets a subsequent command distinguish a
dead owner from a live one.

### Failure handling

The move is a same-filesystem directory `rename`: the data is never copied, the legacy home is never
deleted, and the two homes are never merged.

| Outcome | Handling |
|---|---|
| `ENOENT` on the source | Another process completed the move first. Report success. |
| `EEXIST` / `ENOTEMPTY` on the destination | The new home appeared mid-flight. Report no-op — both homes exist, and the rule for that state is to leave both alone. |
| Anything else | Warn loudly, naming both paths and the consequences: providers and backups are still under the legacy path, and a write command started now would create an empty new home. |

A migration failure is never a hard error. Making it one would brick every command on an unmovable
legacy home, which is worse than the condition it reports.

### Surfacing

The library never writes to stdout directly. Dispatch merges the migration warnings into the
command's `CommandResult`, and the existing renderers already emit `Warning: <text>` in human mode and
a `warnings` array under `--json`. No new output path.

One accepted limitation: if the command then throws, `renderFailure` hardcodes `warnings: []`, so the
migration notice is dropped in that case.

### What is deliberately not rewritten

`providers.json`, `claude-providers.json`, backup contents, and the tool config's `version` field all
keep their existing content. Only names change. The `version` field is validated as a non-empty string
and never compared against the running version, so a migrated home still reading `"0.4.1"` is valid;
`ensureToolConfig()` leaves an existing config untouched.

`--help` and `--version` bypass dispatch entirely in `src/cli.ts`, so they do not migrate. That is
correct: an informational command should have no side effects.

## 4. Residual risks

- **Orphan on a failed rename — the one hole.** If the directory rename fails persistently and a later
  write command then creates an empty new home, both homes exist, guard 2 and the both-homes no-op
  agree to skip migration forever, and every write goes to the new home while the real data sits in
  the legacy one. Mitigations: the Windows rename retry covers the realistic transient case, this
  module never creates the new home itself, and the failure warning names the legacy path. Recovery
  from a persistent failure is manual, and that is accepted.
- **Pre-rename backups and rollback containment.** `backups/latest.json` manifests record absolute
  paths. `restoreManifest()` resolves every restore path inside a caller-built allowlist derived from
  the *new* tool home, so restoring a backup taken before the rename can fail
  `ROLLBACK_PATH_REJECTED`. The honest fix, if it bites, is to prune pre-rename backups — not to widen
  the allowlist for paths a manifest chose.
- **In-flight legacy process.** Guard 4 narrows the window but cannot eliminate it: a pre-rename
  process that acquires the legacy lock after the guard reads it. On POSIX the rename can succeed out
  from under it; on Windows it typically fails `EPERM`/`EBUSY` and is retried.
- **`withCodexLock()` keeps its name.** It guards the lock shared by both targets, so the name is
  already slightly wrong — more so now that the tool is not Codex-specific. Renaming it is a
  mechanical follow-up, not part of this change.

## 5. Release mechanics

- `package.json`: `name`, `bin` (`aps`), version, `description`, `keywords`, and the `repository` /
  `bugs` / `homepage` URLs. `package-lock.json` carries the identity in five spots — the root
  `name`/`version`, the `packages[""]` `name`/`version`, and the `bin` map.
- No version constant in `src` needs editing: `src/cli.ts` and `src/commands/handlers.ts` both read
  `require("../../package.json").version` at runtime.
- `tests/release-contract.spec.js`: version literals, the `--version` assertion, the version regex,
  the five-version doc-existence window, and the fact-source path list.
- `CHANGELOG.md` entry; version strings in `README.md`, `README.CN.md`, `README.AI.md`,
  `docs/cli-usage.md`, `docs/Tests/testing.md`.
- All prior `docs/PRD/*` and `docs/Design/*` files renamed by filename via `git mv`, bodies intact.
- The GitHub repo rename, `npm publish`, and any `npm deprecate` of the old package are manual steps
  outside this change.

## 6. Acceptance criteria

- `npm run build && npx tsc --noEmit && node tests/run-tests.js` is green.
- `aps --version` prints `1.0.0`; `aps --help` never mentions the old program name.
- Migration, against temp directories: legacy-only moves (directory *and* both inner files);
  new-only, both-exist, and neither-exist are no-ops; `APS_HOME` set performs no filesystem access to
  a legacy path; a live legacy lock defers.
- Against the real home, once, after a manual backup: `aps list --json` reports the same providers the
  old binary did, and the old tool home no longer exists.
- `aps doctor` on both targets; `aps rollback` against a backup taken *after* the rename.
- `npm pack --dry-run` lists the same publishable set apart from the rename.
