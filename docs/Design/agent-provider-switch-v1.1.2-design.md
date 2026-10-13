# agent-provider-switch v1.1.2 Design Document

**One error vocabulary.** The one deliberate `--json` contract break on the `1.x` line. It changes
five names in the `ErrorCode` union and removes one duplicated payload field. No behaviour changes:
every refusal is still the same refusal, with a different code string.

Its companions are `docs/Design/agent-provider-switch-v1.1.1-design.md` (the target becomes
explicit) and `docs/Design/agent-provider-switch-v1.1.3-design.md` (shared-state commands report
both targets). This release is only expressible because `1.1.1` put `target` on the envelope first.

**Citation convention.** This document names symbols rather than line numbers.

This release closes no roadmap finding.

## Overview

Two decisions shape everything else.

**The codes are renamed at their producers, not translated at the boundary.** A mapping layer in the
renderer would keep both vocabularies alive and leave the `ErrorCode` union unable to enforce
anything. Roughly nine `cliError()` call sites change their literal, and after that there is one
vocabulary in the repository and a test that says so.

**The prefix goes because a better carrier exists, not because prefixes are bad.** `target` already
answers "which target" on every envelope, on success and on failure. A code prefix was the same
information, encoded worse: it could only be read by string matching, it was absent for Codex, and
it forced the *condition* to be renamed whenever the *target* was.

## 1. The renamed set

The `ErrorCode` union loses four entries and gains one. The net is minus three.

| Removed | Added | Producer sites |
|---|---|---|
| `CLAUDE_PROVIDER_NOT_FOUND` | `PROVIDER_NOT_FOUND` | 5 |
| `CLAUDE_PROVIDERS_NOT_FOUND` | `PROVIDERS_NOT_FOUND` | 2 |
| `CLAUDE_PROVIDERS_PARSE_ERROR` | `PROVIDERS_PARSE_ERROR` | 1 |
| `CLAUDE_PROVIDER_ALREADY_EXISTS` | `PROVIDER_ALREADY_EXISTS` | 1 |
| `CLAUDE_SETTINGS_NOT_FOUND` | — | 0 |

`CLAUDE_PROVIDER_ALREADY_EXISTS` is **not** merged into `PROVIDERS_ALREADY_EXISTS`, and the
one-character difference between the result and that neighbour is the reason to look closely at it.
`PROVIDERS_ALREADY_EXISTS` is raised by `init` and by `import` when the registry **file** already
exists; `CLAUDE_PROVIDER_ALREADY_EXISTS` is raised by `add` when a **record** with that provider name
already exists. They are different conditions that happened to sound alike. Merging them would have
made one code mean "a file exists" and "a name is taken", and a consumer could not tell which. The
singular form is the new name: `PROVIDER_ALREADY_EXISTS`.

`CLAUDE_SETTINGS_NOT_FOUND` has no producer. It is declared in the union and thrown nowhere, so its
deletion has no observability: no test can go red, no user can notice. It is removed as dead
vocabulary, and a test asserts the union has no code without a producer (see §4).

**The messages do not change.** The Claude producers keep saying "Claude provider "x" was not
found.", because that sentence describes the state, and the code names the condition. Two targets
sharing a code while keeping their own sentences is the split that makes the merge worth doing;
collapsing the sentences too would make a Claude failure read as a Codex one.

## 2. Removing `data.target`

Seven `src/app/claude-*.ts` services write `target: "claude"` into their `data`. Every one is
deleted, and the envelope's `target` — added in `1.1.1`, written centrally by `renderSuccess()` and
`renderFailure()` from `ctx.target` — is the replacement.

Nothing else reads it. `1.1.1` moved the human renderer off `data.target` and onto the resolved
target, so this release deletes a field that already has no reader. That sequencing is the whole
point of splitting the two releases: at the moment of deletion, the field is provably unused inside
the repository, and the only thing that can observe its absence is an external `--json` consumer.

**A spec pins the equality before the deletion.** `1.1.1` asserts that for every Claude-capable
command `data.target === ctx.target`. With that asserted, removing the field cannot change what
`target` resolves to, and this release's contract break is exactly one field wide rather than "we
believe nothing else read it".

## 3. Where the codes come from

**No translation layer.** `normalizeError()` keeps its current shape: it passes a thrown
`CliErrorShape` through and falls back to `INVALID_ARGUMENT`. It does not map old codes to new ones,
because a normalization that rewrote codes would be the only place the two vocabularies knew about
each other, and the union's type check would no longer reach the producers.

**No aliases in the union.** The four removed names are gone from the type, not deprecated in it.
Keeping them as `never`-produced members would let a future caller use one and type-check.

**`error.details` is untouched.** The payloads already carry the file involved and, for a missing
provider, the provider name. `target` is not added to `details`: the envelope has it, and a second
copy is the mistake this release exists to stop repeating.

