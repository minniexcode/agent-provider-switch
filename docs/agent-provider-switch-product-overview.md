# agent-provider-switch Product Overview

Current version: `1.1.3`

Current fact sources:

- [`PRD/agent-provider-switch-prd-v1.1.3.md`](./PRD/agent-provider-switch-prd-v1.1.3.md)
- [`Design/agent-provider-switch-v1.1.3-design.md`](./Design/agent-provider-switch-v1.1.3-design.md)
- [`PRD/agent-provider-switch-prd-v1.1.0.md`](./PRD/agent-provider-switch-prd-v1.1.0.md) for Claude defaults and compaction
- [`cli-usage.md`](./cli-usage.md)

Planned `1.2.0`: [PRD](./PRD/agent-provider-switch-prd-v1.2.0.md) and
[Technical Design](./Design/agent-provider-switch-v1.2.0-design.md) define shared target workflows;
the requirements and design are complete, and implementation remains planned.

## Product

`agent-provider-switch` is a local-first CLI for managing Codex and Claude Code provider settings. It saves named choices for each target and makes changes explicit, backed up, and inspectable.

The product owns three jobs:

- Maintain target-local provider records in `providers.json` and `claude-providers.json`.
- Project Codex model-provider routing and authentication, or resolve Claude defaults and provider overrides into active settings.
- Provide target diagnostics, shared backups and rollback, plus Codex import/export.

## Current Workflow

```bash
aps init
aps add <provider> --profile <model-provider-id> --model <model> --api-key <key> --base-url <url>
aps switch <provider>
aps status
aps doctor
```

For Claude Code:

```bash
aps add --claude <provider> --from-file <settings.json>
aps switch --claude <provider>
aps show --claude <provider>
aps doctor --claude
```

`doctor`, `status`, and `backups list` cover both targets by default; `--codex` or `--claude` narrows
them. `backups prune`, `rollback`, and `unlock` operate on shared state and refuse target flags.
Claude supports shared defaults and `config compact --claude`; compaction preserves effective
settings while removing redundant stored overrides.

`migrate` is an advanced adopt helper for existing Codex config, not the fresh-install default.

## Current Boundary

The current product manages local providers and configuration. It does not include account
onboarding, hosted services, local proxy bridges, or background runtime orchestration.

The confirmed [1.2.0 plan](./agent-provider-switch-1.x-roadmap.md#4-120--the-target-descriptor)
introduces target descriptors, common workflows, unified interaction and report composition, and
`--target <id>` alongside the aliases. These are planned features, not part of the current binary.
The plan preserves current target operation semantics and stored formats; a third target follows
separately.

## Users

- Developers who maintain several Codex or Claude Code provider configurations.
- AI agents that need a stable JSON command envelope and deterministic local state.
- Users who want backups and diagnostics before changing either target's active settings.

## Non-Goals

- Copilot SDK or GitHub login flows.
- `login copilot`, `add --copilot`, or `bridge *` commands.
- HTTP proxy bridge or local bridge worker runtime.
- Account systems, cloud sync, or background services.
- Automatic migration of old experimental runtime state.
