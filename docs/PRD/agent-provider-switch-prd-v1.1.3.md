# agent-provider-switch v1.1.3 PRD

## Summary

`1.1.3` gives diagnostics, status, and backup reporting an explicit command scope. Bare
`doctor`, `status`, and `backups list` cover both targets; target flags narrow those reports.
`backups prune`, `rollback`, and `unlock` operate on shared state and refuse target flags.

Three concepts remain separate: **command scope** describes the accepted invocation, **backup
origin** describes the operation that produced a snapshot, and **restore impact** describes state
affected by recovery. Diagnostics distinguish configuration evidence, faults, notes, and normal
states. Local failures preserve independently obtainable results.

Design: [v1.1.3 Design](../Design/agent-provider-switch-v1.1.3-design.md).
Confirmed decisions: [1.1.x review](../Reviews/agent-provider-switch-1.1.x-prd-review.md).
Terms: [Glossary](../../GLOSSARY.md). This release closes no roadmap finding.

## Version and compatibility

- Version: `1.1.3`; predecessor: `1.1.2`.
- Status: **final reviewed requirements; implementation alignment remains in progress**.
- Breaking changes are accepted for this single-user, unpublished CLI. No compatibility window,
  legacy routing fields, or old diagnostic behavior is required.
- The envelope gains `targets`. Bare `target` changes from `"codex"` to `null` for **six**
  commands: the three default-both reports and the three shared commands.
- Shared commands stop accepting the previously accepted `--codex`; the three both-target commands
  reject `--claude --codex-dir`. Reporting payloads change to express partial availability and
  ambiguity explicitly.
- New manifests gain optional target metadata. This is a stored-shape addition; older manifests
  remain readable without migration.

## Goals and boundaries

- One scope table drives target selection, guards, dispatch, and help.
- A selected but unused target contributes no invented faults.
- Valid unmanaged settings, busy state, ambiguity, drift, and redundant deletion markers do not
  alone lower health.
- Existing damaged content is diagnosed before matching; one target's failure does not suppress
  independently obtainable results for the other.
- Every provider query uses the same identity rule; identity and full consistency are separate.
- List backups by origin; report rollback impact from affected artifacts.
- Retain per-target storage, projection, and app services. Target abstraction and a third target
  remain future work; this release does not add per-target retention or partial rollback.

## Command scope

Bare means no target selector. Conflicting `--claude --codex` is always `INVALID_ARGUMENT`.

| Scope | Commands | Bare | `--codex` | `--claude` |
|---|---|---|---|---|
| Switchable | `add`, `switch`, `list`, `show`, `current`, `remove` | Codex | Codex | Claude |
| Codex only | `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config show`, `config list-profiles` | Codex | Codex | Refused |
| Claude only | `config compact` | Refused | Refused | Required |
| Both | `doctor`, `status`, `backups list` | Both | Codex | Claude |
| Shared | `backups prune`, `rollback`, `unlock` | Shared | Refused | Refused |

On the three Both commands, `--claude --codex-dir X` is refused because the directory is outside
the selected scope. The existing switchable-command policy for that pair is outside this change.
Shared retention, lock repair, rollback selection, prompts, and containment stay in place.

### Envelope on success and failure

`targets` means **accepted command scope**, not raw requested flags. Validate the scope before any
file I/O, including migration and shared-config reading.

| Situation | `targets` | `target` |
|---|---|---|
| Accepted single-target command | One selected id | That id |
| Accepted bare Both command | `["codex", "claude"]` | `null` |
| Accepted Shared command | `[]` | `null` |
| Unrecognized/unparseable command or rejected scope/conflict | `[]` | `null` |
| Execution failure after valid scope accepted | Preserve accepted scope | Its single-target alias |

No separate requested-target field is introduced. Rollback's `data.targets` is restore impact,
not envelope scope; backup entry `target` is origin, not envelope scope.

## Configuration evidence and health

A target has configuration evidence when its registry file, an actual runtime configuration file,
or a target defaults block exists. Empty or malformed files still provide evidence. An empty
directory alone does not. Evidence does not assert a previous APS setup or valid configuration.

