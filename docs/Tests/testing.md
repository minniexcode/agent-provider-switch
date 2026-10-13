# Testing

Current version: `1.2.0`

There are two suites, and they cover different things on purpose.

## The in-process suite

`npm test` rebuilds the CLI and runs `tests/run-tests.js`, which discovers `tests/*.spec.js` files. Each spec exports `{ name, tests: [{ name, run() }] }`; a spec whose tests throw is reported and the runner continues with the next one. A spec that throws while being loaded is reported the same way, and the run continues.

**Silence means green.** A passing run prints nothing. This is deliberate for a suite this size, and it is why a fixture problem shows up as a wall of failures rather than as a quietly skipped case.

Tests call `runCli(argv, io)` in-process through `runBuiltCli()`, which means they exercise the production dispatch ladder rather than a hand-written mirror of it. What they structurally cannot observe is a real process exit code, a real pipe, or a real environment.

Every temporary directory is created through `makeTempDir()` in `tests/helpers.js`, which registers it for removal. `run-tests.js` calls `cleanupTempDirs()` after each suite and a `process.on("exit")` backstop covers the failure path, so a full run leaves nothing behind. Nothing calls `fs.rmSync` on a test directory directly.

`runBuiltCli()` points `APS_CODEX_DIR` at a temporary directory whenever the call passes no `--codex-dir`, so a spec that forgets it cannot reach a real `~/.codex`. `withClaudeEnv()` is the only safe way to run a Claude command: it verifies `APS_CLAUDE_DIR` resolves inside a temporary directory before running anything, because `switch --claude` replaces `settings.json`. **Pass `--json` on every Claude spec invocation** — `canPrompt()` is true whenever the suite runs in a terminal, so a missing `--json` blocks on an inquirer prompt and hangs the suite instead of failing it.

## The real-process suite

`npm run test:e2e` builds the CLI and runs `tests/e2e/run-e2e.js`, which discovers `tests/e2e/*.spec.js` in order. Each case runs the built binary as a **real child process** via `spawnSync`, with real pipes, real exit codes, and real argv.

`tests/run-tests.js` does not descend into `tests/e2e/`; the two suites are separately invocable and CI runs them as two steps. The E2E suite costs a process spawn per case, which is too much to pay inside the fast suite for every contributor.

Unlike the in-process runner, this one **prints a per-case line and a summary** (`passed: N   failed: N   skipped: N`). Silence-means-green would hide exactly the environment-dependent gap the suite exists to expose.

The isolation is the point:

- One sandbox root per case, holding `home/`, `codex/`, and `claude/`.
- All three roots are asserted to resolve inside the sandbox **before any child process runs**, and the sandbox is asserted not to sit inside the repo or the user's home directory.
- The child environment is built explicitly: `process.env` minus every ambient `APS_*` and minus `NODE_ENV`, plus the three overrides.
- If a check fails the runner **refuses to run**, rather than warning.

A developer's real `~/.codex`, `~/.claude`, and `~/.config/agent-provider-switch` are never touched. That matters beyond tidiness: the first mutating command against a real tool home prunes its backups to the retention count, irreversibly.

Interactive (inquirer) paths are out of scope for both suites this round: a TTY is required, so every selector, confirmation, and `migrate` wizard branch is uncovered.

## Commands

```bash
npm run build
npx tsc --noEmit
npm test          # in-process; prints nothing on success
npm run test:e2e  # real processes; prints passed/failed/skipped
node dist/cli.js --help
node dist/cli.js --version
npm pack --dry-run
```

## Required Coverage

Focus on the dual-target contract, the `1.2.0` shared-workflow guarantees, the `1.1.3` target-scope guarantees, the `1.1.2` error-vocabulary guarantees, the `1.1.1` target-resolution guarantees, the `1.1.0` shared-defaults guarantees, the `1.0.0` migration guarantees, the `0.4.1` recovery guarantees, and the `0.3.1` secret-handling guarantees:

