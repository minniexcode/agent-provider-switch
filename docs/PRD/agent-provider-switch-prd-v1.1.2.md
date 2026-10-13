# agent-provider-switch v1.1.2 PRD

## Summary

`1.1.2` gives command failures one error vocabulary. A condition has the same code on Codex and
Claude, while the envelope identifies the target. It also removes the duplicated Claude
`data.target` introduced before the envelope acquired that information.

These are declared breaking changes. The CLI is used by its author and has no public compatibility
obligation: no deprecated aliases, dual codes, or `legacyCode` field are required. This release
does not promise to be the only breaking release; `1.1.3` deliberately changes scope and reporting.

Design: [v1.1.2 Design](../Design/agent-provider-switch-v1.1.2-design.md).
This release closes no roadmap finding.

## Version and boundaries

- Version: `1.1.2`; predecessor: `1.1.1`.
- Status: **error-contract specification**. The reviewed requirements below are normative;
  verification of the current implementation is recorded separately in the review.
- Target resolver/envelope foundation belongs to `1.1.1`; final command scope, diagnostics,
  identity matching, and backup reporting belong to `1.1.3`.
- This release changes failure codes and removes one payload field. It preserves which workflows
  succeed or refuse, including target-specific differences.

## Goals

- A missing named provider, a missing required collection, a duplicate name, or invalid registry
  content has a target-neutral code.
- Messages can name the target, provider, and involved path. Details must preserve existing secret
  protections.
- Retire the five old error members and their producers; add `PROVIDER_ALREADY_EXISTS`.
- Remove Claude `data.target`; render and route using the accepted target in the execution context.

## Non-goals

- No exit-code taxonomy: command failures remain exit `1`; successful reports remain exit `0`.
- No unification of success/refusal policy or target-specific workflows. A command that legitimately
  handles an absent registry without failing must continue to do so.
- No renaming of environment variables, identifiers, or diagnostic issue/note codes.
  Diagnostic findings inside successful reports are a separate namespace from `error.code`.
- No cleanup of unrelated error names, such as the existing export-output refusal using
  `INVALID_IMPORT_FILE`. The same-condition requirement here applies to failures across targets.

## Error migration

| Removed 1.1.1 member | 1.1.2 replacement | Condition |
|---|---|---|
| `CLAUDE_PROVIDER_NOT_FOUND` | Existing `PROVIDER_NOT_FOUND` | Specified provider is absent |
| `CLAUDE_PROVIDERS_NOT_FOUND` | Existing `PROVIDERS_NOT_FOUND` | Required registry/collection is absent or empty |
| `CLAUDE_PROVIDERS_PARSE_ERROR` | Existing `PROVIDERS_PARSE_ERROR` | Registry JSON or structural shape is invalid |
| `CLAUDE_PROVIDER_ALREADY_EXISTS` | New `PROVIDER_ALREADY_EXISTS` | A provider name is already taken |
| `CLAUDE_SETTINGS_NOT_FOUND` | Deleted | No command-error producer exists |

The union removes five members and adds one: **net minus four**. The first three replacements
already exist; only `PROVIDER_ALREADY_EXISTS` is a new member. Codex duplicate-add producers also
move from `INVALID_IMPORT_FILE` to that member.

`PROVIDERS_ALREADY_EXISTS` remains distinct. It means an existing nonempty registry prevents a
migration strategy, rather than a provider name being taken. A concrete refusal is
`aps migrate` over a nonempty registry without `--merge` or `--overwrite`; setup can encounter the
same strategy refusal. It is not the result of repeated `init` or ordinary `import`.

## Condition and workflow matrix

The code matrix applies **when a command refuses for that condition**. It does not require every
query to refuse merely because a registry is absent.

| Refusal condition | Codex code | Claude code |
|---|---|---|
| Specified provider absent from a readable registry | `PROVIDER_NOT_FOUND` | `PROVIDER_NOT_FOUND` |
| Required registry absent or required selection collection empty | `PROVIDERS_NOT_FOUND` | `PROVIDERS_NOT_FOUND` |
| Duplicate provider name | `PROVIDER_ALREADY_EXISTS` | `PROVIDER_ALREADY_EXISTS` |
| Registry JSON or structural shape invalid | `PROVIDERS_PARSE_ERROR` | `PROVIDERS_PARSE_ERROR` |

Interactive provider selection from an empty collection uses the plural `PROVIDERS_NOT_FOUND`
on both targets. A request for a particular name in an otherwise readable registry uses the singular
`PROVIDER_NOT_FOUND`.

| Command/state | Required behavior |
|---|---|
| `list --claude`, registry missing | Successful empty provider list |
| `current --claude`, registry missing | Successful no-settings or unmanaged result, according to live settings |
| `list --claude`, malformed registry | Failure with `PROVIDERS_PARSE_ERROR` |
| `init`, registry already exists | Idempotent success |
| `import`, registry already exists | Existing replacement or explicit merge workflow |
| `migrate`, nonempty registry, no merge/overwrite | Failure with `PROVIDERS_ALREADY_EXISTS` |

These differences are intentional. Same-condition failure codes do not imply the same set of
commands, prompts, or management states for each target.

## Payload contract

Claude success results no longer contain the per-service `data.target`. The envelope's `target`
is its replacement, using the `1.1.1` accepted-routing contract until `1.1.3` introduces final scope.
Other success data fields remain intact for this stage. Human output uses the execution context and
does not depend on the removed field.

Update producers and the `ErrorCode` union directly. Do not retain the old vocabulary behind a
renderer translation layer.

## Release mechanics

Synchronize package and lockfile versions, release-contract assertions, CHANGELOG, README variants,
CLI usage, and testing documentation under the repository release checklist. The CHANGELOG must
lead with the migration table, the Codex duplicate-name correction, and removal of `data.target`.
Keep existing historical PRD/Design existence assertions. Publishing is a separate manual step.

## Acceptance criteria

1. None of the five retired names is an `ErrorCode` member or emitted command error. Checks inspect
   the error namespace and its producers; they do not ban all `CLAUDE_*` strings.
2. Both targets reject a missing named provider with `PROVIDER_NOT_FOUND` and duplicate addition
   with `PROVIDER_ALREADY_EXISTS`.
3. Empty interactive selection and genuinely required missing registries use
   `PROVIDERS_NOT_FOUND` consistently; malformed JSON and registry shape use
   `PROVIDERS_PARSE_ERROR`.
4. `list --claude` without a registry succeeds with an empty list. `current --claude` without one
   reports no-settings or unmanaged as appropriate. No artificial failure is added for symmetry.
5. Repeated `init` succeeds. Existing-registry `import` retains replacement/merge behavior.
   `migrate` without a strategy over a nonempty registry fails with `PROVIDERS_ALREADY_EXISTS`,
   distinct from the duplicate-provider code.
6. Every Claude success removes only the old routing `data.target`; envelope routing remains
   correct, including on post-resolution execution failures.
7. Target-specific messages and safe error details remain useful; failures exit `1`.
8. Build, type checking, in-process tests, and E2E tests pass after updating affected assertions.
   Existing tests must be corrected where the contract deliberately changes.
