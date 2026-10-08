# agent-provider-switch v1.0.0 PRD

## Summary

`1.0.0` renames the tool. It is the first release of the `1.x` line, and it is the one release on
that line allowed to break the interface, because it is the rename.

The tool began as a Codex-only provider switcher, so its whole identity was built around the word
`codex`: the repository, the npm package, the binary, the tool home, the environment variables, and
the state filenames. It has since grown a second, independent target — Claude Code, via `--claude`
and a parallel `claude-providers.json` — and the command registry makes a third target a natural
next step.

Naming a tool after one of its targets is a bet that keeps losing. This release pays the rename cost
once, in a single breaking version, so the name stops tracking whichever CLI is supported today.

The rename is complete and unaliased: the old binary name is removed rather than kept as a
forwarding shim. The one concession to existing installs is that a tool home left at the
pre-`1.0.0` location is moved to the new one automatically, because that directory holds the user's
provider records, secrets, and backups — a rename that stranded them would be data loss, not a
rename.

Design detail: `docs/Design/agent-provider-switch-v1.0.0-design.md`. This release closes no roadmap
finding; it is the naming change that makes the `2.x` roadmap's target-generalization work
(`P2-*`) describable without a target name baked into it.

## Version

- Version line: `1.0.0`
- Predecessor: `0.4.1`
- Status: **implemented.** The rename, the migration, and the release mechanics all land in the same
  change; there is no staged rollout, because a half-renamed tool is worse than either endpoint.

## Rename Map

| Artifact | Before | After |
|---|---|---|
| repository / npm package | `codex-switch` / `@minniexcode/codex-switch` | `agent-provider-switch` / `@minniexcode/agent-provider-switch` |
| binary | `codexs` | `aps` |
| tool home | `~/.config/codex-switch` | `~/.config/agent-provider-switch` |
| tool config file | `codex-switch.json` | `agent-provider-switch.json` |
| lock file | `.codex-switch.lock` | `.aps.lock` |
| environment variables | `CODEXS_HOME` / `CODEXS_CODEX_DIR` / `CODEXS_CLAUDE_DIR` | `APS_HOME` / `APS_CODEX_DIR` / `APS_CLAUDE_DIR` |
| domain type | `CodexSwitchConfig` | `AgentProviderSwitchConfig` |
| resolver | `resolveCodexSwitchHome()` | `resolveToolHome()` |
| lock wrapper | `withCodexLock()` | `withToolLock()` |

The split follows one rule: **long names for the eye, short names for the hand.** A directory name is
read rarely and a command is typed constantly, so the directory keeps the descriptive name while
everything typed — `aps`, `APS_*` — stays short. The lock file is short because it is purely
internal and never typed.

**The GitHub repository rename is a manual step outside this change.** The `repository`, `bugs`, and
`homepage` URLs in `package.json` are updated to the new name here; GitHub redirects the old URLs in
the meantime, so the order between the two does not matter. Publishing — `npm publish`, and any
`npm deprecate` of the old package — is likewise a manual step.

## Goals

- **One identity, in one place.** Every literal that names the tool resolves through
  `src/storage/codex-paths.ts`, so the next identity change is one edit rather than a hunt.
- **No silent straddle.** The old binary name is gone, not aliased. A user with it still installed
  gets a clear `command not found`, not two binaries that disagree about which tool home is
  authoritative.
- **The existing tool home survives the rename.** A home left at the pre-`1.0.0` location is moved to
  the new one, so `providers.json`, `claude-providers.json`, and `backups/` continue to be the state
  the tool reads and writes.
- **The move is never destructive and never a merge.** Move, or do nothing. There is no path in which
  the tool copies-then-deletes, overwrites a new home, or unlinks the legacy directory.
- **Configuration overrides still win.** A tool home named explicitly by `APS_HOME` is never
  migrated, never probed, and never second-guessed.

## Non-Goals

- **No alias or shim for the old binary name.** A forwarding script would keep it in `PATH`, in
  documentation, and in shell history indefinitely, which is the cost this release exists to stop
  paying.
- **No change to the command surface.** Every command, flag, and JSON envelope field is unchanged.
  The only user-visible difference is the program name and the state locations.
- **No rewrite of `providers.json`, `claude-providers.json`, the tool config's `version` field, or
  backup contents.** Only names change. A migrated home keeps whatever `version` string it already
  had, which is valid: that field is never compared against the running version.