- Version metadata is `1.2.0` in `package.json` and both spots in `package-lock.json`, and `aps --version` prints it.
- Current docs point to `docs/PRD/agent-provider-switch-prd-v1.2.0.md` and `docs/Design/agent-provider-switch-v1.2.0-design.md`, and the PRD/Design pair exists for every version on the `0.3.1 → 1.2.0` line.
- The six provider verbs are implemented once: each adapter imports no orchestration, both adapters implement the same hook surface, and `commitProviderChange` has exactly one entry point.
- `--help` and `--version` load no execution service — no app service, no inquirer runtime, no Codex probe, no registry I/O — asserted in a child process with a counter-case proving the recorder records something.
- One fake prompt runtime drives both targets' selection and confirmation through `executeCommand()`; a declined confirmation cancels before anything is written.
- `--target <id>` is equivalent to `--codex` / `--claude` in both positions, and a missing, flag-shaped, unknown, or conflicting id is refused.
- No error-code string in `src/` begins with `CLAUDE_`, and the set of declared-but-never-thrown codes is exactly the recorded list of five.
- `PROVIDER_ALREADY_EXISTS` (a record name is taken) and `PROVIDERS_ALREADY_EXISTS` (the registry file exists) are asserted through different commands, so a later merge of the pair is caught.
- The Claude refusal messages still name Claude even though the code no longer does, and a Claude payload carries no `target` of its own.
- Every command id has a declared target scope, and the accept/refuse matrix for `--claude`, `--codex`, and the pair holds for all of them.
- The envelope carries the authoritative `targets` array and a `target` that is non-null exactly when `targets` holds one id; a failure raised after resolution reports the resolved target, and a refusal raised by the flags reports `targets: []` with `target: null`.
- The legacy tool home moves once, and only when `APS_HOME` is unset, the new home is absent, and the old lock has no live owner.
- Help exposes only current commands: `init`, `migrate`, `list`, `show`, `current`, `status`, `config show`, `config list-profiles`, `config compact`, `add`, `edit`, `switch`, `remove`, `import`, `export`, `backups list`, `backups prune`, `unlock`, `rollback`, `doctor`, and deprecated `setup`.
- Fresh provider flow: `init -> add -> switch -> status -> doctor`.
- Base URL drift diagnostics.
- Ambiguous active provider mapping.
- `migrate` remains an advanced adopt helper.
- `setup` remains a deprecated pointer.
- JSON output uses the stable envelope.
- `show --claude` masks credential-shaped env values and omits `settings`; `--reveal` returns real values and includes `settings`.
- `--reveal` placed before the provider name still resolves that name as a positional.
- `list --claude` and `current --claude` expose no secret material.
- Error-detail redaction covers nested keys and key names other than `apikey`.
- `export` reports `containsSecrets` and warns when exported records hold plaintext keys.
- `writeTextFileAtomic` leaves the destination present and intact at rename time, and retries a Windows-transient rename failure instead of aborting the mutation.
- `restoreManifest` rejects a restore path outside the allowed roots and leaves the named file untouched.
- On POSIX, a managed write lands at `0600` for files and `0700` for created directories.
- The suite runs green with no `dev-codex/` present; Codex fixtures are generated per test by `makeCodexFixture()`.
- The Claude provider workflow (`add`, `switch`, `list`, `current`, `show`, `remove`) runs end to end against a `APS_CLAUDE_DIR` that is verified to sit inside a temporary directory.

### Target scope

Covered by `tests/target-scope.spec.js`, `tests/doctor-targets.spec.js`, `tests/claude-status.spec.js`, and `tests/backup-targets.spec.js`.

- Every command id has a declared scope, and `target-scope.spec.js` holds a **hand-written** table of all 21 commands to check it against. A table derived from the code would agree with the code by construction and would assert nothing.
- The accept/refuse matrix runs the real order — `assertFlagsApply`, then `resolveTarget`, then `selectedTargets` — for one flag, the other, and the pair, on every command. The pair refusal is asserted in four distinct message buckets, because "does not support `--claude`", "has no Codex form", and "operates on state every target shares" are three different reasons and only a fourth case is the genuine contradiction.
- Scope and routing are asserted to differ on exactly three commands — `status`, `doctor`, `backups list` accept `--claude` and do not route to a Claude handler — so a later change that conflates the two questions fails here rather than silently narrowing a report.
- `--codex-dir` together with `--claude` is refused on a `both` command, while `list --claude --codex-dir <path>` keeps its long-standing accepted form.
- A bare `doctor` and a bare `status` report both targets with `target: null`; a narrowed one reports one target and omits the other's fields entirely.
- An unconfigured target contributes no issue and leaves `healthy` true, and an in-scope unconfigured target still builds its payload so `configured` is reported as a reading — `{status: "ok", value: false}` — rather than the section being absent.
- Evidence is a file, never a directory: a sandbox whose Codex directory exists and holds nothing reads `configured: false`. A malformed file still counts — the file is there, whatever it says.
- A registry with no `config.toml`, and a `config.toml` carrying no top-level `model_provider`, are both `not-activated`: no issue, no CLI probe, `healthy: true`. `MODEL_PROVIDER_MISSING` is asserted unreachable, since it told a user who had never switched anything that their setup needed repair.
- Identity is answered once per target, in `matching`. A live lock is `{status: "ok", value: "busy"}` and raises no finding; only a dead owner (`LOCK_STALE`) or a record that cannot be attributed (`LOCK_ABNORMAL`) does, and the lock is inspected once under every scope.
- Damage is local. A malformed registry leaves `providerCount` and `matching` `unavailable` while the rest of that section and the other target's results survive, the command still exits `0` with `ok: true`, and `healthy` is `false` rather than `null` — a fault was established.
- `status --claude` resolves a stored delta record and marks the row that matches the live `settings.json` active, and its section carries no raw `settings` blob in either mode.
- Claude identity includes the authentication paths, so two records that differ only in their token are two candidates and the report is `ambiguous` rather than naming the one that sorts first.
- Backup classification: a recorded `target` wins over the reason and the containment; each `claude-` reason and each Codex operation name classifies as expected; a path in the tool home classifies as `unknown` rather than being guessed; and a tree containing files from both targets reads `mixed`. The narrowed listing includes `mixed` in **both** lists and `unknown` in neither.
- Rollback impact is read from the restore paths alone, never from the manifest's target or reason: a registry-only backup reports `["claude"]` while listing as `codex`, and `data.impact` separates shared-only recovery from paths that could not be attributed.

