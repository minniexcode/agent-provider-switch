# agent-provider-switch v0.4.0 PRD

## Summary

`0.4.0` is the first of two releases on the `0.3.x → 0.4.x` line of `@minniexcode/agent-provider-switch`. It is
the **foundation and CLI-contract** release: it adds no command, no storage format, and no recovery
path. It closes three Phase 2 items:

1. There is no CI, the test suite cannot run on a fresh clone, and three tests are red on the
   author's machine today.
2. Boolean flags are parsed as value-taking options, so `--force` and `--claude` swallow the token
   after them.
3. Unknown commands exit 0, and synchronous parse errors escape the JSON error envelope.

**No new commands.** One behaviour change is user-visible in scripts: an unrecognized command now
exits `1` instead of `0`.

The second release, `0.4.1`, carries the two stateful P0 items (stale-lock recovery, backup
retention). It is deliberately sequenced after this one: the lock work needs a deterministic crash
fixture and a harness whose teardown does not delete the directory under test, and both of those are
built here.

Source of record for the findings: `docs/agent-provider-switch-2.x-roadmap.md` §2 — `P1-1` and `P1-2` (flag
parsing), `P1-3`, `P1-4`, `P1-5` (exit codes and the error envelope), `P1-9` (test portability).
Design detail: `docs/Design/agent-provider-switch-v0.4.0-design.md`.

## Version

- Version line: `0.4.0`
- Predecessor: `0.3.1`
- Status: **planned.** This document and its Design are the review artifacts; implementation begins
  only after they are approved. Nothing described here exists in the tree yet.

## Goals

- **Make the suite trustworthy before making more changes.** A test harness that mirrors the
  production dispatch ladder by hand, leaks temporary directories, and cannot observe an exit code
  will silently stop covering anything that is changed. This release fixes the harness first.
- **Parse boolean flags as booleans.** `--force`, `--claude`, `--merge`, `--overwrite`, and
  `--create-profile` must not consume the following token, and the normalization workaround that
  exists only to compensate for the current behaviour must be deleted.
- **Make failure visible to scripts.** An unrecognized command exits non-zero; a synchronous parse
  error produces the structured error envelope rather than a stack trace.
- **Run the suite where it is checked out.** CI on Windows and Linux, a fixture the tests build
  themselves, no leaked temporary directories, and runtime coverage for the `--claude` half of the
  CLI.

## Non-Goals

`0.4.0` does not implement:

- **Stale-lock recovery or backup retention.** Both are P0 and both are `0.4.1`. They are excluded
  here because they are stateful: they change a recovery path, and one of them can produce two
  concurrent writers. They land on the harness this release proves out, not alongside it.
- **An exit-code taxonomy.** Only success-vs-failure is corrected. No `2` for usage errors, no code
  map. There is no consumer for one.
- **Deletion of the dead code.** `src/infra/` (8 files), the 5 dead `src/cli/` shims, the dead
  exports, and the Copilot-era remnants are Phase 3. `0.4.0` leaves them in place so the diff stays
  reviewable.
- **Any change to `engines.node`.** It advertises `>=18` while the sole runtime dependency requires
  `>=20.12`. Correcting that is a packaging change (Phase 3). CI does **not** test Node 18, so green
  CI must not be read as "the advertised floor is supported".
- **Dead-code-driven refactors of the parser.** The fix is scoped to boolean flags and the
  command-resolution order it depends on. `--codex-dir` consuming `--json` as a path, and
  `--version` matching anywhere in `argv`, are recorded but not changed.
- **A redesigned help/flag model.** Making `--help` and `--version` symmetric is required only to
  the extent the exit-code rule depends on it; the wider inconsistency is P2-7.
- **TOML parser work** (Phase 4) and **any generic target abstraction** — the latter remains a
  written non-goal from the `0.3.0` PRD.
- **Windows ACL remediation.** Unchanged from `0.3.1`: the exposure there is at the ACL layer and is
  left to the operator.
- **Unification of the Codex and Claude `show` JSON contracts.** Codex `show --json` keeps emitting
  the full `apiKey`; it is a documented automation contract.

## Command Surface

**New:** none.

**Changed:**

- `--claude`, `--force`, `--merge`, `--overwrite`, `--create-profile` become true boolean flags, and
  `--claude` becomes position-independent.
- Unknown command: exit `1` with a structured error instead of exit `0` with help.
- `status`: the tool-home root is now actually reported in both human and JSON output.
- `resolveClaudeProviderName()` is deleted; provider names arrive as positionals for both targets.

