# CLI Usage

This document describes the current `1.1.3` repository development-line CLI contract for `@minniexcode/agent-provider-switch`.

`agent-provider-switch` is a local-first CLI for managing and switching Codex and Claude Code provider routing. It manages local provider records, projects the active Codex route into `config.toml` and `auth.json`, and switches Claude Code `settings.json` profiles.

## Version

Current package version: `1.1.3`

This line targets Codex `0.134.0+`, where the active route is selected by top-level `model` plus `model_provider`. Legacy top-level `profile` and `[profiles.*]` sections may still be inspected for migration/adoption, and `--create-profile` writes one on request, but they are not the recommended managed route.

`1.1.3` makes the target a fact about the command rather than a flag on it. Every command declares a target *scope*, and `status`, `doctor`, and `backups list` report on both targets at once — so a machine with only Claude Code now has a health check. Three consequences: a bare multi-target command carries `"target": null` and names its targets in a new authoritative `targets` array; `doctor` no longer reports a target you never configured, so a fresh tool home is healthy; and the three commands that act on state both targets share — `backups prune`, `rollback`, `unlock` — refuse both target flags. `--codex-dir` is also refused alongside `--claude`, since the directory is part of what the command was asked to report. See the migration table in [CHANGELOG.md](../CHANGELOG.md).

`1.1.2` is **breaking for `--json` consumers**. Error codes no longer name a target: `CLAUDE_PROVIDER_NOT_FOUND`, `CLAUDE_PROVIDERS_NOT_FOUND`, `CLAUDE_PROVIDERS_PARSE_ERROR`, and `CLAUDE_PROVIDER_ALREADY_EXISTS` become `PROVIDER_NOT_FOUND`, `PROVIDERS_NOT_FOUND`, `PROVIDERS_PARSE_ERROR`, and `PROVIDER_ALREADY_EXISTS`; `CLAUDE_SETTINGS_NOT_FOUND` is deleted (it was declared and never thrown). The Claude payload loses its `data.target` field. Exit codes and messages are unchanged, and `target` on the envelope is now the supported way to tell the two lines apart. See the migration table in [CHANGELOG.md](../CHANGELOG.md).

`1.1.1` makes the target explicit. Every command acts on Codex unless `--claude` says otherwise; `--codex` names that default. The two flags name different targets and are refused together with `INVALID_ARGUMENT` rather than resolved by a precedence rule. The JSON envelope gains a `target` field, written on failures as well as successes. `config compact` refuses `--codex`, since it rewrites Claude provider records and has no Codex form. No command gains or loses a target.

