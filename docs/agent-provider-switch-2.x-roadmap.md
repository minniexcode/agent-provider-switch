# agent-provider-switch 2.x Roadmap

A review of `@minniexcode/agent-provider-switch` as of `0.3.1`, plus a phased plan for the 0.3.x → 0.4.x line.

This is a **decision document**, not a fact source. It is deliberately not wired into the version
assertions in `tests/release-contract.spec.js`.

Every claim below cites `file:line` and was verified against the working tree, not inferred.

**Issue IDs are cited from PRD and Design documents and must not be renumbered.** Findings that get
fixed keep their ID and gain a **Fixed in** marker. This file previously handled that two different
ways — the file-permission finding was *deleted* from this inventory when `0.3.1` fixed it, which
shifted `P0-3`…`P0-7` up by one and silently invalidated every `P0-*` citation in the already-shipped
`0.3.1` PRD and Design.

---

## 1. Where We Are

**Version.** The repository, `package-lock.json`, and the npm `latest` dist-tag are all at **`0.3.1`**
(`package.json:3`). `0.3.1` was published 2026-09-20 as the secret-handling patch over `0.3.0`
(2026-07-17, the "Claude Code provider switching release"). There is no 2.0; the project is on a
0.x line.

**Shape.** 7,402 lines of TypeScript across 72 files. One runtime dependency: `inquirer`.
The 0.1.x copilot-sdk / HTTP bridge / proxy runtime was fully removed in 0.2.1
(`CHANGELOG.md:34`) and `package-lock.json` is clean — no SDK packages remain.

**Two targets, one tool home.**

| | Codex (default) | Claude Code (`--claude`) |
|---|---|---|
| Registry | `providers.json` | `claude-providers.json` |
| Projection | `~/.codex/config.toml` + `auth.json` | `~/.claude/settings.json` (atomic replace) |
| Record | `{ profile, apiKey, model?, baseUrl?, note?, tags? }` | `{ settings: {...}, note?, tags? }` |
| Commands | all 18 | 6 (`add` `switch` `list` `show` `current` `remove`) |

The `--claude` flag is a **parallel code path**, early-returned from `handleRegisteredCommand()`
before any Codex logic runs (`src/commands/handlers.ts:49-56` → `src/commands/claude-handlers.ts:53`).
This was a deliberate choice in the 0.3.0 design and this roadmap keeps it.

**Observed state on a real machine.** These numbers drove several findings below:

- `~/.config/agent-provider-switch/backups/` holds **97 directories plus `latest.json`, 864 KB**.
- `claude-providers.json` holds 4 profiles (`copilot`, `copilot-pool`, `copilot-gpt`, `deepseek`).
  **Every one contains `ANTHROPIC_AUTH_TOKEN`**; `deepseek` also contains `ANTHROPIC_API_KEY`.
- `claude-providers.json` reports mode **`0666`** to MSYS `stat`. **That number is a synthetic
  POSIX view, not a real permission** — the real exposure is an ACL one, described in the `0.3.1`
  Design document's Implementation Notes. It was never in this inventory.
- Leftovers from the removed integration are still on disk and are never read or cleaned up:
  `~/.config/agent-provider-switch/github-token` (40 chars, shaped like a real GitHub PAT),
  `~/.config/agent-provider-switch/runtime/copilot-bridge-state.json`, `.../copilot-bridge.log`.

---

## 2. Issue Inventory

### P0 — Security and data correctness

#### P0-1 · `show --claude` prints auth tokens in plaintext

**Fixed in `0.3.1`.** Masked by default, with the global `--reveal` as the escape hatch.

`claudeShowProvider()` returns the raw `env` map **and** the complete `settings` blob
(`src/app/claude-show-provider.ts:25-26`), and the human renderer prints every env entry verbatim
(`src/cli/output.ts:392-398`). `--json` carries the same payload.

The Codex side does this correctly — `showProvider()` masks `apiKey` unless `includeSecret` is set
(`src/app/show-provider.ts:16-19`, `maskSecret()` at `src/domain/providers.ts:147-155`), and the
registry documents the guarantee (`src/commands/registry.ts:103`).

**Impact.** Every Claude profile on the observed machine carries a token, so
`aps show --claude deepseek` prints a live credential into terminal scrollback, screenshots,
piped logs, and CI output.

**Fix (decided): mask by default, add `--reveal`.**

#### P0-2 · Backups grow without bound and duplicate secrets

There is no prune, retention, or cleanup logic — `grep -rn "prune\|retention\|maxBackups\|cleanup" src/`
returns nothing. Every mutation copies the full previous state into a new directory
(`src/storage/backup-repo.ts:11-53`), including `providers.json` and `auth.json`, which hold keys.

**Impact.** 97 directories / 864 KB on the observed machine after a few months, containing an
unbounded plaintext key history. Nothing ever removes them.

