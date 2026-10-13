# agent-provider-switch v1.1.3 Design Document

**Shared-state commands see both targets.** The last of the three `1.1.x` releases and the only one
that changes what a command does. No stored file changes shape, no command gains or loses a
capability, and the two targets' storage, record shapes, and services stay exactly where they are.

Its companions are `docs/Design/agent-provider-switch-v1.1.1-design.md` (the target becomes
explicit) and `docs/Design/agent-provider-switch-v1.1.2-design.md` (one error vocabulary). It
consumes both: it reads `TargetId` from `1.1.1` and reports its findings through `1.1.2`'s single
vocabulary.

**Citation convention.** This document names symbols rather than line numbers.

This release closes no roadmap finding.

## Overview

Three decisions shape everything else.

**One table states each command's target scope, and everything reads it.** `CLAUDE_COMMANDS`, the
`--claude` guard, and the dispatch decision are three consumers of the same fact today. They become
one `Record<CommandId, TargetScope>`, so a new command cannot be added without answering the
question, and `1.2.0` has one table to generalize instead of three.

**A command that cannot narrow refuses the flag.** `backups prune`, `rollback`, and `unlock` operate
on a shared directory, a shared pointer, and a shared lock. `--claude` there is not a smaller
answer, it is a question with no answer, so it is refused rather than accepted and ignored.

**A target that was never set up is not a finding.** This is what makes "default both" usable. It is
also the release's one behaviour change to an existing command, and it is declared as such.

## 1. The scope table

`src/domain/target.ts` (the `1.1.1` module) gains:

```ts
export type TargetScope = "switchable" | "codex-only" | "claude-only" | "both" | "shared";
export const TARGET_SCOPES: Record<CommandId, TargetScope>;
export function scopeOf(command: CommandId): TargetScope;
export function acceptsTargetFlag(command: CommandId, flag: "--claude" | "--codex"): boolean;
export function routesToClaudeHandler(command: CommandId): boolean;
export function selectedTargets(command: CommandId, options: Map<string, string[]>): TargetId[];
```

`Record<CommandId, TargetScope>` rather than a `Map` built at runtime: a command added to the union
without a scope entry is a compile error, which is the whole point of the table.

| Scope | Commands | `--codex` | `--claude` | bare |
|---|---|---|---|---|
| `switchable` | `add`, `switch`, `list`, `show`, `current`, `remove` | accepted, no-op | selects Claude | Codex |
| `codex-only` | `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config-show`, `config-list-profiles` | accepted, no-op | refused | Codex |
| `claude-only` | `config-compact` | refused | required | refused |
| `both` | `doctor`, `status`, `backups-list` | narrows to Codex | narrows to Claude | both |
| `shared` | `backups-prune`, `rollback`, `unlock` | refused | refused | shared |

`selectedTargets()` is the only function that reads the flags for a `both` command. It returns
`["codex", "claude"]`, `["codex"]`, or `["claude"]`; for every other scope it returns the single
target the command covers, or `[]` for `shared`.

### `CLAUDE_COMMANDS` is deleted

`claude-handlers.ts`'s `CLAUDE_COMMANDS` set, `supportsClaudeTarget()`, and `getClaudeCommandNames()`
all become derivations of the table and move to `domain/target.ts`. The refusal message that names
the commands accepting `--claude` still exists; it is now built from `TARGET_SCOPES` instead of from
a set that had to be kept in step with it by hand. `flag-guards.ts` stops importing from
`claude-handlers.ts`, which removes the only `commands → commands` import in the guard path.

### Routing is a different question from scope

`isClaudeCommand()` keeps its meaning: "route this dispatch to `handleClaudeCommand`". That is true
for `switchable` with `--claude` present and for `claude-only`, and it is **false for `both`** —
`doctor`, `status`, and `backups list` do not have a Claude handler that could produce the whole
result, and routing them there would answer half the question. So the table drives two predicates
with different members:

- `routesToClaudeHandler(command)` — `switchable` and `claude-only`, i.e. today's `CLAUDE_COMMANDS`.
- `acceptsTargetFlag(command, "--claude")` — the above **plus** `both`.

Conflating them is the specific mistake this section exists to prevent: it would either send
`doctor` to a handler that returns a Claude-only payload, or refuse `--claude` on the one command a
Claude-only user needs.

