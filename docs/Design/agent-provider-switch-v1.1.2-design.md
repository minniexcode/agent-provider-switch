# agent-provider-switch v1.1.2 Design Document

This design implements [the v1.1.2 PRD](../PRD/agent-provider-switch-prd-v1.1.2.md): one command-error
vocabulary and removal of duplicated Claude payload routing. These are deliberate breaking changes,
without a compatibility window. Later scope changes in `1.1.3` are also breaking.

The design specifies the required result; it does not certify that every requirement is already
implemented. Current verification belongs in the [review record](../Reviews/agent-provider-switch-1.1.x-prd-review.md).

## 1. Change the union and the producers together

`src/domain/errors.ts` loses five old members:

| Retired member | Producer replacement |
|---|---|
| `CLAUDE_PROVIDER_NOT_FOUND` | `PROVIDER_NOT_FOUND` |
| `CLAUDE_PROVIDERS_NOT_FOUND` | `PROVIDERS_NOT_FOUND` |
| `CLAUDE_PROVIDERS_PARSE_ERROR` | `PROVIDERS_PARSE_ERROR` |
| `CLAUDE_PROVIDER_ALREADY_EXISTS` | `PROVIDER_ALREADY_EXISTS` |
| `CLAUDE_SETTINGS_NOT_FOUND` | None; no command-error producer |

Only `PROVIDER_ALREADY_EXISTS` is added to the union: five removed, one added, net minus four.
Codex `add-provider.ts` must use it for duplicate names as well as Claude `claude-add-provider.ts`.

Change `cliError()` call sites and any required-file reader error arguments directly. The renderer
and `normalizeError()` must not translate old names to new ones; aliases would leave two producer
vocabularies type-correct.

Messages retain target-specific context. Error details do not gain a duplicate target field; the
envelope already carries accepted routing.

## 2. Audit actual failure conditions

The rename table alone cannot establish symmetry. Audit callable workflows and assert:

| Failure condition | Code for either target |
|---|---|
| Specified provider absent | `PROVIDER_NOT_FOUND` |
| Required registry absent / required collection empty | `PROVIDERS_NOT_FOUND` |
| Duplicate name | `PROVIDER_ALREADY_EXISTS` |
| Registry JSON or structural shape invalid | `PROVIDERS_PARSE_ERROR` |

Codex and Claude interactive selectors use the plural collection code for no candidates. Avoid
changing list/current success behavior to manufacture a failure covered by the table.

`PROVIDERS_ALREADY_EXISTS` remains the migration-strategy refusal for a nonempty registry.
Its reachable paths include `migrate` dispatch and setup strategy handling. Repeated `init`
succeeds, and `import` replaces or explicitly merges; neither is a valid test producer for this
code.

Error symmetry does not generalize target-specific record formats, mutation flows, or prompts.
Validation errors concerning different input types remain governed by their existing contracts.

## 3. Remove Claude payload routing

Remove the literal `target: "claude"` from the seven Claude app-service result payloads.
The renderer already receives the resolved target through its context from `1.1.1`.
Codex data had no corresponding field.

Assert envelope routing for successful and failed Claude dispatch. The payload removal does not
change the route; `1.1.3` subsequently makes accepted command scope authoritative and expands
reporting payloads.

## 4. Enforce the correct namespace

Tests must inspect the `ErrorCode` union and error-producing positions, or execute real producers.
A source-wide `/CLAUDE_[A-Z_]+/` check is invalid. Even a check for every quoted Claude-prefixed string
is too broad: diagnostic issue codes can use that prefix legitimately.

Environment variables such as `APS_CLAUDE_DIR`, identifiers such as `CLAUDE_COMMANDS`, and issue
codes inside successful reports are separate namespaces. A diagnostic issue sharing a retired
error's spelling is not the retired command error returning.

A producer census can guard against newly unused members. It must document the actual existing
exceptions rather than claiming every union member is thrown. At review time the recorded
unproduced members were `LIVE_STATE_DRIFT`, `AUTH_JSON_SYNC_FAILED`,
`ACTIVE_PROVIDER_UNRESOLVED`, `UNMANAGED_ACTIVE_PROFILE`, and `PROVIDER_BASE_URL_MISMATCH`.
This release does not delete them or unify error and diagnostic namespaces.

## 5. Verification and release

Use real producer cases for missing name, empty selection, duplicate name, malformed registry,
and migration refusal. Include successful empty Claude list, unmanaged/no-settings current,
idempotent init, and import replacement/merge as regression cases.

Update `tests/error-vocabulary.spec.js` and affected error assertions. E2E coverage verifies
the JSON error stream, exit `1`, and useful human output for the changed codes. Preserve secret
redaction; no real credentials are needed.

Run the repository build, type check, in-process suite, and E2E suite. Tests asserting deliberate
old behavior must change with the contract. Follow the synchronized release checklist and publish
manually. The CHANGELOG must state the full migration rather than imply this is the final breaking
release on the line.
