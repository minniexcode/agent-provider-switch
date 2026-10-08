# agent-provider-switch v0.1.0 PRD

## Status

- Version line: `0.1.0`
- Role: first stable documentation baseline
- Scope: summarize the stable public contract already reached by the CLI

## Product Contract

`agent-provider-switch` is a local-first CLI named `aps` for managing Codex model-provider routes. It keeps tool-owned provider state separate from the target Codex runtime while projecting the selected provider into Codex-compatible `config.toml` and `auth.json` files.

Stable user workflows:

```bash
aps init
aps add <provider> --profile <model-provider-id> --api-key <key> --base-url <url> --model <model>
aps switch <provider>
aps status
aps doctor
```

```bash
aps init
aps login copilot
aps add <provider> --copilot --profile <model-provider-id> --model <model>
aps switch <provider>
aps status
aps doctor
```

## Stable Boundaries

- Tool home owns `agent-provider-switch.json`, `providers.json`, `backups/`, `runtime/`, and `runtimes/`.
- Target Codex home owns the active `config.toml` and `auth.json` projection.
- `providers.json` is the provider registry source of truth.
- `config.toml` uses top-level `model` / `model_provider` plus `[model_providers.*]` sections.
- `auth.json` receives the active Codex-facing bearer value as `OPENAI_API_KEY`.
- Copilot upstream GitHub credentials are not stored in `providers.json` or target `auth.json`.

## Stable Commands

Stable command families include `init`, `login copilot`, `add`, `edit`, `switch`, `remove`, `list`, `show`, `current`, `status`, `doctor`, `config show`, `config list-profiles`, `import`, `export`, `bridge start`, `bridge status`, `bridge stop`, `backups list`, and `rollback`.

`migrate` remains an advanced adopt helper for existing Codex state. `setup` is a deprecated compatibility entry that points users to `init` and `migrate`.

## Output Contract

JSON output keeps the top-level envelope:

```json
{
  "ok": true,
  "command": "status",
  "data": {},
  "warnings": [],
  "error": null
}
```

New information should be added under `data`, `warnings`, or `error.details` without changing the envelope.

## Non-Goals

`0.1.0` does not introduce automatic migration shims, a daemon, GUI/TUI, plugin system, new upstream families, or backward-compatibility dual-read paths for old development state.