## 2. The envelope and the context

`CommandExecutionContext.targets: TargetId[]` replaces `1.1.1`'s `target: TargetId | null`, required
in the same way, so every construction site is a compile error until it states its answer.

`JsonEnvelope` keeps `target` and gains `targets`:

| Field | Value |
|---|---|
| `targets` | The selected targets, `[]` when no command resolved. **Authoritative.** |
| `target` | The single target when exactly one is selected, otherwise `null`. A convenience alias. |

**This changes the value of `target` for three commands.** In `1.1.1` a bare `aps doctor --json`
carried `"target": "codex"`, which was true at the time: `doctor` was Codex-only. In `1.1.3` the same
invocation carries `"target": null` and `"targets": ["codex", "claude"]`, because the fact it
reports changed in the same release. A consumer reading only `target` and expecting a bare `doctor`
to answer `"codex"` migrates by reading `targets`; one that passes `--codex` or `--claude` sees the
same single value it always did. This is a consequence of the feature rather than a separate break,
and it is stated in the CHANGELOG because `1.1.2` was the release that promised to be the line's
only breaking one.

## 3. `doctor`

`runDoctor()` is split into `collectCodexIssues()` and `collectClaudeIssues()`, composed by the
selected targets:

```ts
runDoctor(args: {
  targets: TargetId[];
  codex: { codexDir; configPath; providersPath; authPath };
  claude: { claudeDir; claudeProvidersPath; claudeSettingsPath };
  lockPath: string;
  defaults: Record<string, unknown> | null;
}): Promise<CommandResult>;
```

`collectCodexIssues()` is today's body, unchanged. `collectClaudeIssues()` is new:

| Check | Issue code | Raised when |
|---|---|---|
| registry present | `PROVIDERS_NOT_FOUND` | `claude-providers.json` is absent |
| registry parses | `PROVIDERS_PARSE_ERROR` | the file is not valid JSON, or its shape is invalid |
| records resolve | `INVALID_CONFIG` | a stored record cannot be resolved against the defaults |
| settings present | `CLAUDE_SETTINGS_NOT_FOUND` | `settings.json` is absent |
| active provider managed | `UNMANAGED_ACTIVE_PROFILE` | live settings match no managed provider |
| deletion marker orphaned | `INVALID_CONFIG` | a record's `null` deletes a default that is no longer there |

`CLAUDE_SETTINGS_NOT_FOUND` is reused as an **issue** code. It was deleted from the `ErrorCode`
union in `1.1.2` as a code with no producer, and this is a different namespace: an issue code is a
finding inside a successful result, is not type-checked against the union, and is not a failure. The
name is right for the condition and there is no Codex twin to merge it with, so it is introduced
here rather than invented twice.

**The last row is a real bug class.** A record may carry an explicit `null` that deletes an
inherited key. If the block changes so that key is no longer a default, the `null` deletes nothing
and the key is simply absent from the file the user believes sets it. Nothing else reports that,
because `switch` writes exactly what the merge produces and both sides agree.

**Every issue gains `target`.** An issue about one target's file carries that target; an issue about
shared state carries `null`. Exactly one check is target-neutral: the lock. It runs whatever the
selection, because a stale lock blocks writes on both targets, and reporting it twice — once per
target — would make `issues.length` depend on how many targets happened to be in scope.

**Skipping is the feature.** `--claude` never calls `probeCodexRuntime()`. On a machine with no
Codex CLI the un-narrowed run reports `CODEX_NOT_INSTALLED`, which is true and is not something a
Claude-only user can act on; the narrowed run reports only what they can.

### `configured` and `healthy`

```ts
isTargetConfigured(target: TargetId, paths): boolean;
```

- Codex: `providers.json` exists **or** the Codex directory exists.
- Claude: `claude-providers.json` exists **or** the Claude directory exists.

An unconfigured target runs no checks, contributes no issues, and is reported as
`configured: false`. It does not affect `healthy`. `healthy` is `true` when the selected targets have
no issues, so `aps doctor --claude` is healthy whatever the Codex side is doing.

**The behaviour change.** A Codex user who has ever run `aps init` has `providers.json`, so their
diagnostics are byte-identical to `1.1.2`'s. A user with no Codex state at all saw
`CONFIG_NOT_FOUND` and `healthy: false`; they now see `configured: false` and `healthy: true`. That
is the correct reading of "this tool has never been used on that target", and it is what allows the
default to be both targets without making every Claude-only install permanently unhealthy.

