# agent-provider-switch v1.1.3 Design Document

This is the implementation design for [the final reviewed v1.1.3 PRD](../PRD/agent-provider-switch-prd-v1.1.3.md).
It consumes `1.1.1`'s target foundation and `1.1.2`'s error vocabulary. It specifies the required
contract; implementation and test alignment remain in progress.

The [review](../Reviews/agent-provider-switch-1.1.x-prd-review.md) records the accepted decisions.
Breaking changes are authorized for this single-user CLI. Existing source behavior is evidence for
the implementation audit, not a reason to override the accepted rules.

## 1. Scope before I/O

Keep target identifiers and a total scope table in `src/domain/target.ts`:

```ts
type TargetId = "codex" | "claude";
type TargetScope = "switchable" | "codex-only" | "claude-only" | "both" | "shared";
const TARGET_SCOPES: Record<CommandId, TargetScope>;
```

| Scope | Command ids | Accepted targets |
|---|---|---|
| Switchable | `add`, `switch`, `list`, `show`, `current`, `remove` | Bare Codex, one flag selects one |
| Codex only | `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config-show`, `config-list-profiles` | Bare/explicit Codex |
| Claude only | `config-compact` | Explicit Claude required |
| Both | `doctor`, `status`, `backups-list` | Bare both, one flag narrows |
| Shared | `backups-prune`, `rollback`, `unlock` | Empty target scope; neither flag accepted |

Derive capability predicates, supported-command messages, and help metadata from this table.
Remove independent `CLAUDE_COMMANDS` membership as a source of truth. Routing to the Claude
handler is distinct from accepting `--claude`: Both commands are composed by their report handler,
not routed to a single-target mutation handler.

Dispatch order is normative:

1. Parse and recognize a command without touching files.
2. Validate target selection and scope, including conflicting flags, Claude-only requirements,
   and `--claude --codex-dir` on all three Both commands.
3. Store accepted `targets` in the execution/failure context.
4. Perform migration, shared-config reading, path resolution, and command execution.

Rejected selection leaves scope empty. Later I/O/service errors retain the accepted scope.
Shared commands enter execution with an empty scope. The switchable-command directory-flag policy
is unchanged by the specific Both-command guard.

## 2. Envelope and reporting types

Execution context requires `targets: TargetId[]`. Both render paths write:

```ts
targets: TargetId[];
target: TargetId | null; // sole entry of targets, otherwise null
```

Order is Codex then Claude. No requested-target field and no restored `data.target` routing field
are introduced. A bare Both command has both ids and null alias; Shared commands have an empty
array and null alias on success or failure.

All six commands' bare aliases change from the legacy `"codex"` routing tag to null. This is a
breaking contract change, alongside shared-flag and reporting changes, and must be described that
way in release notes.

### Explicit availability

Use a tagged reading for data that can fail independently:

```ts
type Reading<T> =
  | { status: "ok"; value: T }
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string };

type Finding = {
  code: string;
  target: TargetId | null;
  message: string;
  path?: string;
};
```

Absent means confirmed nonexistence; invalid means obtained content failed validation; unavailable
means the answer cannot reliably be derived, including read failure or invalid dependencies.
Reasons and findings contain safe messages/paths, never settings or secret values. A damaged file's
existence can be known even when its content is invalid.

A successful zero count is `{ status: "ok", value: 0 }`. Missing registry is separately represented
as absent; if its absence is reliably known, a derived provider count can validly be zero.
A count that could not be read is unavailable, never zero. Null is not a substitute for any
unavailable reading.

### Doctor and status report shape

Both commands use this common report structure; status fills summary readings and doctor adds the
deeper applicable checks:

