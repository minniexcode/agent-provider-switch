# README.AI

This file is the current AI-facing fact sheet for `@minniexcode/agent-provider-switch`.

Current repository version: `1.1.0`

Current fact sources:

- `docs/PRD/agent-provider-switch-prd-v1.1.0.md`
- `docs/Design/agent-provider-switch-v1.1.0-design.md`
- `docs/PRD/agent-provider-switch-prd-v1.0.0.md`
- `docs/Design/agent-provider-switch-v1.0.0-design.md`
- `docs/PRD/agent-provider-switch-prd-v0.4.1.md`
- `docs/Design/agent-provider-switch-v0.4.1-design.md`
- `docs/PRD/agent-provider-switch-prd-v0.4.0.md`
- `docs/Design/agent-provider-switch-v0.4.0-design.md`
- `docs/PRD/agent-provider-switch-prd-v0.3.1.md`
- `docs/Design/agent-provider-switch-v0.3.1-design.md`
- `docs/PRD/agent-provider-switch-prd-v0.3.0.md`
- `docs/Design/agent-provider-switch-v0.3.0-design.md`
- `docs/PRD/agent-provider-switch-prd-v0.2.1.md`
- `docs/Design/agent-provider-switch-v0.2.1-design.md`
- `docs/cli-usage.md`

## Product Positioning

`agent-provider-switch` is a local-first CLI for managing and switching Codex and Claude Code provider routing. It manages local provider records, projects Codex `model_provider` sections, writes the active top-level `model` / `model_provider` route, switches Claude Code `settings.json` profiles, and maintains backups around mutating commands.

In `1.1.0`, there are two managed workflows:
1. **Codex providers** — OpenAI-compatible provider records projected into `config.toml` / `auth.json`.
2. **Claude Code providers** (via `--claude` flag) — `settings.json` profiles stored as deltas over an optional shared `claudeDefaults` block, and switched atomically.

## Primary Workflow (Codex)

```bash
aps init
aps add <provider> --profile <model-provider-id> --model <model> --api-key <key> [--base-url <url>]
aps switch <provider>
aps status
aps doctor
```

`--profile` means managed `model_provider` id alias. It is not the legacy Codex top-level `profile` selector.

## Claude Code Workflow

```bash
aps add --claude <name> --from-file <settings.json> [--full]
aps switch --claude <name>
aps current --claude
aps list --claude
aps show --claude <name>
aps show --claude <name> --reveal
aps remove --claude <name> --force
aps config compact --claude [--dry-run]
```

Without a `claudeDefaults` block, Claude providers store the entire `settings.json` as an opaque blob and switching replaces the whole file atomically with backup/rollback. With one, each record stores a delta and a switch writes `merge(defaults, record)`.

### Shared Claude defaults

`agent-provider-switch.json` may carry `claudeDefaults: { settings: { ... } }`. It is hand-written: no command creates or edits it, and `config compact` refuses when it is absent. A malformed block (an unknown key under `claudeDefaults`, or a non-object `settings`) is `INVALID_CONFIG` for every command, because the tool config is read on every dispatch; unknown keys are refused rather than dropped.

Merge rule: plain objects merge recursively, the record wins, arrays are replaced wholesale, `null` deletes an inherited key. `env` has no special case. An empty object does **not** clear an inherited object — only `null` does.

- Resolution is read-side. The stored record stays a delta; `list`, `current`, `show`, the interactive selector, and `switch` resolve it, and only `switch` writes the result to `~/.claude/settings.json`. `remove` and `config compact` work on the raw records so a delete cannot expand the defaults into the survivors.
- With no defaults block nothing is merged and a record is written verbatim, explicit `null` members included.
- `add --claude --from-file` slims by default (drops entries deep-equal to the defaults); `--full` keeps every entry, which pins them against later changes to the defaults. Slimming is inheritance-first: a default the file omits is inherited, so it is not a byte-preserving round trip. The invariant is `merge(defaults, slim(defaults, x)) == merge(defaults, x)`.
- `config compact --claude` rewrites every record to its delta. It changes storage, never what a switch writes. `--dry-run` takes no lock and writes nothing; a run with nothing to change takes no backup. It is reversible through `rollback`.
- `show --claude` prints the resolved settings, marks inherited entries, and lists inherited dotted paths in `--json` (`inherited`) — paths only, never values. `--reveal` returns `settings` (resolved) plus `overrides` (stored).

