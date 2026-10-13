# Changelog

## 1.2.0 - 2026-10-14

**Not a break of stored state or the JSON contract.** This release replaces two parallel implementations with one, so it moves code rather than data. `providers.json`, `claude-providers.json`, and `agent-provider-switch.json` keep their paths, shapes, and ordering; the envelope keeps its fields and meanings; the error vocabulary, the issue codes, the exit codes, and the three `show` policies are unchanged. A backup written by `1.1.x` still reads, and a `rollback` still restores it. Nothing `1.1.3` documented is withdrawn, and no migration step is needed to upgrade.

**Why the rewrite.** The six provider verbs existed twice — `add`, `list`, `show`, `current`, `switch`, `remove`, once over `providers.json` and once over `claude-providers.json` — and each copy repeated the same five steps: prepare the input, declare the affected files, take the lock, write the record, project it into the target's native configuration. The Claude services had been written from the Codex ones, so a fix in either had to be made in both, and the two had already drifted where nothing asserted otherwise. `1.1.3` made the target a first-class value everywhere it is *observed* — the envelope, the error vocabulary, diagnostics, backups, the flag guards — and nowhere it is *implemented*. This is the release that spends the seam: the workflows become one, and a target becomes an adapter that declares its differences.

The boundary is deliberate. What is shared is orchestration — the transaction, the registry I/O, the chooser, the report composition, the presentation dispatch. What stays per-target is everything that is genuinely a fact about Codex or about Claude Code: the record schema, the native projection, the matching rules, the defaults merge, and the text a user reads. A third target should now add a descriptor and an adapter, not a sixth copy of six layers.

### Added

- `--target <id>`, with `codex` and `claude` as its values. It is a third spelling of `--codex` and `--claude` and produces the same selection, so it can sit before or after the command tokens (`aps --target claude list`, `aps list --target claude`). The `=` form is refused — `--target` does not accept it — as are a missing, flag-shaped, or unknown id, and naming two different targets. Repeating the same target is accepted. The point of the flag is a value that arrives from a variable, where `--codex` and `--claude` would mean an `if` in the caller.
- `src/app/provider-workflows.ts` — the six verbs, once, ending at a single `commitProviderChange()` boundary. It is the only caller of `runMutation()` for a provider write, so one logical change still takes one lock and writes one backup.
- `src/app/targets/` — `types.ts` (the adapter contract), `codex-adapter.ts`, `claude-adapter.ts`, and `report-ports.ts`. An adapter declares its records, its native plans, its matching and payload views, and its report reads. It may not import the shared workflow module, `run-mutation.ts`, the registry repo, the shared chooser, or the binding layer.
- `src/commands/target-bindings.ts` and `src/commands/target-presenters.ts`. A handler reaches a workflow through `bindTarget()` / `bindCodexTarget()` / `bindClaudeTarget()`, which is also where the target's presenter is attached; `presenterFor()` is a static map, and a missing presenter is an internal error rather than a fallback to another target's text.
- `src/cli/report-lines.ts`. The pure text helpers the renderer and the per-target presenters both use. They live beside the renderer rather than in either consumer because the renderer *selects* a presenter — a presenter importing the renderer back would be an import cycle.
- `src/app/collect-target-reports.ts` — the generic `doctor` / `status` / `backups list` composer. It runs the shared tool-config inspection and the lock check once and asks each in-scope target's report port for its own section.
- `src/storage/provider-registry-repo.ts` — `createRegistryRepo(path, codec, errorPolicy)`, the one JSON registry reader/writer. Both registries keep their own file, their own record shape, and their own error policy; only the reading and writing is shared.
- `src/domain/provider-registry.ts` and `src/domain/command.ts` — the generic registry shape, and the command and verb vocabulary (`CommandId`, `ProviderVerb`, `isProviderVerb`).
- `src/storage/tool-home-paths.ts` — the tool's own identity: the home paths, the state filenames, the env-var prefix, and the frozen `LEGACY_*` names. They moved out of `codex-paths.ts`, which now holds only the `~/.codex` target. The `LEGACY_*` constants are read-only and were moved, not updated.
- Three specs that assert structure rather than output, because the property they check is about the call graph: `tests/shared-workflows.spec.js` (adapters import no orchestration; both adapters implement the same hook surface; `commitProviderChange` has one entry point), `tests/load-boundary.spec.js` (`--help` loads no execution service, in a child process, with a counter-case so a recorder that records nothing cannot pass), and `tests/provider-prompts.spec.js` (one fake prompt runtime driven through both targets).

### Changed

- Target selection is normalized once. `parseArgs()` extracts `--target <id>` alongside `--json`, `--reveal`, `--codex-dir`, and the declared boolean flags, and reduces all three spellings to one selection that every guard, handler, and report reads. Nothing downstream re-reads a flag.
- `src/domain/target.ts`'s per-command table now carries the whole answer in `COMMAND_TARGET_POLICIES` — scope, target capability, routing, and flag applicability — read back through `policyOf()`, `scopeOf()`, `acceptsTarget()`, `acceptsTargetFlag()`, `routesToClaudeHandler()`, `resolveCommandTargets()`, and `singleTarget()`. Capability and routing stay different questions: `acceptsTarget()` is true for a report command, while `routesToClaudeHandler()` is not, because no Claude handler could produce the whole answer for a two-target report.
- Both targets share one chooser and one confirmation path, through an injectable prompt runtime. A non-interactive run and a `--json` run ask nothing; a declined confirmation cancels before the lock is taken, so it leaves no backup and no partial write.
- `doctor`, `status`, and `backups list` compose through the report ports. An out-of-scope target is never read: `aps doctor --claude` opens no `config.toml` and runs no Codex CLI probe.
- Presentation is split. `src/cli/output.ts` renders the shared view and the envelope and delegates to a target's presenter when exactly one target is in scope; a presenter maps a payload to lines and may not read a file, resolve a path, or probe a runtime.
- `--help` still loads none of this. `src/commands/registry.ts` holds declarations only and the handler is loaded by `src/commands/dispatch.ts`, so help never pulls in the app services, the inquirer runtime, the Codex probe, or registry I/O.

