# agent-provider-switch v1.1.1 PRD

## Summary

`1.1.1` makes the **target** an explicit concept. Every command answers "which agent CLI is this
about?" today, but it answers through three unrelated conventions, none of which is a value the user
ever wrote: `isClaudeCommand()` infers it from `--claude` plus a command's membership in a set, each
Claude service hand-writes `target: "claude"` into its own payload, and each Claude mutation encodes
it again as the `claude-` prefix on its backup operation name. There is no `--codex`, so "the
default" has no name.

This release adds the missing name and the single function that reads all of it. `--codex` becomes
an accepted flag on every command except Claude-only `config compact`. `resolveTarget()` becomes
the one place "which target" is decided, and the JSON envelope gains a `target` field that is always present. Nothing else changes:
no command gains or loses a Claude path, no stored file changes shape, and every existing `--json`
payload is byte-identical apart from the new envelope field.

This is a foundation release, not a feature release. It exists because three later pieces of work
(`1.1.2` collapsing the error vocabulary, `1.1.3` making the shared-state commands report both
targets, and the `1.2.0` target abstraction) each need "which target" to be a value they can read
rather than a convention they have to re-derive.

Design detail: `docs/Design/agent-provider-switch-v1.1.1-design.md`. This release closes no roadmap
finding. It is the first target-foundation stage after `1.1.0`. `1.1.2` changes the error
vocabulary and `1.1.3` changes diagnostic behavior and command scope.

## Version

- Version line: `1.1.1`
- Predecessor: `1.1.0`
- Status: **foundation-stage specification.** Its flag and envelope additions preserve `1.1.0`
  payloads. The final reviewed `1.1.3` contract deliberately supersedes some scope and flag behavior;
  this document does not promise compatibility across future releases.

## Goals

- **One answer to "which target".** A single `resolveTarget()` decides it from the parsed command and
  its flags. The three existing conventions keep working but stop being independent sources of truth.
- **The default has a name.** `--codex` names the Codex route where accepted, so a script can state
  the target it means instead of relying on the absence of `--claude`.
- **Every envelope says which target it answers about.** `--json` carries `target` on success and on
  failure alike, so a consumer no longer infers the target from `command` plus a `CLAUDE_*` error
  code.
- **Strictly additive.** No command changes behaviour, no payload loses a field, and no stored file
  changes shape. A caller that ignores `--codex` and the new envelope field sees `1.1.0` exactly.
- **Two targets cannot be named at once.** `--claude --codex` is refused rather than resolved by
  precedence.

## Non-Goals

- **No change to which commands support Claude.** `doctor`, `status`, `backups list`, `backups
  prune`, `rollback`, and `unlock` remain Codex-only or shared-only, exactly as in `1.1.0`. Their
  target awareness is `1.1.3`, and shipping a half-aware `doctor` here would be worse than shipping
  none.
- **No error-code unification.** `CLAUDE_PROVIDER_NOT_FOUND` and `PROVIDER_NOT_FOUND` still coexist.
  Merging them is `1.1.2`, because it is a breaking change to the `--json` contract and deserves its
  own release note rather than a footnote in a foundation release.
- **No removal of `data.target`.** The field each Claude service writes into its own payload stays,
  byte for byte. It is now redundant with the envelope field, and it is slated for removal in
  `1.1.2`; removing it here would make this release break a payload it promised not to touch.
- **No target abstraction.** `1.1.1` gives the target a name and one resolver, nothing more. The
  per-target storage repositories, record shapes, app services, and handler switches stay as they
  are. Making the target *pluggable* is `1.2.0` work, and it is the reason this line exists.
- **No third target.** `TargetId` is a closed union of `"codex" | "claude"`. A third id is added when
  a third target is implemented, not pre-declared here.

## Three Conventions Doing One Job

The reason this release is worth a version of its own.

| # | Where | How it decides | What it cannot say |
|---|---|---|---|
| 1 | `isClaudeCommand(command, commandOptions)` | `--claude` present **and** the command is in `CLAUDE_COMMANDS` | It is a boolean. "Codex" is the absence of `--claude`, and `--claude` on a command outside the set is an error rather than an answer. |
| 2 | `data.target === "claude"` | Each of the seven Claude services writes it into its own result payload | Only one target ever sets it, so the field is absent for Codex and exists to route the human renderer, not to describe the result. |
| 3 | the `claude-` prefix on `runMutation`'s `operation` | `claude-add`, `claude-switch`, `claude-remove`, `claude-config-compact` | It is a naming convention. It reaches `backups/` as the manifest's `reason` string, where nothing parses it. |

All three are load-bearing and all three are conventions rather than data. `1.1.1` replaces none of
them outright — it introduces the value they were each approximating, and points them at it.

## `--codex`

`--codex` joins the parser's boolean set, so like `--claude` it never consumes the token after it and
is position-independent: `aps --codex list` and `aps list --codex` resolve identically.

It is **accepted by every command that can run against Codex**. That is nearly all of them, because
Codex is the default; naming the default must never fail. The two exceptions are stated as refusals
rather than silences:

- `aps list --claude --codex` is `INVALID_ARGUMENT`. Two targets were named and there is no
  precedence rule that would not surprise someone.
- `aps config compact --codex` is `INVALID_ARGUMENT`, unchanged from today's `config compact`
  refusal: there is nothing to compact on the Codex side, where records are already flat.