#### P0-3 · Backup directory names collide within the same second

`createTimestamp()` has one-second resolution (`src/storage/backup-repo.ts:205-217`) and the backup
directory is `${timestamp}-${reason}` (`:17`). Two mutations with the same operation inside one
second resolve to the same path, and `ensureDir` succeeds silently (`:19`), so the second run
**overwrites the first backup's files and manifest**.

**Impact.** Silent backup loss. `rollback` then restores a state that is not the one it claims.

#### P0-4 · The "atomic" write is not atomic, and one write bypasses it entirely

**Fixed in `0.3.1`.** The redundant `rmSync` is gone, and `writeOpenAiApiKeyAuth()` now goes
through the helper.

`writeTextFileAtomic()` deletes the target and then renames the temp file over it
(`src/storage/fs-utils.ts:15-24`). The `rmSync` is what breaks atomicity — Node's `renameSync`
already replaces existing files on both Windows and POSIX. Between the `rm` and the `rename` the
target does not exist.

Separately, `writeOpenAiApiKeyAuth()` does not use the helper at all: it is a bare
`fs.writeFileSync` (`src/storage/auth-repo.ts:83`), making it the only non-atomic write on the
mutation path.

**Impact.** A concurrent reader can observe a missing file. A failed write to `auth.json` leaves it
truncated.

#### P0-5 · A stale lock blocks every write forever

`acquireLock()` records the owner's pid (`src/storage/lock-repo.ts:8-12`, `:30-49`) but nothing ever
reads it for liveness. There is no TTL and no force-unlock path. If the process is killed between
acquire and release, the lock file persists and **every subsequent write command** returns
`LOCK_CONFLICT` permanently. The only recovery is manually deleting
`~/.config/agent-provider-switch/.aps.lock`.

**Impact.** The user is locked out of their own tool with no supported way back.

#### P0-6 · Backup manifests are trusted for absolute restore paths

**Fixed in `0.3.1`.** `restoreManifest()` now requires a caller-supplied `allowedRoots`.

`restoreManifest()` copies to whatever absolute path the manifest names
(`src/storage/backup-repo.ts:58-81`), and `validateBackupManifest()` checks types only, never path
safety (`src/domain/backups.ts:22-64`). A tampered or corrupted `manifest.json` under `backups/`
turns `rollback` into an arbitrary file write.

**Impact.** Low likelihood, high consequence. Worth a containment check (restore only into the
recorded target directories).

---

### P1 — Correctness, robustness, portability

#### P1-1 · Boolean flags are parsed as value-taking options

The argument parser treats any `--x` followed by a non-`--` token as `--x <value>`
(`src/commands/args.ts:78-101`). So:

```
aps remove --force packycode     # "--force" swallows "packycode"
```

leaves `positionals` empty (`src/commands/handlers.ts:301-303`), and the command falls through to an
interactive prompt or a "missing provider name" error.

This is the **root cause** of the `resolveClaudeProviderName()` workaround
(`src/commands/claude-handlers.ts:37-48`), whose own doc comment admits it exists to normalize the
parser's behaviour.

There is no notion of a boolean flag anywhere in the command registry.

#### P1-2 · `getSingleOption`'s `required` parameter is dead

```ts
return required ? null : null;   // src/commands/args.ts:162
```

Both branches return `null`. Callers that rely on the default (`required = true`) to enforce
presence — `src/commands/handlers.ts:181-182` — silently receive `null` instead of an error.

#### P1-3 · Unknown commands exit 0

An unresolvable token leaves `parsed.command === null`, which prints full help and calls
`process.exit(0)` (`src/cli.ts:52-55`). A typo like `aps lst` looks like success to any script
or CI job.

#### P1-4 · Synchronous parse errors bypass the error envelope

`parseArgs()` throws synchronously (`src/commands/args.ts:25`), and `main()`'s synchronous section
has no `try`/`catch` (`src/cli.ts:27-28`). `aps --codex-dir` with no value produces a raw stack
trace instead of the structured failure envelope, breaking the `--json` automation contract.

#### P1-5 · `status` renders a field that is never populated

`src/cli/output.ts:165` reads `data.storage.toolHome.root`, but `getStatus()` never returns a
`storage` key. The line always renders empty.

#### P1-6 · A computed value in `import` is discarded

`src/commands/handlers.ts:136-145` builds `buildManagedProfileViews(...).filter(...).map(...).sort()`
and throws the result away. The comment says the intent is to fail before mutation — but that is
already achieved by the `readStructuredConfig()` / `validateProvidersShape()` calls above it. The
chain itself is dead.

#### P1-7 · `export` writes plaintext keys with no warning

**Fixed in `0.3.1`.** The payload reports `containsSecrets` and the command warns.

