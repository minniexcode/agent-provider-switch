# agent-provider-switch v1.1.2 PRD

## Summary

`1.1.2` gives the CLI **one error vocabulary**. Today the same condition has different error codes
depending on which target it happened against: a provider that is not in the registry is
`PROVIDER_NOT_FOUND` on the Codex side and `CLAUDE_PROVIDER_NOT_FOUND` on the Claude side, and the
registry file being absent is `PROVIDERS_NOT_FOUND` versus `CLAUDE_PROVIDERS_NOT_FOUND`. A script
that branches on `error.code` therefore has to know which line it called before it can name the
failure it is handling — which is exactly the coupling `1.1.1` removed by putting `target` in the
envelope.

This release also removes `data.target`, the per-service duplicate of the envelope field that
`1.1.1` left in place for one release. Both changes are the same change: information the envelope
now carries once stops being encoded a second time in the payload.

**This is the one release on the `1.x` line that breaks the `--json` contract.** `1.0.0` was allowed
to break the interface because it was the rename; `1.1.x` is otherwise additive throughout. The
break here is deliberate, singular, and declared: three codes are merged, one is renamed, one is
deleted, and `data.target` is removed. Nothing else in any payload moves.

Design detail: `docs/Design/agent-provider-switch-v1.1.2-design.md`. This release closes no roadmap
finding.

## Version

- Version line: `1.1.2`
- Predecessor: `1.1.1`
- Status: **planned.** The one deliberate `--json` contract break on the `1.x` line.

## Goals

- **The same condition has the same code.** Whether a missing provider is Codex or Claude, the code
  is `PROVIDER_NOT_FOUND`.
- **A code names a condition, not a target.** The envelope's `target` answers "which target"; a code
  prefix that answered it too was a second, weaker answer.
- **One declared break, not a drip.** Every affected code and field changes in this release, so a
  consumer migrates once.
- **No code is invented.** Every merged code already exists on the Codex side. The union shrinks by
  four entries and gains none.
- **Dead vocabulary is deleted, not carried.** One declared code has no producer at all.

## Non-Goals

- **No deprecation window.** The old codes are not emitted alongside the new ones and no
  `legacyCode` field is added. A transitional field would have to be removed later, and the cost of
  carrying it is paid by every consumer that never read the old codes in the first place. This is a
  local, single-user tool whose `--json` contract has one documented consumer in the repository's own
  test suite.
- **No rename of the `PROVIDER_NOT_FOUND` / `PROVIDERS_NOT_FOUND` pair.** The two differ by one
  character and describe adjacent conditions, which is a standing hazard. Fixing it means renaming
  a code that has been stable since `0.1.0` and is asserted across the suite, so it is recorded here
  as accepted rather than fixed. See the design's residual risks.
- **No exit-code taxonomy.** Failures keep exiting `1`. The `0.3.x` roadmap rejected a taxonomy for
  lack of a consumer and nothing has changed.
- **No change to doctor's issue codes.** `issues[].code` is a separate string space (`MODEL_MISSING`,
  `LOCK_STALE`, `CODEX_NOT_INSTALLED`) carried inside a successful result rather than in `error`.
  It overlaps the error vocabulary by name in one place and does not share its rules. Its target
  dimension is `1.1.3`.
- **No behaviour change.** Every refusal and every success is the same refusal and the same success.
  Only the name of the code and the presence of one duplicated field change.

## The Rename Map

| `1.1.1` | `1.1.2` | Why |
|---|---|---|
| `CLAUDE_PROVIDER_NOT_FOUND` | `PROVIDER_NOT_FOUND` | The Codex code for the same condition. Merged. |
| `CLAUDE_PROVIDERS_NOT_FOUND` | `PROVIDERS_NOT_FOUND` | The Codex code for "the registry file is absent / no providers are registered". Merged. |
| `CLAUDE_PROVIDERS_PARSE_ERROR` | `PROVIDERS_PARSE_ERROR` | The Codex code for an unparsable registry. Merged. |
| `CLAUDE_PROVIDER_ALREADY_EXISTS` | `PROVIDER_ALREADY_EXISTS` | **Renamed, not merged.** It means a *record* with that name exists; `PROVIDERS_ALREADY_EXISTS` means the registry *file* exists and is raised by `init` and `import`. Merging them would have made one code mean two things. |
| `CLAUDE_SETTINGS_NOT_FOUND` | *deleted* | One producer: none. The code is declared and never thrown, so nothing can observe the deletion. |