### Removed

- The fourteen per-target app services the shared workflows replace: `add-provider.ts`, `list-providers.ts`, `show-provider.ts`, `get-current-profile.ts`, `switch-provider.ts`, `remove-provider.ts`, `run-doctor.ts`, and the seven `claude-*.ts` services; plus `src/interaction/interactive.ts`, whose chooser both targets now share.

### Notes

- The three `show` policies are deliberately untouched: Codex `show --json` still returns the full `apiKey` without `--reveal` as a documented automation contract, and Claude `show` still masks secret env values and withholds the raw `settings` blob in both modes.
- `--full` and `--dry-run` are still refused with `INVALID_ARGUMENT` anywhere they would be ignored, and that check still runs before the Claude early-return.
- `restoreManifest()` still requires an allowlist built by its caller and never reads one from the manifest, so a target's backup attribution cannot become a restore grant.
- The dead trees — `src/infra/` and the four remaining `src/cli/` shims — are untouched. They are still `P2-1`, and this release did not make them reachable.

## 1.1.3 - 2026-10-13

**Breaking.** The target becomes a fact about the command rather than a flag on it. `doctor`, `status`, and `backups list` now report on both targets in one run and narrow with `--codex` / `--claude`, instead of reporting on Codex and refusing the flag. Three payload and invocation changes follow from that, and they are the whole break: `target` is `null` on a bare multi-target command, `doctor` stops reporting a target the user never set up, and the three shared-state commands refuse both target flags.

**Why the break is worth taking.** `--claude` used to mean two different things depending on the command: "use the Claude code path" for the six switchable commands, and "unsupported" for everything else. So the commands a Claude-only user most needs — what is my Claude state, and is it healthy — were exactly the ones that could not answer. A second target had been bolted on to a one-target CLI, and every question about it had to be asked in the shape the first target left behind.

### Migration

| `1.1.2` | `1.1.3` | Note |
|---|---|---|
| `doctor --json`: `target: "codex"` | `target: null`, `targets: ["codex", "claude"]` | The only *envelope* change. Read `targets`; `target` is now a convenience alias, non-null exactly when one target is in scope. The report's own schema changes separately, as the rows below and the `Added` section record. |
| `status --json`: `target: "codex"` | `target: null`, `targets: ["codex", "claude"]` | Same. `data` also gains a `claude` section. |
| `backups list --json`: `target: "codex"` | `target: null`, `targets: ["codex", "claude"]` | Same. Each entry gains a `target` label. |
| `doctor --json`: `data.codexConfigured`, `data.claude.activeProvider` | `data.codex.configured`, `data.claude.matching` | The flat Codex status layout is replaced by the normalized target sections. Every field the report carries is a `Reading` or a state, and the identity answer lives in `matching` alone. |
| `status --json`: `data.currentModel`, `data.currentModelProvider`, `data.provider`, `data.activeProviderCandidates`, `data.activeProviderResolvable` | `data.codex.currentModel`, `data.codex.currentModelProvider`, `data.codex.matching` | A top-level field in a two-target report cannot say whose value it is, so the projection fields move inside the section they belong to. `matching` replaces the three fields that described one answer. |
| a lock held by a running operation: `LOCK_OCCUPIED` issue | `data.shared.lock: {status: "ok", value: "busy"}` | A live lock is normal. Only a lock that cannot be attributed to a running process is a finding (`LOCK_STALE` / `LOCK_ABNORMAL`). |
| `doctor` on a never-configured target | `healthy: true`, `configured: false` | Findings are no longer reported for a target the user has not set up. `configured: false` says so rather than leaving it silent. |
| `backups prune --codex`, `rollback --codex`, `unlock --codex` | `INVALID_ARGUMENT` | `1.1.1` accepted `--codex` on these and ignored it. They act on state the targets share — one backups tree, one pointer, one lock — so neither flag is a smaller answer, and both flags on all three commands are now refused with that reason. |
| any refused flag combination (`--claude --codex`, `--claude --codex-dir X`) | `targets: []`, `target: null` | A refusal is raised before a target is selected, so there is no scope to report. `targets` is still present, which is how a consumer tells "no target" from a build that predates the field. |

Narrowing restores the old shape: `aps doctor --codex --json` still reports Codex alone, with `target: "codex"` and no Claude section.

### Added