`exportProviders()` serializes the whole registry — including `apiKey` — to any user-specified path
with no caution (`src/app/export-providers.ts:11-34`); the result payload reports only
`{ exportedTo, count }`.

#### P1-8 · Error-detail masking only matches the substring `"apikey"`

**Fixed in `0.3.1`.** Redaction walks the whole detail tree against the shared key pattern.

`printErrorDetails()` skips detail keys whose lowercase name contains `apikey`
(`src/storage/fs-utils.ts:52-66`). `token`, `authorization`, `secret`, `api_key`, `auth_token` all
pass through, and nested objects are `JSON.stringify`'d wholesale.

Given Claude settings use `ANTHROPIC_AUTH_TOKEN`, this is the same class of leak as P0-1 via a
different route.

#### P1-9 · Tests are not portable, and the Claude path has zero coverage

`tests/` contains `run-tests.js`, `helpers.js`, and two spec files.

- **Fixture gap.** `tests/helpers.js:8` points at `dev-codex/local-sandbox`, which is gitignored
  (`.gitignore:49`) and **does not exist in this checkout**. Three of the five `provider-workflow`
  tests depend on it, so the suite cannot run on a fresh clone.
- **No Claude coverage.** No test invokes a command with `--claude`. The entire 0.3.0 feature —
  `src/app/claude-*.ts`, `src/domain/claude-providers.ts`, `src/storage/claude-*.ts`,
  `src/commands/claude-handlers.ts` — shipped with no runtime test.
- **No coverage for** `show`, `current`, `config show`, `config list-profiles`, `edit`, `remove`,
  `import`, `export`, `backups list`, `rollback`, or any interactive flow.
- **Harness leaks temp dirs.** `makeSandboxCopy()` results are never removed, and `runBuiltCli()`
  only cleans up the tool home when the caller did *not* pass `toolHomeDir` — which every
  fixture-based test does.
- The harness calls `dist/` modules **in-process** (`tests/helpers.js:59-64`), so it never exercises
  the real `bin` entrypoint, exit codes, or process-level behaviour.

#### P1-10 · Rollback failure leaves no second chance

If `restoreManifest()` throws mid-restore, some files are restored and some are not; the thrown
`ROLLBACK_FAILED` reports the cause but there is no retry path and the backup is left in place. The
user is told the backup path, which is the minimum — but `writeTextFileAtomic` on the
`latest.json` pointer is not consulted in this path.

---

### P2 — Complexity and hygiene

#### P2-1 · `src/infra/` is an entire dead layer, and `src/cli/` is mostly dead too

`src/infra/` — 8 files — is **imported by nothing** in `src/` or `tests/`. Every file is a
"Compatibility facade" re-export of `../storage/*` or `../runtime/*`, e.g.
`src/infra/fs-utils.ts`, `src/infra/codex-paths.ts`, `src/infra/backup-repo.ts`.

The same applies to 5 of the 6 files in `src/cli/`: `args.ts`, `help.ts`, `interactive.ts`,
`prompt.ts`, `add-interactive.ts` are also self-described compatibility facades. Only `src/cli.ts`
and `src/cli/output.ts` are real.

Verified:

```
$ grep -rn "infra/" src/ tests/          → no matches
$ grep -rn "cli/args\|cli/help\|cli/interactive\|cli/prompt\|cli/add-interactive" src/ tests/  → no matches
```

This is the tangible remnant of a half-finished directory reorganisation — the old `cli`/`infra`
layout was superseded by `commands`/`storage`/`interaction`, but the old files were never deleted.
It means two names exist for every module, and a reader has to work out which is canonical.

#### P2-2 · Dead exports

Verified to have zero live callers:

| Location | Exports |
|---|---|
| `src/domain/config.ts` | `parseTopLevelProfile`, `parseProfileNames`, `replaceTopLevelProfile` (`:141-158`), `planProfileLifecycleOutcome` (`:508-564`), `DEFAULT_LINE_ENDING` (`:1143`) |
| `src/storage/config-repo.ts` | `readCurrentProfile` (`:45`), `listConfigProfiles` (`:58`), `ensureProfileExists` (`:65-67`, a stub that ignores both arguments), `updateTopLevelProfile` (`:135`), `requireManagedProfileRuntime` / `requireModelProviderRuntimeSection` (`:72`, `:115`) |
| `src/domain/providers.ts` | `findProviderByProfile` (`:125`) |
| `src/interaction/interactive.ts` | `confirmCreateCodexDir` (`:235`) |
| `src/commands/registry.ts` | `isKnownCommandName` (`:352`) + `COMMAND_NAME_SET` (`:286`) — `COMMAND_NAME_SET` is consumed only via that function, whose only importer is the dead `src/cli/help.ts` shim |

`DESTRUCTIVE_REMOVE_BLOCKED` (`src/domain/config.ts:48-54`) is only ever rendered, never produced.

