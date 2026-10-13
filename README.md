# agent-provider-switch

`@minniexcode/agent-provider-switch` is a local-first CLI for managing and switching Codex and Claude Code provider routing.

It keeps its own state in `~/.config/agent-provider-switch`, separate from the runtime directories it writes, so provider records, backups, and runtime projection change through explicit commands instead of hand-edited `config.toml` and `settings.json`.

Current package version: `1.2.0`. It adds `--target <id>` and gives both targets one shared implementation; stored formats, the JSON envelope, and the error vocabulary are unchanged. Everything below is what `aps --help` prints today. Per-version release notes are in the [CHANGELOG](./CHANGELOG.md).

## Install

```bash
npm install -g @minniexcode/agent-provider-switch
aps --help
```

Node.js `>=18` is required, with one caveat — see [Not implemented](#not-implemented). To build from source, see [Development](#development).

## Quick start

### Codex

```bash
aps init
aps add packycode --profile packycode --model gpt-5 --api-key sk-xxx --base-url https://api.example/v1
aps switch packycode
aps status
aps doctor
```

- `init` creates the tool home files.
- `add` stores a managed provider in `providers.json` and creates or updates the matching `[model_providers.<id>]` projection in `config.toml`.
- `switch` writes top-level `model` and `model_provider`, and projects `OPENAI_API_KEY` into `auth.json`.
- `status` summarizes the current mapping, the auth projection, and drift.
- `doctor` reports issue-first diagnostics.

`--profile` is a CLI alias for the managed Codex `model_provider` id. It is not the legacy Codex top-level `profile` selector.

### Claude Code

```bash
aps add --claude opus --from-file ~/.claude/settings.json
aps add --claude copilot --from-file ~/.claude/settings-copilot.json
aps switch --claude copilot
aps current --claude
aps list --claude
aps show --claude copilot
```

- `add --claude` imports a complete `settings.json` as a named profile into `claude-providers.json`. With a `claudeDefaults` block it stores only the entries that differ from it; `--full` keeps every entry.
- `switch --claude` atomically replaces `~/.claude/settings.json` with the stored profile, layered over the shared defaults when there are any.
- `current --claude` detects which registered profile matches the active settings.
- `list --claude` shows all Claude profiles with an active indicator.
- `show --claude` prints one profile as it resolves, marks which entries came from the shared defaults, masks secret env values, and withholds the raw `settings` blob.

Without a `claudeDefaults` block, Claude providers store the full `settings.json` as an opaque blob and a switch replaces the whole file with it. Providers whose settings overlap heavily are better stored as deltas, as described next.

## Choosing a target

Every command acts on Codex unless a target flag says otherwise. The three flags are equivalent, and only one target may be named:

| Spelling | Meaning |
|---|---|
| *(none)* | Codex — the default |
| `--codex` | Codex, named explicitly so a command line reads the same whichever target it picks |
| `--claude` | Claude Code |
| `--target <id>` | `codex` or `claude`, for a value that arrives from a variable |

Naming two different targets is refused with `INVALID_ARGUMENT` rather than resolved by a precedence rule; repeating the same one is accepted. `--target` takes a space-separated value — the `--target=codex` form is refused.

Commands differ in what a target can mean:

| Commands | Targets | What a flag means |
|---|---|---|
| `add`, `switch`, `list`, `show`, `current`, `remove` | one | selects the Claude code path; the default is Codex |
| `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config show`, `config list-profiles` | Codex | a Claude target is refused; `--codex` is accepted and changes nothing |
| `config compact` | Claude | the Claude target is required — the command has no Codex form |
| `status`, `doctor`, `backups list` | both | narrows the report instead of choosing a code path; bare means both |
| `backups prune`, `rollback`, `unlock` | shared | both are refused: one lock and one backups tree serve the targets, so neither flag is a smaller answer |

On the three two-target commands, `--codex-dir` together with a Claude target is refused as well — the directory is part of what the command would otherwise report, and naming one contradicts the narrowing.

### Reporting on both targets

`status`, `doctor`, and `backups list` cover both targets in one run, so a Claude-only user has a health check and a state report of their own.

- **A target you never set up contributes no findings and cannot make the run unhealthy.** The evidence has to be a file — a registry, an actual runtime configuration file, or a defaults block — so an empty `~/.codex` proves nothing and produces no missing-config finding.
- **A Claude-only run reads no Codex file and never runs the Codex CLI probe**, so a machine with no Codex CLI is not told it has a Codex problem.
- Every issue names its target. The exception is a stuck lock, reported once with `target: null`, because one lock blocks writes on both. A lock held by a *running* operation is a state rather than a finding, so a background run cannot make `doctor` pronounce the install broken.
- On a bare multi-target run, `target` on the JSON envelope is `null` — read `targets`, which is authoritative. `target` is non-null exactly when one target is in scope.
- `backups list` labels each entry `codex`, `claude`, `mixed`, or `unknown`, and a target filters the listing. A manifest that cannot be classified reads `unknown` rather than being guessed at, because the label is what tells you what a `rollback` is about to restore. `mixed` holds files from both targets and appears in both narrowed lists; `unknown` appears only unfiltered.

The full per-target payload shape — every field a reading of `ok` / `absent` / `invalid` / `unavailable`, and a three-valued `healthy` — is specified in the [technical architecture](./docs/agent-provider-switch-technical-architecture.md).

## Commands

```text
aps init
aps migrate
aps list [--claude]
aps show <provider> [--claude] [--reveal]
aps current [--claude]
aps status [--codex] [--claude]
aps config show
aps config list-profiles
aps config compact --claude [--dry-run]
aps add <provider> --profile <id> --model <model> --api-key <key> [--base-url <url>] [--create-profile]
aps add --claude <name> --from-file <settings.json> [--full]
aps edit <provider> [options] [--create-profile]
aps switch <provider> [--claude]
aps remove <provider> [--claude] --force
aps import <file>
aps export <file>
aps backups list [--codex] [--claude]
aps backups prune [--keep N]
aps unlock [--force]
aps rollback [backup-id]
aps doctor [--codex] [--claude]
aps setup
```

Every command that takes a target also takes `--target <id>` in place of the shorthand flags. All commands accept `--json` for the standard JSON envelope, and `--codex-dir <path>` to target a specific Codex directory; `--codex-dir` requires a path, and a following token that starts with `-` is refused rather than taken as the value.

`setup` is deprecated and exists only as a pointer to `init` for fresh state or `migrate` for adopting existing Codex config.

## Shared Claude defaults

Provider settings tend to overlap almost entirely: the same dozen env flags, the same theme, often the same permissions block. Put what they share in the tool config, and let each provider record hold only what is its own.

`~/.config/agent-provider-switch/agent-provider-switch.json` — keep the existing `version` field and add the block by hand; no command creates it:

```json
{
  "version": "1.2.0",
  "claudeDefaults": {
    "settings": {
      "env": {
        "CLAUDE_CODE_USE_VERTEX": "0",
        "CLAUDE_CODE_USE_BEDROCK": "0",
        "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
        "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
        "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
        "CLAUDE_CODE_EFFORT_LEVEL": "XHIGH",
        "MCP_CONNECT_TIMEOUT_MS": "30000"
      },
      "model": "sonnet",
      "theme": "dark",
      "editorMode": "normal",
      "autoCompactEnabled": true
    }
  }
}
```

A provider then needs only its own entries:

```json
"freemodel": {
  "settings": {
    "env": {
      "ANTHROPIC_BASE_URL": "https://cc-t2.freemodel.dev",
      "ANTHROPIC_API_KEY": "...",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5.5"
    }
  },
  "note": "freemodel claude code"
}
```

Merge rule, in one line: **objects merge recursively, the provider wins, arrays are replaced wholesale, and `null` deletes an inherited key.** `env` needs no special handling — it is just an object of scalars, so its keys merge one by one.

Two consequences worth knowing before they surprise you:

- **An empty object does not clear.** `"enabledPlugins": {}` over a default with entries still inherits them. To drop an inherited key, set it to `null`.
- **A key the defaults set and a provider omits is inherited, not missing.** That is the point, but it means a provider's stored settings are no longer the whole story; `aps show --claude <name>` prints the resolved result and marks each inherited entry, and `--json` lists the inherited paths (paths only, never values).

To convert providers you already have, preview first:

```bash
aps config compact --claude --dry-run   # reports what would change; takes no lock, writes nothing
aps config compact --claude             # rewrites each record to its delta, after a backup
```

Compaction changes only how a provider is stored. Records are resolved over the defaults whenever they are read, so `switch --claude` writes the same file before and after, and `aps rollback` undoes the rewrite. A malformed `claudeDefaults` block — for example `env` placed directly under it instead of under `settings` — is refused with `INVALID_CONFIG` rather than silently ignored, and because the tool config is read by every command, it blocks all of them until fixed.

### Reading secrets back

`show` masks any env value whose key looks like a credential (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, anything containing `auth`) in both the human and `--json` output. Non-secret neighbours such as `ANTHROPIC_BASE_URL` print normally, and Claude `show` withholds the raw `settings` blob in both modes.

`--reveal` prints the real values and includes the `settings` blob. It is an explicit escape hatch, never applied by accident:

```bash
aps show --claude copilot --reveal
```

Codex `show --json` is the deliberate exception: it returns the full `apiKey` without `--reveal`, as a documented automation contract.

Files this tool writes are created with owner-only permissions (`0600` for files, `0700` for directories it creates) on **macOS and Linux**. On Windows the permission tightening is skipped — NTFS has no group/other bits for `chmod` to set, so access there is decided by ACLs and this tool does not touch them. On macOS and Linux, files written before the upgrade keep their previous mode until the next write touches them; to fix them all at once:

```bash
# macOS / Linux only — this is a no-op on Windows.
chmod -R go-rwx ~/.config/agent-provider-switch ~/.codex/config.toml ~/.codex/auth.json ~/.claude/settings.json
```

## Runtime projection

For Codex `0.134.0+`, the active route is the top-level `model` and `model_provider` in `config.toml`. A managed OpenAI-compatible provider is projected as:

```toml
model = "gpt-5"
model_provider = "packycode"

[model_providers.packycode]
name = "packycode"
base_url = "https://api.example/v1"
wire_api = "responses"
requires_openai_auth = true
```

Legacy `[profiles.*]` sections are not written for new managed providers by default. `--create-profile` is the explicit opt-in that also writes the matching `[profiles.<id>]` for older Codex builds that route through it, and it removes legacy `env_key` / `env_key_instructions` fields from managed projections when it writes them.

Authentication is projected into the target `auth.json` as API-key mode with `OPENAI_API_KEY`.

## State and paths

```text
~/.config/agent-provider-switch/     # tool home
  agent-provider-switch.json
  providers.json
  claude-providers.json
  backups/
  .aps.lock

~/.codex/                            # Codex target
  config.toml
  auth.json

~/.claude/                           # Claude Code target
  settings.json
```

Environment variables:

- `APS_HOME` overrides the tool home.
- `APS_CODEX_DIR` provides the default Codex directory when `--codex-dir` is not passed.
- `APS_CLAUDE_DIR` overrides the Claude Code directory (default: `~/.claude`).
- In development, `NODE_ENV=development` defaults to `./dev-codex/local-sandbox` when no override is set.

`migrate` adopts existing Codex runtime config into managed state, and is not the fresh-install command:

```bash
aps migrate
aps migrate --overwrite --codex-dir ~/.codex
```

## Locks and backups

Every write command takes one lock, shared by both targets, and snapshots the files it touches into `backups/` first.

A process killed mid-write leaves that lock behind. `aps unlock` clears it, but only after proving the recorded owner is gone — a live owner is refused, because taking a lock from a running process corrupts state where refusing only inconveniences:

```bash
aps unlock
aps unlock --force   # a recycled pid you know is not the original owner
```

There is no timeout-based takeover: a slow `migrate` can outlast any timer, so a pid that looks live is treated as live, and `--force` is the deliberate override.

Backups are retained to the newest 20 by default. Retention runs automatically after every successful mutation, and `backups prune` is the manual path:

```bash
aps backups prune
aps backups prune --keep 5
```

A directory that any surviving manifest still references is never deleted, so a rollback route stays intact even when the backup that created it is old. Directories whose manifest is missing or unreadable are reported rather than deleted. Both targets share one `backups/` directory and one `latest.json`.

## Not implemented

- Creating or editing the `claudeDefaults` block. It is hand-written, and `config compact` refuses when it is absent rather than guessing which keys are shared.
- Export or import of Claude provider records — both commands are Codex-only.
- Claude provider creation from individual fields; only `--from-file` import is supported.
- GitHub Copilot SDK integration, device-flow login, an HTTP proxy bridge, background runtime services, built-in third-party router packaging, account systems or cloud sync, and Claude Code plugin marketplace management.
- An exit-code taxonomy: success is `0`, failure is `1`, with no `2` for usage errors.
- A change to `engines.node`. It still advertises `>=18` while the sole runtime dependency requires `>=20.12`, and CI does not test Node 18 — green CI is not evidence that the advertised floor is supported.

## Development

```bash
npm run build
npx tsc --noEmit
npm test          # in-process suite; silence means green
npm run test:e2e  # real child processes against sandboxed roots; prints passed/failed/skipped
node dist/cli.js --help
npm pack --dry-run
```

`npm test` runs every `tests/*.spec.js` through one in-process harness and prints nothing when it passes. `npm run test:e2e` builds the CLI and drives the real binary as a child process, with `APS_HOME`, `APS_CODEX_DIR`, and `APS_CLAUDE_DIR` all pointing inside a sandbox that the runner refuses to leave. It is a separate command and a separate CI step: it costs a process spawn per case, and it covers what the in-process suite structurally cannot — exit codes, real pipes, and environment isolation.

## Documentation

- [Product overview](./docs/agent-provider-switch-product-overview.md)
- [Technical architecture](./docs/agent-provider-switch-technical-architecture.md)
- [CLI usage](./docs/cli-usage.md)
- [1.x roadmap](./docs/agent-provider-switch-1.x-roadmap.md)
- [CHANGELOG](./CHANGELOG.md)
- Current fact sources: [PRD 1.2.0](./docs/PRD/agent-provider-switch-prd-v1.2.0.md), [Design 1.2.0](./docs/Design/agent-provider-switch-v1.2.0-design.md)

Everything under `docs/PRD/` and `docs/Design/` is kept as history, one PRD and one design document per release.