`1.1.0` lets Claude Code providers share their common settings through an optional `claudeDefaults` block in `agent-provider-switch.json`. A provider record then stores only what differs, and `switch --claude` writes the two layered together. It adds `config compact --claude [--dry-run]`, `add --claude ... --full`, and the global `--full` / `--dry-run` flags. A tool home without the block behaves exactly as before. See [Shared Claude Defaults](#shared-claude-defaults).

`1.0.0` renames the tool. The binary is `aps`, the package is `@minniexcode/agent-provider-switch`, the tool home is `~/.config/agent-provider-switch`, the environment variables are `APS_HOME` / `APS_CODEX_DIR` / `APS_CLAUDE_DIR`, and the state files are `agent-provider-switch.json` and `.aps.lock`. A tool home left at the pre-`1.0.0` location is moved automatically by the first command that runs. No command surface changed.

`0.4.1` adds `unlock` and `backups prune`, plus automatic backup retention, same-second backup uniqueness, and stale-lock takeover in the mutation path.

`0.4.0` changed the failure surface: an unrecognized command exits `1` with a structured error instead of exiting `0` with help, a synchronous parse failure produces the error envelope under `--json`, boolean flags stopped consuming the following token, and `status` began reporting the tool-home root.

## Global Options

| Flag | Meaning |
|---|---|
| `--json` | Render the standard JSON envelope and disable all prompts. |
| `--reveal` | Print secret values instead of masking them. Affects `show --claude` only. |
| `--codex-dir <path>` | Target a specific Codex directory instead of `~/.codex`. Requires a path: a following token starting with `-` is refused. Refused together with `--claude` on a two-target command. |
| `--claude` | Target the Claude Code path on the commands that support it. |
| `--codex` | Target the Codex path. This is the default, named. Accepted on every command except `config compact` (no Codex form) and the three shared-state commands, which refuse it. |
| `--full` | With `add --claude`, store every entry of the imported file instead of only those that differ from the shared defaults. |
| `--dry-run` | With `config compact --claude`, report what would change without taking the lock or writing anything. |
| `--help`, `-h` | Show top-level or command-specific help. |
| `--version`, `-v` | Print the current CLI version. |

`--reveal` is parsed as a **global** flag, not a per-command option. The command-option pass treats any `--flag <non-flag>` pair as a valued option, so a per-command `--reveal` would swallow the provider name that follows it. As a global flag it is matched by exact token, and both `show --claude --reveal <name>` and `show --claude <name> --reveal` work. `--json` and `--codex-dir` are stripped in the same pass.

`--claude` is also global, but it is accepted only by `add`, `switch`, `list`, `show`, `current`, `remove`, `config compact`, and the three two-target commands `status`, `doctor`, and `backups list`. On any other command it is refused with `INVALID_ARGUMENT` naming that set. Ignoring it would answer the wrong question — `aps init --claude` would report Codex state under a flag that asked about Claude.

`--codex` is global and accepted by every command except `config compact`, which rewrites Claude provider records and has no Codex form, and the three shared-state commands. Naming the default must not fail, so it carries almost no refusal surface; it exists so a command line reads the same whichever target it picks. `--claude --codex` names two different targets and is refused with `INVALID_ARGUMENT` rather than resolved by a precedence rule — letting `--claude` win as the "more specific" flag would silently ignore a flag the user typed.

`backups prune`, `rollback`, and `unlock` refuse both target flags in their own right, with a sentence that says why: they act on one `backups/` tree, one `latest.json`, and one lock. There is no smaller answer to "which target" for them, so a flag is not a narrowing but a contradiction.

`--full` and `--dry-run` follow the same rule for the same reason: the parser accepts a global boolean anywhere, so each is refused with `INVALID_ARGUMENT` on any command that would ignore it. `--full` applies only to `add --claude`, and `--dry-run` only to `config compact --claude`. The check runs before the Claude path is entered, so `aps switch --claude --full` is refused too. Accepted-and-ignored is the dangerous reading: `aps backups prune --dry-run` would otherwise delete real backups under a flag that promised a preview.

`--force`, `--merge`, `--overwrite`, `--create-profile`, `--full`, and `--dry-run` are true boolean flags: they never consume the token after them, and they are position-independent, so `aps --claude list` resolves the same way as `aps list --claude`.

One consequence is worth naming: because these tokens are torn out of `argv` before the option pass runs, a boolean flag used where an option *value* was intended becomes the literal string `"true"` rather than being rejected. In `aps edit p --note --json`, the note is recorded as the string `"true"` and `--json` still selects the JSON envelope.

## Target Scope

Every command declares how many targets it covers. There are five scopes, and the flag that a command accepts follows from its scope:

| Scope | Commands | What a target flag means |
|---|---|---|
| Switchable | `add`, `switch`, `list`, `show`, `current`, `remove` | `--claude` picks the Claude code path; Codex is the default, and `--codex` names it |
| Codex-only | `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config show`, `config list-profiles` | `--claude` is refused; `--codex` is accepted and changes nothing |
| Claude-only | `config compact` | `--claude` is required, not optional |
| Both | `status`, `doctor`, `backups list` | A flag **narrows** the report instead of choosing a code path; a bare invocation covers both |
| Shared | `backups prune`, `rollback`, `unlock` | Both flags are refused — one backups tree, one pointer, one lock |

Scope and routing are different questions, and the `Both` row is where they part. `--claude` is *accepted* by `status`, `doctor`, and `backups list`, but those commands do not route to a Claude handler: no Claude handler could produce the whole answer, since the whole answer is "here is Codex, here is Claude, here is the lock they share".

The consequence for `--codex-dir`: on a `Both` command, `--codex-dir <path>` together with `--claude` is refused with `INVALID_ARGUMENT`. The directory is part of what the command was asked to report, so naming it and narrowing to Claude in the same breath is a contradiction rather than a refinement.

```bash
aps doctor                          # both targets, one report
aps doctor --claude                 # Claude only; no Codex file is read, no probe is run
aps doctor --codex                  # Codex only
aps doctor --claude --codex-dir ~/.codex   # refused: the directory contradicts the narrowing
```

An out-of-scope target is not read at all. `aps doctor --claude` never opens `config.toml` and never runs the Codex CLI probe, so a machine without Codex installed gets no Codex findings rather than findings about an installation it does not have. An in-scope target you never configured contributes no issue and does not make the run unhealthy; the payload says `"configured": {"status": "ok", "value": false}` about it.

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
  "version": "1.1.3",
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

### `status [--codex] [--claude]`

Reports the Codex directory, the tool-home root, the current model route and the record it maps to, the auth projection state, warnings, and a next step. It does not report bridge runtime health.

It covers both targets at once, so a Claude-only machine gets a status report too. A bare `aps status` reports Codex *and* Claude: the payload carries a `codex` and a `claude` section, and the envelope's `target` is `null` because two targets are in scope — read `targets` there, which is the authoritative field. `--codex` reports the Codex section and omits `claude` entirely; `--claude` reports `claude` and omits `codex`.

Each section has the same shape (see [Report and state shapes](#report-and-state-shapes)), and the projection-specific fields live *inside* the section they belong to rather than beside it: `currentModel` at the top level of a two-target report could not say whose model it was naming. A target you have never configured is still reported — `configured: {status: "ok", value: false}`, `providers: {status: "ok", value: 0}` — so "no providers yet" reads differently from "there is something here and it is wrong". A count that could not be obtained is `unavailable`, never zero.

The identity question is asked once per target and answered in `matching`. For Codex that is the live `model_provider` mapped back to the records whose stored profile is the same id; for Claude it is the [identity paths](#report-and-state-shapes) compared against every record's **resolved** settings, authentication included. `matching` is `not-activated`, `unmanaged`, `managed`, or `ambiguous`, and `activeProvider` is non-null only for `managed` — several candidates are reported as candidates rather than collapsed to the first of them.

The `claude` section carries `settingsStatus` — `"absent"`, `"invalid"`, or `"ok"` — with `settingsInvalidReason` when the file could not be read, and the per-provider rows the human view prints. `status` reports and `doctor` diagnoses, so a corrupt `settings.json` is a **successful** `status` (exit `0`) with `settingsStatus: "invalid"` and `matching` `unavailable`, and a `doctor` finding. The two commands answering the same file differently is the split they exist to keep. `status` also carries the same `issues` and `notes` so the reasons for an incomplete reading are visible without a second command.

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

### `backups list [--codex] [--claude]`

Lists managed backup manifests newest first. Both targets share one `backups/` directory, so this is one listing with a `target` label on each entry rather than two listings.

Entries read `codex`, `claude`, `mixed`, or `unknown`. Classification is about **which operation wrote the backup**: it looks at the target recorded in the manifest, then a `claude-` operation prefix, then a known Codex operation name, and finally whether the files a manifest holds are inside the Claude directory or the Codex directory. Manifests written before the label existed classify the same way, so an older backup is not reported as unknown merely for being old. The tool home decides nothing: `claude-providers.json` lives there, and a path matching neither runtime directory reads `unknown` rather than being guessed at, so a confident wrong answer is never printed in place of an admitted gap.

This label and `rollback`'s `data.targets` answer different questions from the same manifest. Here it is *what the backup belongs to* — the operation that produced it — and it is read from metadata first. `rollback` reports *what a restore overwrites*, read from the restore paths alone. They agree for every manifest this tool writes and can disagree for a hand-edited one, in which case the restore's answer is the one that describes what is about to happen to your files.

`--codex` and `--claude` filter the listing; a bare call lists both. The two labels that are not a single target are treated by what they mean rather than by name: `mixed` touches both targets' files, so it appears in **both** narrowed lists, while `unknown` touches nothing that could be attributed and appears only in the unfiltered one. Leaving `mixed` out of a narrowed list would hide a backup that the rollback you are about to run can overwrite. `count` is the number of entries actually returned.

### `backups prune [--keep <count>]`

Deletes old backup directories, newest-first, keeping `count` (default `20`). `--keep` must be a positive integer; a missing value, `true`, `0`, a negative number, and any trailing junk are all `INVALID_ARGUMENT`. `0` is refused rather than read as "delete everything", because that is the reading that turns a typo into data loss.

A directory that any surviving manifest still references is never deleted, because rollback resolves through it — the protected set is derived from every manifest, not only the newest. Directories whose manifest is missing or unreadable are reported rather than deleted. The same retention rule runs automatically after every successful mutation, and each mutating command reports how many backups retention removed.

It prunes one `backups/` tree shared by both targets, so `--codex` and `--claude` are both refused with `INVALID_ARGUMENT` rather than accepted and ignored.

Backup directory names carry zero-padded milliseconds (`YYYYMMDD-HHmmssSSS`) and are created exclusively, so two mutations in the same second no longer overwrite each other. A mutation that fails and rolls back successfully removes its own backup directory.

### `unlock [--force]`

Clears the lock left behind by a process that no longer exists. Codex and Claude operations share one lock file (`<toolHome>/.aps.lock`), so this is the recovery command for both.

- The lock is cleared only when the recorded owner is provably gone.
- A live owner is refused with `LOCK_CONFLICT`; `--force` clears it regardless, which is the documented path for a recycled pid.
- No lock present is success, so the command is idempotent.
- It runs without a Codex directory, because the lock lives in the tool home.
- Both target flags are refused with `INVALID_ARGUMENT`: the lock it clears is the one both targets share, so neither flag names a smaller operation.

There is no TTL-based takeover: a slow `migrate` can exceed any timer, so a pid that looks live is treated as live and the failure is fail-closed.

### `rollback [backup-id]`

Restores the latest managed backup or a specific backup id.

Every restore path must resolve inside the managed roots supplied by the caller — the tool home, the Codex directory, and the Claude directory. A manifest naming a path outside those roots is rejected with `ROLLBACK_PATH_REJECTED` and nothing is written. Both targets share one `backups/` directory and one `latest.json`, so a Codex `rollback` may legitimately restore a Claude settings file; the payload reports which targets it actually restored under `data.targets`. Both target flags are refused with `INVALID_ARGUMENT`, for the same reason: there is one pointer, so "which target" is answered by the backup that is restored, not by the invocation.

`data.targets` is derived from the paths the restore is about to write, never from the manifest's recorded target or operation name. That is deliberate: a manifest can name one target and hold another's files, and in that case the question worth answering is what the command is changing, not what the snapshot claims to be. A backup holding only tool-home files — a registry snapshot — reports `[]`, because it overwrites neither target's runtime state. Compare `backups list`, which labels the *operation* from the metadata; the two differ only for a manifest this tool did not write.

### `doctor [--codex] [--claude]`

Runs issue-first diagnostics across both targets: for Codex, the registry, `config.toml`, `auth.json`, and — for an activated target — the projection checks and the CLI probe; for Claude, the provider registry and the live `settings.json`. A bare `aps doctor` runs both and every issue line is prefixed `[codex]` or `[claude]` so one run reads as one report; a narrowed run prints no prefix, because there is nothing to disambiguate.

Three kinds of answer, kept apart on purpose:

- **issues** are diagnosed faults, and `healthy` reads them.
- **notes** are worth printing and are not faults. They arrive in `data.notes`, are printed after the issues under their own heading, and never lower health: `REDUNDANT_DELETION_MARKER` and `CONFIGURATION_DRIFT`.
- **states** describe the installation without judging it — activation, management, ambiguity, lock ownership. A valid settings file that matches no record and a lock held by a running operation are both states. Folding either into `issues` would fail a run over a machine that is working, which is how a user learns to ignore the report.

Two rules make the two-target default safe to run anywhere:

- **A target you have never configured contributes no issue** and does not make the run unhealthy, so a fresh tool home is healthy. `configured` is a reading, and its evidence is a file: the registry, an actual runtime configuration file, or a target defaults block. An empty directory proves nothing, so a `~/.codex` some other tool created does not count. This holds however the target entered scope: `aps doctor --codex` on a machine with no Codex state answers `configured: {status: "ok", value: false}` and is healthy, because the flag chooses what to report on and does not assert that the target must exist. *Malformed* files still count as evidence — the file is there, whatever it says.
- **A target out of scope is not read at all.** `--claude` opens no Codex file and runs no Codex CLI probe, so a machine without Codex is not reported as having a Codex problem.

`healthy` is three-valued, and the third value is not a hedge: `false` when any selected-target or shared issue exists, `true` when the health-relevant checks completed without issues, and `null` when they could not be completed *and* nothing that ran found a fault — which is not the same as a target that was inspected and is fine. `complete` says whether every planned reading was obtainable. A report can be successful, unhealthy, and incomplete at once.

Every issue carries the `target` it belongs to. The one exception is a lock: it is inspected exactly once under every scope and reported with `target: null`, because one lock blocks writes for both targets. Only a lock that cannot be attributed to a running operation is a finding — `LOCK_STALE` when the recorded owner is gone, `LOCK_ABNORMAL` when the record cannot be attributed at all — and both carry the pid, operation, hostname, and start time with a next step naming `aps unlock` (or `--force`). A lock held by a running operation is `data.shared.lock: {status: "ok", value: "busy"}` and no finding at all: a background `aps` run must not make `doctor` pronounce the install broken.

**Absence is never a finding.** A missing `config.toml`, a missing registry, and a missing `settings.json` are states the readings carry, so no issue is raised for any of them. The Claude side is the clearest case:

| `claude-providers.json` | `settings.json` | Reported |
|---|---|---|
| absent, and no Claude directory | not read | nothing — `configured` is `{status: "ok", value: false}` |
| absent | absent | `providers: 0`, `matching: not-activated` — no issue |
| unparsable | not read | `PROVIDERS_PARSE_ERROR`; readings that depend on the registry are `unavailable`, and the rest of the report still runs |
| valid | absent | `matching: not-activated` — no issue |
| valid | present but unparsable, or not a JSON object | `CLAUDE_SETTINGS_INVALID` — **not** `UNMANAGED_ACTIVE_PROFILE` |
| valid, empty | valid, matching nothing | `matching: unmanaged` — a state, not a fault |
| valid, non-empty | valid, matching a record | `matching: managed` |
| valid, non-empty | valid, matching several records | `matching: ambiguous`, with every candidate enumerated |

A candidate that matches on identity but differs elsewhere — a permission, a plugin list — is `managed` with `differencePaths`, and the difference is a `CONFIGURATION_DRIFT` note. A record's `env` and `model` are checked as **resolved** against `claudeDefaults`, not as stored: a stored `null` is a deletion marker — `{env: null, model: null}` is how a record that strips both defaults is written — so it is not a wrong type. A record that deletes a key the current defaults no longer set is an `REDUNDANT_DELETION_MARKER` note, and `config compact --claude` is the tidy-up.

The Codex checks that need a runtime are gated on activation, which is a top-level `model_provider` in `config.toml`. A registry with no runtime configuration is a *prepared* target: it owes no `config.toml` and no installed CLI, so neither a missing file nor a missing `codex` on `PATH` is reported for it. There is no finding for a `config.toml` without a selector — that is `not-activated`, not a fault.

A finding on one target never suppresses the other's. Each side is composed independently, so an unparsable Claude registry still leaves the Codex findings in the report, and a malformed `claudeDefaults` block — a Claude issue — does not stop the Codex checks or the shared file's own raw checks. When the shared config file cannot be read at all, the finding is `SHARED_CONFIG_INVALID` and only the readings that depend on it become `unavailable`.

`aps doctor --codex` is the invocation a Codex-only user should use; the bare form would also report on the Claude directory, which is now a supported thing to ask about but not what that user meant. `aps doctor --claude` is new in `1.1.3`.

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
  "targets": ["codex", "claude"],
  "target": null,
  "data": {},
  "warnings": [],
  "error": null
}
```

`targets` is the authoritative field: it names every target the invocation covered. It is `["codex"]` or `["claude"]` when one is in scope, `["codex", "claude"]` for a bare `status`, `doctor`, or `backups list`, and `[]` for a command whose targets are shared or whose flags were refused before anything resolved.

`target` is `singleTarget(targets)` — the one target's id, or `null` when the list does not hold exactly one. It is `null` for a bare multi-target command because there genuinely are two targets, and it is `null` on a refusal raised by the flags because nothing was resolved; `targets: []` distinguishes the second case. Writing it on the failure envelope too means a caller reading an error does not have to infer which target the invocation was about from the error code.

A failure that happened *after* the target resolved reports that target: `aps switch --claude missing --json` fails with `PROVIDER_NOT_FOUND` and `"target": "claude"`. A failure that *is* the resolution failing reports `null`, because no target was settled on — `aps init --claude --json` (a command with no Claude path) and `aps list --claude --codex --json` (two contradictory flags) both fail with `INVALID_ARGUMENT`, `"target": null`, and `"targets": []`. `null` therefore means "no target was resolved", never "Codex was assumed".

**An error code names a condition, never a target.** `PROVIDER_NOT_FOUND` covers a missing Codex provider and a missing Claude provider alike; the `message` says which ("Claude provider "ghost" was not found."), and `target` says which line the invocation was on. Two codes that differ by one character are kept distinct on purpose: `PROVIDER_ALREADY_EXISTS` means a *record* with that name is taken, and `PROVIDERS_ALREADY_EXISTS` means the registry *file* already exists. A payload does not repeat the target: `data.target` was removed in `1.1.2`, so read it from the envelope.

Error codes and `doctor` issue codes are separate vocabularies with separate jobs. An error code is a command that failed; an issue code is a finding a command reported successfully. `CLAUDE_SETTINGS_NOT_FOUND` was deleted as an error code in `1.1.2` because nothing threw it, and `1.1.3` does not bring it back under either name: an absent `settings.json` is a *state* — `activation: not-activated` — not a diagnosis, so nothing produces that string any more. `CLAUDE_SETTINGS_INVALID` covers the case it was usually confused with, a file that exists and cannot be read, and `REDUNDANT_DELETION_MARKER` is a third kind of string again: a *note*, carried in `data.notes` rather than in `data.issues`, because nothing about it is wrong. Error codes, issue codes, note codes, and the `APS_CLAUDE_DIR` / `CLAUDE_CODE_ATTRIBUTION_HEADER` environment variables are four namespaces that happen to share a prefix; only the first is unified by `1.1.2`, and a grep for `CLAUDE_` across `src/` crosses all four.

### Report and state shapes

`doctor` and `status` publish one section per target — `data.codex` and `data.claude`, each omitted entirely when its target is out of scope — and both sections are written in the same vocabulary:

```ts
type Reading<T> =
  | { status: "ok"; value: T }
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string };

type TargetReport = {
  configured: Reading<boolean>;         // evidence: a registry, a runtime config, or a defaults block
  paths: Reading<Record<string, string>>;
  registry: Reading<{ providerCount: number }>;
  live: Reading<{ present: true }>;
  activation: Reading<"not-activated" | "activated">;
  defaults: Reading<{ present: boolean }>;
  providerCount: Reading<number>;
  inheritance: Reading<Record<string, number>>;
  matching: Reading<ProviderMatch>;
};

type ProviderMatch = {
  state: "not-activated" | "unmanaged" | "managed" | "ambiguous";
  activeProvider: string | null;        // non-null for "managed" alone
  candidates: Array<{ name: string; consistent: boolean; differencePaths: string[] }>;
};
```

The four reading states are not collapsible, which is the point of the shape. A `null` field used to mean "no value" for a file that is not there, a file that could not be read, and a count that genuinely is zero, and a report cannot tell a user which of the three to repair. A successful zero is `{status: "ok", value: 0}`; a count that could not be read is `unavailable`, never zero. `null` is not a substitute for an unavailable reading.

`candidates` is never collapsed to a first entry: several identity matches stay `ambiguous` and every one is listed with its own `consistent` and `differencePaths`, because full consistency is not a tie-breaker — a candidate matching the whole document still proves nothing about which credential the live file is meant to carry. Difference paths name paths only and never values, since one of them can be `env.ANTHROPIC_AUTH_TOKEN`.

Claude **identity** is these paths, compared for presence and value exactly:

`model`, `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`, `env.ANTHROPIC_DEFAULT_SONNET_MODEL`, `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, `env.ANTHROPIC_AUTH_TOKEN`, `env.ANTHROPIC_API_KEY`, `apiKeyHelper`.

The authentication paths are compared with the rest because two providers can differ only in the credential they authenticate with, and an identity that ignored them reported whichever record happened to sort first. Nothing is normalised — no trailing-slash folding, no model-alias resolution, no `apiKeyHelper` execution — because every normalisation would be a guess about a service this tool does not call. Secret values are compared in memory and never appear in output.

Codex adds `artifacts` (`config` and `auth` as separate readings), `liveState`, `configProfiles`, `currentModel`, and `currentModelProvider`; Claude adds `settingsStatus`, `settingsInvalidReason`, and `providers`, the per-provider rows the human view prints.

Failures render the same envelope to stderr with `ok: false` and a structured error. A failure never writes the envelope to stdout, so a caller that pipes stdout gets nothing rather than a message that looks like a result.

A synchronous parse failure — an unknown option value, a missing `--codex-dir` path — produces the same envelope when `--json` is present in the raw `argv`. The flag is read from `argv` there because a parse result does not exist when the parser is what threw.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success. Includes a bare group root such as `aps config`, which prints that group's help. |
| `1` | Any failure: an unrecognized command, a missing provider, a refused operation, or a parse error. |

There is no `2` for usage errors and no code map. An unrecognized command exited `0` with the top-level help before `0.4.0`; that is the one behaviour change visible to an existing script.

## Current Non-Goals

`1.1.3` does not provide `login copilot`, `add --copilot`, `bridge start`, `bridge status`, `bridge stop`, Copilot SDK integration, GitHub device-flow login, HTTP proxy bridge, local bridge workers, background runtime services, bridge logs, or automatic migration of old bridge state.

It also does not provide a redacted export mode, Claude Code plugin marketplace management, a TTL-based lock takeover, an audit log for takeovers, or an exit-code taxonomy. There is no command that creates or edits the `claudeDefaults` block, and no export or import of Claude provider records.

The target is a *scope* declared per command, not yet a *descriptor*. There is no table saying how a target stores providers or what it can do — each target keeps its own hand-written code path and record shape. There is no third target, and no `--target <id>` flag: `--claude` and `--codex` are the only target flags. `TargetId` is a closed union of two, so a third target is a type change that fails at every exhaustive switch rather than something that can appear quietly.

## Fact Sources

Current:

- [PRD 1.1.3](./PRD/agent-provider-switch-prd-v1.1.3.md)
- [Design 1.1.3](./Design/agent-provider-switch-v1.1.3-design.md)
- [PRD 1.1.2](./PRD/agent-provider-switch-prd-v1.1.2.md)
- [Design 1.1.2](./Design/agent-provider-switch-v1.1.2-design.md)
- [PRD 1.1.1](./PRD/agent-provider-switch-prd-v1.1.1.md)
- [Design 1.1.1](./Design/agent-provider-switch-v1.1.1-design.md)
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