#### P2-3 · Copilot-era remnants

- `runCodexLogin()` (`src/runtime/codex-cli.ts:39-53`) is the last piece of the removed
  `codex login --with-api-key` flow. Its only reference is the dead `src/infra/codex-cli.ts` shim.
- `CODEX_LOGIN_FAILED` (`src/domain/errors.ts`) exists only for that dead function, yet is reused as
  the catch-all fallback for Codex probe failures in `src/app/run-doctor.ts:94-97`.
- `setCodexSpawnImplementation` / `resetCodexSpawnImplementation` (`src/runtime/codex-cli.ts:25-34`)
  exist for tests that no longer call them.

#### P2-4 · Unused parameters reveal a half-retired code path

`addProvider()` accepts `authPath` and `createProfile` and never reads them
(`src/app/add-provider.ts:26`, `:34`). `editProvider()` accepts `authPath`, `createProfile`, and
`switchToProfile` and never reads them (`src/app/edit-provider.ts:23`, `:31-32`). The handlers
compute and pass all of them.

#### P2-5 · The hand-rolled TOML parser is ~15% of the codebase and fails silently

`src/domain/config.ts` is 1,143 lines — the largest file in the repository — built on a line-scanner
with three regex matchers (`:992-1046`). Its failure mode is the problem: **anything it does not
recognise is treated as absent, never as an error.**

Consequences:

- `"""multi-line"""` strings are invisible → the field looks missing.
- Arrays, inline tables, and dotted keys are unsupported.
- `requires_openai_auth = True` (capitalised) does not match; only lowercase `true`.
- An unterminated quote matches nothing, silently.
- Root fields keep the **first** occurrence of a duplicate key; section fields keep the **last**
  (`:259-340`) — inconsistent, with no diagnostic either way.

So `doctor` can report `MODEL_MISSING` for a `config.toml` that plainly has the field. The
byte-offset patch approach itself is sound (operations are applied in descending offset order,
`:728-744`) — the weakness is entirely in recognition coverage.

`expandDeletionEnd()` (`:1107-1122`) computes a cursor value and then never uses it; the second half
of the function is a no-op.

#### P2-6 · Documentation drift

`docs/agent-provider-switch-product-overview.md:3` and `docs/agent-provider-switch-technical-architecture.md:3` still
declare `0.2.1` and contain no `--claude` content — yet `README.md:193` and `README.AI.md` list them
as **current** fact sources. (`docs/cli-usage.md:3,9` was brought up to the current version during
the `0.3.1` release.) The release gate explicitly tolerates the remaining drift:
`tests/release-contract.spec.js:39` matches `/0\.2\.1|0\.3\.0|0\.3\.1/`.

`CHANGELOG.md:29` still marks 0.2.1 as "Unreleased" though 0.2.2 and 0.3.0 shipped after it; the same
applies to the 0.1.2–0.1.5 entries.

#### P2-7 · Help and flag handling are inconsistent with the surface

- Top-level `--help` never mentions Claude Code (`src/commands/help.ts:32-81`), even though
  `CHANGELOG.md:23` states help text was updated for `--claude`. Only per-command registry usage
  lines were.
- `--claude` is **silently ignored** on the 12 commands outside `CLAUDE_COMMANDS`
  (`src/commands/claude-handlers.ts:22`). `aps doctor --claude` runs the Codex doctor with no
  warning.
- `aps config` prints top-level help; the nested list is reachable only via `aps help config`.
- `aps -h` works only by accident: `startIndex` skips index 0 (`src/commands/args.ts:66`), so the
  `-h` is never parsed as a help request — the no-command fallback prints help anyway. `aps -h list`
  ignores `list`.
- `--codex-dir` consumes the next token unconditionally (`:22-30`), so `aps list --codex-dir --json`
  resolves a directory literally named `--json`.
- Undocumented flags: `--create-profile` (`add`, `edit`), `--switch-to` (`edit`), `--merge`
  (`import`) are implemented but absent from the registry usage strings
  (`src/commands/registry.ts:142-143`, `:162-165`, `:222`).

#### P2-8 · Inconsistent error codes

The same "missing provider name" condition uses three different codes:
`INVALID_ARGUMENT` (`src/commands/handlers.ts:75`, `src/commands/claude-handlers.ts:168`),
`PROVIDER_NOT_FOUND` (`handlers.ts:114`, `:311`), and `CLAUDE_PROVIDER_NOT_FOUND`
(`claude-handlers.ts:138`, `:196`).

The empty-registry picker error differs the same way: `PROVIDER_NOT_FOUND` "No providers are
configured." (`src/interaction/interactive.ts:55`) vs `CLAUDE_PROVIDERS_NOT_FOUND`
(`claude-handlers.ts:232`).

