# README.AI

This file is the current AI-facing fact sheet for `@minniexcode/agent-provider-switch`. It is meant to be quoted, so it holds only claims that are true of this repository: every symbol named below exists in `src/`, and the behaviour claims are the ones the suite asserts.

`agent-provider-switch` is a local-first CLI for managing and switching Codex and Claude Code provider routing. It manages provider records, projects Codex `model_provider` sections, writes the active top-level `model` / `model_provider` route, switches Claude Code `settings.json` profiles atomically, and keeps backups around every mutating command.

Version: the published package is `1.2.0`. It replaces the two parallel provider implementations with one set of shared workflows selected through target adapters, and adds `--target <id>` beside `--codex` and `--claude`. Stored formats, the JSON envelope, the error vocabulary, and the exit codes are unchanged from `1.1.3`.

## Where the current facts live

- [PRD 1.2.0](./docs/PRD/agent-provider-switch-prd-v1.2.0.md) and [Design 1.2.0](./docs/Design/agent-provider-switch-v1.2.0-design.md) — the released behaviour: shared workflows, target adapters, `--target <id>`.
- [PRD 1.1.3](./docs/PRD/agent-provider-switch-prd-v1.1.3.md) and [Design 1.1.3](./docs/Design/agent-provider-switch-v1.1.3-design.md) — the previous line: the per-command target scope and the two-target reports.
- [ADR-0001](./docs/adr/0001-share-provider-workflows-through-target-adapters.md) — why the workflows are shared through target adapters.
- [CLI usage](./docs/cli-usage.md), [technical architecture](./docs/agent-provider-switch-technical-architecture.md), [1.x roadmap](./docs/agent-provider-switch-1.x-roadmap.md).

Every other pair under `docs/PRD/` and `docs/Design/` is history, kept for context only.

## Architecture

The six provider verbs — `add`, `list`, `show`, `current`, `switch`, `remove` — are implemented once in `src/app/provider-workflows.ts`. Each target contributes a `ProviderAdapter` under `src/app/targets/` that declares its records, native plans, matching rules, and payload views; an adapter must not import the shared workflow module, `src/app/run-mutation.ts`, `src/storage/provider-registry-repo.ts`, the shared chooser, or `src/commands/target-bindings.ts`.

- `commitProviderChange()` in `src/app/provider-workflows.ts` is the single mutation boundary for a provider write. It wraps `runMutation()`, which owns the lock, the backup, and the rollback. A second caller would be a second lock and a second backup for one logical change.
- `src/commands/target-bindings.ts` binds one adapter to those workflows (`bindTarget`, `bindCodexTarget`, `bindClaudeTarget`). A command handler routes here rather than opening its own transaction.
- `src/storage/provider-registry-repo.ts` exports `createRegistryRepo(path, codec, errorPolicy)`, the one JSON registry reader/writer, parameterized by the target's codec.
- `src/interaction/provider-selection.ts` holds the provider chooser both targets share.
- `src/cli/output.ts` renders the shared view and the JSON envelope and delegates to a target's presenter; `src/cli/report-lines.ts` holds the pure text helpers both use; `src/commands/target-presenters.ts` maps a target id to its presenter (`presenterFor`). Presenters are pure — they map a payload to lines and may not read a file, resolve a path, or probe a runtime. A missing presenter is an internal error, never a fallback to another target's text.
- `src/commands/registry.ts` holds command declarations only, and the handler is loaded by `src/commands/dispatch.ts`. That split is why `--help` loads no app service, no inquirer, no Codex probe, and no registry I/O. Do not put a `handler` back on `CommandDefinition`.

Three specs assert that structure rather than its output, so a regression fails loudly:

- `tests/shared-workflows.spec.js` — adapters import no orchestration, both adapters implement the same hook surface, and `commitProviderChange` has exactly one entry point.
- `tests/load-boundary.spec.js` — `--help` and `--version` load no execution service, in a child process, with a counter-case proving the recorder records something.
- `tests/provider-prompts.spec.js` — drives a fake prompt runtime through both targets via `executeCommand()`.

## Target selection

`parseArgs()` extracts `--json`, `--reveal`, `--codex-dir`, `--target <id>`, and the declared boolean flags before resolving command tokens, and normalizes `--target <id>`, `--codex`, and `--claude` into one `targetSelection`. Nothing downstream re-reads the flags.

`src/domain/target.ts` declares `COMMAND_TARGET_POLICIES`, one entry per command id, and is the only place the scope answer lives. The accessors are `policyOf()`, `scopeOf()`, `scopeOfName()`, `acceptsTarget()`, `acceptsTargetFlag()`, `routesToClaudeHandler()`, `resolveCommandTargets()`, and `singleTarget()`. `src/domain/command.ts` holds the command and verb vocabulary, including `isProviderVerb()`.

Scopes, and what a target flag means in each:

- `switchable` — `add`, `switch`, `list`, `show`, `current`, `remove`. Two code paths; the flag picks one, and Codex is the default.
- `codex-only` — `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config show`, `config list-profiles`. A Claude target is refused; `--codex` is accepted and changes nothing.
- `claude-only` — `config compact`. The Claude target is required, and the command routes to the Claude handler either way.
- `both` — `status`, `doctor`, `backups list`. Reports on both targets; a flag narrows the report rather than choosing a code path.
- `shared` — `backups prune`, `rollback`, `unlock`. One backups tree, one pointer, one lock, so both flags are refused.

Scope and routing are different questions: `acceptsTarget()` is true for `switchable`, `claude-only`, and `both`, while `routesToClaudeHandler()` is true only for the first two, because no Claude handler could produce the whole answer for a `both` command. Naming two different targets is refused with `INVALID_ARGUMENT` before any handler runs; repeating the same target is accepted; `--target` does not accept the `=` form. On a `both` command, `--codex-dir` together with a Claude target is refused as well.

The envelope carries `targets` (authoritative) and `target` (`singleTarget(targets)`, non-null exactly when one target is in scope). On a bare multi-target command `target` is `null`; on a refusal raised by the flags it is `null` and `targets` is `[]`.

Error codes name a condition and never a target. A Claude payload carries no `target` of its own — the envelope's is the only copy. Messages still name the target where the state needs it (`Claude provider "x" was not found.`), and `PROVIDER_ALREADY_EXISTS` (a record name is taken) stays distinct from `PROVIDERS_ALREADY_EXISTS` (the registry file exists).

## Reporting on both targets

`doctor` and `status` compose their payload from `ctx.targets`. An out-of-scope target is not read at all: `aps doctor --claude` never reads `config.toml` and never runs the Codex CLI probe. An in-scope but unconfigured target contributes no issue and does not affect `healthy`; `configured` is a reading whose evidence must be a file — the registry, an actual runtime configuration file, or a defaults block — because an empty directory proves nothing. Every `doctor` issue carries a `target` except the lock check, which is inspected once and reported with `target: null`. A lock held by a live process is `{status: "ok", value: "busy"}` and no finding.

Every per-target field is a `Reading<T>` — `{status: "ok", value}`, `absent`, `invalid`, or `unavailable` — so "there is no such file", "it could not be read", and "the answer really is zero" are three different payloads instead of one `null`. The identity answer is `matching`: `not-activated`, `unmanaged`, `managed`, or `ambiguous`, with every candidate and its `differencePaths` (paths only, never values). `healthy` is three-valued: `false` with an issue, `true` when the checks completed cleanly, `null` when they could not be completed and nothing that ran found a fault. `complete` says whether every planned reading was obtainable. Codex's projection fields — `currentModel`, `currentModelProvider`, `liveState`, `configProfiles`, `artifacts` — live inside `data.codex`; Claude's `settingsStatus` sits in `data.claude` beside `providers`, whose rows carry `inherited` as a list of dotted paths (paths only, never values). An absent `settings.json` is the `not-activated` state rather than a diagnosis, so no error code names it.

`backups list` entries carry `target`: `codex`, `claude`, `mixed`, or `unknown`. Classification order is `manifest.target`, then a `claude-` operation prefix, then a known Codex operation name, then artifact names and containment in the Claude directory, then the Codex directory. An unclassifiable manifest reads `unknown` rather than being guessed at. Narrowed listings include `mixed` in both and `unknown` in neither. `rollback` reports the targets its restore paths overwrote under `data.targets`, beside `data.impact` (`{shared, unknown}`).

## Claude Code specifics

`agent-provider-switch.json` may carry `claudeDefaults: { settings: { ... } }`. It is hand-written: no command creates or edits it, and `config compact` refuses when it is absent. A malformed block (an unknown key under `claudeDefaults`, or a non-object `settings`) is `INVALID_CONFIG` for every command, because the tool config is read on every dispatch; unknown keys are refused rather than dropped.

Merge rule: plain objects merge recursively, the record wins, arrays are replaced wholesale, `null` deletes an inherited key. `env` has no special case. An empty object does **not** clear an inherited object — only `null` does.

- Resolution is read-side. The stored record stays a delta; `list`, `current`, `show`, the interactive selector, and `switch` resolve it, and only `switch` writes the result to `~/.claude/settings.json`. `remove` and `config compact` work on the raw records, so a delete cannot expand the defaults into the survivors.
- With no defaults block nothing is merged and a record is written verbatim, explicit `null` members included.
- `add --claude --from-file` slims by default (drops entries deep-equal to the defaults); `--full` keeps every entry, which pins them against later changes to the defaults. Slimming is inheritance-first, so it is not a byte-preserving round trip; the invariant is `merge(defaults, slim(defaults, x)) == merge(defaults, x)`.
- `config compact --claude` rewrites every record to its delta, changing storage and never what a switch writes. `--dry-run` takes no lock and writes nothing, and a run with nothing to change takes no backup. It is reversible through `rollback`.
- `show --claude` prints the resolved settings, marks inherited entries, and lists inherited dotted paths in `--json` (`inherited`). `--reveal` returns `settings` (resolved) plus `overrides` (stored).