```ts
type Report = {
  toolHomeRoot: string;
  complete: boolean;
  healthy: boolean | null;
  issues: Finding[];
  notes: Finding[];
  shared: {
    toolConfig: Reading<{ defaultsPresent: boolean }>;
    lock: Reading<"free" | "busy" | "abnormal">;
  };
  codex?: TargetReport;
  claude?: TargetReport;
};

type TargetReport = {
  configured: Reading<boolean>;
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
  activeProvider: string | null;
  candidates: Array<{
    name: string;
    consistent: boolean;
    differencePaths: string[];
  }>;
};
```

This is a reporting contract, not raw settings export. Codex can report empty inheritance data when
that concept is inapplicable; its projection-specific state/checks can extend its section with
equally explicit readings. Claude inheritance counts derive from resolved provider records.
`paths` includes only reliably resolved relevant paths; failures in some paths must not erase
other independently known paths (split readings per path if needed). For multi-file Codex runtime
state, report each artifact's reading separately. Activation depends on active configuration, not
merely the existence of an auxiliary auth artifact.

Omit unselected target sections. The top-level envelope already states command scope; do not
duplicate it as another routing field inside report data. The normalized target sections replace
the earlier flat Codex status layout as a declared reporting-schema break.

`activeProvider` is null for not-activated, unmanaged, and ambiguous states, with `state` giving
the meaning. If matching cannot run, return an invalid/unavailable reading rather than any of
those successfully determined states.

`healthy` is false whenever issues exist; true only when health-relevant checks are complete and
fault-free; otherwise null. `complete` is false when planned readings/checks cannot be obtained.
Status health concerns its summary checks and does not certify unperformed doctor-only runtime
checks. A report can be successful, unhealthy, and incomplete simultaneously.

## 3. Independent reads and shared-config dependencies

Storage readers must preserve absent, invalid, and read-error states. Do not collapse them into
null. Keep file presence probes, raw content validation, effective resolution, and matching
separate so a failed dependency does not suppress unrelated results.

For reporting, shared-config inspection must separate whole-file readability/root shape from
field-specific validation:

- File absent: validated absence, no defaults, use normal resolver precedence.
- File invalid/unreadable: one shared issue; dependent config values unavailable.
- Valid JSON/root with malformed `claudeDefaults`: one Claude issue when Claude is selected;
  resolution depending on defaults unavailable. Shared file-level validity remains known, and
  other validated fields and independent Codex checks remain available. Do not emit unselected
  target issues or mark a Codex-only report incomplete because unused Claude defaults are invalid.
- Valid defaults: pass the validated block normally.

Do not weaken mutation config validation globally merely to support reporting. Provide a reporting
inspection result or split validation paths; mutation commands can retain their strict fail-fast
config readers.

Codex path precedence is explicit flag > environment > shared config > discovery/default.
An explicit or environment path does not depend on a broken shared file. Without either, an unreadable
shared file cannot be treated as if it lacks a configured override; its dependent path is unavailable.
Known tool-home registry paths and independently resolved Claude paths can still be checked.

Each collector catches expected local storage/content errors, emits an issue for unreadable or
invalid existing content, marks dependent readings, and continues. Unexpected failures that prevent
the basic report reach the top-level failure path with accepted scope retained.

Report production succeeds with `ok: true`/exit `0` even when it reports faults or unavailable
local data. Rejected invocations or inability to produce a basic report yield `ok: false`/exit `1`.

## 4. Configuration evidence, activation, and lock

Configuration evidence uses files/default blocks, not directory existence:

- Codex registry, Codex runtime configuration artifacts such as `config.toml`/`auth.json`, or
  any supported Codex defaults block.
- Claude registry, `settings.json`, or a Claude defaults block.
- Malformed files/blocks still establish evidence; report their validation faults separately.
- Empty target directories do not establish evidence.

If all evidence sources are reliably absent, configured is false. Any known evidence makes it
true. Otherwise, if uncertainty prevents a negative conclusion, it is unavailable.
Explicit target selection does not change these rules.

Absent live configuration means not activated. A prepared registry/defaults-only target does not
owe a missing-live-file issue. Missing/valid-empty registry means no managed records; valid live
settings can still be unmanaged. For a partially present multi-file Codex projection, validate
existing content and run consistency checks whose prerequisites are available; do not classify
existing broken content as harmless absence.

