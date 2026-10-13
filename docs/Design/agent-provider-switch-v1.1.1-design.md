# agent-provider-switch v1.1.1 Design Document

**The target becomes explicit.** Additive release on the `1.x` line, and the first of three on
`1.1.x`. No architecture change: both registries, the projection model, the merge rule, the lock
discipline, and the rollback containment are untouched. No command gains or loses a target.

Its companions are `docs/Design/agent-provider-switch-v1.1.2-design.md` (one error vocabulary) and
`docs/Design/agent-provider-switch-v1.1.3-design.md` (shared-state commands report both targets).
This is the release that makes those two expressible.

**Citation convention.** This document names symbols (`resolveTarget()`, `TargetId`) rather than line
numbers, because a citation that is wrong within one commit is worse than one that is vague.

This release closes no roadmap finding.

## Overview

Three decisions shape everything else.

**The value already exists three times; this release writes it down once.** `isClaudeCommand()`
returns it as a boolean, `data.target` carries it as a payload field nobody set centrally, and the
`claude-` operation prefix carries it as a string convention. The release introduces `TargetId` and
`resolveTarget()`, then points all three at them.

**`--codex` is accepted everywhere; `--claude` keeps its narrowness.** Naming the default must not
fail, so `--codex` has almost no refusal surface. `--claude` keeps exactly the refusal it has today,
because loosening it here would ship a `doctor` that half-works.

**Nothing is removed.** `data.target` stays for one release. The envelope gains a field; the payload
gains nothing and loses nothing.

## 1. `TargetId` and `resolveTarget()`

A new pure module, `src/domain/target.ts`:

```ts
export type TargetId = "codex" | "claude";
export const TARGET_IDS: readonly TargetId[];
export function resolveTarget(input: {
  command: CommandId | null;
  claudeRequested: boolean;
  codexRequested: boolean;
}): { target: TargetId | null } | { refusal: { code: "INVALID_ARGUMENT"; message: string } };
```

It is pure and takes no filesystem or parsed-options argument, so it can be unit-tested without a
tool home. `claudeRequested` / `codexRequested` are read from `commandOptions.has(...)`, which is
already how `hasFlag()` works.

**It does not consult `CLAUDE_COMMANDS`.** The capability set stays in `claude-handlers.ts`, where it
belongs: it answers "does this command have a Claude code path", which is a different question from
"which target did the caller name". `resolveTarget` answers only the second, and the flag guards
answer whether the two agree. Merging them would mean the capability table had to be edited to add a
target-aware command, which is exactly the coupling `1.1.3` has to untangle.

**A conflict is a refusal, not a precedence rule.** `--claude --codex` returns a refusal; the caller
raises it through `assertFlagsApply()`'s existing `INVALID_ARGUMENT` path. A hidden precedence
(`--claude` wins because it is more specific) would silently ignore a flag the user typed.

**`null` means "no command".** `resolveTarget` returns `{ target: null }` when `command` is null, and
that is a success, not a refusal: the parse-failure and unrecognized-command paths legitimately have
no command to describe.

## 2. `--codex` in the parser

`--codex` joins `BOOLEAN_FLAGS` in `src/commands/args.ts`, which is the set stripped by exact token
in the parser's first pass. That placement is what makes it position-independent and what stops the
greedy option pass from swallowing the token after it — the same reason `--claude` is there.

It does not join `GlobalOptions` as a field. `GlobalOptions` carries `json`, `reveal`, and
`codexDir`, which are values; `--claude` and `--codex` are booleans whose presence is already
recorded in `commandOptions` and read through `hasFlag()`. Adding mirrored boolean fields would
create a second source of truth for a fact that already has one, and the two would drift the first
time a call site read the wrong one. The target is resolved **once**, in dispatch, and lands on
`CommandExecutionContext.target` (§3).

## 3. Where the resolved target lives

`CommandExecutionContext` gains a required field:

```ts
target: TargetId | null;
```