`show --claude` masks env values whose key matches `SECRET_KEY_PATTERN` and omits the raw `settings` blob, in both human and `--json` output — including a credential inherited from the defaults. The payload carries `revealed` so renderers can tell masked from unmasked without re-deriving it, and `output.ts` re-applies the mask as a second line of defence. `--reveal` is a global flag that affects the Claude `show` path only. Codex `show --json` still returns the full `apiKey` — a documented automation contract, deliberately unchanged.

`--full` and `--dry-run` are global boolean flags in the parser but are refused with `INVALID_ARGUMENT` anywhere they would be ignored: `--full` applies only to `add --claude`, `--dry-run` only to `config compact --claude`. The check runs before the Claude early-return, so `switch --claude --full` is refused too. Accepted-and-ignored is the dangerous reading — `aps backups prune --dry-run` would otherwise delete real backups under a flag that promised a preview.

## Command surface

```text
init
migrate
list [--claude]                 show [--claude] [--reveal]
current [--claude]              status [--codex] [--claude]
config show                     config list-profiles
config compact --claude [--dry-run]
add [--claude] [--full]         edit
switch [--claude]               remove [--claude]
import                          export
backups list [--codex] [--claude]
backups prune [--keep N]        unlock [--force]        rollback [backup-id]
doctor [--codex] [--claude]     setup
```

`setup` is deprecated and only points callers to `init` or `migrate`. Every command that takes a target also takes `--target <id>`. All commands accept `--json` where the parser supports it, and `--codex-dir <path>`; `--codex-dir` refuses a following token that starts with `-` instead of taking it as the path value.

## State model

```text
~/.config/agent-provider-switch/     # tool home; APS_HOME overrides
  agent-provider-switch.json         # version, optional claudeDefaults
  providers.json                     # Codex registry
  claude-providers.json              # Claude registry
  backups/                           # one tree, one latest.json, both targets
  .aps.lock                          # one lock, both targets

~/.codex/                            # config.toml, auth.json
~/.claude/                           # settings.json
```

Managed projection for current Codex versions is route-first: top-level `model`, top-level `model_provider`, the matching `[model_providers.<id>]`, and API-key auth in `auth.json`. Do not present top-level `profile` or `[profiles.*]` as the current managed runtime path; `--create-profile` writes `[profiles.<id>]` as an explicit opt-in for older Codex builds that route through it. `APS_CODEX_DIR` and `APS_CLAUDE_DIR` override the two target directories, and `NODE_ENV=development` defaults to `./dev-codex/local-sandbox` when nothing else is set.

## Locks and retention

- A killed process leaves its lock behind. `aps unlock` clears it only when the recorded owner is provably gone; a live owner is refused, because a false takeover corrupts state where a false conflict only inconveniences. `aps unlock --force` is the documented override for a recycled pid. No lock present is success.
- There is no TTL-based takeover. A slow `migrate` can exceed any timer, so a pid that looks live is treated as live.
- Backups retain the newest 20 by default. `aps backups prune [--keep N]` is the manual path, and retention also runs automatically after every successful mutation.
- A directory that any surviving manifest still references is never deleted, because rollback resolves through it. Directories whose manifest is missing or unreadable are reported rather than deleted.
- Backup directory names are `YYYYMMDD-HHmmssSSS` and are created exclusively, so two mutations in the same second cannot collide; the path is returned by the create rather than re-derived from the timestamp.

## Not implemented

- A command that creates or edits the `claudeDefaults` block.
- Export or import of Claude provider records; both commands are Codex-only.
- Field-based Claude provider creation — only `--from-file` import is supported.
- Copilot SDK integration, device-flow login, an HTTP proxy bridge, background runtime services, third-party router packaging, account systems or cloud sync, and Claude Code plugin marketplace management.
- A third target. `TargetId` is a closed union of two, so adding one is a type change that fails at every exhaustive switch — the intended shape.
- A pluggable provider type system, and an exit-code taxonomy (success is `0`, failure is `1`).
- Deletion of the dead code trees (`src/infra/`, the dead `src/cli/` shims) — that is `P2-1`.
- A change to `engines.node`: it advertises `>=18` while the sole runtime dependency requires `>=20.12`, and CI does not test Node 18.

## Verification commands

```bash
npx tsc --noEmit
npm test          # in-process suite; prints nothing on success
npm run test:e2e  # real child processes; prints passed/failed/skipped
git diff --check
node dist/cli.js --help
node dist/cli.js --version
npm pack --dry-run
```