- `aps doctor --claude` and `aps doctor --codex` — the Codex checks and the Claude checks as two independent sets. `--claude` reads no Codex file and never runs the Codex CLI probe, so a Claude-only machine is not told it has a Codex problem. Every issue now carries a `target`, and the one target-neutral finding (a stuck lock) carries `null`.
- `CLAUDE_SETTINGS_INVALID`, an issue code for a `settings.json` that exists and cannot be read — invalid JSON, or a top-level array or scalar. `readClaudeSettings()` returned `null` for that and for a missing file alike, so a corrupt file was compared against the registry as an empty object and reported as `UNMANAGED_ACTIVE_PROFILE`, whose remedy is to register a provider the user already has. A read failure and a failed comparison are now different findings, and only a settings file that was actually read can produce the second.
- `data.notes` on `doctor` and `status`, with two codes so far: `REDUNDANT_DELETION_MARKER` and `CONFIGURATION_DRIFT`. A record may delete a key with an explicit `null`; if the shared defaults stop setting that key, the marker deletes nothing and the key is absent either way. That is not a fault — the user's intent is satisfied — so the renderer prints notes after the issues and `healthy` never reads them. Drift is a note for the same reason: a permission or a plugin list that differs from the stored record is still the provider the user configured, and the difference paths are printed without their values.
- `settingsStatus` (`"absent" | "invalid" | "ok"`) and `settingsInvalidReason` on the Claude section of both report commands, so "no settings file" and "an unreadable one" are distinguishable without inferring them from an unresolved match.
- `Reading<T>`, the tagged result every report field is now written in — `{status: "ok", value}`, `absent`, `invalid`, or `unavailable`. The point is that the four are not collapsible: a `null` field said "no value" for a file that is not there, a file that could not be read, and a value that genuinely is empty, and a report cannot tell a user which of those to repair. A successful zero is `ok(0)`; a count that could not be read is `unavailable`, never zero.
- `matching` on both sections: one identity answer per target — `not-activated`, `unmanaged`, `managed`, or `ambiguous`, with every candidate and its difference paths. The flat `provider` / `activeProviderCandidates` / `activeProviderResolvable` fields are gone; they answered one question in three places and resolved ambiguity by picking the first match. A candidate list is never collapsed to its first entry.
- `activation` on both sections. Codex activation is a top-level `model_provider` in `config.toml`, and Claude activation is a live `settings.json`; a registry alone is neither. `MODEL_PROVIDER_MISSING` is retired with it: a `config.toml` with no selector is a prepared target, not a broken one, and the Codex probe and projection checks now run only for an activated target.
- Three-valued `healthy`, beside `complete`. `null` is a real answer: checks could not be completed and nothing that ran found a fault, which is not the same as a target that was inspected and is fine. A report can be successful (`ok: true`, exit `0`), unhealthy, and incomplete at once.
- `configured` is answered from configuration evidence — a registry file, an actual runtime configuration file, or a target defaults block. A directory on its own is evidence of nothing, so an empty `~/.codex` no longer makes the Codex side look set up.
- `SHARED_CONFIG_INVALID` and `CLAUDE_DEFAULTS_INVALID`, for the two failures a shared config file can have. They are separate because they have different scopes: an unparseable file is shared and makes dependent values unavailable, while a malformed `claudeDefaults` block inside a readable file is a Claude issue that leaves Codex and the file's own raw checks running.
- `target` on a `backups list` entry — `"codex"`, `"claude"`, `"mixed"`, or `"unknown"`. Worked out from the recorded target, then the operation name, then containment; `unknown` is a refusal to guess rather than a failure, because the label is what `rollback` informs. Manifests written before this release classify correctly without a migration. The two labels that are not a single target are filtered by what they mean: `mixed` names files under both runtime directories, so it appears in **both** narrowed lists, and `unknown` appears only in the unfiltered one. `count` matches the list it is returned with.
- `targets` on the JSON envelope. It is the authoritative field; `target` is derived from it.
- `targets` on `rollback`'s output: the targets whose runtime files the restore **overwrote**, accumulated over the manifest's restore paths. This is not the same question as the `backups list` label, which reports the target that *wrote* the backup: a manifest recording `target: "codex"` whose paths lead into the Claude directory lists as `codex` and rolls back reporting `["claude"]`. A backup holding only tool-home files — a registry snapshot — reports `[]`, because it overwrote no target's runtime state. `data.impact` carries the two cases an empty list cannot distinguish: `{shared: true}` is known shared-only recovery, `{unknown: true}` is paths that could not be attributed to any target. Both and neither are possible, so a consumer that reads only `targets` cannot tell "only shared state changed" from "nothing classifiable was restored".
- `src/domain/target.ts`'s `TARGET_SCOPES`: one entry per command, `switchable` / `codex-only` / `claude-only` / `both` / `shared`. Three consumers held this fact separately before — a capability set, the flag guard, and the dispatch decision — and a new command could satisfy all three differently.
- `tests/target-scope.spec.js`, `tests/doctor-targets.spec.js`, `tests/claude-status.spec.js`, `tests/backup-targets.spec.js`.

### Changed

- `aps status --claude` works. It reports the Claude registry and the live `settings.json` and omits the Codex fields entirely, rather than reporting Codex state under a Claude flag.
- `aps config compact` requires `--claude`, since it has no Codex form. It routes to the Claude handler either way; the refusal names the missing flag.
- `aps doctor --claude --codex-dir <dir>` is refused on the three two-target commands: the directory is part of what the command would otherwise report, and naming one contradicts the narrowing.
- A backup manifest records the target that wrote it, so classification stops being a guess for anything written from here on.
- The Claude record check judges the **resolved** `env` and `model` rather than the stored delta. A stored `null` is a deletion marker under the merge rule, and `{env: null, model: null}` is what a record that strips both defaults is written as; reading the stored fields and calling that a non-object `env` reported two faults about a record doing exactly what it was written to do.
- The human `doctor` view prefixes each issue line with `[codex]` or `[claude]` — but only on a run that covers both, since a narrowed run has nothing to disambiguate.
- The human `status` view speaks in states rather than in guesses at faults. An unconfigured Codex reads `runtime health: not activated` instead of `config.toml absent or unreadable`, which named a repair for a machine that had nothing to repair, and the summary line reads `healthy` / `unhealthy` / `unknown (report incomplete)` from the three-valued field rather than from the issue count alone. A projection mismatch still reads `provider projection drift`, now read from the candidates' consistency instead of from the issue list, so the two views of the same fact cannot disagree.