Required with an explicit `null`, not optional. Every construction site is then a compile error
until it states its answer, which is the point: `cli.ts` builds three contexts by hand for the help,
version, and pre-dispatch failure paths, and a `target?: TargetId` would let all three silently
carry `undefined` into a payload that promises a definite value. This follows the repository's
existing convention for `restoreManifest()`'s allowlist and the Claude services' `defaults`
argument, where the parameter is required precisely so a new call site cannot forget it.

- `cli.ts`'s three pre-dispatch constructions pass `target: null`.
- `executeCommand` in `dispatch.ts` calls `resolveTarget()` once, after `assertFlagsApply()` has had
  its say, and assigns the result. It is the single funnel every command passes through, so there is
  exactly one call site — the same property that made it the right home for the legacy-home
  migration.

`resolveTarget()`'s refusal is thrown from `dispatch.ts`, not from `assertFlagsApply()`. The guard
table decides whether a single flag is *acceptable for a command*; whether two flags are
*compatible with each other* is a property of the pair, and putting it in the guard loop would mean
each entry had to know about the others.

## 4. The envelope field

`JsonEnvelope` gains `target: TargetId | null`, written by `renderSuccess()` and `renderFailure()`
from `ctx.target`. Both paths write it, which is what makes it reliable under `--json`: a consumer
reads the target once for a success and once for a failure instead of correlating `command` with an
error code.

The failure path matters more than the success path here. Today the only signal that a failed
`aps switch --claude` asked about Claude is that its code starts with `CLAUDE_`, which is exactly
the convention `1.1.2` deletes. The envelope field has to exist before the prefix can go.

### `data.target` is untouched, and now unused

The seven Claude services keep writing `target: "claude"` into their `data`, unchanged, so every
existing `--json` payload stays byte-identical. The one change is at the read site: the human
renderer stops reading it.

`renderHumanSuccess(command, data, warnings)` currently short-circuits on `data?.target === "claude"`
to reach the Claude view. It gains the resolved target as its first argument and branches on that
instead. The renderer was the only reader, so after this change `data.target` has no consumer inside
the repository — which is the honest state to be in before removing it in `1.1.2`, and is why its
removal there is a documentation change rather than a code change.

The Claude services keep setting it for one release on purpose. Removing it here would break a `data`
payload in a release whose stated property is that no `data` payload changes.

## 5. Flag guards

`src/commands/flag-guards.ts` gains a `--codex` entry and a conflict rule.

`FlagGuard` today is `{ flag, accepts, supportedCommands, requiresClaude }`. `--codex` fits none of
it cleanly: its `accepts` is "everything except `config compact`", and `requiresClaude` is the
opposite of what it needs. The table entry is:

| flag | accepts | supportedCommands | requiresClaude |
|---|---|---|---|
| `--claude` | unchanged (`supportsClaudeTarget`) | unchanged | `false` |
| `--codex` | every command id except `config-compact` | the same set | `false` |

**`config compact` is refused `--codex`** by the same guard mechanism, with a message naming that
there is no Codex form. This is unchanged behaviour — `aps config compact` is already refused today
— but it now arrives from the guard table rather than from the `ctx.command === "config-compact"`
branch in `handleRegisteredCommand`. That branch stays for the bare case; the guard covers the case
where the user named Codex explicitly.

**The pair rule runs after the loop.** Once each flag has been judged acceptable on its own,
`assertFlagsApply()` refuses `--claude --codex` together. Placed inside the loop, the check would run
once per guard entry and would report the conflict on whichever flag the table happened to list
second.

**`--codex` does not make `--claude` acceptable on a command that lacks a Claude path.** `aps
doctor --codex --claude` is a conflict and is refused as one; `aps doctor --claude` is refused as it
is today. The two refusals are distinct and separately asserted, because they will diverge in
`1.1.3`: `doctor --claude` becomes valid while `doctor --codex --claude` stays a conflict forever.

## 6. Help and registry metadata

- `booleanFlags` on the seven Claude-capable definitions grows from `["--claude"]` to
  `["--claude", "--codex"]`, and the Codex-capable ones gain `["--codex"]`. The field is help
  metadata a test validates against the parser's actual set, so `--codex` being absent from a
  definition is a test failure rather than a silent documentation gap.