| Observed state | Report | Health consequence |
|---|---|---|
| No evidence, including only an empty directory | Unconfigured | No fault, even when explicitly selected |
| Registry/defaults exist, live configuration absent | Configured, not activated | Absence alone is not a fault |
| Registry missing or valid empty registry | No managed records | Absence/emptiness alone is not a fault |
| Valid live configuration, no matching managed record | Unmanaged | State, no fault |
| Existing file unreadable, malformed JSON/TOML, or invalid relied-on shape | Fault and unavailable dependent data | Unhealthy |
| Valid settings match several identities | Ambiguous, enumerate candidates | State, no fault |
| Identity matches but other valid settings differ | Drift paths | Note, no fault |
| Valid deletion or redundant deletion under defaults | Effective settings / optional housekeeping note | No fault |
| Normal live lock owner | Busy | State, no fault |
| Stale, malformed, or otherwise abnormal lock | Shared issue | Unhealthy in every doctor scope |

For activated Codex state, retain applicable provider/profile, model, auth, projection, and runtime
checks. Do not demand activation from a prepared target merely because a registry exists. Run runtime/projection prerequisites only for activated Codex state. Skip Codex runtime probing
for an unconfigured or not-activated target and for Claude-only selection.

`issues` contain diagnosed faults; `notes` contain non-fault observations; state fields describe
activation, management, ambiguity, and busy state. Every issue/note has a target id or `null` for
shared state. Inspect the shared lock exactly once under every doctor scope.

`healthy` is false when any selected-target or shared issue exists; true when health-relevant
checks completed without issues; null when those checks are unavailable and no fault has been
established. `complete` identifies whether all planned checks/data were obtainable. An incomplete
report must never assert healthy merely because a collector failed to return issues.

## Claude resolution, validation, and matching

With defaults, validate the **effective** settings after applying the `1.1.0` merge rules. A
legitimate null deletion is valid, including `env` or `model` removal. Deleting an already absent
default is a no-op; optional `REDUNDANT_DELETION_MARKER` notes do not lower health. Arrays retain
their contents. Without defaults, null is ordinary data and is not silently normalized to missing.

Validate JSON root/registry/record shapes and fields the tool relies on before using them. A
malformed live root, including an array or scalar, cannot be classified as unmanaged or match an
empty provider. Preserve no-default null semantics. Do not import an exhaustive external Claude
settings schema; unrelated valid settings remain supported.

### Identity

Claude identity compares these paths in live settings and every provider's effective settings:

- `model`
- `env.ANTHROPIC_BASE_URL`
- `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `env.ANTHROPIC_DEFAULT_SONNET_MODEL`
- `env.ANTHROPIC_DEFAULT_OPUS_MODEL`
- `env.ANTHROPIC_AUTH_TOKEN`
- `env.ANTHROPIC_API_KEY`
- `apiKeyHelper`

Compare presence and values exactly. Do not guess URL/model normalization, collapse ordinary null
into absence, execute `apiKeyHelper`, or resolve external authentication. Compare configured secret
values only in memory; output must never contain them.

Use one identity result across `current`, `list`, `show` summaries, `doctor`, `status`, and
interactive active markers. Zero candidates is unmanaged; one identifies a managed provider; more
than one is ambiguous. Never choose the first candidate or use full equality to silently select one.

### Full consistency

For each identity candidate compare full effective settings with live settings: object key order
does not matter, array order does. Report per-candidate `consistent` and `differencePaths`; never
report difference values. A unique identity can remain managed with drift. Multiple identities
remain ambiguous even if only one candidate is fully consistent.

## Partial reports and shared configuration

Doctor and status retain all independently obtainable information for selected targets. A read or
content failure is local when the rest of the report can still be produced.

| Shared config condition | Required behavior |
|---|---|
| Absent shared config | Known absence; no defaults; normal path precedence |
| Valid JSON but malformed Claude defaults | Claude issue when Claude is selected; Claude resolution unavailable; continue independent Codex and raw-file checks |
| Entire shared JSON unreadable/invalid or root unusable | Shared issue; continue checks using reliably known paths; dependent results unavailable |
| Valid shared config | Use validated values normally |

Do not replace invalid defaults with an empty block. Codex path precedence remains explicit flag,
environment, shared config, then discovery/default. If invalid shared config prevents deciding
whether its path overrides the fallback, do not guess a fallback path; the dependent path/report is
unavailable. An explicit or environment path can still support independent checks.

A successful report has `ok: true` and exit `0`, even when `healthy: false` or data is locally
unavailable. Use top-level `ok: false`/exit `1` only if a basic report cannot be produced, or the
invocation is rejected. A local result must explicitly distinguish absence, invalidity, unavailable
data, and successful zero/empty values.

Doctor and status share selected target sections and safe state readings described in the Design.
Status includes known target/registry/live paths, configuration evidence, registry count, defaults,
activation/matching, and inheritance information where available. A narrowed report omits the other
target. `status` also carries issues and notes so partial-data reasons are visible.

## Backup origin and list filtering

Every listed backup entry has `target: "codex" | "claude" | "mixed" | "unknown"`, describing
**origin**. New optional manifest `target` metadata accepts only `"codex"` or `"claude"`;
reject other values when present. Unknown extension fields do not exempt known metadata from
validation.

Classify origin using valid explicit metadata first, recognized operation names second, and
artifact/path ownership as a legacy fallback. A path fallback accumulates both targets where
appropriate. Generic tool-home containment alone does not imply Codex.

| Origin label | Unfiltered | Codex filter | Claude filter |
|---|---|---|---|
| Codex | Included | Included | Omitted |
| Claude | Included | Omitted | Included |
| Mixed | Included | Included | Included |
| Unknown | Included | Omitted | Omitted |

Metadata/reason describe provenance even when restored paths affect another target. Filtering must
not use restore impact. Listing skips corrupt manifests with a warning; explicit restore of one
fails. Older valid manifests require no migration.

## Rollback impact and containment

Rollback reports `data.targets` from the validated restore operations, never from origin metadata
or operation names. Registry-only recovery affects its registry's target, even if live files do not
change. Restoring earlier absence/deleting a snapshotted-new file also counts as impact.

Classify known artifacts by their owner: target registries belong to their target; genuinely shared
tool state belongs to neither. For other paths, accumulate **all** matching trusted target roots,
including overlapping roots. Deduplicate and order targets consistently.

The result also distinguishes known shared-only recovery from unknown/unclassifiable paths.
If target and unknown paths coexist, preserve known targets and mark unknown impact. An empty
target set alone cannot express both shared-only and unknown recovery.

Preserve the existing caller-built restore allowlist. Historical roots recorded in manifests are
never automatically trusted or added to the allowlist. A refused restore remains a failure and must
not claim completed impact. Rollback remains whole-manifest recovery; target flags are refused.

## Release and acceptance

Synchronize version/release docs under the repository checklist. CHANGELOG must declare all six
bare alias changes, shared-flag refusals, the three directory-flag refusals, reporting-schema changes,
and optional manifest metadata. Update affected tests rather than promising unmodified suites.

Required acceptance cases:

1. Table-test every command with bare, each flag, and conflicting flags. All three Both commands
   reject `--claude --codex-dir`. Shared refusals happen before filesystem work.
2. Verify scope on parse/unknown-command/rejected-target failures and on later config/read/service
   failures; accepted scope survives later failures.
3. Empty tool homes and empty target directories are unconfigured and healthy, including explicit
   narrowing. A Claude-only home does not manufacture Codex faults.
4. Registry-only/defaults-only state is configured but not activated; missing/empty registry and
   absent live settings do not alone generate faults. Existing malformed files do.
5. Legitimate env/model deletions and array-contained null remain valid; redundant deletions are
   notes at most. No-default null remains data and differs from a missing identity field.
6. Invalid JSON, arrays/scalars as live roots, malformed registry shapes, and invalid relied-on
   field types become issues before matching.
7. Valid unmanaged live state remains healthy. Same address/model with different token, API key,
   or helper does not falsely match. No credentials appear in reporting output.
8. Multiple identity candidates remain ambiguous, including a case with just one fully consistent
   candidate. Full consistency ignores object key order and detects array-order differences.
   Drift reports paths as notes without lowering health.
9. Shared live lock is busy and healthy; stale/malformed lock is unhealthy in both narrowed scopes.
   Shared lock is checked once in a default-both report.
10. One target's damaged/unreadable content does not erase the other's results. Malformed Claude
    defaults do not block Codex. Broken shared JSON retains checks with independently known paths
    and marks dependent readings unavailable; no guessed defaults/path are used.
11. Status preserves the same partial-information rules. Confirmed zero counts differ from
    unavailable counts; reported local faults still yield `ok: true`/exit `0`.
12. Origin filters include mixed in both narrowed lists and unknown only unfiltered. Validate known
    metadata; corrupt manifests are skipped with warnings in list and rejected by explicit restore.
13. Rollback origin/impact disagreement reports path-derived impact. Registry-only, runtime-only,
    mixed, shared-only, and unknown-path recoveries are distinguishable. Overlapping roots
    accumulate all targets; historical roots do not bypass containment.
14. Build, type checking, in-process tests, and E2E tests pass after contract assertions are aligned.
    These criteria specify work to verify; they are not a claim that all current tests cover it.