### Notes

- **`CLAUDE_SETTINGS_NOT_FOUND` stays deleted.** `1.1.2` removed it because nothing threw it, and this release does not bring it back: an absent `settings.json` is a *state* — `not-activated` — rather than a finding, and a code for it would reserve the name for a condition the tool deliberately does not treat as a fault. The condition it was usually confused with, a settings file that exists and cannot be read, is `CLAUDE_SETTINGS_INVALID`. `tests/error-vocabulary.spec.js` holds the retirement by refusing any `CLAUDE_`-prefixed string that is not recorded, so an entry for a name nothing produces cannot be added quietly.
- **One correction to `1.1.2`'s unification, which that release's table could not express.** `1.1.2` unified the codes that carried a `CLAUDE_` prefix, and a code can name a condition without one: Codex's `add` refused a duplicate provider name with `INVALID_IMPORT_FILE`, which describes a malformed *import* rather than a name that is already taken. It now reports `PROVIDER_ALREADY_EXISTS`, the code the Claude path already used for the same condition, so the two lines agree for the first time. `aps export` still reports `INVALID_IMPORT_FILE` for an existing output file, which is the same kind of misnaming; it is recorded in `1.1.2`'s PRD as accepted rather than fixed here, because the repair needs a new member in the union.
- **`configured` no longer reads directory existence.** Any `~/.codex` used to count as evidence, so a directory an unrelated tool created made the Codex side look set up — and then produced `CONFIG_NOT_FOUND`, a finding about a file the user never meant to have. Evidence is now a registry file, an actual runtime configuration file, or a defaults block. A directory proves nothing on its own, and neither its absence nor its emptiness raises a finding. The trade is the deliberate one: the loud direction was wrong here, because it reported a fault for a target nobody had pointed this tool at.
- **`mixed` is currently unreachable.** No operation writes both targets' files, and the classification deliberately does not consult the tool home — `claude-providers.json` lives there and `settings.json` lives in the Claude directory, so a rule that read the tool home as "the Codex side" would file every Claude backup as Codex. `mixed` is what a manifest holding entries under both *runtime* directories reads as, and it is labelled rather than guessed at.
- **This is a scope table, not an abstraction.** The storage repositories, record shapes, projection rules, and app services are still per-target copies; a third target still means writing all of them. What it inherits is one place to declare the target and one function that answers "which target" — the shape `1.2.0` builds on.

## 1.1.2 - 2026-10-13

**Breaking.** One error vocabulary. The `--json` contract changes in exactly one table: five Claude error codes are renamed and one payload field is removed. Nothing else moves — every refusal is the same refusal, with a different code string, and every exit code and message is unchanged.

**Why the break is worth taking.** An error code should name a condition, not a target. `target` already answers "which target", on every envelope, on success and on failure. A `CLAUDE_` prefix was that same information encoded worse: it could only be read by string matching, it was absent for Codex, and it forced the *condition* to be renamed whenever the *target* was.

### Migration

| `1.1.1` | `1.1.2` | Note |
|---|---|---|
| `CLAUDE_PROVIDER_NOT_FOUND` | `PROVIDER_NOT_FOUND` | The Codex code for the same condition. |
| `CLAUDE_PROVIDERS_NOT_FOUND` | `PROVIDERS_NOT_FOUND` | The Codex code for "the registry is absent, or holds no providers". |
| `CLAUDE_PROVIDERS_PARSE_ERROR` | `PROVIDERS_PARSE_ERROR` | The Codex code for an unparsable registry. |
| `CLAUDE_PROVIDER_ALREADY_EXISTS` | `PROVIDER_ALREADY_EXISTS` | **Renamed, not merged.** It means a *record* with that name is taken; `PROVIDERS_ALREADY_EXISTS` means the registry *file* already exists. The singular is the new name. |
| `CLAUDE_SETTINGS_NOT_FOUND` | *deleted* | Declared and never thrown, so nothing could observe it. |
| `data.target` on a Claude payload | *deleted* | The envelope's `target` replaces it. |

There is no deprecation window and no `legacyCode` alias: a transitional field would have to be removed later, and every consumer that never read the old codes would pay for it.

### Changed

- Error codes no longer name a target. `target` on the envelope is the supported way to tell the Codex and Claude lines apart, and it is written on failures as well as successes.
- The Claude refusal *messages* are unchanged. A missing Claude provider still fails with `Claude provider "x" was not found.` — the code names the condition, the sentence describes the state. Collapsing the sentences too would have made a Claude failure read as a Codex one.
- `data.target` is gone from the Claude payload. It was a hand-written copy of a fact the envelope already states, and each of the seven Claude services wrote it itself.

### Added

- `PROVIDER_ALREADY_EXISTS`, alongside the existing `PROVIDERS_ALREADY_EXISTS`. They are one character apart on purpose and the distinction is asserted: a record with that name exists, versus the registry file exists.
- `tests/error-vocabulary.spec.js` — asserts no error code string in `src/` starts with `CLAUDE_`, that every declared code has a producer apart from a recorded list of five, and that the singular and plural codes stay distinct.

### Notes