- **No merging of two tool homes.** If both the legacy and the new home exist, the tool uses the new
  one and leaves the legacy one alone. It does not warn either — with no one-shot marker the warning
  would repeat on every command, and `doctor` is the right home for that signal if it is ever wanted.
- **No preservation of the old name in prior records.** The `docs/PRD/*` and `docs/Design/*` files of
  prior releases are reissued under the new name — filenames and prose alike — so that no document in
  the repository reads as a different tool. They remain records of the releases they describe; only
  the name they were written under changes.
- **No pre-`1.0.0` backup guarantee.** A backup manifest taken before the rename records absolute
  paths under the old tool home. Rollback containment resolves every restore path inside the roots
  the caller supplies, and those roots are derived from the *new* tool home, so a pre-rename backup
  can be rejected with `ROLLBACK_PATH_REJECTED` rather than restored.

## Legacy Tool Home Migration

The first command that runs after an upgrade moves the pre-`1.0.0` tool home to the current one, so
a user does not have to know the rename happened. It runs at the top of the dispatch funnel, which
every registered command passes through, so it covers both targets — including `unlock`, which reads
the lock from the tool home and would otherwise recover the wrong one.

The migration runs only when **all** of these hold:

1. `APS_HOME` is unset. An explicit override wins, and this check happens before any filesystem call.
2. The new tool home does not exist.
3. The legacy tool home exists and is a directory.
4. The legacy lock has no live or foreign owner. A lock whose recorded process is gone — or which is
   absent, unreadable, or malformed — is safe to move.

Anything else is a no-op. Inside the legacy home, the tool config and the lock file are renamed to
their current names **before** the directory itself is renamed. The directory rename is the only
irreversible step, so everything retryable precedes it: if the rename fails, the legacy home stays
intact with the new filenames inside it, and the next command retries cleanly.

`--help` and `--version` do not migrate, because `src/cli.ts` resolves them before dispatch. An
informational command should have no side effects.

**Acceptance:** on a machine with only the pre-`1.0.0` tool home, the first `aps` command leaves the
providers readable from `~/.config/agent-provider-switch` and the legacy directory absent. With
`APS_HOME` set, no legacy path is touched at all.

## Release Mechanics

- `package.json` and both `package-lock.json` version fields.
- `package.json` `name`, `bin` (`aps`), `description`, `keywords`, and the `repository` / `bugs` /
  `homepage` URLs.
- `docs/PRD/agent-provider-switch-prd-v1.0.0.md` and
  `docs/Design/agent-provider-switch-v1.0.0-design.md` exist, which the release contract asserts for
  the current line.
- `tests/release-contract.spec.js` version assertions, its version regex, its doc-path existence
  window, and its fact-source path list.
- `CHANGELOG.md` entry.
- Version strings and the new names in `README.md`, `README.CN.md`, `README.AI.md`,
  `docs/cli-usage.md`, and `docs/Tests/testing.md`.
- All prior release docs reissued under the new name — filenames and prose alike, so no document in
  the repository reads as a different tool. The Rename Map above is the only place the old
  identifiers are written down.

## Acceptance Criteria

**Identity**

- `aps --version` prints `1.0.0`; `aps --help` shows `aps` and never the old program name.
- No tracked file names the old identity, with exactly three deliberate exceptions: the Rename Map
  above, the frozen `LEGACY_*` constants that the migration must match against what is already on a
  user's disk, and the negative-assertion pattern in `tests/release-contract.spec.js`. The unrelated
  third-party project `codex-switcher` cited in the product-research doc is a different name and is
  untouched.
- `npm install -g @minniexcode/agent-provider-switch` puts `aps` on `PATH`.

**Migration**

- A legacy-only machine moves, and both inner files are renamed in place rather than rewritten.
- A machine with both homes, or with neither, is a no-op.
- `APS_HOME` set means no filesystem access to a legacy path.
- A live legacy lock defers the move rather than migrating under a running process.
- A persistent rename failure warns, naming the legacy path, and never removes or copies data.
- `aps rollback` works against a backup taken **after** the rename.

**Build and test**

- `npx tsc --noEmit` passes.
- The full suite passes on Windows and Linux, Node 20 and 22, with no leftover temporary directories.
- `npm run build` passes without errors.
- `npm pack --dry-run` lists the same publishable set apart from the rename.