**Unchanged:** the command set, the JSON envelope shape, the secret-handling contract from `0.3.1`,
the file-permission model, rollback containment, and every write path.

## Boolean Flag Parsing

The parser treats any `--x` followed by a non-`--` token as `--x <value>`, so `aps remove --force
packycode` leaves no provider name and falls through to a prompt or an error. The
`resolveClaudeProviderName()` helper exists only to dig a provider name back out of the `--claude`
flag value, and its own comment says so.

- The five boolean flags are recognized as booleans wherever they appear, including before the
  command name.
- `--claude` becomes position-independent. `aps add --claude copilot --from-file x` yields
  `copilot` as a positional, and `aps remove --claude --force <name>` — which does not work today
  — works.
- The parser fix and the deletion of `resolveClaudeProviderName()` ship in one commit; the helper is
  only deletable once names land as positionals.
- `getSingleOption()`'s `required` parameter, which has never had an effect, is deleted rather than
  made to throw. `aps add` with no flags relies on receiving an empty value in order to prompt,
  and that is the documented interactive form.
- `--reveal` stays a global flag. It is already stripped before the command-option pass, so listing
  it among the boolean flags would change nothing.

**Acceptance:** `aps remove --force <name>` and `aps remove --claude --force <name>` both
resolve the provider name for both targets. `resolveClaudeProviderName` no longer exists.

## Exit Codes and the Error Envelope

- An unrecognized command exits `1` with `INVALID_ARGUMENT` through the standard envelope, in both
  human and `--json` output.
- `aps`, `aps --help`, `aps -h`, `aps --version`, and a recognized command group with no
  subcommand continue to exit `0`.
- `main()`'s synchronous section is wrapped so a parse error produces the envelope. Because a thrown
  parse error leaves no parsed options, `--json` is honored for that case too.
- `status` reports the tool-home root, which it has always documented but never populated.

The discriminator between "no command" and "wrong command" does not exist today — the parser discards
the first token when it resolves nothing — so this goal is a parser change, not a `cli.ts` change.

**Acceptance:** `aps lst` exits 1 and produces a structured error; `aps --help` exits 0;
`aps --json --codex-dir` exits 1 with a JSON envelope, not a stack trace; `aps status` prints a
non-empty tool home.

## CI and Test Portability

- A GitHub Actions workflow runs install, type-check, and the suite on Windows and Linux, on Node 20
  and 22.
- The three tests that depend on a gitignored fixture directory are rewritten to build the fixture
  themselves, so a fresh clone is green.
- Temporary directories created by the harness are tracked and removed, including on failure.
- A new spec covers the Claude workflow end to end: add, switch, list, current, show, remove.
- The production dispatch ladder is extracted so the harness calls it instead of re-implementing it,
  and a test asserts the real process exit code — which the current harness cannot observe, because
  it calls the built modules in-process.

**Acceptance:** `git clean -xdf && npm ci && npm test` passes on Windows and Linux, with no leftover
temporary directories.

## Release Mechanics

`0.4.0` does not ship correctly without these steps, and the release contract test enforces several
of them:

- `package.json` and both `package-lock.json` version fields.
- `docs/PRD/agent-provider-switch-prd-v0.4.0.md` and `docs/Design/agent-provider-switch-v0.4.0-design.md` exist, which
  the release contract asserts for the current line.
- `tests/release-contract.spec.js` version assertions and its version regex.
- `CHANGELOG.md` entry.
- Version strings in `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, and
  `docs/Tests/testing.md`, plus the command lists and the new flags in each.

## Acceptance Criteria

**Flags**

- `aps remove --force <name>` and `aps remove --claude --force <name>` both resolve the name.
- `aps add --claude <name> --from-file <path>` resolves the name as a positional.
- `aps --claude list` resolves as a normal invocation.
- `resolveClaudeProviderName` no longer exists.

**Exit codes**

- `aps lst` exits 1 with a structured error.
- `aps --help`, `aps -h`, `aps --version`, and `aps` exit 0.
- `aps --json --codex-dir` exits 1 with a JSON envelope.
- `aps status` prints a non-empty tool home in human and JSON output.

**Build and test**

- `npx tsc --noEmit` passes.
- `git clean -xdf && npm ci && npm test` passes on Windows and Linux, Node 20 and 22.
- The new Claude workflow spec covers add, switch, list, current, show, and remove.
- A test observes the real process exit code of the built CLI.
- No temporary directories remain after a suite run.
- `npm run build` passes without errors.