The heuristic can misjudge in one direction, deliberately: if `~/.codex` exists but has no
`config.toml`, the target counts as configured and the missing-config issue is raised. A Codex
installation that is present and broken is a finding; a Codex installation that was never mentioned
is not.

## 4. `status`

`getStatus()` keeps its signature and its payload, so every existing top-level field of
`status --json` keeps its name and position. A new `getClaudeStatus()` returns the Claude section,
and `handlers.ts` composes:

| Invocation | Payload |
|---|---|
| `aps status` | every existing Codex field, plus `claude` and `targets: ["codex","claude"]` |
| `aps status --codex` | every existing Codex field, plus `targets: ["codex"]` |
| `aps status --claude` | `toolHomeRoot`, `claude`, and `targets: ["claude"]` |

The Claude section carries `claudeDir`, `claudeProvidersPath`, `claudeSettingsPath`,
`providersExists`, `settingsExists`, `configured`, `defaultsPresent`, `providerCount`,
`inheritedCount`, and `activeProvider` — the last resolved against the defaults, so a delta record
still reports its active provider.

**A narrowed status omits the other target.** `aps status --claude` carries no `codexDir`, which a
consumer that reads `codexDir` unconditionally will notice. The alternative — keeping the Codex
fields in a payload the caller asked to be about Claude — would make `targets` decorative.

## 5. Backups

### The manifest records its target

`BackupManifest` gains an optional `target?: TargetId`. `validateBackupManifest()` checks required
fields and passes unknown ones through, so an added optional field cannot make an existing manifest
invalid, and a manifest written by an older version simply lacks it.

`runMutation()` gains a required `target` argument, following the same convention as its `lockPath`:
the ten call sites must each state it, and a new mutation cannot inherit a wrong default. It is
passed straight into `createBackup()`, which writes it into the manifest.

### Classifying an older manifest

```ts
classifyBackupTargets(manifest, roots: { codexDir; claudeDir; toolHomeDir }): TargetId[];
```

Applied in order, first match wins:

1. `manifest.target`, when present.
2. The `reason` field: a `claude-` prefix means Claude; the known Codex operation names (`add`,
   `switch`, `remove`, `edit`, `import`, `migrate`) mean Codex.
3. Any `restorePath` inside the Claude directory.
4. Any `restorePath` inside the Codex directory.
5. Otherwise `[]` — unknown.

**Step 3 has to be checked before any tool-home or Codex test.** `claude-providers.json` lives in the
tool home, not in `~/.claude`, so a `claude-remove` backup contains a tool-home path and a
`claude-switch` backup contains both a tool-home path and a Claude path. Classifying by containment
without ordering would file Claude backups as Codex.

Every Claude mutation already uses a `claude-` operation name, so step 2 does the work for every
manifest written before this release; steps 3 and 4 catch anything older. An unclassifiable entry is
`unknown`, never a guess — a wrong label on a backup is worse than a missing one, because `rollback`
is the command it informs.

### `backups list`

`BackupListItem` gains `target: TargetId | "mixed" | "unknown"`. The selection filters:
`--claude` keeps Claude entries only, `--codex` keeps Codex only, and an `unknown` entry appears in
the unfiltered list only — matching it to either target would be the guess step 5 refuses to make.
The human view gains a column.

### `backups prune`, `rollback`, `unlock`

All three are `shared` in the scope table, so `--claude` and `--codex` are refused by the guard
before any handler runs. `pruneBackups()` and `unlockLock()` are otherwise untouched: the retention
policy is one policy over one directory, the never-delete-a-referenced-directory rule is unchanged,
and the lock is one lock.

`rollbackBackup()` gains `targets: TargetId[]` in its output, computed by `classifyBackupTargets()`
over the manifest it restored. The manifest is already in hand and its paths are already validated
by the containment check, so this adds no new trust in it.

## 6. Flag guards

`assertFlagsApply()` reads `acceptsTargetFlag()` from the scope table for `--claude` and `--codex`
and keeps its existing entries for `--full` and `--dry-run`. Its `supportedCommands` callback now
builds the refusal's command list from the table, so the error message and the check cannot disagree.