#### P2-9 · Unreachable branches

`UNKNOWN_COMMAND` (`src/commands/dispatch.ts:19`, `src/commands/handlers.ts:476-477`) cannot be
reached from argv — `parseArgs` can only produce a registry id or `null`. The same applies to
`findCommandDefinition`'s special-casing of `"help"`/`"version"` (`src/commands/registry.ts:309-314`).

#### P2-10 · Duplication between the two targets (accepted, documented)

The Codex and Claude layers are structural near-copies of each other:

- Domain validators: `src/domain/providers.ts:30-120` vs `src/domain/claude-providers.ts:20-90`.
- Repositories: `src/storage/providers-repo.ts:10-50` vs `src/storage/claude-providers-repo.ts:14-60`.
- Mutation actions: `src/app/claude-remove-provider.ts:16-39` is `removeProvider`'s `runMutation`
  scaffold minus the config projection; `claude-add-provider.ts:48-72` mirrors `addProvider`.
- Prompting: `promptForClaudeProviderSelection()` (`claude-handlers.ts:224-258`) re-implements
  `promptForProviderSelection()` (`src/interaction/interactive.ts:24-59`), and additionally bypasses
  the `CliPromptRuntime` abstraction by importing `inquirer` directly (`claude-handlers.ts:75`,
  `:91`, `:249`) where every Codex flow uses the runtime.
- `claude-handlers.ts:103-113` and `:115-124` are two near-identical `claudeAddProvider(...)` calls
  differing only in where `fromFile` came from.
- Path plumbing: `claude-handlers.ts:60-62` hand-rolls `lockPath` / `backupsDir` / `latestBackupPath`
  with three inline `require("node:path")` calls instead of extending `createClaudePaths()`
  (`src/storage/claude-paths.ts:34-41`), which omits those fields. The same inline-`require` pattern
  appears at `src/app/run-mutation.ts:27` and `src/storage/lock-repo.ts:18`.

Roughly 300–350 of ~500 lines are structural repetition. **This is accepted, not scheduled** — see
§4.

#### P2-11 · Packaging and release surface

- `engines.node` is `>=18` (`package.json:25`) and `README.md:26` repeats it, but the sole runtime
  dependency declares `>=23.5.0 || ^22.13.0 || ^21.7.0 || ^20.12.0`
  (`node_modules/inquirer/package.json`). On Node 18/19 the install is unsupported.
- `files` ships the entire `docs/` tree — including archived 0.1.x PRD/Design documents — while
  **excluding** `README.CN.md`, `README.AI.md`, and `CHANGELOG.md` (`package.json:10-15`). Chinese
  users installing from npm never see the Chinese README.
- No `types` field and no emitted `.d.ts` — the package is untyped for TypeScript consumers.
- **No CI.** There is no `.github/` directory; the release gate only ever runs locally.
- **21 npm versions, 0 git tags.** `git tag` returns nothing.

#### P2-12 · Local machine leftovers

Empty `bin/` (also gitignored), `tmp/isolated-codex-validation/` (June 2026, containing a full Codex
runtime state: `auth.json`, sqlite logs, sandbox logs), and the `~/.config/agent-provider-switch/` artifacts
listed in §1.

---

## 3. Roadmap

Ordered so that each phase is independently shippable and reviewable.

### Phase 1 — `0.3.1` Security patch

No architecture change. Highest value per line changed.

**Design: [`docs/Design/agent-provider-switch-v0.3.1-design.md`](./Design/agent-provider-switch-v0.3.1-design.md).**

**Status: shipped in `0.3.1` (2026-09-20).** All six items landed. Three deviations from this plan,
recorded in the Design document's Implementation Notes:

- `--reveal` shipped as a **global** flag, not a `CLAUDE_COMMANDS` flag. The command-option pass
  treats any `--x <non-flag>` pair as a valued option, so a per-command `--reveal` would swallow
  the provider name that follows it. Fixing that parser is P1-1 (Phase 2).
- Item 4 warns that the export holds plaintext keys, but does not suggest `export --redact`. A
  redacted export mode is out of scope for this release.
- Item 6's allowlist is built by the **caller**, not read from the manifest: a root recorded inside
  the manifest is tamperable by the same edit that redirects a restore path.