`show --claude` masks env values whose key matches `SECRET_KEY_PATTERN` and omits the raw `settings` blob, in both human and `--json` output. That includes a credential inherited from the defaults. The payload carries `revealed` so renderers can tell masked from unmasked without re-deriving it. `--reveal` is a global flag that prints the real values and includes `settings`; it affects the Claude `show` path only, and is never applied by default. Codex `show --json` still returns the full `apiKey` — that is a documented automation contract and is unchanged.

## Current Command Surface

Document only these current commands:

```text
init
migrate
list [--claude]
show [--claude] [--reveal]
current [--claude]
status
config show
config list-profiles
config compact --claude [--dry-run]
add [--claude] [--full]
edit
switch [--claude]
remove [--claude]
import
export
backups list
backups prune [--keep N]
unlock [--force]
rollback
doctor
setup
```

`setup` is deprecated and only points callers to `init` or `migrate`.

`--claude` is accepted only by `add`, `switch`, `list`, `show`, `current`, `remove`, and `config compact`. On any other command it is refused with `INVALID_ARGUMENT` naming the supported set, rather than silently reported as Codex state.

`--full` and `--dry-run` are global boolean flags in the parser but are refused with `INVALID_ARGUMENT` anywhere they would be ignored: `--full` applies only to `add --claude`, `--dry-run` only to `config compact --claude`. The check runs before the Claude early-return, so `switch --claude --full` is refused too. Accepted-and-ignored is the dangerous reading — `aps backups prune --dry-run` would otherwise delete real backups under a flag that promised a preview.

All commands accept `--json` where the parser supports it, and `--codex-dir <path>`. `--codex-dir` refuses a following token that starts with `-` instead of taking it as the path value.

## State Model

Tool home:

```text
~/.config/agent-provider-switch/
  agent-provider-switch.json
  providers.json
  claude-providers.json
  backups/
  .aps.lock
```

Target Codex directory:

```text
~/.codex/
  config.toml
  auth.json
```

Target Claude Code directory:

```text
~/.claude/
  settings.json
```

Managed projection for current Codex versions is route-first:

- top-level `model`
- top-level `model_provider`
- matching `[model_providers.<id>]`
- API-key auth projection in `auth.json`

Do not present top-level `profile` or `[profiles.*]` as the current managed runtime path. `--create-profile` writes the `[profiles.<id>]` section for older Codex builds that route through it; it is an explicit opt-in and is not the default projection. Those sections may otherwise be inspected for adoption or legacy diagnostics only.

Every write command takes one lock (`<toolHome>/.aps.lock`, shared by both targets) and snapshots the files it touches into `backups/` first. Backup directory names are `YYYYMMDD-HHmmssSSS` and are created exclusively, so two mutations in the same second cannot collide; the directory's path is returned by the create rather than re-derived from the timestamp.

## Locks And Retention

- A killed process leaves its lock behind. `aps unlock` clears it only when the recorded owner is provably gone; a live owner is refused because a false takeover corrupts state where a false conflict only inconveniences. `aps unlock --force` is the documented override for a recycled pid. No lock present is success.
- There is no TTL-based takeover. A slow `migrate` can exceed any timer, so a pid that looks live is treated as live.
- Backups retain the newest 20 by default. `aps backups prune [--keep N]` is the manual path and runs automatically after every successful mutation.
- A directory that any surviving manifest still references is never deleted, because rollback resolves through it. Directories whose manifest is missing or unreadable are reported rather than deleted.

## Current Non-Goals

`1.1.0` does not include:

- A command that creates or edits the `claudeDefaults` block.
- Export or import of Claude provider records (both commands are Codex-only).
- Copilot SDK integration.
- GitHub device-flow login.
- HTTP proxy bridge or local bridge worker runtime.
- Background runtime services, bridge logs, or bridge runtime state.
- Built-in third-party router packaging.
- Account systems or cloud sync.
- Claude Code plugin marketplace management.
- Generic "target" abstraction or pluggable provider type system.
- Field-based Claude provider creation (only `--from-file` import is supported).
- TTL-based lock takeover, or an audit log for takeovers.
- An exit-code taxonomy: success is `0`, failure is `1`.
- Deletion of the dead code trees (`src/infra/`, the dead `src/cli/` shims) — that is `P2-1`.

## Verification Commands

```bash
npx tsc --noEmit
npm test          # in-process suite; prints nothing on success
npm run test:e2e  # real child processes; prints passed/failed/skipped
node dist/cli.js --help
node dist/cli.js --version
npm pack --dry-run
```
