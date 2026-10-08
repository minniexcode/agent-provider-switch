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

The one live file under `src/cli/` is `src/cli/output.ts`: the human and JSON renderer for every command.

`src/infra/` is slated for deletion in Phase 2 (roadmap P2-1). Do not add to it, and do not "fix" it to match its live twin.

## Architecture

```
src/cli.ts              Entry point — argv parsing, --help/--version, lazily imports commands/dispatch
src/commands/           Command registry, arg parsing (parseArgs), dispatch routing
  registry.ts           COMMANDS array: id, tokens, usage, details, examples, handler
  dispatch.ts           Resolves the definition, migrates a legacy tool home, resolves codexDir, calls the handler
  handlers.ts           Main switch for Codex commands
  claude-handlers.ts    --claude flag dispatch (early-returns before the Codex path)
src/cli/output.ts       Human + JSON rendering (the only live file in src/cli/)
src/app/                Application services — one file per command action
  run-mutation.ts       Lock + backup + rollback wrapper for all write ops
src/domain/             Pure types, validation, errors, parsers (no I/O)
  providers.ts          Codex ProviderRecord / ProvidersFile
  claude-providers.ts   Claude ClaudeProviderRecord / ClaudeProvidersFile
  config.ts             TOML parser with byte-offset patching (~1140 lines)
  secrets.ts            Secret-key pattern, maskSecret, maskSecretValues, redactSecretValues
  errors.ts             ErrorCode union + cliError() factory
src/storage/            File I/O — read/write repos, path resolution
  codex-paths.ts        ~/.config/agent-provider-switch paths + ~/.codex target
                        (also owns the identity constants and the frozen LEGACY_* names)
  claude-paths.ts       ~/.claude target paths
  tool-home-migration.ts  Moves a pre-1.0.0 tool home to its current location
src/interaction/        Interactive prompts (inquirer-based)
src/runtime/            Codex CLI detection/probing
```

`src/cli.ts` imports `commands/dispatch` **dynamically**, so `--help`, `--version`, and flag errors never load `inquirer` or the command services. `runCli(argv, io)` is the whole entry ladder — it takes line-oriented `{ stdout, stderr }` sinks and returns an exit code instead of calling `process.exit`. Tests call `runCli` directly through `runBuiltCli()`, so the dispatch ladder has exactly one implementation: there is no in-process mirror to keep in sync, and a change to `src/cli.ts` is immediately visible to the suite.

Output rendering is pure: `renderSuccess` / `renderFailure` in `src/cli/output.ts` return `{ stdout, stderr, exitCode }` and never write. Never add a `process.exit` to the library path — `src/cli.ts` sets `process.exitCode` after the promise settles, because exiting right after a write to a POSIX pipe can truncate stdout.

### Dual-Target Model

The CLI manages two independent targets via the same tool-home (`~/.config/agent-provider-switch/`):

- **Codex** (default): `providers.json` → projected into `~/.codex/config.toml` + `auth.json`
- **Claude Code** (`--claude` flag): `claude-providers.json` → atomic replacement of `~/.claude/settings.json`

`isClaudeCommand(command, commandOptions)` gates a fixed set (`add`, `switch`, `list`, `show`, `current`, `remove`). `handleRegisteredCommand()` checks it first and early-returns to `handleClaudeCommand()` **before** the `ctx.options.codexDir` null check, so Claude commands work with no Codex directory configured. All commands share one registry — there is no separate Claude command table.

### Tool-Home Migration

`ensureLegacyToolHomeMigrated()` runs once at the top of `executeCommand` — the single funnel every command passes through, so one call site covers both targets, `unlock` included. It runs *before* the tool-home paths are built, because those resolve to the new home.