- The unproduced-code census found more debt than the design recorded. Four codes are declared and thrown nowhere (`LIVE_STATE_DRIFT`, `AUTH_JSON_SYNC_FAILED`, `ACTIVE_PROVIDER_UNRESOLVED`, `UNMANAGED_ACTIVE_PROFILE`), and a fifth (`PROVIDER_BASE_URL_MISMATCH`) is rendered by the doctor as a *config issue* — a different space, and the one that made the original `DESTRUCTIVE_REMOVE_BLOCKED` exception wrong to name, since that code is a config-issue member and not an error code at all. All five are left in place and pinned by the test, which fails if the set grows.
- The two vocabularies stay separate: an issue is a finding on a successful run and an error is a failed run. Conflating them would make `healthy: false` indistinguishable from a crash.

## 1.1.1 - 2026-10-13

Target-explicit release. During the 1.1.x line the CLI manages two targets — Codex by default, Claude Code under `--claude` — but the code recorded which one an invocation meant in three separate informal ways: a boolean from `isClaudeCommand()`, a `data.target` field each Claude service wrote by hand, and a `claude-` prefix on mutation operation names. This release writes that value down once, as `TargetId`, and gives it a name a user can type. Additive and backward compatible: no command gains or loses a target, and the two registries, the projection model, the merge rule, the lock discipline, and the rollback containment are untouched.

### Added

- `--codex`, a named alias for the target a command acts on by default. It is accepted everywhere except `config compact`, which rewrites Claude provider records and has no Codex form. Naming the default must not fail, so it carries almost no refusal surface; it exists so a command line reads the same whichever target it picks, and so the pair rule below has something to refuse.
- `src/domain/target.ts` — `TargetId`, `TARGET_IDS`, and `resolveTarget()`, a pure function taking the resolved command id and the two `--claude` / `--codex` booleans. It answers "which target did the caller name" and deliberately does not consult the Claude capability set, which answers a different question.
- A `target` field on the JSON envelope, written by `renderSuccess()` and `renderFailure()` alike. It is `"codex"`, `"claude"`, or `null` when no command resolved, and it is written on the failure path too — until now the only signal that a failed `--claude` invocation had anything to do with Claude was the error code's name.
- `tests/target-resolution.spec.js`, table-driven over every command id, so adding a command without deciding which flags it accepts fails the suite. `docs/PRD/agent-provider-switch-prd-v1.1.1.md` and `docs/Design/agent-provider-switch-v1.1.1-design.md`.

### Changed

- `--claude --codex` on one command line is refused with `INVALID_ARGUMENT` rather than resolved by a precedence rule. Letting `--claude` win as the more specific flag would silently ignore a flag the user typed.
- `config compact` refuses `--codex`, naming the reason, instead of parsing it and ignoring it.
- The top-level `--help` global-options block lists `--claude` and `--codex`. `--claude` had been documented per-command but never in the global list.
- The flag guards moved from `handleRegisteredCommand()` to `executeCommand()`, which is the one funnel every command passes through. The guard has to see the command before the target can be assigned, and the target has to be assigned before the handler — which is what throws the failures the envelope has to describe — can run.

### Notes

- `backups prune`, `rollback`, and `unlock` accept `--codex` and do nothing with it. Those three act on shared state, and `1.1.3` is the release that makes them scope-aware; refusing the flag here would need that release's scope table, and shipping half of it is how a `doctor` ends up reporting one target under a flag that asked for two.
- `data.target` still exists on the Claude payload alongside the envelope's `target`, which is now the same value stated twice. `1.1.2` removes the former; a spec pins the two equal in the meantime so the removal is provably behaviour-preserving.
- `TargetId` is a closed union of two, so a third target is a type change plus an exhaustive-switch failure at every consumer. That is the intended shape, but it also means this release does not by itself make a third target cheap — that is `1.2.0`'s job.

## 1.1.0 - 2026-10-08

Shared-defaults release. A Claude provider has always been stored as a complete `settings.json`, and most of that is identical across providers: in the real tool home that prompted this, 10 `env` keys and 4 top-level keys were byte-identical in all four records. This release lets the shared part live once, in the tool config, with each record storing only what differs. Additive and backward compatible: a tool home without the new block behaves exactly as `1.0.0` did, and existing full records stay valid.

### Added

- An optional `claudeDefaults` block in `agent-provider-switch.json`, shaped `{ "settings": { ... } }` to mirror a provider record. It is written by hand; no command creates or edits it.
- `aps config compact --claude [--dry-run]` — rewrites every stored Claude provider to the entries that differ from the defaults. It changes only how a provider is stored: `switch --claude` writes the same file before and after, and `rollback` undoes the rewrite. `--dry-run` takes no lock, creates no backup, and leaves the file byte-identical, so it succeeds while another operation holds the lock. A run with nothing to change writes nothing and takes no backup. It refuses, naming the file, when the block is absent.
- `aps add --claude --from-file <f> --full` — keeps every entry of the file instead of only those that differ from the defaults. That pins them against later changes to the defaults; the record is still resolved over the defaults when read.
- `show --claude` marks inherited entries `(inherited)`, prints an `inherited:` summary, and `--json` carries an `inherited` list of dotted paths — paths only, never values. `--reveal` returns `settings` (the resolved result) plus `overrides` (what is stored).
- `tests/tool-config.spec.js`, `tests/claude-settings-merge.spec.js`, `tests/claude-defaults.spec.js`, and `tests/claude-config-compact.spec.js`, including seeded randomized properties for the merge. `docs/PRD/agent-provider-switch-prd-v1.1.0.md` and `docs/Design/agent-provider-switch-v1.1.0-design.md`.

### Changed