1. **Mask Claude secrets by default; add `--reveal`.**
   - `claudeShowProvider()` stops returning the raw `settings` blob; `env` values are masked through
     `maskSecret()` for any key matching a secret pattern
     (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `ANTHROPIC_*`).
   - `--reveal` (registered in `CLAUDE_COMMANDS`' flag set) restores current behaviour.
   - `--json` masks too. Add a second-pass guard in `renderClaudeHumanSuccess()`'s `show` case
     (`src/cli/output.ts:392-398`) so a future service-layer change cannot silently re-leak.
   - **Acceptance:** `aps show --claude deepseek` contains no real token;
     `aps show --claude deepseek --reveal` does.
2. **Tighten permissions on write.** New POSIX mode for
   `claude-providers.json`, `providers.json`, `auth.json` (`0o600`), and backup directories
   (`0o700`), applied in `writeTextFileAtomic()` / `ensureDir()` with a platform check that is a
   no-op on Windows. Repair the existing 4 files on next write.
   - **Acceptance:** `stat -c %a ~/.config/agent-provider-switch/claude-providers.json` reports `600` on
     Linux/macOS after any mutation; no error on Windows.
3. **Widen error-detail masking.** Replace the `"apikey"` substring test
   (`src/storage/fs-utils.ts:59-61`) with a key-name regex, and mask values inside nested objects
   instead of `JSON.stringify`-ing them whole.
4. **Make `export` loud.** Warn in the result payload and in human output when the exported payload
   contains keys; suggest `aps export --redact` as a follow-up option.
5. **Fix the non-atomic writes.** Drop the redundant `rmSync` from `writeTextFileAtomic()`
   (`src/storage/fs-utils.ts:20-22`) — Node's `renameSync` already replaces on both platforms — and
   route `writeOpenAiApiKeyAuth()` (`src/storage/auth-repo.ts:83`) through the helper.
   - **Acceptance:** a `writeFileSync`-injected failure mid-mutation leaves the previous file intact.
6. **Add a containment check to rollback.** `restoreManifest()` refuses to write outside the
   directory recorded in the manifest, or outside an allowlist of managed paths.

### Phase 2 — `0.4.0` + `0.4.1` Stability

Split into two releases, ordered so the smaller stateless work proves out the reworked test harness
before the stateful P0 work lands on top of it. **Phase 2a is `0.4.0`; Phase 2b is `0.4.1`.**

**Designs: [`v0.4.0`](./Design/agent-provider-switch-v0.4.0-design.md),
[`v0.4.1`](./Design/agent-provider-switch-v0.4.1-design.md).** The items below are the pre-design sketch: where
an item disagrees with its Design, the Design is the settled record.

#### Phase 2a — `0.4.0` Foundation and CLI contract

Nothing here writes a new storage format or changes a recovery path. It exists to make the suite
trustworthy first: exit codes cannot be tested at all until the harness stops re-implementing
`main()`'s dispatch ladder by hand, and both remaining items are parser-level.

1. **CI and test portability.**
   - New `.github/workflows/ci.yml`: `npm ci` → `npx tsc --noEmit` → `npm test`, matrix of
     `windows-latest` + `ubuntu-latest` × Node 20/22. Do **not** set `engine-strict`: both matrix
     Node lines satisfy `inquirer`'s range, while `package.json` advertises `>=18`, which CI never
     tests — `engine-strict` would turn that pre-existing inconsistency into an install failure.
   - Replace the `dev-codex/local-sandbox` dependency with a fixture the tests generate themselves
     (`tests/helpers.js:8`). Three tests are red on the author's machine today, not only on a fresh
     clone, so this is not hypothetical portability work.
   - Fix the temp-directory leaks. `runBuiltCli()` uses the **codex directory as `APS_HOME`** when
     `--codex-dir` appears, and the only cleanup is an unguarded `rmSync` inside a `finally` that
     fires on exactly that path — so it can delete a directory the test is still using, or fail a
     passing test on a Windows `EBUSY`.
   - Extract `main()`'s ladder into `runCli(argv, io): number` so the harness calls it instead of
     mirroring it. Exit codes are untestable today because `printHelp()`/`outputFailure()` call
     `process.exit` and no test requires `dist/cli.js` at all.
   - **New `tests/claude-provider-workflow.spec.js`** covering add → switch → list → current → show
     → remove. It **must** set and assert `APS_CLAUDE_DIR` up front: `claudeSwitchProvider()`
     replaces `<claudeDir>/settings.json`, and that path resolves to the real `~/.claude` otherwise —
     a missing variable makes `npm test` rewrite the developer's own settings file.
   - **Acceptance:** `git clean -xdf && npm ci && npm test` passes on Windows and Linux, with no
     leftover temporary directories.
2. **Boolean flag parsing.**
   - Add a `booleanFlags: string[]` field to `CommandDefinition` (`src/commands/types.ts:57-66`),
     for `--claude`, `--force`, `--merge`, `--overwrite`, `--create-profile`.
   - The set is applied as a **union in the parser's first pass**, alongside `--json`, `--reveal`,
     and `--codex-dir`, while still recording the hit into `commandOptions` as `["true"]`. Consuming
     it in the command-option pass cannot work: `resolveCommandFromArgv()` matches only at the head
     of `remaining`, and `startIndex` derives from it (`src/commands/args.ts:76`). This also makes
     `--claude` position-independent as a side effect.
   - `--reveal` is deliberately excluded — it is already stripped by exact token in that same pass,
     so listing it would be a no-op.
   - **The compatibility claim is not true today.** `aps add --claude copilot --from-file x`
     currently yields `positionals: []` with `--claude: ["copilot"]`; `copilot` becomes a positional
     only once this change lands. `resolveClaudeProviderName()`
     (`src/commands/claude-handlers.ts:37-48`) prefers `positionals[0]`, so it can be deleted in the
     same commit — but the parser fix and the deletion must ship together, and
     `aps remove --claude --force <name>` does not work at all today.
   - Fix the `required` parameter of `getSingleOption()` or remove it (P1-2). Removing it is
     correct: `add` relies on receiving `null` there in order to prompt.
   - **Acceptance:** `aps remove --force <name>` and `aps remove --claude --force <name>` both
     work; `resolveClaudeProviderName` no longer exists.
3. **Exit codes and the error envelope.**
   - Unknown command → exit 1. **The fix lands in the parser, not `src/cli.ts:52-55`**: the parse
     result cannot distinguish "no command" from "unknown command" — eight distinct inputs produce an
     identical `ParsedCommand`, because `startIndex` skips index 0 when nothing resolved. Naively
     changing the `cli.ts` branch makes `aps --help` exit 1.
   - Wrap `main()`'s synchronous section in `try`/`catch` → `outputFailure` (`src/cli.ts:27-28`),
     reading `--json` from the **raw argv** for that path: a thrown parse leaves no parsed options, so
     the catch cannot otherwise tell whether the envelope was requested.
   - Fix the empty `status` field (`src/cli/output.ts:165`) — it reads `data.storage.toolHome.root`
     and `getStatus()` returns no `storage` key, so the line has always rendered empty.
   - **Acceptance:** `aps lst; echo $?` prints `1`; `aps --json --codex-dir; echo $?` prints `1`
     with a JSON envelope, not a stack trace; `aps --help; echo $?` still prints `0`.

#### Phase 2b — `0.4.1` Lock and backup safety

Both items are P0 and both change lock discipline, so they ship together: lock takeover is what turns
`releaseLock()`'s missing ownership check from a latent problem into two concurrent writers, and that
same interleaving re-breaks the same-second backup fix and can race two writers onto `latest.json`.

They land after Phase 2a on purpose — the lock work needs a deterministic crash fixture and a harness
whose teardown does not delete the directory under test.

1. **Stale-lock recovery.**
   - On conflict, `acquireLock()` reads the pid and probes it with `process.kill(pid, 0)`.
   - Dead pid, or an **unreadable** record, → take over with a warning naming what was removed. The
     third state matters: a hard kill mid-`writeFileSync` leaves truncated JSON, which is the
     likeliest residue of the very crash this recovers from.
   - **No TTL fallback — settled against.** A TTL that can seize a lock from a live process will
     eventually seize it from a slow `migrate`, and a false takeover corrupts state where a false
     conflict only inconveniences. A recycled pid is therefore fail-closed, which is why the record
     gains `hostname` and why `aps unlock --force` is the documented way out.
   - **No audit line — settled against.** There is no log sink in the tool home, and adding one
     creates a new unbounded-growth and redaction surface. The takeover reports through the existing
     result payload.
   - `releaseLock()` re-reads and removes only a record it owns, and `acquireLock()` treats only
     `EEXIST` as a conflict — today any thrown code, including `EACCES` and `EROFS`, is reported as
     "another operation is running", which points at the wrong remedy on a read-only tool home.
   - Add `aps unlock [--force]`, and have `doctor` report an occupied or stale lock with the
     owner, the operation, the age, and the remedy.
   - **Acceptance:** a process that acquires the lock and exits inside the critical section leaves a
     lock the next mutation takes over without manual file deletion. (The original `kill -9`
     criterion is not executable here: `kill -9` does not exist in cmd or PowerShell, and Git Bash's
     `kill` addresses MSYS pids. The Design substitutes a `process.exit(0)`-inside-the-lock fixture,
     which `finally` does not unwind.)
2. **Backup retention.**
   - `aps backups prune [--keep N]`, default retention 20, newest-first.
   - The prune also runs automatically after every successful mutation, and reports how many
     directories it removed. Settled — see §5.
   - `createTimestamp()` gains zero-padded milliseconds, and creation becomes an **exclusive**
     non-recursive `mkdirSync` with an `EEXIST` retry, so same-second mutations cannot collide
     (P0-3). A check-then-act suffix bump is only race-free because of the shared lock, which the
     item above is simultaneously loosening.
   - Prune never deletes a directory that **any** surviving manifest still names as `backupDir` —
     not merely the one under `latest.json`, because `rollback <id>` resolves through
     `loadManifestById()` and then reads `manifest.backupDir` too.
   - `runMutation()` removes its own backup directory when the mutation fails (after restore), so
     failed attempts stop accumulating. The error payload reports that path, so the two must be
     reconciled — see the `v0.4.1` Design.
   - Clean up the 97 existing directories on this machine once `prune` exists. The automatic path
     performs this reduction on the first mutation after upgrade, and reports the count.
   - **Acceptance:** after 25 mutations, `backups/` holds 20 directories; two mutations in the same
     second produce two distinct directories; no-argument `rollback` still resolves after a prune.

### Phase 3 — `0.4.x` Maintainability

1. **Delete the dead code** (one commit, easy to review): all of `src/infra/`, the 5 dead `src/cli/`
   shims, every export in P2-2, the copilot-era remnants in P2-3, and the unused parameters in P2-4.
2. **Resync the docs.** Bring `docs/cli-usage.md`, `docs/agent-provider-switch-product-overview.md`, and
   `docs/agent-provider-switch-technical-architecture.md` to the current version with `--claude` sections, and
   tighten `tests/release-contract.spec.js:39` to a single current version so drift fails the build.
   Fix the "Unreleased" markers in `CHANGELOG.md`.
   Add a Claude section to top-level help (`src/commands/help.ts:32-81`). Document the
   currently-undocumented flags in the registry usage strings.
3. **Packaging.** Move `engines.node` to `>=20.12` (or pin a compatible `inquirer`). Add
   `README.CN.md` and `CHANGELOG.md` to `files`; exclude archived `docs/PRD` and `docs/Design`
   directories from the tarball. Decide whether to emit `.d.ts`. Start tagging releases — 21
   published versions with zero tags makes bisecting impossible.
4. **Machine cleanup** (needs explicit confirmation before touching anything outside the repo):
   `github-token`, `runtime/copilot-bridge*`, `tmp/isolated-codex-validation/`, the empty `bin/`.

### Phase 4 — `0.5+` Open decision: the TOML parser

Two options, deliberately left open:

**(a) Keep the hand-rolled parser, make it fail loudly.** Any line the matchers cannot recognise
becomes an explicit diagnostic instead of silently-absent data, so `doctor` stops reporting false
`MODEL_MISSING` (P2-5). Small, and it preserves comments and formatting — which is exactly what the
byte-offset patch approach buys.

**(b) Parse with a real TOML library** (`smol-toml`), keep the byte-offset patcher for writes. The
read path becomes trustworthy; the cost is a second runtime dependency against the "lightweight"
goal.

**Recommendation: (a) now, (b) only if a real parsing failure is reported by a user.** The parser's
correctness problem is its silence, not its coverage.

---

## 4. Explicitly Rejected

| Not doing | Why |
|---|---|
| A generic "target" abstraction, or merging into one `providers.json` | Already a written non-goal in the 0.3.0 PRD and Design. The Claude path is ~700 lines; the payoff does not justify a storage-format migration. Confirmed as the direction for this cycle. |
| Re-introducing copilot-sdk, the HTTP bridge, or the proxy runtime | Removed deliberately in 0.2.1. `package-lock.json` is clean. No reason to regress. |
| Unifying the Codex and Claude domain/storage/app layers behind a shared `ProviderRegistry<T>` | ~300–350 lines of the ~500 structural repetition would collapse, but it trades the clarity of two independent targets for indirection — and contradicts the decision above. Phase 3 removes the dead code instead. |
| A `--target` flag replacing `--claude` | Same reasoning. `--claude` is already documented and shipped. |
| Adding an exit-code taxonomy (2 for usage errors, etc.) | Phase 2 only needs "success vs. failure" to be correct. A taxonomy is a behaviour change with no current consumer. |

---

## 5. Decisions and Open Questions

**Decided — Codex `show --json` keeps emitting the full `apiKey`.** It is documented as an
automation contract (`src/commands/registry.ts:103-106`) and is left unchanged. Phase 1 masks only
the Claude side. Unifying the two would be a breaking JSON-contract change with no benefit for a
single-user local tool. Recorded as a non-goal in the v0.3.1 design.

**Decided — `--reveal` is a global flag**, parsed in `parseArgs()`'s first pass alongside `--json`.
Per-command registration would collide with the greedy `--flag value` rule (P1-1) and make
`aps show --reveal <name>` swallow the provider name. Settled in the v0.3.1 design, §1.

**Decided — `backups prune` runs automatically after every successful mutation**, with
`aps backups prune [--keep N]` as the manual control. Automatic caps growth with no user action.
The automatic path also performs the one-time reduction of the 97 existing directories on this
machine, which is irreversible: those copies contain plaintext keys, so removing them is the point of
P0-2, but the command must report how many it removed rather than doing it silently. Settled for
Phase 2b; see the `0.4.1` Design.