Doctor's Codex checks retain applicable config/profile/model/auth/projection/runtime validation.
Run runtime/projection prerequisites only for activated Codex. Skip the runtime probe for
unconfigured or not-activated Codex and never run it for Claude-only scope. Existing content is
still validated independently; unsupported/malformed active config remains a fault.

Inspect the shared lock once outside target collectors for every doctor selection:
free is normal, a valid live owner is busy, and stale/malformed/abnormal ownership is a shared issue.
Normal busy state does not lower health. Repair advice belongs to the abnormal finding; do not
turn live occupancy into a fault solely because a mutation would currently be refused.

## 5. Claude validation and a single identity result

Keep raw registry readers for writes and effective settings for reads, as in `1.1.0`.
Validate the registry container and record shapes before resolution; validate relied-on settings
on the effective view. The existing `readClaudeSettingsState()` separation of absent/invalid/ok
must also preserve read failures and validate the fields used by summaries/matching.

For the relied-on fields, non-null `env` must be an object, and non-null model/address/model-routing/
authentication/helper values must have their supported string types. Preserve the established
ordinary-null behavior when defaults are absent. A missing/deleted field is allowed; raw null
deletion under defaults is not an invalid field type. Live root arrays/scalars are invalid.

Do not apply the recursive merge's deletion semantics inside arrays. Redundant deletion markers
under defaults can become `REDUNDANT_DELETION_MARKER` notes, never issues. Without defaults they
are ordinary data, not orphaned deletion markers.

### Identity comparison

Create one pure identity/candidate calculation shared by all Claude query and active-marker
callers. Compare these effective/live paths:

| Dimension | Paths |
|---|---|
| Address | `env.ANTHROPIC_BASE_URL` |
| Model routing | `model`, `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`, `env.ANTHROPIC_DEFAULT_SONNET_MODEL`, `env.ANTHROPIC_DEFAULT_OPUS_MODEL` |
| Configured authentication | `env.ANTHROPIC_AUTH_TOKEN`, `env.ANTHROPIC_API_KEY`, `apiKeyHelper` |

Use a missing-value sentinel so presence differs from ordinary null. Compare exact values without
normalizing trailing slashes/model aliases or resolving helper output. Secret values remain in
memory and must not appear in result payloads, reasons, logs, or findings.

Zero valid identity candidates means unmanaged, one means managed, several mean ambiguous.
Do not use `.find()` or sorting to select an arbitrary candidate. List/selector rows may identify
candidate membership, but must label ambiguous membership rather than declare every candidate
uniquely active. Preserve Codex's ambiguity-safe identity policy with the same reporting meanings.

If damaged records or invalid defaults prevent establishing a complete candidate set, matching is
unavailable; do not claim uniqueness/unmanaged merely from surviving records.

### Full consistency and drift

For every identity candidate compare full live/effective JSON structurally: compare objects by key
set and values, arrays by ordered elements, and primitives exactly. Ignore object insertion order.
No full-equality tie-breaker is allowed: several identity candidates remain ambiguous even if one
matches the full configuration.

Return `consistent` and deterministic `differencePaths` per candidate. Report array paths/indices
without values. Use a `CONFIGURATION_DRIFT` note for valid differences; permissions/plugins/custom
settings can drift without becoming invalid. Only diagnosed content/field faults lower health.

Apply this policy to current/list/show summaries, doctor/status, and interactive selectors.
Explicit existing show/reveal contracts remain separate; diagnostic comparison output never
includes secret values.

## 6. Backup origin

`BackupManifest` gains optional `target?: TargetId`. Required-field validation remains, and the
known optional field must be checked: if present it is exactly `"codex"` or `"claude"`.
Unknown extension fields may still be retained. Null, mixed, unknown, arrays, and arbitrary strings
are invalid values for this metadata.