- **Merge rule, in one line:** objects merge recursively, the record wins, arrays are replaced wholesale, and `null` deletes an inherited key. `env` has no special case. An empty object does **not** clear an inherited object — `"enabledPlugins": {}` still inherits; clearing takes an explicit `null`.
- `add --claude --from-file` now slims against the defaults when a block exists. This is inheritance-first: a key the defaults set and the file omits is inherited, so slimming is not a byte-preserving round trip of the file. What it guarantees is that it never changes what a switch writes.
- `switch`, `list`, `current`, `show`, and the interactive selector resolve a stored record over the defaults before using it. The resolved settings are a separate `effective` field and never overwrite the stored `settings`: `remove` reads the whole file and writes it back, so a reader that overwrote `settings` would silently expand the defaults into every surviving record.
- With no `claudeDefaults` block nothing is merged and a record is written verbatim, explicit `null` members included, so upgrading cannot change what `switch` writes for anyone who never opts in.
- `--full` and `--dry-run` are refused with `INVALID_ARGUMENT` on any command that would ignore them, instead of being silently accepted: the parser takes a global boolean anywhere, and `aps backups prune --dry-run` would otherwise delete real backups under a flag that promised a preview. The check runs before the Claude path is entered, so `switch --claude --full` is refused too. `--claude` is now accepted by `config compact` as well.
- `agent-provider-switch.json` validation rejects an unknown key under `claudeDefaults` and a non-object `settings` with `INVALID_CONFIG`, rather than dropping them. The tool config is read on every command, so a malformed block fails all of them until it is fixed.
- The top-level `--help` banner names both targets. It had advertised Codex-only routing since before Claude Code became the second target.
- The wrapper that holds the shared lock is `withToolLock()`. Both targets contend for that one lock file, so it no longer carries either target's name. The old identifier is recorded in the `1.0.0` rename map.

### Notes

- Editing a default changes every provider that inherits the edited key, but the live `~/.claude/settings.json` is not rewritten until the next `switch`. After changing `model`, a model-map variable, or the base URL in the defaults, `current --claude` reports the active provider as unmanaged until `aps switch --claude <name>` is run again.
- An explicit `null` in a record is plain data while no block exists and a deletion marker once one does, so adding a block can start stripping such members from the written file.
- There is still no export or import of Claude provider records, so no built-in way to back up `claude-providers.json` as data.

## 1.0.0 - 2026-10-08

Rename release. The tool stopped being Codex-only when `0.3.0` added Claude Code as a second target, and this release makes the name say so. One breaking change, no compatibility shims, no command-surface change.

The old identity is gone rather than aliased. The binary is `aps`, the package is `@minniexcode/agent-provider-switch`, the tool home is `~/.config/agent-provider-switch`, the environment variables are `APS_HOME` / `APS_CODEX_DIR` / `APS_CLAUDE_DIR`, and the state files are `agent-provider-switch.json` and `.aps.lock`. The GitHub repository rename is a manual step outside this change.

### Added

- Automatic migration of a pre-`1.0.0` tool home. The first command after an upgrade moves the old home to the new location, so existing provider records, Claude profiles, and backups stay the state the tool reads. The move is a same-filesystem rename — never a copy-then-delete, never a merge — and it is skipped when `APS_HOME` is set, when the new home already exists, or when the old lock has a live owner.
- `docs/PRD/agent-provider-switch-prd-v1.0.0.md` and `docs/Design/agent-provider-switch-v1.0.0-design.md`.
- `tests/tool-home-migration.spec.js` covering the move, every no-op guard, and the `APS_HOME` short-circuit.

### Changed

- The tool home, the tool config filename, the lock filename, the environment variables, the binary name, the npm package name, and the `AgentProviderSwitchConfig` type all carry the new identity from this release.
- Every identity literal now resolves through `src/storage/codex-paths.ts`. `dispatch.ts` and `claude-handlers.ts` previously rebuilt the tool-config, lock, and backups paths by hand, which is how an identity change leaves one spot stale.
- All prior `docs/PRD/*` and `docs/Design/*` files are reissued under the new name — filenames and prose alike — so the repository reads as one tool throughout. They remain records of the releases they describe.

### Notes

- The old binary name is not kept as an alias. A forwarding script would keep it in `PATH`, in the docs, and in shell history indefinitely, which is the cost this release exists to stop paying.
- A backup manifest taken before the rename records absolute paths under the old tool home, and rollback containment derives its allowed roots from the new one, so a pre-rename backup can be rejected with `ROLLBACK_PATH_REJECTED`. Prune pre-rename backups after upgrading.

## 0.4.1 - 2026-09-20

Stateful-recovery release. Two commands added, both aimed at a state the tool could previously enter and not leave: a lock whose owner no longer exists, and a backups directory that grows without bound.

### Added

- `aps unlock [--force]` — clears a lock left behind by a process that is provably gone. Idempotent: a missing lock is success. Refuses when the recorded owner is still alive, and names it; `--force` is the documented override.
- `aps backups prune [--keep N]` — deletes backup directories newest-first, keeping `N` (default 20). Never deletes a directory that a surviving manifest still names, so a rollback route is protected by every backup that references it, not only the newest.
- Automatic retention: every mutating command prunes to the default depth and reports how many backups it removed.
- `doctor` reports an occupied or stale lock as a finding, with the owning pid.
- `LOCK_STALE` error code and a stale-lock takeover path in `runMutation()`.
- `tests/lock-recovery.spec.js`, `tests/backup-retention.spec.js`, `tests/atomic-write.spec.js`, `tests/arg-parsing.spec.js`, `tests/cli-process.spec.js`, and the `tests/e2e/` real-process suite with its own runner and CI step.
- PRD v0.4.0/Design v0.4.0 and PRD v0.4.1/Design v0.4.1 fact sources.