**`--codex-dir` with `--claude` is refused** on the three `both` commands. `--codex-dir` is stripped
by the parser as a global option and is accepted by every command today because every command was
Codex-facing. On `aps doctor --claude` it names a directory the command will not read. The refusal
lives in the guard table, keyed on the same scope, and applies only to `both`: on `switchable`
commands the pair was never meaningful either, but `aps list --claude --codex-dir X` is a
long-standing accepted form and changing it is not this release's business.

## 7. Residual risks

- **`target` changes value for three commands without a `--claude`.** Covered in §2. It is the only
  payload change in the release and it is reported in the CHANGELOG.
- **`doctor` stops reporting `CONFIG_NOT_FOUND` for a target that was never set up.** Covered in §3.
  A user who expects `healthy: false` on a fresh tool home now sees `healthy: true`; the reason is
  reported as `configured: false` rather than left silent.
- **The `configured` heuristic reads directory existence.** A `~/.codex` created by an unrelated
  tool makes the Codex side count as configured, and the resulting `CONFIG_NOT_FOUND` is a true
  finding about a broken install. The error direction is the loud one by choice.
- **Backup classification depends on the `claude-` operation prefix**, which is the third of the
  three conventions `1.1.1` catalogued. A future target whose operations carry no prefix will classify
  its pre-`1.1.3` backups as `unknown`. That is the safe failure: the label is shown as unknown and
  never as another target.
- **A mixed backup lists as `mixed` and is restored whole.** `rollback` has no partial-restore mode
  and this release does not add one; the label tells the user what they are about to do.
- **`status --claude` omits the Codex fields entirely.** A consumer that narrows gains a payload it
  did not have before and loses keys it may have been reading; keeping both would make `targets`
  decorative.
- **`1.2.0` still has to do the real work.** This release builds a scope table, not an abstraction.
  The storage repositories, record shapes, projection rules, and app services remain per-target
  copies, and a third target still means writing all of them. What it inherits is a place to declare
  the target and one function that answers "which target", which is what a `TargetContext` needs in
  order to be worth introducing.
- **The lock check is target-neutral and runs under either narrowing.** `aps doctor --claude`
  reports a stale lock with `target: null`, which is accurate and may read as off-topic in a
  narrowed run.

## 8. Release mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.3`; `src/` has no version
  constant to edit.
- `tests/release-contract.spec.js` takes `1.1.3`, gains `1.1.3` in the version regex, and slides the
  PRD/Design existence window to `["1.1.3", "1.1.2", "1.1.1", "1.1.0", "1.0.0"]`.
- `CHANGELOG.md` gains a `1.1.3` entry naming the two behaviour changes: the `doctor` result for an
  unconfigured target, and `target` becoming `null` on a bare multi-target command.
- New specs: `tests/target-scope.spec.js` (the scope table, table-driven over every `CommandId`),
  `tests/doctor-targets.spec.js`, `tests/claude-status.spec.js`, `tests/backup-targets.spec.js`.
- `tests/e2e/commands.spec.js`, `tests/e2e/errors.spec.js`, and `tests/e2e/renderers.spec.js` carry
  the two hardcoded lists and the rendered views this change alters.
- `docs/cli-usage.md` gains the command/target matrix and the `--codex-dir` refusal;
  `docs/agent-provider-switch-technical-architecture.md` gains the scope table and the
  routing-versus-scope distinction.
- `README.md`, `README.CN.md`, `README.AI.md`, and `docs/Tests/testing.md` carry the version.
- `docs/agent-provider-switch-2.x-roadmap.md` records that the `1.1.x` line narrows its §4
  rejection: a `--target` flag replacing `--claude` is still rejected, and the target becoming a
  first-class value is now the shipped direction.
- Publishing is a manual step.

## 9. Acceptance criteria

See `docs/PRD/agent-provider-switch-prd-v1.1.3.md`. In short: `doctor` reports both targets and is
healthy on an unconfigured machine; `--claude` skips the Codex probe; every issue carries a target;
`status` is additive with a `claude` section and omits the other target when narrowed; `backups
list` labels entries including pre-`1.1.3` ones and the tool-home containment ordering is asserted;
`prune`, `rollback`, and `unlock` refuse both target flags; `rollback` reports what it restored; and
`npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