It moves the pre-`1.0.0` tool home to the current one only when **all** of these hold: `APS_HOME` is unset (checked before any filesystem call — the one thing standing between a bug here and the developer's real `~/.config`), the new home does not exist, the old one is a directory, and the old lock has no live or foreign owner. Both homes existing is a silent no-op: with no one-shot state marker, a warning there would fire on every command forever.

Inside the legacy home, the tool config and the lock file are renamed to their current names *before* the directory is. That ordering is load-bearing. The directory rename is the only irreversible step, so everything retryable has to precede it; doing it first would leave the old config filename inside a home whose existence permanently satisfies the second guard, and the tool would then read the migrated data as a fresh install with no retry ever possible.

The names it looks for come from the `LEGACY_*` constants in `src/storage/codex-paths.ts`. They are frozen and only ever read — never write to one, and never "update" them to match the current identity. Do not move this migration into `resolveToolHome()`: that is a pure resolver called several times per process, so the migration would run repeatedly, add probes to a hot path, and have no warning channel.

The identity literals live in one place for the same reason. When renaming again, note that bare `codex` is **not** in scope — only the tool's own name tokens are, wherever they appear: the home directory name, the state filenames, the env-var prefix, and the bin name. A blanket `codex` replace corrupts the Codex integration itself: `--codex-dir`, `~/.codex`, `[model_providers.*]`, `src/runtime/codex-cli.ts`, `MIN_SUPPORTED_CODEX_VERSION`.

### Secret Handling

`src/domain/secrets.ts` is the single source of truth. `SECRET_KEY_PATTERN` matches key names like `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, and anything containing `auth` — tuned so `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_ATTRIBUTION_HEADER`, and `MCP_CONNECT_TIMEOUT_MS` pass through untouched.

Two different contracts, deliberately:

- **Codex `show`**: human output masks the key, `--json` returns the full `apiKey` (`includeSecret: ctx.options.json` in `handlers.ts`). This is a documented automation contract — do not "fix" it.
- **Claude `show`**: masks `env` values and omits the raw `settings` blob in *both* modes. The payload carries `revealed` so the renderer can tell masked from unmasked without re-deriving it, and `output.ts` re-applies the mask as a second line of defence.

### Mutation Safety

All write commands go through `runMutation()` which: acquires a file lock, snapshots affected files into `backups/`, executes the mutation, and auto-restores on failure. Both Codex and Claude operations share the same lock file.

Rollback is contained: `restoreManifest(manifest, allowedRoots)` requires an allowlist **built by the caller**, never read from the manifest — a root recorded inside the manifest would be tamperable by the same edit that redirects a restore path. Every restore path must resolve inside a root or it throws `ROLLBACK_PATH_REJECTED`. The parameter is required, not optional, so a new call site cannot silently skip the check. Both targets share one `backups/` dir and one `latest.json`, so the Codex rollback handler passes the Claude directory as a third root.

### Arg Parsing Quirk

The arg parser (`src/commands/args.ts`) treats any `--flag nextToken` as `flag=nextToken` unless `nextToken` starts with `--`. So `aps add --claude myname` assigns `"myname"` as the value of `--claude`. `resolveClaudeProviderName()` in `claude-handlers.ts` normalizes this by checking both positionals and the `--claude` flag value.

`--reveal` sidesteps the quirk by being registered as a **global** flag: `parseArgs()`'s first pass matches tokens by exact equality, so it is stripped before the greedy second pass can swallow a provider name. Without this, `aps show --reveal deepseek` would eat `deepseek`. Fixing the parser itself is Phase 2 (roadmap P1-1) — new boolean flags should be global until then.

Pass 1 strips exactly three tokens by exact equality: `--json`, `--reveal`, `--codex-dir`. `--version`/`-v` and `--help` are not stripped there — they are detected afterwards by scanning the leftover tokens, so they must appear where the command-option pass will not consume them as a value.

## Version Bumps and Releases

`tests/release-contract.spec.js` is the gate. It hardcodes the version in the `package.json` and both `package-lock.json` fields, asserts `--version` prints it, pins the package name and `bin` map across both files, and asserts the PRD/Design docs for the current line exist. A version bump is not complete until:

1. `package.json` **and both spots** in `package-lock.json` (root `version` and `packages[""].version`).
2. `tests/release-contract.spec.js` — update the version assertions and add the new `docs/PRD/` + `docs/Design/` existence checks.
3. `CHANGELOG.md` — a new entry at the top.
4. Docs that track the current version: `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, `docs/Tests/testing.md`.
5. Add `docs/PRD/agent-provider-switch-prd-v<version>.md` and `docs/Design/agent-provider-switch-v<version>-design.md`. Every release carries both.
6. `npm run build && npx tsc --noEmit && node tests/run-tests.js`.

`docs/agent-provider-switch-product-overview.md` and `docs/agent-provider-switch-technical-architecture.md` deliberately lag a version or two; the contract test's version regex tolerates that. `docs/agent-provider-switch-2.x-roadmap.md` is the source of record for outstanding findings — cite its IDs (e.g. P1-9) in comments and commits.

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
- `withClaudeEnv()` is the only safe way to run a Claude command: it verifies `APS_CLAUDE_DIR` resolves inside a temp directory before running anything, because `switch --claude` replaces `settings.json` and would otherwise hit the real `~/.claude`. **Pass `--json` on every Claude spec invocation** — `canPrompt()` is true whenever the suite runs in a terminal, so a missing `--json` blocks on an inquirer prompt and hangs the suite instead of failing it
- POSIX-only assertions (file modes) must `return` early on `win32`

## Security

Never commit real API keys, `auth.json`, `settings.json` with real tokens, or private provider exports.

Note the platform split on file permissions: `writeTextFileAtomic()` sets `0600`/`0700` on POSIX and **skips `chmod` entirely on Windows**, where it only toggles the read-only bit and access is actually governed by NTFS ACLs. The POSIX assertions in `tests/secret-handling.spec.js` return early on Windows, so that code path has no executable coverage there.