### Shared Claude defaults

Covered by `tests/tool-config.spec.js`, `tests/claude-settings-merge.spec.js`, `tests/claude-defaults.spec.js`, and `tests/claude-config-compact.spec.js`. Each guarantee below was checked by mutating the built module and confirming a spec fails; a spec that stays green under the matching mutation is not pinning anything.

- `claudeDefaults` survives a tool-config read and write, an absent block stays absent, and an unknown key under it is refused rather than dropped. The validator rebuilds the object, so this is the test that fails if the block is ever erased again.
- The merge rule holds: objects merge recursively, the record wins, arrays are replaced wholesale, `null` deletes, an empty object inherits instead of clearing, and a `null` default reads as absent. Randomized, seeded properties pin `merge(d, diff(d, x)) == merge(d, x)` (slimming never changes what a switch writes), idempotent `diff`, no `null` member in a merged result, and that every reported inherited path carries the default's value.
- `switch --claude` writes the resolved settings while the stored record stays a delta; with no defaults block a record is written verbatim, explicit `null` members included.
- `list`, `current`, `show`, and the interactive selector resolve a delta record, so the active marker and the `model` / `baseUrl` columns still work. `remove` does not expand the defaults into the surviving records.
- `show --claude` masks an inherited credential, reports inherited paths without values, and `--reveal` returns `settings` (resolved) plus `overrides` (stored).
- `add --claude` slims by default and `--full` keeps every entry, wherever `--full` sits relative to the provider name.
- `--full` and `--dry-run` are refused where they would be ignored, including on a Claude-capable command (`switch --claude --full`), which is why the check runs before the Claude early-return.
- `config compact --claude` leaves what a switch writes unchanged, carries `note` and `tags` over, keeps a `null` that deletes a real default, is a no-op the second time (no write, no backup), and is reversible through `rollback`. `--dry-run` leaves the file byte-identical, creates no backup, and succeeds while a live lock is held — the control being that a real run is refused with `LOCK_CONFLICT` under the same lock.

### Recovery

- A stale lock — owner pid gone — is taken over rather than blocking the write, and `doctor` reports it as `LOCK_STALE`.
- A live lock is never taken over; `doctor` reports it as the state `data.shared.lock: {status: "ok", value: "busy"}` with no `LOCK_*` finding, and `unlock` refuses with `LOCK_CONFLICT`.
- `unlock` succeeds as a no-op when no lock is present, and `--force` clears a live lock.
- Retention keeps the newest `N`, deletes the rest, and **never** deletes a directory a surviving manifest still references.
- A failed-and-rolled-back mutation does not leave its backup directory behind.
- Two mutations in the same second produce two distinct backups.

### Process-level (E2E only)

- An unrecognized command exits `1` with a structured error; a bare group root exits `0`.
- A synchronous parse failure produces the envelope on stderr under `--json`, and never on stdout.
- Boolean flags are position-independent, and `--claude` placed before the command name resolves.
- `--codex-dir` refuses a following flag instead of taking it as the path.
- `--claude` is refused on a command with no Claude path (`init --claude`), and the refusal names the ten commands that do accept it.
- A bare `doctor` in a sandbox covering both targets reports both sections, prefixes every human line `[codex]` or `[claude]`, and finds only what is actually wrong: the Codex side contributes `CODEX_NOT_INSTALLED` and the empty Claude root contributes nothing, rather than the absence findings this used to assert. The pair refusal and the `--codex-dir`-with-`--claude` refusal both come back with `targets: []`.
- A Claude-only machine — a Claude provider added and switched, with the sandbox's Codex CLI removed from the child `PATH` — reports `healthy: true` and no Codex finding at all.
- Every mutating command has an asserted human rendering, not only a JSON envelope.

Do not add tests for removed `0.2.1` runtime experiments such as Copilot SDK integration, GitHub login, `add --copilot`, or bridge commands.

## Known Gaps

- The POSIX permission assertions in `tests/secret-handling.spec.js` return early on Windows, so the `0600` / `0700` code path has no executable coverage on that platform. The `ubuntu-latest` leg of `.github/workflows/ci.yml` is the only place it runs.
- Interactive paths — inquirer selectors, confirmations, `migrate`'s wizard, `PROMPT_CANCELLED` — have no coverage in either suite.
- The E2E suite proves the binary works against synthetic roots. It does not prove that a developer's live configuration survives a real `switch`; nothing in the repo exercises a real `~/.codex` or `~/.claude`, deliberately.
- `migrate` is the one command that ignores `APS_CODEX_DIR` (`codexDirExplicit` is set only by a literal `--codex-dir`). Its non-interactive surface is covered; its happy path needs a TTY and is not.