- Usage strings gain `[--codex]` on the commands that accept it. `backups prune`, `rollback`, and
  `unlock` do **not** gain it: they are the shared-state commands whose flags `1.1.3` will refuse,
  and advertising `--codex` on them for one release would be advertising a flag about to be removed.
  The guard still accepts it there in `1.1.1` — a documented, temporary asymmetry, recorded here so
  it does not read as an oversight.
- The top-level help's "Global options" block gains `--codex` next to `--claude`, with the sentence
  that it names the default and changes nothing on its own.

## 7. Residual risks

- **`--codex` is accepted on `backups prune`, `rollback`, and `unlock`, where it means nothing.**
  `1.1.3` refuses it there. For one release the flag is accepted-and-ignored on three commands, which
  is the exact failure mode `flag-guards.ts` was written to close. It is accepted here rather than
  refused because refusing it would require the `1.1.3` scope table, and shipping half of that table
  is how a `doctor` ends up reporting one target under a flag that asked for two.
- **A third target is a union edit.** `TargetId` is closed, so adding one is a type change plus an
  exhaustive-switch failure at every consumer — which is the desired shape, but it means this release
  does not by itself make a third target cheap. That is `1.2.0`'s job, and the PRD says so.
- **`data.target` and the envelope's `target` can disagree** until `1.1.2` removes the former. They
  cannot in practice — the services set it to the literal `"claude"` and only the Claude path runs
  when `--claude` resolved — but nothing asserts it. A spec pins the two are equal for every
  Claude-capable command, which is what keeps the removal in `1.1.2` provably behaviour-preserving.
- **`resolveTarget()` cannot see an alias or a future `--target` flag.** Adding one means editing one
  function, which is the point.

## 8. Release mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.1`; `src/` has no version
  constant to edit.
- `tests/release-contract.spec.js` takes `1.1.1`, gains `1.1.1` in the version regex, and slides the
  PRD/Design existence window to `["1.1.1", "1.1.0", "1.0.0", "0.4.1", "0.4.0"]`.
- `CHANGELOG.md` gains a `1.1.1` entry.
- New spec: `tests/target-resolution.spec.js` — the pure function plus the guard table. It is
  table-driven over every `CommandId`, asserting the accept/refuse matrix for `--claude`, `--codex`,
  and the pair, so adding a command without deciding its target scope fails the suite.
- `tests/arg-parsing.spec.js` returns the parser's boolean set, which legitimately grows by one.
- `tests/e2e/flags.spec.js` and `tests/e2e/guard.spec.js` carry the two hardcoded refusal lists this
  change alters.
- `tests/e2e/renderers.spec.js` carries the human-view routing assertions the renderer signature
  change touches.
- `docs/cli-usage.md` gains `--codex` in Global Options, a paragraph on the conflict rule, and the
  envelope field in JSON Contract. `docs/agent-provider-switch-product-overview.md` and
  `docs/agent-provider-switch-technical-architecture.md` are brought to the current version with a
  two-target description; both have lagged since `0.2.1` and this is the release whose subject is
  the thing they were wrong about.
- `docs/agent-provider-switch-2.x-roadmap.md` carries a superseded notice naming this line, and its
  §4 rejection of a generic target abstraction is marked as a `0.3.x`-era decision that `1.1.3` and
  `1.2.0` narrow: what stays rejected is a `--target` flag replacing `--claude`, and what changes is
  that the target becomes a value the code passes around. The live document is
  `docs/agent-provider-switch-1.x-roadmap.md`, which points at the three `1.1.x` PRD/Design pairs.

## 9. Acceptance criteria

See `docs/PRD/agent-provider-switch-prd-v1.1.1.md`. In short: `--codex` parses position-independently
and changes no `data`; `--claude --codex` is refused; `config compact --codex` is refused; every
`--json` envelope carries `target`, `null` exactly when no command resolved; `data.target` is still
emitted for Claude commands and equals the envelope field; `aps doctor --claude` is still refused;
and `npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