`--codex` does **not** enable anything. On `add`, `switch`, `list`, `show`, `current`, `remove`,
`doctor`, `status`, and the Codex-only commands it is exactly equivalent to omitting it. On the
commands that `1.1.3` will make report both targets it will mean "narrow to Codex"; `1.1.1` ships the
flag before the narrowing exists, and says so in the help text.

## The `target` Field

The JSON envelope gains one field:

```json
{
  "ok": true,
  "command": "list",
  "target": "claude",
  "data": {},
  "warnings": [],
  "error": null
}
```

**It is `null` when no command or valid target route resolved.** A parse failure
(`aps --json --codex-dir`) and an unrecognized command (`aps --json lst`) both produce an envelope with `"target": null`, because
there is no command for it to describe. Reporting `"codex"` there would assert a default that was
never chosen; reporting nothing would make the field's presence depend on the outcome. Conflicting
or unsupported target selections also produce `target: null`. Resolve and validate the target route
before migration, config reads, or other file I/O; later execution failures retain the accepted route.

**It is present on failure too.** A failed `switch --claude` and a successful one both say
`"target": "claude"`. This is the field's whole point: a consumer reads the target from one place
instead of correlating `command` with a `CLAUDE_*` error code.

**It does not replace `data.target`.** Both are emitted in `1.1.1` for any Claude command. The
duplicate is deliberate and short-lived, and `--json` output for every existing command stays
byte-identical apart from the one added field.

### Stage boundary and final scope semantics

In `1.1.1`, `target` is the accepted dispatch route. The three shared commands still enter through
the legacy Codex handler and carry its `"codex"` routing tag. That tag does not describe the target
state a rollback restores: a shared rollback can already restore Claude files.

The final contract in [the 1.1.3 PRD](agent-provider-switch-prd-v1.1.3.md) uses accepted command
scope instead. Envelope `targets` is authoritative, and `target` is its single-target alias.
Shared commands have `targets: []` and `target: null`; rollback reports restore impact separately
in its result. Backup origin is a third concept. These are deliberate breaking corrections to the
foundation routing tag, with no legacy field or compatibility window.

## Behaviour By Command

No row in this table changes anything a user observes, apart from the flag and the envelope field.

| Command | Change in `1.1.1` |
|---|---|
| `list`, `show`, `current`, `switch`, `remove`, `add` | `--codex` accepted, equivalent to omitting it. `--json` gains `target`. |
| `config compact` | `--codex` refused (no Codex form); `--claude` still required. `--json` gains `target`. |
| `doctor`, `status`, `backups list`, `backups prune`, `rollback`, `unlock` | `--codex` accepted, equivalent to omitting it. `--claude` behaviour unchanged (`backups prune`, `rollback`, `unlock` still refuse it). `--json` gains `target: "codex"`. |
| every unrecognized-command or parse-failure envelope | `target: null`. |

Two of those rows are worth stating rather than leaving in a table cell, because `1.1.3` moves them
and a reader of this document alone would not expect it.

**The six commands above change scope in `1.1.3`.** Bare `doctor`, `status`, and
`backups list` become two-target reports. `backups prune`, `rollback`, and `unlock` become
explicitly shared and refuse both target flags. All six change their bare envelope `target` from
`"codex"` to `null`. The three shared commands' earlier value describes their handler route only,
never their restore impact.

**`1.1.1` refuses `aps status --claude`.** The command reports Codex state and has no Claude form
until `1.1.3` gives it one, so the refusal is the correct behaviour here and the capability is that
release's. Nothing in the documents for this release may describe it as available.

## Release Mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.1`.
- `tests/release-contract.spec.js` takes `1.1.1`, and the PRD/Design existence window slides to
  `1.1.1 → 1.0.0`.
- `CHANGELOG.md` gains a `1.1.1` entry.
- `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, and `docs/Tests/testing.md` carry
  the new version and document `--codex` and the envelope's `target`.
- Product overview and architecture documentation must describe both targets and the foundation
  routing tag honestly. Keep `status --claude` and final scope semantics in the `1.1.3` stage.
  Verification of current product documentation is separate from this stage's requirements.
- Publishing is a manual step.

## Acceptance Criteria

1. `aps list --codex` and `aps list` produce identical `data` and the same accepted Codex route.
2. `aps list --claude --codex` fails with `INVALID_ARGUMENT` and names both flags.
3. `aps config compact --codex` fails with `INVALID_ARGUMENT`, and `config compact --claude` is
   unaffected.
4. Every executed command's `--json` success carries a non-null `target`, and it is `"claude"` when
   `--claude` selected the Claude path. Shared-command `"codex"` values are legacy routing tags.
   Informational help/version contexts that execute no command retain `target: null`.
5. Every `--json` failure carries `target`; it is `null` for a parse failure and for an unrecognized
   command. Rejected target scopes/conflicts also carry `target: null`; file-read failures after
   accepted routing retain the route.
6. A Claude command's `--json` payload still contains `data.target === "claude"`, unchanged.
7. `aps doctor --claude` is still refused with `INVALID_ARGUMENT` naming the Claude-capable set, and
   the refusal is unchanged from `1.1.0`.
8. `--codex` is position-independent: `aps --codex add p --from-file f` and
   `aps add p --from-file f --codex` parse identically.
9. `aps --help` lists `--codex` and the envelope's `target` field.
10. `npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