Each target mutation states its target to `runMutation()` and `createBackup()`.
No new mutation bypasses the existing lock/backup/rollback wrapper.

Keep `classifyBackupTargets()` for **origin only**, applied in tiers:

1. Valid explicit metadata yields its origin.
2. Recognized operation names (`claude-*` for known Claude operations; known Codex operations
   such as add/switch/remove/edit/import/migrate/config writes) yield their origin.
3. Without recognized provenance, classify known target artifacts and accumulate all matching
   trusted target roots for remaining paths.
4. No target evidence yields unknown; both ids yield mixed.

Use an explicit recognized-operation table rather than guessing from any arbitrary string.
A generic tool-home path is not a Codex origin. A registry-only legacy backup can be classified
by the known registry artifact when provenance is absent.

`BackupListItem.target` is `TargetId | "mixed" | "unknown"`. Mixed appears in both narrowed lists;
unknown appears only unfiltered. Valid explicit provenance takes priority over paths even when
restore impact differs. Listing a corrupt manifest skips it with a warning; explicitly restoring
it fails through normal validation. Older valid manifests need no migration.

## 7. Restore impact independently of origin

`targetsRestoredBy()` must inspect actual validated restore operations. Do not call the origin
classifier or consult `manifest.target`/`reason` to decide impact.

For each restored destination, including removal to recover earlier absence:

1. Recognize exact known artifact paths first. `providers.json` belongs to Codex and
   `claude-providers.json` belongs to Claude, even inside a shared/overlapping root. Known shared
   tool artifacts, including the shared tool config, have shared ownership.
2. For other paths, test each trusted target root independently and add every match. There is no
   Claude-first `if/else` winner when roots overlap.
3. A path with no known owner/root match is unknown; generic tool-home containment does not prove
   shared ownership.

Return safe impact metadata on successful rollback:

```ts
data: {
  // Existing backup identification and restored-file summary are retained.
  targets: TargetId[];
  impact: { shared: boolean; unknown: boolean };
}
```

| Operations classified | targets | impact |
|---|---|---|
| Claude registry only | `["claude"]` | shared false, unknown false |
| Both target paths | Both ids | shared false unless shared artifacts also occur |
| Only known shared artifacts | `[]` | shared true, unknown false |
| Unclassifiable paths | Known ids, if any | unknown true |
| No restore operations | `[]` | shared false, unknown false |

The envelope of rollback always has empty command scope. A manifest with Codex origin and Claude
restore destinations still reports Claude impact. Human output must distinguish shared-only,
unknown impact, and known target impact, and avoid presenting origin as completed recovery.

Keep `restoreManifest(manifest, allowedRoots)` and its caller-built allowlist. Classifiers do not
grant restore permission. Historical roots in manifest metadata must never enlarge the allowlist.
A path rejected by containment fails before completed-impact output; no target flag enables a
partial restore.

## 8. Verification and release

Retain shared pruning's retention policy and never-delete-a-referenced-directory invariant,
rollback selection/prompts, and shared unlocking behavior. Align help, usage, JSON docs, and
CHANGELOG with the accepted scope and explicit breaking reporting contract.

Use the PRD acceptance matrix for meaningful regression cases. In-process tests cover scope before
I/O, local availability, evidence/health, identity ambiguity, consistency, metadata validation,
origin filtering, and restore ownership/overlaps. E2E tests cover actual JSON streams and exit
codes for healthy/unhealthy/partial reports and rejected shared flags. Use isolated target homes
and synthetic credentials; do not touch real configuration.

Existing tests for unmanaged-as-issue, live-lock-as-issue, directory-based configuration,
first-candidate selection, path-insensitive rollback, and old envelope aliases must be revised.
Passing existing suites alone does not establish the new rules.

Synchronize release versions and documentation under the repository checklist; keep the existing
historical PRD/Design existence checks. Run build, type checking, in-process tests, and E2E tests.
Publishing remains manual. The review record distinguishes completed documentation from remaining
implementation gaps.
