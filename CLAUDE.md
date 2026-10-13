# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build          # Wipe dist/ then compile src/**/*.ts → dist/ via scripts/build.cjs (plain tsc, no bundler)
npm test               # Build + run tests/run-tests.js
npx tsc --noEmit       # Type-check only
node dist/cli.js --help  # Run built CLI locally
npm pack --dry-run     # Preview publishable package
```

Node.js `>=18` required. Single runtime dependency: `inquirer`.

## Running a Single Test Suite

Tests use a custom harness (no Jest/Vitest). Each `tests/*.spec.js` exports `{ name, tests: [{ name, run() }] }`. To run one suite in isolation:

```bash
npm run build && node -e "require('./tests/provider-workflow.spec.js')"
```

Or use the full runner which discovers all `*.spec.js` alphabetically:

```bash
node tests/run-tests.js
```

The runner reports failures only — a passing test prints nothing, and the runner continues after a failure. **Silence means green.**

The suite is green on a fresh clone (`.github/workflows/ci.yml` runs it on Linux and Windows against Node 20 and 22). No fixture directory is needed: `makeCodexFixture()` writes a temporary `config.toml` / `auth.json` per test, so `dev-codex/local-sandbox` — gitignored and absent — is never read.

Temporary directories are created only through `makeTempDir()`, which registers them for removal; `run-tests.js` calls `cleanupTempDirs()` after every suite, with a `process.on("exit")` backstop. **Never call `fs.rmSync` on a test directory directly** — removal has to stay owned by the registry, so a directory cannot be deleted while another suite still points at it.

## Live vs. Dead Source Trees

`src/` contains two near-duplicate trees. **Only one is reachable from `src/cli.ts`:**

| Live | Dead (nothing imports it) |
|---|---|
| `src/commands/` — registry, args, help, dispatch, handlers | `src/cli/{args,help,interactive,prompt,add-interactive}.ts` |
| `src/storage/` — file I/O, paths, repos | `src/infra/` — all 8 files |
| `src/interaction/` — inquirer prompts | |
| `src/runtime/` — Codex CLI detection/probing | |

So `fs-utils.ts`, `args.ts`, `help.ts`, `providers-repo.ts`, `config-repo.ts`, `backup-repo.ts`, `lock-repo.ts`, `codex-paths.ts`, and `codex-cli.ts` each exist twice. Edit the one under `src/storage/`, `src/commands/`, or `src/runtime/` — never `src/infra/`.

Two files under `src/cli/` are live: `src/cli/output.ts` (the human and JSON renderer for every command) and `src/cli/report-lines.ts` (the pure text helpers it shares with the per-target presenters — they live there rather than in either consumer because the renderer selects a presenter, so a presenter importing the renderer back would be an import cycle).

`src/infra/` and the four remaining `src/cli/` shims are slated for deletion in Phase 2 (roadmap P2-1). Do not add to them, and do not "fix" a shim to match its live twin.

## Architecture

```
src/cli.ts              Entry point — argv parsing, --help/--version, lazily imports commands/dispatch
src/commands/           Command registry, arg parsing (parseArgs), dispatch routing
  registry.ts           COMMANDS array: id, tokens, group, summary, usage, details, examples, booleanFlags
  dispatch.ts           Resolves the definition, migrates a legacy tool home, resolves codexDir, calls the handler
  handlers.ts           The registered handler: the main command switch, plus the Codex binding
  claude-handlers.ts    Claude-selected dispatch (reached before the Codex directory guard)
  target-bindings.ts    Binds one adapter to the shared workflows (bindTarget/bindCodexTarget/bindClaudeTarget)
  target-presenters.ts  Per-target human renderers, selected by a pure static registry
src/cli/output.ts       Human + JSON rendering
src/cli/report-lines.ts Pure text helpers shared by the renderer and the presenters
src/app/                Application services — one file per command action
  run-mutation.ts       Lock + backup + rollback wrapper for all write ops
  provider-workflows.ts The six shared provider workflows and the single commitProviderChange boundary
  collect-target-reports.ts  The generic status/doctor composer
  targets/              Target adapters (codex-adapter, claude-adapter), the adapter types, report ports
src/domain/             Pure types, validation, errors, parsers (no I/O)
  command.ts            CommandId, ProviderVerb, PROVIDER_VERBS, isProviderVerb
  target.ts             Target metadata, per-command policies, scope and routing rules
  provider-registry.ts  The generic registry shape both targets store
  providers.ts          Codex ProviderRecord / ProvidersFile
  claude-providers.ts   Claude ClaudeProviderRecord / ClaudeProvidersFile
  config.ts             TOML parser with byte-offset patching (~1140 lines)
  secrets.ts            Secret-key pattern, maskSecret, maskSecretValues, redactSecretValues
  errors.ts             ErrorCode union + cliError() factory
src/storage/            File I/O — read/write repos, path resolution
  tool-home-paths.ts    Tool-home paths, the identity constants, and the frozen LEGACY_* names
  codex-paths.ts        The ~/.codex target paths and directory resolution
  claude-paths.ts       ~/.claude target paths
  provider-registry-repo.ts  createRegistryRepo() — the one JSON registry reader/writer
  tool-home-migration.ts  Moves a pre-1.0.0 tool home to its current location
src/interaction/        Interactive prompts (inquirer-based)
src/runtime/            Codex CLI detection/probing
```

`src/cli.ts` imports `commands/dispatch` **dynamically**, and help/version finish before dispatch executes. That boundary is load-bearing and now structural: `commands/registry.ts` holds declarations only, and the handler is loaded by `commands/dispatch.ts`, so `--help` does not pull in the app services, the inquirer runtime, the Codex probe, or any registry I/O. Do **not** put a `handler` back on `CommandDefinition` — a static import of `handlers.ts` from the registry is exactly what defeats the dynamic import. `tests/load-boundary.spec.js` checks this in a child process and would fail on that edit; it also asserts the counter-case, that a real command does load them. `runCli(argv, io)` is the whole entry ladder — it takes line-oriented `{ stdout, stderr }` sinks and returns an exit code instead of calling `process.exit`. Tests call `runCli` directly through `runBuiltCli()`, so the dispatch ladder has exactly one implementation: there is no in-process mirror to keep in sync, and a change to `src/cli.ts` is immediately visible to the suite.

Output rendering is pure: `renderSuccess` / `renderFailure` in `src/cli/output.ts` return `{ stdout, stderr, exitCode }` and never write. Never add a `process.exit` to the library path — `src/cli.ts` sets `process.exitCode` after the promise settles, because exiting right after a write to a POSIX pipe can truncate stdout.

### Dual-Target Model

The CLI manages two independent targets via the same tool-home (`~/.config/agent-provider-switch/`):

- **Codex** (default): `providers.json` → projected into `~/.codex/config.toml` + `auth.json`
- **Claude Code** (`--claude` / `--target claude`): `claude-providers.json` → atomic replacement of `~/.claude/settings.json`

`src/domain/target.ts` declares each command's scope, and `src/domain/command.ts` the command and verb vocabulary. `acceptsTarget()` / `routesToClaudeHandler()` derive both from those declarations, and `parseArgs()` normalizes `--target <id>`, `--codex`, and `--claude` into one `targetSelection`; nothing downstream re-reads the flags. `doctor`, `status`, and `backups list` compose reports across the selected targets rather than taking the Claude early-return. `handleRegisteredCommand()` performs that early-return before the Codex directory guard, so Claude provider commands work without a configured Codex directory — that ordering is why the guard cannot simply move to the top of the function.

The six provider verbs (`add`/`list`/`show`/`current`/`switch`/`remove`) are implemented once, in `src/app/provider-workflows.ts`, and each target contributes a `ProviderAdapter` under `src/app/targets/`. An adapter declares records, native plans, matching and payload views; it must not import the shared workflow module, `run-mutation.ts`, `provider-registry-repo.ts`, the shared chooser, or `target-bindings.ts`. `tests/shared-workflows.spec.js` enforces that, that both adapters implement the same hook surface, and that `commitProviderChange` is entered only from the module that declares it. Native settings, defaults, matching, and presentation stay target-specific; read roadmap §4 and [ADR-0001](docs/adr/0001-share-provider-workflows-through-target-adapters.md) before extending them.

Presentation follows the same split: `src/cli/output.ts` renders the shared view and the envelope, and delegates to a target's `TargetPresenter` when exactly one target is in scope. A presenter returns `null` for a command it does not own, which is how `status`, `doctor`, and `backups` reach the shared renderer; a missing presenter is an internal error, never a fallback to another target's text. Presenters are pure — they map the payload to lines and may not read a file, resolve a path, or probe a runtime.

Stored formats are unchanged: `providers.json`, `claude-providers.json`, and `agent-provider-switch.json` keep their schemas, and the same-name isolation between the two targets is a property both registries rely on.

### Tool-Home Migration

`ensureLegacyToolHomeMigrated()` runs once in `executeCommand`, after flag/scope validation and before the tool-home paths are built. The one call site covers both targets, `unlock` included; the paths must be built after migration because they resolve to the new home.

It moves the pre-`1.0.0` tool home to the current one only when **all** of these hold: `APS_HOME` is unset (checked before any filesystem call — the one thing standing between a bug here and the developer's real `~/.config`), the new home does not exist, the old one is a directory, and the old lock has no live or foreign owner. Both homes existing is a silent no-op: with no one-shot state marker, a warning there would fire on every command forever.

Inside the legacy home, the tool config and the lock file are renamed to their current names *before* the directory is. That ordering is load-bearing. The directory rename is the only irreversible step, so everything retryable has to precede it; doing it first would leave the old config filename inside a home whose existence permanently satisfies the second guard, and the tool would then read the migrated data as a fresh install with no retry ever possible.

The names it looks for come from the `LEGACY_*` constants in `src/storage/tool-home-paths.ts`. They are frozen and only ever read — never write to one, and never "update" them to match the current identity. Do not move this migration into `resolveToolHome()`: that is a pure resolver called several times per process, so the migration would run repeatedly, add probes to a hot path, and have no warning channel.

The identity literals live in `src/storage/tool-home-paths.ts` for the same reason — they moved there with the tool-home paths, and `codex-paths.ts` now holds only the `~/.codex` target. When renaming again, note that bare `codex` is **not** in scope — only the tool's own name tokens are, wherever they appear: the home directory name, the state filenames, the env-var prefix, and the bin name. A blanket `codex` replace corrupts the Codex integration itself: `--codex-dir`, `~/.codex`, `[model_providers.*]`, `src/runtime/codex-cli.ts`, `MIN_SUPPORTED_CODEX_VERSION`.

### Secret Handling

`src/domain/secrets.ts` is the single source of truth. `SECRET_KEY_PATTERN` matches key names like `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, and anything containing `auth` — tuned so `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_ATTRIBUTION_HEADER`, and `MCP_CONNECT_TIMEOUT_MS` pass through untouched.

Two different contracts, deliberately:

- **Codex `show`**: human output masks the key, `--json` returns the full `apiKey` (`includeSecret: ctx.options.json` in `handlers.ts`). This is a documented automation contract — do not "fix" it.
- **Claude `show`**: masks `env` values and omits the raw `settings` blob in *both* modes. The payload carries `revealed` so the renderer can tell masked from unmasked without re-deriving it, and `output.ts` re-applies the mask as a second line of defence.

### Mutation Safety

Managed provider and configuration writes go through `runMutation()`: acquire the shared lock, snapshot affected files, apply the change, and restore on failure. Recovery and pruning use their own shared-lock workflows; export writes an external file atomically without changing the managed registry. Both targets share one lock.

The six provider verbs reach it through `commitProviderChange()` in `src/app/provider-workflows.ts`, which is the only entry point: the common workflow owns the wrapper, and a target adapter supplies the affected files and the native changes without nesting another `runMutation()`. A second caller of `commitProviderChange` would be a second lock and a second backup for one logical change, so `tests/shared-workflows.spec.js` fails on one.

Rollback is contained: `restoreManifest(manifest, allowedRoots)` requires an allowlist **built by the caller**, never read from the manifest — a root recorded inside the manifest would be tamperable by the same edit that redirects a restore path. Every restore path must resolve inside a root or it throws `ROLLBACK_PATH_REJECTED`. The parameter is required, not optional, so a new call site cannot silently skip the check. Both targets share one `backups/` dir and one `latest.json`, so the Codex rollback handler passes the Claude directory as a third root.

### Argument Parsing and Target Selection

`parseArgs()` first extracts `--json`, `--reveal`, `--codex-dir`, and the declared boolean flags, including `--claude` and `--codex`, before resolving command tokens. Booleans do not consume the following provider name, so `aps add --claude myname` and prefix target flags are supported. The old `resolveClaudeProviderName()` workaround is gone. Help/version are detected by scanning the remaining tokens.

`--target <id>` is extracted in that same first pass, so its prefix and suffix forms both work; what all three spellings produce is one `targetSelection`, and every guard, handler, and report reads that instead of the flags. Same-target repeats are accepted, two different targets are refused, and a missing, flag-shaped, or unknown id reports `INVALID_ARGUMENT`. `--target` does not accept the `=` form. Other valued command options are parsed after command resolution.

## Version Bumps and Releases

`tests/release-contract.spec.js` is the gate. It hardcodes the version in the `package.json` and both `package-lock.json` fields, asserts `--version` prints it, pins the package name and `bin` map across both files, and asserts the PRD/Design docs for the current line exist. A version bump is not complete until:

1. `package.json` **and both spots** in `package-lock.json` (root `version` and `packages[""].version`).
2. `tests/release-contract.spec.js` — update the version assertions and add the new `docs/PRD/` + `docs/Design/` existence checks.
3. `CHANGELOG.md` — a new entry at the top.
4. Docs that track the current version: `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, `docs/Tests/testing.md`.
5. Add `docs/PRD/agent-provider-switch-prd-v<version>.md` and `docs/Design/agent-provider-switch-v<version>-design.md`. Every release carries both.
6. `npm run build && npx tsc --noEmit && node tests/run-tests.js`.

Keep the product overview and technical architecture's current fact sources aligned with the released version, and label planned behavior separately. The contract test's broad version regex does not prove those documents are current. Roadmaps describe decisions rather than released functionality and are not version-tracked by the contract test.

`docs/agent-provider-switch-1.x-roadmap.md` is the live decision document — read it before planning anything. `docs/agent-provider-switch-2.x-roadmap.md` is superseded for planning but its §2 remains the **source of record for finding IDs** (`P0-*` / `P1-*` / `P2-*`): cite those IDs (e.g. P1-9) in comments and commits, and never renumber them.

## Style

- TypeScript strict mode, 2-space indent, semicolons, double-quoted imports
- `camelCase` functions/variables, `PascalCase` types, `kebab-case` filenames
- JSDoc on exported functions; inline comments only for non-obvious invariants
- No formatter/linter configured — match surrounding code
- Comments explain *why*, not *what*: e.g. "`chmod` is applied after the rename, because the mode passed at write time is masked by the umask"

## Testing

- Plain Node specs using `node:assert/strict`
- Test helpers in `tests/helpers.js`: `makeTempDir()`, `withEnv()`, `makeToolHomeWithManagedState()`, `withClaudeEnv()`, `makeCodexFixture()`, `runBuiltCli()`, `runJsonCli()`
- `runBuiltCli()` swaps `APS_HOME` and calls `runCli` in-process; `runJsonCli()` additionally parses the JSON envelope from stdout on success or stderr on failure. Both accept `--codex-dir` in `args`
- `runBuiltCli()` points `APS_CODEX_DIR` at a temporary directory whenever the call passes no `--codex-dir`, so a spec that forgets it cannot operate on the real `~/.codex`
- Use `makeCodexFixture()` for any Codex target; there is no checked-in fixture directory
- `withClaudeEnv()` is the only safe way to run a Claude command: it verifies `APS_CLAUDE_DIR` resolves inside a temp directory before running anything, because `switch --claude` replaces `settings.json` and would otherwise hit the real `~/.claude`. It pins `APS_HOME` for the same reason one directory over — a Claude write goes to `<APS_HOME>/claude-providers.json`, and an unset variable sends it to the developer's real `~/.config/agent-provider-switch`. **Pass `--json` on every Claude spec invocation** — `canPrompt()` is true whenever the suite runs in a terminal, so a missing `--json` blocks on an inquirer prompt and hangs the suite instead of failing it
- POSIX-only assertions (file modes) must `return` early on `win32`
- `tests/provider-prompts.spec.js` covers prompting by calling `executeCommand()` from `commands/dispatch` with a recorded fake `CliPromptRuntime`, which is the only way to reach a prompt without a TTY. It is the one suite exempt from the `--json` rule above, and only because nothing on its path builds the inquirer-backed runtime: it asserts for both targets that an unnamed `switch` asks once over that target's own registry, that a declined confirmation reaches neither the registry nor `runMutation()`, and that a non-interactive runtime and `--json` each suppress prompting entirely
- Two specs assert structure rather than behaviour, because the property is about the call graph: `tests/shared-workflows.spec.js` reads `src/` to check that adapters import no orchestration and that `commitProviderChange` has one entry point, and `tests/load-boundary.spec.js` spawns a child process to check what `--help` loads. When either fails, the fix is the architecture, not the assertion — and the load-boundary spec's second test exists so a recorder that records nothing cannot pass

## Security

Never commit real API keys, `auth.json`, `settings.json` with real tokens, or private provider exports.

Note the platform split on file permissions: `writeTextFileAtomic()` sets `0600`/`0700` on POSIX and **skips `chmod` entirely on Windows**, where it only toggles the read-only bit and access is actually governed by NTFS ACLs. The POSIX assertions in `tests/secret-handling.spec.js` return early on Windows, so that code path has no executable coverage there.