### Changed

- Backup directory names gain zero-padded milliseconds and are created exclusively, so two mutations in the same second no longer overwrite each other's backup. The created directory reports its own path rather than being re-derived from the timestamp.
- A mutation that fails and rolls back successfully no longer leaves its own backup directory behind.
- Windows: `writeTextFileAtomic()` retries a rename that fails with `EPERM`/`EACCES`/`EBUSY`. Those codes are what an antivirus or indexer produces by holding the destination open for a moment, and treating them as permanent aborted a mutation that would have succeeded.
- `add --create-profile` and `edit --create-profile` now actually write the `[profiles.<id>]` section. The flag was parsed, threaded to both app services, and then dropped, so it had never had an effect; the interactive `add` collector, which prompts for the model and base URL precisely because it believes it writes that section, was writing nothing.
- `--claude` on a command with no Claude path is refused (`INVALID_ARGUMENT`, naming the supported commands) instead of being silently ignored. `aps status --claude` used to report Codex state under a flag that asked about Claude.

### Fixed

- `--codex-dir` no longer accepts a flag as its value. `aps list --codex-dir --json` resolved a directory literally named `--json`, dropped the JSON request, and reported an empty provider list as success.

## 0.4.0 - 2026-09-20

Foundation release: no new command and no storage change. It makes the failure surface honest to scripts and makes the suite runnable where it is checked out.

### Added

- CI on Windows and Linux against Node 20 and 22: install, type-check, `npm test`.
- `runCli(argv, io)` as the single implementation of the entry ladder. It takes line-oriented sinks and returns an exit code instead of calling `process.exit`, so the in-process tests exercise the real dispatch rather than a hand-written mirror of it.
- Temporary-directory registry with an `exit` backstop; `makeCodexFixture()` generates the Codex `config.toml` / `auth.json` per test instead of copying a gitignored directory.
- `--claude` runtime coverage end to end: `tests/claude-provider-workflow.spec.js`, driven through `withClaudeEnv()` so it cannot reach a real `~/.claude`.
- `tests/release-contract.spec.js` asserts the version in `package.json`, both `package-lock.json` fields, and `--version` output, and that the PRD/Design pair for each line exists.

### Changed

- `--claude`, `--force`, `--merge`, `--overwrite`, and `--create-profile` are true boolean flags and no longer consume the token after them. `--claude` is position-independent, so `aps --claude list` resolves.
- An unrecognized command exits `1` with `INVALID_ARGUMENT` instead of exiting `0` with the top-level help. A bare group root (`aps config`) still prints that group's help and exits `0`.
- A synchronous parse failure produces the structured error envelope when `--json` is present, instead of escaping as a stack trace.
- `status` reports the tool-home root in both human and JSON output. The field was populated only in the JSON payload under a path the human renderer never read, so the human view printed an empty string.
- `resolveClaudeProviderName()` deleted; Claude provider names arrive as positionals like the Codex ones.
- `getSingleOption()`'s `required` parameter deleted — both of its branches returned `null`.

### Security

- Codex `show --json` continues to return the full `apiKey` by design. It is a documented automation contract and is unchanged by this release; Claude `show` still masks in both modes.

## 0.3.1 - 2026-09-20

Security patch release for the `0.3.0` dual-target line. No architecture change: the `--claude` path, both registries, and the command surface are unchanged.

### Added

- Global `--reveal` flag. `show --claude <name>` now masks credential-shaped env values by default; `--reveal` is the explicit opt-in that prints the real values and includes the raw `settings` blob.
- `export` reports `secretCount` and `containsSecrets`, and emits a warning when exported provider records contain API keys in plaintext.
- New `src/domain/secrets.ts` as the single source of truth for secret-key detection and masking; `maskSecret()` moved there from `src/domain/providers.ts`.
- `ROLLBACK_PATH_REJECTED` error code.
- `tests/secret-handling.spec.js` covering masking, `--reveal`, error-detail redaction, atomic writes, export warnings, and rollback containment.
- PRD v0.3.1 and Design v0.3.1 fact sources.

### Changed

- Managed files are written with owner-only permissions (`0600` for files, `0700` for directories the tool creates) on macOS and Linux. The `chmod` is skipped on Windows, where access is governed by NTFS ACLs and `chmod` only toggles the read-only bit.
- Error details are redacted by walking the whole detail tree against the shared secret-key pattern, instead of skipping only top-level keys containing `apikey`.
- `restoreManifest()` requires an `allowedRoots` argument, sourced from the caller rather than the backup manifest, so a tampered manifest cannot redirect a restore outside the managed roots.
- The `show --claude` payload gained `revealed`, and omits `settings` unless `--reveal` is passed.
- Human `show --claude` output notes when values were masked so `--reveal` is discoverable.

### Fixed

- `writeTextFileAtomic()` no longer deletes the destination before renaming. The previous `rm`-then-`rename` left a window where the destination did not exist; `rename` alone already replaces an existing file on both platforms.
- `auth.json` writes go through the atomic helper instead of a bare `fs.writeFileSync`, closing the last non-atomic write on the mutation path and bringing the file under the permission fix.

### Security

- `show --claude <name>` no longer returns live `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` values, in human or `--json` output.
- Codex `show --json` still returns the full `apiKey` by design; it is a documented automation contract and is unchanged in this release.
- On Windows, `chmod`-based permission tightening is inert. The exposure there is at the NTFS ACL layer and is documented as an operator action in `docs/agent-provider-switch-2.x-roadmap.md` (P0-2).

