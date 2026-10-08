# CLI Usage

This document describes the current `1.1.0` repository development-line CLI contract for `@minniexcode/agent-provider-switch`.

`agent-provider-switch` is a local-first CLI for managing and switching Codex and Claude Code provider routing. It manages local provider records, projects the active Codex route into `config.toml` and `auth.json`, and switches Claude Code `settings.json` profiles.

## Version

Current package version: `1.1.0`

This line targets Codex `0.134.0+`, where the active route is selected by top-level `model` plus `model_provider`. Legacy top-level `profile` and `[profiles.*]` sections may still be inspected for migration/adoption, and `--create-profile` writes one on request, but they are not the recommended managed route.

`1.1.0` lets Claude Code providers share their common settings through an optional `claudeDefaults` block in `agent-provider-switch.json`. A provider record then stores only what differs, and `switch --claude` writes the two layered together. It adds `config compact --claude [--dry-run]`, `add --claude ... --full`, and the global `--full` / `--dry-run` flags. A tool home without the block behaves exactly as before. See [Shared Claude Defaults](#shared-claude-defaults).

`1.0.0` renames the tool. The binary is `aps`, the package is `@minniexcode/agent-provider-switch`, the tool home is `~/.config/agent-provider-switch`, the environment variables are `APS_HOME` / `APS_CODEX_DIR` / `APS_CLAUDE_DIR`, and the state files are `agent-provider-switch.json` and `.aps.lock`. A tool home left at the pre-`1.0.0` location is moved automatically by the first command that runs. No command surface changed.

`0.4.1` adds `unlock` and `backups prune`, plus automatic backup retention, same-second backup uniqueness, and stale-lock takeover in the mutation path.

`0.4.0` changed the failure surface: an unrecognized command exits `1` with a structured error instead of exiting `0` with help, a synchronous parse failure produces the error envelope under `--json`, boolean flags stopped consuming the following token, and `status` began reporting the tool-home root.

## Global Options

| Flag | Meaning |
|---|---|
| `--json` | Render the standard JSON envelope and disable all prompts. |
| `--reveal` | Print secret values instead of masking them. Affects `show --claude` only. |
| `--codex-dir <path>` | Target a specific Codex directory instead of `~/.codex`. Requires a path: a following token starting with `-` is refused. |
| `--claude` | Target the Claude Code path on the commands that support it. |
| `--full` | With `add --claude`, store every entry of the imported file instead of only those that differ from the shared defaults. |
| `--dry-run` | With `config compact --claude`, report what would change without taking the lock or writing anything. |
| `--help`, `-h` | Show top-level or command-specific help. |
| `--version`, `-v` | Print the current CLI version. |

`--reveal` is parsed as a **global** flag, not a per-command option. The command-option pass treats any `--flag <non-flag>` pair as a valued option, so a per-command `--reveal` would swallow the provider name that follows it. As a global flag it is matched by exact token, and both `show --claude --reveal <name>` and `show --claude <name> --reveal` work. `--json` and `--codex-dir` are stripped in the same pass.

`--claude` is also global, but it is accepted only by `add`, `switch`, `list`, `show`, `current`, `remove`, and `config compact`. On any other command it is refused with `INVALID_ARGUMENT` naming that set. Ignoring it would answer the wrong question — `aps status --claude` would report Codex state under a flag that asked about Claude.

`--full` and `--dry-run` follow the same rule for the same reason: the parser accepts a global boolean anywhere, so each is refused with `INVALID_ARGUMENT` on any command that would ignore it. `--full` applies only to `add --claude`, and `--dry-run` only to `config compact --claude`. The check runs before the Claude path is entered, so `aps switch --claude --full` is refused too. Accepted-and-ignored is the dangerous reading: `aps backups prune --dry-run` would otherwise delete real backups under a flag that promised a preview.

`--force`, `--merge`, `--overwrite`, `--create-profile`, `--full`, and `--dry-run` are true boolean flags: they never consume the token after them, and they are position-independent, so `aps --claude list` resolves the same way as `aps list --claude`.

One consequence is worth naming: because these tokens are torn out of `argv` before the option pass runs, a boolean flag used where an option *value* was intended becomes the literal string `"true"` rather than being rejected. In `aps edit p --note --json`, the note is recorded as the string `"true"` and `--json` still selects the JSON envelope.

## Primary Workflow (Codex)

```bash
aps init
aps add packycode --profile packycode --model gpt-5 --api-key sk-xxx --base-url https://api.example/v1
aps switch packycode
aps status
aps doctor
```

`--profile` is a CLI alias for the managed `model_provider` id.

## Claude Code Workflow

```bash
aps add --claude copilot --from-file ~/.claude/settings-copilot.json
aps switch --claude copilot
aps current --claude
aps list --claude
aps show --claude copilot
aps show --claude copilot --reveal
aps config compact --claude --dry-run
```

Without a `claudeDefaults` block, Claude providers store the full `settings.json` content as an opaque blob, and switching replaces the entire file with it. With one, a record stores only its delta; see below.

## Shared Claude Defaults

Provider settings tend to overlap almost entirely. `agent-provider-switch.json` may carry a `claudeDefaults` block holding what they share, so each record stores only what is its own. The block is **written by hand** — no command creates or edits it — and keeps the existing `version` field:

```json
{
  "version": "1.1.0",
  "claudeDefaults": {
    "settings": {
      "env": {
        "CLAUDE_CODE_USE_VERTEX": "0",
        "CLAUDE_CODE_EFFORT_LEVEL": "XHIGH",
        "MCP_CONNECT_TIMEOUT_MS": "30000"
      },
      "model": "sonnet",
      "theme": "dark"
    }
  }
}
```

Its inner shape mirrors a provider record's, so resolving a record is `merge(claudeDefaults.settings, record.settings)`.

**Merge rule.** Objects merge recursively, the record wins, arrays are replaced wholesale, and `null` deletes an inherited key. `env` needs no special case: it is an object of scalars, so its keys merge one by one. The result never contains a `null` object member.

Two consequences that are easy to get wrong:

- **An empty object does not clear.** `"enabledPlugins": {}` over a default with entries inherits them. Dropping an inherited key takes an explicit `null`.
- **A key the defaults set and a record omits is inherited, not missing.** So `add --claude` slimming is inheritance-first and is not a byte-preserving round trip of the imported file; `--full` is the escape hatch. What slimming guarantees is that it never changes what a switch writes: `merge(defaults, slim(defaults, x)) == merge(defaults, x)`.

**Where resolution happens.** Resolution is read-side: the stored record stays a delta. `list`, `current`, `show`, the interactive selector, and `switch` resolve it, and only `switch` writes the result to `~/.claude/settings.json`. `remove` and `config compact` work on the raw records, so neither can expand the defaults into the survivors. With no `claudeDefaults` block nothing is merged and a record is written verbatim — explicit `null` members included, which are plain data until a block exists.

**Validation.** A `claudeDefaults` that is not an object, a missing or non-object `settings`, or any other key under `claudeDefaults` (typically `env` placed there instead of under `settings`) is `INVALID_CONFIG`. Unknown keys are refused rather than dropped, because dropping one would leave every provider with no inherited env and no message saying why. The tool config is read on every command, so a malformed block fails all of them until it is fixed.

## Commands

### `init`

Initializes the `agent-provider-switch` tool home. It creates `agent-provider-switch.json` and `providers.json` when missing. It does not require a target Codex `config.toml`.

### `migrate`

Advanced adopt helper for existing Codex config. Use it only when existing route/profile state should be copied into managed `providers.json`.

### `list [--claude]`

Lists managed providers with their model-provider ids, model hints, tags, notes, and current-state mapping. With `--claude`, lists Claude profiles with model and active indicator instead.

Human output does not expose a provider-type column; the `--claude` flag selects the registry.

### `show <provider> [--claude] [--reveal]`

Shows one provider record.

- Codex path: human output masks the API key; `--json` returns the full local provider payload including `apiKey`. That is a documented automation contract and is unchanged in `0.4.1`. `--reveal` does not affect this path.
- Claude path: shows the **resolved** settings — what `switch` would write — with each entry that came from the shared defaults marked `(inherited)` and a trailing `inherited:` summary. `env` values whose key looks like a credential are masked, an inherited credential included, and the raw `settings` blob is omitted. `--json` adds `inherited`, a list of dotted paths (`env.MCP_CONNECT_TIMEOUT_MS`, `model`, ...) that carries paths only, never values. `--reveal` prints the real values and adds `settings` (resolved) and `overrides` (the stored delta).

### `current [--claude]`

Reads the current top-level `model` and `model_provider` from `config.toml` and maps it back to a managed provider when possible. With `--claude`, compares the active `~/.claude/settings.json` identity fields against registered profiles.

### `status`

Reports target Codex directory, tool-home root, current model route, mapping state, auth projection state, warnings, and next step. It does not report bridge runtime health.

### `config show`

Shows the current route summary and recognizable legacy profile view.

### `config list-profiles`

Lists recognizable legacy config profiles with managed-state hints for adoption and diagnostics.

### `config compact --claude [--dry-run]`

Rewrites every stored Claude provider to the entries that differ from the shared `claudeDefaults`, so a file of full copies becomes a file of deltas.

```bash
aps config compact --claude --dry-run   # preview
aps config compact --claude             # apply, after a backup
```

It changes only how a provider is stored. A record is resolved over the defaults whenever it is read, full or delta alike, so `switch --claude` writes the same file before and after, and `rollback` undoes the rewrite.

- Requires `--claude`; Codex records are already flat.
- Refuses with `INVALID_ARGUMENT`, naming the file, when the tool config has no `claudeDefaults` block: compacting against nothing would report success while changing nothing.
- `--dry-run` is a separate branch that never reaches the mutation wrapper. It takes no lock, creates no backup, and leaves `claude-providers.json` byte-identical, so it succeeds while another operation holds the lock.
- A run in which every record is already a delta takes the same early exit: no write, no backup. "Changed" is decided by deep equality, so key order alone never counts as a change and a second run always reports zero.
- A real run re-reads the file under the lock, carries `note` and `tags` over untouched, and keeps an explicit `null` that deletes a real default — dropping it would make the deleted value reappear.
- The payload is `{ target, dryRun, changedCount, unchangedCount, providers: [{ provider, changed, droppedPaths }] }`. `droppedPaths` are dotted paths and never values.

### `add`

```bash
aps add <provider> --profile <model-provider-id> --model <model> --api-key <key> [--base-url <url>] [--note <text>] [--tag <tag> ...] [--create-profile]
aps add --claude <name> --from-file <settings.json> [--full]
```

Adds a provider to `providers.json`, creates or updates the matching `[model_providers.<id>]` section, and backs up managed files before writing. The `--claude` form imports a complete `settings.json` into `claude-providers.json`; field-based Claude provider creation is not supported.

With a `claudeDefaults` block, the `--claude` form stores only the entries that differ from it, and reports how many were dropped. `--full` keeps every entry instead, which pins them against later changes to the defaults. The record is still resolved over the defaults when read, so `--full` stores more but does not stop a key the file omits from being inherited.

`--create-profile` additionally writes the matching legacy `[profiles.<id>]` section, for older Codex builds that route through it. It is the only way that section is written; the default projection never creates one.

### `edit`

Updates selected fields on a provider record and repairs the matching model-provider projection when needed.

```bash
aps edit <provider> [--profile <id>] [--model <model>] [--api-key <key>] [--base-url <url>] [--note <text>] [--tag <tag> ...] [--create-profile]
```

`--create-profile` counts as an update in its own right, because it writes a section the default projection does not. Passing it alone prompts for nothing and binds the section to the record's existing model. An `edit` with neither a field nor a flag at all is `INVALID_ARGUMENT`.

### `switch [--claude]`

Codex path: switches the active route to a managed provider by writing top-level `model` and `model_provider`, updating the matching model-provider section, and projecting API-key auth. Claude path: atomically replaces `~/.claude/settings.json` with the stored profile layered over the shared defaults, when there are any.

### `remove [--claude]`

Removes a provider from the selected registry. Non-interactive and JSON runs require `--force`. Removing a provider that owns the active route may require `--switch-to` first.

### `import`

Replaces or merges `providers.json` from an explicit JSON file under backup flow.

### `export`

Exports current `providers.json` to an explicit file. Use `--force` to overwrite in automation.

The payload reports `count`, `secretCount` (records with a non-empty `apiKey`), and `containsSecrets`. When `containsSecrets` is true, the command emits a warning that the export contains API keys in plaintext and must not be committed. There is no automatic redaction mode.

### `backups list`

Lists managed backup manifests newest first.

### `backups prune [--keep <count>]`

Deletes old backup directories, newest-first, keeping `count` (default `20`). `--keep` must be a positive integer; a missing value, `true`, `0`, a negative number, and any trailing junk are all `INVALID_ARGUMENT`. `0` is refused rather than read as "delete everything", because that is the reading that turns a typo into data loss.

A directory that any surviving manifest still references is never deleted, because rollback resolves through it — the protected set is derived from every manifest, not only the newest. Directories whose manifest is missing or unreadable are reported rather than deleted. The same retention rule runs automatically after every successful mutation, and each mutating command reports how many backups retention removed.

Backup directory names carry zero-padded milliseconds (`YYYYMMDD-HHmmssSSS`) and are created exclusively, so two mutations in the same second no longer overwrite each other. A mutation that fails and rolls back successfully removes its own backup directory.

### `unlock [--force]`

Clears the lock left behind by a process that no longer exists. Codex and Claude operations share one lock file (`<toolHome>/.aps.lock`), so this is the recovery command for both.

- The lock is cleared only when the recorded owner is provably gone.
- A live owner is refused with `LOCK_CONFLICT`; `--force` clears it regardless, which is the documented path for a recycled pid.
- No lock present is success, so the command is idempotent.
- It runs without a Codex directory, because the lock lives in the tool home.

There is no TTL-based takeover: a slow `migrate` can exceed any timer, so a pid that looks live is treated as live and the failure is fail-closed.

### `rollback [backup-id]`

Restores the latest managed backup or a specific backup id.

Every restore path must resolve inside the managed roots supplied by the caller — the tool home, the Codex directory, and the Claude directory. A manifest naming a path outside those roots is rejected with `ROLLBACK_PATH_REJECTED` and nothing is written. Both targets share one `backups/` directory and one `latest.json`, so a Codex `rollback` may legitimately restore a Claude settings file.

### `doctor`

Runs issue-first diagnostics across config, providers, auth projection, route drift, lock state, and Codex CLI availability. A lock is reported as an issue only when a lock file is actually present: `LOCK_STALE` when the recorded owner is gone, `LOCK_OCCUPIED` when it is still running. Both carry the pid, operation, hostname, and start time, and the next step names `aps unlock` (or `--force`).

### `setup`

Deprecated. It exists only to point users to `init` for fresh state or `migrate` for adoption.

## Secret Handling

`show --claude` masks env values whose key matches the shared secret pattern (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, and anything containing `auth`) in both human and `--json` output. Non-secret neighbours such as `ANTHROPIC_BASE_URL` print normally.

The raw `settings` blob is omitted rather than masked: it is opaque and can nest arbitrarily, so there is no reliable rule for which of its values are credentials. The identity fields the command exists to display are extracted into `model`, `baseUrl`, and `theme`.

The payload carries `revealed` so a renderer can tell masked from unmasked without re-deriving it. `--reveal` is the only way to see real values, and it is never applied by default.

Error details are redacted by walking the whole detail tree against the same pattern, so a nested secret is masked regardless of the key name that holds it.

`list --claude` and `current --claude` return only name, model, and base URL — no secret is reachable there.

## File Permissions

Files this tool writes are created `0600` and directories it creates are `0700`, on **macOS and Linux** only.

- `chmod` is applied after the atomic rename, because the mode passed at write time is masked by the process umask and is a floor rather than an exact value.
- Directory mode applies only to directories that do not already exist, so a pre-existing `~/.codex` or `~/.claude` is never re-permissioned.
- On Windows this is skipped: NTFS has no group/other bits for `chmod` to set, and access there is decided by ACLs, which this tool does not modify.
- Reading a file does not re-permission it. Files written by an earlier version keep their previous mode until the next write touches them. To remediate immediately on macOS or Linux:

```bash
chmod -R go-rwx ~/.config/agent-provider-switch ~/.codex/config.toml ~/.codex/auth.json ~/.claude/settings.json
```

## JSON Contract

`--json` renders the standard envelope:

```json
{
  "ok": true,
  "command": "status",
  "data": {},
  "warnings": [],
  "error": null
}
```

Failures render the same envelope to stderr with `ok: false` and a structured error. A failure never writes the envelope to stdout, so a caller that pipes stdout gets nothing rather than a message that looks like a result.

A synchronous parse failure — an unknown option value, a missing `--codex-dir` path — produces the same envelope when `--json` is present in the raw `argv`. The flag is read from `argv` there because a parse result does not exist when the parser is what threw.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success. Includes a bare group root such as `aps config`, which prints that group's help. |
| `1` | Any failure: an unrecognized command, a missing provider, a refused operation, or a parse error. |

There is no `2` for usage errors and no code map. An unrecognized command exited `0` with the top-level help before `0.4.0`; that is the one behaviour change visible to an existing script.

## Current Non-Goals

`1.1.0` does not provide `login copilot`, `add --copilot`, `bridge start`, `bridge status`, `bridge stop`, Copilot SDK integration, GitHub device-flow login, HTTP proxy bridge, local bridge workers, background runtime services, bridge logs, or automatic migration of old bridge state.

It also does not provide a redacted export mode, Claude Code plugin marketplace management, a generic target abstraction, a TTL-based lock takeover, an audit log for takeovers, or an exit-code taxonomy. There is no command that creates or edits the `claudeDefaults` block, and no export or import of Claude provider records.

## Fact Sources

Current:

- [PRD 1.1.0](./PRD/agent-provider-switch-prd-v1.1.0.md)
- [Design 1.1.0](./Design/agent-provider-switch-v1.1.0-design.md)
- [PRD 1.0.0](./PRD/agent-provider-switch-prd-v1.0.0.md)
- [Design 1.0.0](./Design/agent-provider-switch-v1.0.0-design.md)
- [PRD 0.4.1](./PRD/agent-provider-switch-prd-v0.4.1.md)
- [Design 0.4.1](./Design/agent-provider-switch-v0.4.1-design.md)
- [PRD 0.4.0](./PRD/agent-provider-switch-prd-v0.4.0.md)
- [Design 0.4.0](./Design/agent-provider-switch-v0.4.0-design.md)
- [PRD 0.3.1](./PRD/agent-provider-switch-prd-v0.3.1.md)
- [Design 0.3.1](./Design/agent-provider-switch-v0.3.1-design.md)
- [PRD 0.3.0](./PRD/agent-provider-switch-prd-v0.3.0.md)
- [Design 0.3.0](./Design/agent-provider-switch-v0.3.0-design.md)

Historical `0.1.x` and `0.2.x` docs remain archived for context only.