## 4. Enforcement

- **`src/` contains no target-prefixed error code.** A spec greps every `.ts` file under `src/` for
  `/CLAUDE_[A-Z_]+/` and asserts no match. This is the same shape as the `1.0.0` rename's
  negative-assertion test, and it is what keeps a future contributor from introducing
  `CLAUDE_SOMETHING_NOT_FOUND` out of habit.
- **Every declared code has a producer.** A spec collects the string literals passed to `cliError()`
  and to `readRequiredFile()`'s code parameter, and asserts every other member of `ErrorCode` is
  produced somewhere. One code is excepted by name: `DESTRUCTIVE_REMOVE_BLOCKED` is only ever
  rendered and never produced, which the `0.3.x` roadmap already records as a known pre-existing
  wart. The test lists it as an exception rather than silently allowing it, so the exception is
  visible and removing the code later fails the test in the useful direction.
- **The two similar codes stay distinct.** A spec asserts `aps add --claude <duplicate>` yields
  `PROVIDER_ALREADY_EXISTS` and `aps init` over an existing registry yields `PROVIDERS_ALREADY_EXISTS`,
  so a later "cleanup" that merges the pair is caught.

## 5. Residual risks

- **`PROVIDER_NOT_FOUND` and `PROVIDERS_NOT_FOUND` differ by one character.** This is a
  pre-existing hazard that this release makes marginally more visible, because the Claude vocabulary
  no longer offers a contrast that reminds a reader the pair exists. Renaming either is a break of
  the same class as this one, so doing both at once was considered and rejected: a consumer
  migrating `CLAUDE_*` should not also have to migrate a code that has been stable since `0.1.0`.
  Accepted, and recorded here rather than fixed.
- **The error vocabulary and doctor's issue vocabulary overlap by name.** `run-doctor` emits an issue
  whose `code` is the string `"PROVIDERS_NOT_FOUND"`, and `renderDoctorIssueNextStep()` switches on
  `"CONFIG_NOT_FOUND"` and `"PROVIDERS_NOT_FOUND"`. Those are issue codes inside a successful
  result, not error codes, and they are not type-checked against the union. Unifying the two spaces
  is not proposed: an issue is a finding on a successful run and an error is a failed run, and
  conflating them would make `healthy: false` indistinguishable from a crash. `1.1.3` adds `target`
  to each issue, which is the dimension the issue space actually needed.
- **An external consumer of the old codes breaks silently.** There is no deprecation window and no
  `legacyCode`. The mitigation is documentation: the CHANGELOG entry leads with the break, and
  `docs/cli-usage.md` states that the envelope's `target` is the supported way to tell the two lines
  apart. The repository's own `--json` consumers are its tests, and they are updated in the same
  commit.
- **A stale `dist/` reads as a passing suite.** `runBuiltCli()` calls the built output, so running
  the new specs without `npm run build` tests the old vocabulary. The runner builds first; a
  contributor who invokes a spec directly does not. Unchanged from every prior release.

## 6. Release mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.2`; `src/` has no version
  constant to edit.
- `tests/release-contract.spec.js` takes `1.1.2`, gains `1.1.2` in the version regex, and slides the
  PRD/Design existence window to `["1.1.2", "1.1.1", "1.1.0", "1.0.0", "0.4.1"]`.
- `CHANGELOG.md` gains a `1.1.2` entry. It is the only entry on the `1.x` line that opens with
  **Breaking**, and it carries the rename map so the migration is one table rather than a diff.
- New spec: `tests/error-vocabulary.spec.js` — the `src/` grep, the producer census, and the
  singular/plural distinction.
- `tests/e2e/claude.spec.js` carries four asserted codes, all of which change.
- `tests/e2e/errors.spec.js` and `tests/e2e/renderers.spec.js` carry the human and JSON assertions
  for the shared codes, which do not change but do gain a Claude-side twin worth asserting.
- `docs/cli-usage.md`: the JSON Contract section, the Claude workflow section, and Version section.
  `docs/agent-provider-switch-technical-architecture.md` gains the invariant "an error code names a
  condition and never a target".
- `README.md`, `README.CN.md`, `README.AI.md`, and `docs/Tests/testing.md` carry the version.
- Publishing is a manual step.

## 7. Acceptance criteria

See `docs/PRD/agent-provider-switch-prd-v1.1.2.md`. In short: no `CLAUDE_*` string survives in
`src/`; every declared code has a producer except the recorded `DESTRUCTIVE_REMOVE_BLOCKED`;
`PROVIDER_ALREADY_EXISTS` and `PROVIDERS_ALREADY_EXISTS` are asserted distinct; a Claude success
payload has no `data.target`; exit codes and messages are unchanged; and `npm run build`,
`npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