The Claude-capable commands keep their own refusal messages — a missing Claude provider still says
"Claude provider "x" was not found" — because the message describes the state and the code names the
condition. That split is what lets two targets share a code without sharing a sentence.

## `data.target` Is Removed

Every Claude service writes `target: "claude"` into its own `data`. `1.1.1` added `target` to the
envelope and stopped the renderer from reading the payload copy, which left the field with no
consumer inside the repository. This release removes it.

The field is replaced exactly:

| Before | After |
|---|---|
| `data.target` | `target` (envelope, top level) — added in `1.1.1`, present for both targets |

A Claude success payload loses one field; a Codex payload is unchanged, because Codex never set it.
The human renderer is unaffected: `1.1.1` already moved it to branching on the resolved target.

**It is in this release, not the previous one, on purpose.** `1.1.1`'s stated property is that no
`data` payload changes, and grouping this with the error-code merge means a consumer migrating for
one reason finds everything that moved in the same release note.

## Behaviour By Command

No command behaves differently. The table records which failures change code, so the surface of the
break is legible in one place.

| Command | Failure | `1.1.1` code | `1.1.2` code |
|---|---|---|---|
| `switch --claude`, `remove --claude`, `show --claude` | named provider absent | `CLAUDE_PROVIDER_NOT_FOUND` | `PROVIDER_NOT_FOUND` |
| `add --claude` | provider name already taken | `CLAUDE_PROVIDER_ALREADY_EXISTS` | `PROVIDER_ALREADY_EXISTS` |
| `add --claude` (interactive), `list --claude`, `current --claude` | no Claude providers registered | `CLAUDE_PROVIDERS_NOT_FOUND` | `PROVIDERS_NOT_FOUND` |
| any `--claude` read | `claude-providers.json` is not valid JSON | `CLAUDE_PROVIDERS_PARSE_ERROR` | `PROVIDERS_PARSE_ERROR` |
| every `--claude` success | — | `data.target: "claude"` | *removed* |

## Release Mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.2`.
- `tests/release-contract.spec.js` takes `1.1.2`, and the PRD/Design existence window slides to
  `1.1.2 → 1.0.0`.
- `CHANGELOG.md` gains a `1.1.2` entry that opens with the break, names all five code changes and
  the removed field, and states the migration in one line: read `target` from the envelope instead
  of from `data` or from a code prefix.
- `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, and `docs/Tests/testing.md` carry
  the new version, and `docs/cli-usage.md`'s JSON Contract section lists the error codes it
  documents without a target prefix.
- Publishing is a manual step.

## Acceptance Criteria

1. No string matching `/CLAUDE_[A-Z_]+/` remains anywhere in `src/`; the four surviving names are
   absent from the source, the registry, and the help text.
2. `aps switch --claude <absent> --json` fails with `error.code === "PROVIDER_NOT_FOUND"` and a
   message naming the provider; the same command without `--claude` produces the same code.
3. `aps add --claude <duplicate> --json` fails with `PROVIDER_ALREADY_EXISTS`; `aps init` against an
   existing `providers.json` still fails with `PROVIDERS_ALREADY_EXISTS`, and the two are asserted
   as distinct.
4. `aps list --claude --json` with no `claude-providers.json` fails with `PROVIDERS_NOT_FOUND`;
   a malformed file fails with `PROVIDERS_PARSE_ERROR`.
5. A Claude `--json` success payload contains no `data.target`; the envelope's `target` is
   `"claude"` and is the only place the target appears.
6. Every Claude-capable command's success envelope satisfies
   `target === "claude" && data.target === undefined`.
7. `error.details` still names the file involved and still contains no secret value.
8. The exit code is `1` for every failure listed above, unchanged.
9. `npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