## 0.3.0 - 2026-07-18

Claude Code provider switching release.

### Added

- Claude Code provider management via `--claude` flag on `add`, `switch`, `list`, `show`, `current`, `remove` commands.
- `aps add --claude <name> --from-file <settings.json>` imports a Claude Code settings file as a named profile.
- `aps switch --claude <name>` atomically replaces `~/.claude/settings.json` with the stored profile.
- `aps current --claude` detects which registered profile matches the active Claude settings.
- `aps list --claude` shows all Claude profiles with active detection.
- `aps show --claude <name>` displays full Claude profile details including env vars.
- `aps remove --claude <name>` removes a Claude profile from the registry.
- Separate `claude-providers.json` storage in tool home directory.
- `APS_CLAUDE_DIR` environment variable to override the Claude Code directory.
- PRD v0.3.0 and Design v0.3.0 fact sources.

### Changed

- Package description updated to reflect dual-target (Codex + Claude Code) support.
- Help text for `add`, `switch`, `list`, `show`, `current`, `remove` updated with `--claude` usage.

## 0.2.2 - 2026-07-15

Version bump and command summary update.

## 0.2.1 - Unreleased

Provider-management-only consolidation release.

- Repositioned the current development line as a local-first Codex provider/model-provider management CLI.
- Removed current-facing Copilot login, `add --copilot`, bridge command, SDK, HTTP proxy bridge, and local bridge runtime contracts from docs and command presentation.
- Added `0.2.1` PRD and design fact sources.
- Updated release-contract coverage around the reduced provider-management command surface.
## 0.1.5 - 2026-07-01

Copilot Bridge process-visibility and redaction patch release.

### Changed

- Added stable Copilot bridge runtime events for assistant intent, message deltas, reasoning deltas, tool lifecycle, permission lifecycle, user-input requests, exit-plan-mode requests, and session status signals.
- Projected Copilot process/status events into Responses streaming commentary items and reasoning/progress updates into Responses reasoning summary events.
- Forwarded adapter runtime events through the bridge worker while keeping Chat Completions streaming text-only.
- Hardened unknown SDK event summaries with key-aware and value-aware redaction plus bounded truncation.
- Added adapter-level regression coverage for raw SDK session event normalization.

## 0.1.4 - Unreleased

Bridge stability and observability release.

### Changed

- Reworked Copilot bridge reuse to retry transient health/auth probe failures before replacing an existing worker.
- Added persisted bridge runtime logging, restart reason tracking, and surfaced `logPath` metadata across bridge, switch, status, and doctor flows.
- Extended bridge runtime state and start results with persisted probe/restart metadata for diagnostics.
- Restored the interactive provider picker `current` hint for legacy top-level `profile` state when `model_provider` is absent or unresolved.
- Replaced the hard-coded test runner with deterministic `tests/*.spec.js` discovery and aligned the widened release gate with the current help, runtime, and workflow contracts.

## 0.1.3 - Unreleased

Copilot login hotfix release.

### Changed

- Replaced the legacy `CopilotClient` constructor fields with the official `RuntimeConnection.forStdio({ path })` SDK connection path.
- Resolved the managed SDK runtime against `@github/copilot/npm-loader.js` instead of relying on implicit bundled package lookup.
- Kept human `copilot --help` and `copilot login` invocations on the bundled `.bin` shim while separating SDK runtime resolution from terminal CLI resolution.
- Added a focused `0.1.3` regression spec covering the Copilot login compatibility fix.

## 0.1.2 - Unreleased

Copilot runtime repair release.

### Changed

- Pinned the managed Copilot runtime installer to `@github/copilot-sdk@1.0.2` instead of installing `latest`.
- Added a Copilot-only Node.js runtime gate. Direct providers still support Node.js `>=18`; Copilot runtime paths require Node.js `>=20`.
- Reworked SDK loading to resolve `@github/copilot-sdk` from the managed runtime install directory via `createRequire()`.
- Replaced session-based auth probing with `CopilotClient.getAuthStatus()`.
- Added explicit Copilot runtime errors for unsupported Node runtime, SDK version, SDK API shape, and bridge upstream timeout.
- Reworked the bridge worker to keep one long-lived Copilot client, create one session per request, disconnect sessions after use, and serialize requests.
- Updated Responses streaming to emit initial SSE events before the upstream request completes and to keep the connection alive with heartbeat comments.
- Added Copilot config projection for `stream_idle_timeout_ms = 300000`.

### Documentation

- Added `0.1.2` PRD and design docs describing the experimental Copilot bridge boundary.
- Removed obsolete `0.0.x` transition docs and old test reports from the active docs tree.

## 0.1.1 - 2026-05-28

Documentation and fact-source completion release.

### Changed

- Added missing `0.1.1` PRD/design fact sources.
- Aligned README, CLI usage, product overview, architecture notes, and AI-facing README around the stable `0.1.x` route model.
- Clarified that `profile` is a managed alias for the Codex `model_provider` route id.

## 0.1.0 - 2026-05-28

First stable documentation baseline.

### Added

- Stable command-surface summary for direct provider and Copilot provider workflows.
- Stable JSON envelope contract for automation.
- Stable split-state model: tool home for managed state, target Codex home for runtime projection.

### Notes

- `migrate` remains an advanced adopt helper.
- `setup` remains a deprecated compatibility entry.
- Development-version policy remains in effect: no automatic migration shims or backward-compatibility preservation logic unless explicitly requested.

