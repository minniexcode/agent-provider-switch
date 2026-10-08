# agent-provider-switch v0.4.0 Design Document

**Foundation and CLI contract.** First of two releases on the `0.3.x → 0.4.x` line. No architecture
change: both registries, the projection model, the command set, and the `0.3.1` security contracts are
untouched. No new command, no new storage format, no change to a recovery path.

Its two companion documents are `docs/Design/agent-provider-switch-v0.4.1-design.md` (stale-lock recovery,
backup retention) and the roadmap's Phase 2a section.

**Citation convention.** This document names symbols (`getSingleOption()`, `resolveCommandFromArgv()`)
rather than line numbers. Every `file:line` citation in the roadmap drifted within a single release,
and a document that is wrong within one commit is worse than one that is vague.

Source of record: `docs/agent-provider-switch-2.x-roadmap.md` §2 — `P1-1`, `P1-2`, `P1-3`, `P1-4`, `P1-5`,
`P1-9`.

## Overview

`0.3.1` closed the security findings. What remains open splits cleanly by *risk shape*, and that split
is why this release exists separately from `0.4.1`.

The two `0.4.1` items change state: one takes over a lock another process left behind, the other
deletes backup directories. Both need tests that observe a **crash** and a **file that must survive**.
Neither is testable on the current harness, which re-implements the production dispatch ladder
in-process, cannot observe an exit code, and whose only cleanup can delete the directory under test.

So this release fixes the harness first, then makes two parser-level changes on top of it. Nothing
here can corrupt state; the worst failure is a wrong exit code.

## Scope

**In:** CI; test fixture generation; temp-directory lifecycle; `runCli(argv, io)` extraction; Claude
workflow coverage; boolean flag parsing; exit codes and the synchronous error envelope.

**Out:** stale-lock recovery and backup retention (both `0.4.1`); exit-code taxonomy; dead-code
deletion; `engines.node`; TOML parser work; a generic target abstraction; Windows ACL remediation;
and any change to the Codex `show --json` automation contract. Rationale in the PRD's Non-Goals.

---

## 1. CI and test portability

This section comes first because the other two are proven by it. Nothing else in the release is
trustworthy until the harness stops being a hand-maintained mirror of production.

### The fixture

`makeSandboxCopy()` copies a gitignored directory that is absent in this working tree, so three tests
fail **now**, not only on a fresh clone. That distinction matters for how this is scoped: it is not
hypothetical portability work discovered by adding CI, it is a suite that is already red.

The replacement is a generator parameterised by model-provider id and base URL — one fixed blob will
not serve all three, because two of them assert on different config shapes:

- a Codex directory containing **`config.toml`**. The config reader throws `CONFIG_NOT_FOUND` without
  it, and `switchProvider` reads it. `makeEmptyCodexDir()` is the starting point; it currently creates
  only an empty `backups/`.
- test 1 needs `status` to report the active provider and `auth.valid === true`.
- test 2 needs a top-level `model_provider` so that two records sharing one profile hit the
  shared-profile branch and report the active provider as ambiguous.
- test 3 needs the same top-level `model_provider`, **plus** a `[model_providers.<id>]` section whose
  `base_url` differs from the seeded one — the mismatch diagnostic requires exactly one linked
  provider and differing URLs.

### Teardown

There is no teardown hook: `tests/run-tests.js` has no before/after and no `finally` around a spec.
The one cleanup that exists is doubly conditional — it fires only when the caller passed no tool home
and no codex directory — and it is an **unguarded `rmSync` inside a `finally`**, so a Windows `EBUSY`
there turns a passing test red.

The conditional is worse than it looks: when `--codex-dir` is passed, the harness uses the **codex
directory as the tool home**, so an object input with `args: [..., "--codex-dir", X]` and no
`toolHomeDir` gets `X` used as the tool home *and then deleted by the cleanup*. That is the same
directory the test is still asserting against.

Design: always create a private temp tool home (never reuse the codex directory), register every
temp directory in a module-level list, export an idempotent cleanup, invoke it per spec and once at
the end, add a `process.on("exit")` backstop, and make every removal best-effort.

This is a precondition for `0.4.1`, not a nicety: the lock test spawns a child that dies holding a
lock, and the backup test asserts that a specific directory **survives** a prune. Neither survives a
teardown that deletes directories under the test's feet.

### The new Claude spec carries a data-loss hazard

`claudeSwitchProvider` atomically replaces `<claudeDir>/settings.json`, and `<claudeDir>` resolves
from `APS_CLAUDE_DIR` or the real `~/.claude`. The existing secret-handling spec sets that
variable; **the new spec must set it too, and assert it up front** — otherwise `npm test` rewrites
the developer's real Claude settings file.

This is the most dangerous line in the release, and it is a test-harness property rather than a
product defect. The assertion is not defensive style; without it, running the suite damages the
machine it runs on.

Related: `APS_CLAUDE_DIR` is load-bearing and undocumented — top-level help lists only the
tool-home and Codex-directory variables. It is documented as supported.

### The workflow

`.github/workflows/ci.yml`: `npm ci` → `npx tsc --noEmit` → `npm test`, matrix of
`windows-latest` + `ubuntu-latest` × Node 20/22.

Two notes that belong in the file as comments:

- `prepare` runs the build, so a type error surfaces during `npm ci` and the build runs twice.
  Accepted: it makes a broken tree fail at install, which is the more useful failure.
- **Do not set `engine-strict`.** Node 20 and 22 both satisfy the dependency's range, while
  `package.json` advertises `engines.node: ">=18"`, which CI never tests. `engine-strict` would turn
  that pre-existing inconsistency into a hard install failure on the advertised floor.

### What a green matrix does and does not mean

Green CI means the tested Node lines pass. It does **not** mean `engines.node` is correct — that
mismatch is Phase 3. The POSIX `0600`/`0700` assertions are skipped on win32, so the ubuntu leg is
the only thing exercising them, which is an argument for keeping it.

---

## 2. Boolean flag parsing

### Current state

The command-option pass treats any `--x` followed by a non-`--` token as `--x <value>` and skips the
token. A flag with no following token, or one followed by another `--` token, is recorded as
`["true"]`. There is no notion of a boolean flag anywhere in the registry — the `usage` strings are
documentation, not schema.

`aps remove --force packycode` therefore leaves no provider name. `resolveClaudeProviderName()`
exists to dig a provider name back out of the `--claude` flag value, and its own comment says so.

### Where the fix has to go

The roadmap puts `booleanFlags` on the command definition and applies it in the command-option pass.
That cannot work, and the reason is structural: `startIndex` is derived from command resolution, and
`resolveCommandFromArgv()` matches only at the **head** of `remaining`. Verified against the built
parser:

| Input | Today | With the set applied in the command-option pass |
|---|---|---|
| `["--claude", "list"]` | `command: null` → top-level help | still broken — the flag precedes the command, so the pass never runs with a definition loaded |
| `["add", "--claude", "copilot", "--from-file", "x.json"]` | `positionals: []`, `--claude: ["copilot"]` | fixed |
| `["remove", "--claude", "--force", "deepseek"]` | `positionals: []`, `--force: ["deepseek"]` | fixed |

The first row is why this release and §3 cannot be reviewed independently: an input that today prints
help and exits 0 would exit 1 once §3 lands, if this fix is not in place.

### The fix

The set is applied as a **union in the parser's first pass**, alongside the three tokens already
stripped there (`--json`, `--reveal`, `--codex-dir`), while still recording the hit into
`commandOptions` as `["true"]`.

Three things follow, and all three are the reason for this placement:

- **`--claude` becomes position-independent**, which is what makes `["--claude", "list"]` a normal
  invocation instead of a resolution failure.
- **Nothing downstream changes.** `hasFlag()` and `isClaudeCommand()` read `commandOptions`, so
  recording the hit keeps the handlers untouched — the flag is still present, only its value is now
  always `"true"`.
- **`CommandDefinition.booleanFlags` becomes validation and help metadata**, not a parser input. That
  is deliberate: the definition is the right *declaration* site even though it is not the mechanism.

### `--reveal` is excluded

It is already stripped by exact token in that same pass, so listing it would be a no-op rather than a
fix. It stays global, as documented since `0.3.1`.

### A wart this widens, stated so it does not grow silently

Any option **value** equal to a stripped token becomes the literal `"true"`. Verified today:
`["edit", "p", "--note", "--json"]` yields `--note: ["true"]`. Adding five names to the stripped set
widens that class. Fixing it is out of scope — it needs a real value-vs-flag model — but the rule
belongs in the document so the next person adding a global flag knows what they are joining.

### Deleting the workaround

`resolveClaudeProviderName()` and the parser fix ship in **one commit**, because the helper is only
deletable once names land as positionals.

**The roadmap's compatibility claim is not true today.** It states that `copilot` already lands as a
positional in `aps add --claude copilot --from-file x`. It does not — today that input yields
`positionals: []` with `--claude: ["copilot"]`. The claim describes the post-fix state. The four call
sites are `add`, `switch`, `show`, and `remove` in `handleClaudeCommand`; `list` and `current` take no
name. Each is re-verified against the new parser rather than assumed, and the acceptance test covers
all three orderings — including `aps remove --claude --force <name>`, which does not work at all
today.

### `getSingleOption()`

The `required` parameter is dead: both branches of its ternary return `null`, so the default `true`
never enforces anything. It is **deleted**, not made to throw.

Making it throw is the intuitive fix and the wrong one: `handlers.ts` relies on receiving `null`
there in order to fall through to the interactive collector, and `aps add` with no flags is a
documented usage form in the registry. A throw would break the primary interactive path to enforce
something already enforced further down. The parameter and the ternary go, the third argument is
dropped at all fifteen call sites, and presence enforcement stays where it already lives.

---

## 3. Exit codes and the error envelope

### The discriminator does not exist

§3 as written in the roadmap is "unknown command → exit 1". Implementing it requires telling an
unknown command apart from no command, and the parse result cannot do that. Verified by running the
built parser — all eight of these produce an **identical** `ParsedCommand`:

```
[]  ["--json"]  ["--help"]  ["-h"]  ["lst"]  ["--json","lst"]  ["version"]  ["config"]

  → { command: null, positionals: [], helpRequested: false, helpTarget: null, versionRequested: false }
```

`startIndex` falls back to `Math.min(remaining.length, 1)` when nothing resolved, so index 0 is
skipped and the token there is recorded nowhere. `aps --help` prints help only because it lands in
the unknown-command branch — the same branch a typo lands in. **Naively changing that branch to exit
1 makes `aps --help` exit 1.**

### The fix belongs in the parser

Drop the `Math.min(remaining.length, 1)` fallback. The loop already skips `--`-prefixed tokens when
collecting positionals, so with the fallback gone `["--help"]` sets `helpRequested` properly and
`["lst"]` lands in `positionals` — and `cli.ts`'s ladder can distinguish them.

Considered and rejected: adding an explicit `unresolvedToken` field. Once the fallback is gone,
`positionals[0]` already carries that information; a second field would be a second source of truth
for the same fact.

### Three buckets

| Bucket | Behaviour |
|---|---|
| No tokens at all | top-level help, exit 0 |
| A recognized command-group root with no subcommand (`aps config`) | that group's help, exit 0 |
| Anything else unresolvable | `INVALID_ARGUMENT`, exit 1 |

Bucket 2 needs the **help-topic** predicate, not the command-name one. `isKnownCommandName()` and
`COMMAND_NAME_SET` look like the natural fit and are the wrong choice twice over: their only importer
is a dead `src/cli/` shim, so they are Phase 3 deletions, and `COMMAND_NAME_SET` is keyed on ids and
joined tokens, so bare `config` is absent from it while it *is* a help topic. The live predicate is
`isKnownCommandNameForHelp()` → `isKnownHelpTopic()` → `HELP_TOPIC_SET`, already imported by
`cli.ts`.

### Inputs that need an explicit answer

| Input | Today | `0.4.0` |
|---|---|---|
| `aps` / `aps --json` | help, 0 | help, 0 |
| `aps --help` / `aps -h` | help, 0 *(by accident)* | help, **0 by design** |
| `aps lst` | help, 0 | `INVALID_ARGUMENT`, 1 |
| `aps version` | help, 0 | `INVALID_ARGUMENT`, 1 |
| `aps config` | top-level help, 0 | group help, 0 (bucket 2) |
| `aps --claude list` | top-level help, 0 | normal invocation, once §2 lands |
| `aps --help list` | top-level help, 0; `list` ignored | help wins, topic ignored |
| `aps --json --help` | plain-text help | unchanged — pre-existing, recorded not fixed |

`aps version` is called out because `findCommandDefinition()` special-cases `"help"` and
`"version"` and returns `null` for both, which makes `version` look recognized when it is not a
command id. It lands in bucket 3 with every other typo.

### The synchronous envelope needs `--json` from raw argv

Wrapping `main()`'s synchronous section is not sufficient. When `parseArgs()` throws there is no
parsed result, so the catch cannot know whether `--json` was requested — and `aps --json
--codex-dir` would print a plain-text error, breaking the exact contract the change exists to fix.
`--json` is read from the raw `argv` for that path.

The likeliest real instance today is `aps list --codex-dir --json`: `--codex-dir` consumes
`--json` as its value, so the resolved directory is a path literally named `--json` and the eventual
error is plain text. That `--codex-dir` takes its next token unconditionally is recorded, not fixed —
a `--` guard there is a different change with its own compatibility question.

### `status`

`renderHumanSuccess()`'s `status` case reads `data.storage.toolHome.root`, and `getStatus()` returns
no `storage` key at all — so the line has always rendered empty. `docs/cli-usage.md` documents that
`status` reports the tool-home root, so the field is **populated**, not deleted.

Shape: a flat `toolHomeRoot` alongside the payload's other flat fields, with the renderer reading it.
A nested `storage.toolHome.root` grouping for one value would be inconsistent with every neighbouring
field, and no JSON consumer can depend on the current key because it is never emitted. `getStatus()`
gains a parameter for it; its only caller already has the tool-home path in hand.

### Help detection, recorded because the rule depends on it

`--version`/`-v` is matched by a whole-array scan. `--help`/`-h` is matched only at indices the
option loop actually visits, so a valued option can swallow it. The bucket table above is written as
though help is reliably detected, and it is not — today `aps --help` reaches the right outcome by
accident. Making the two symmetric is in scope here, to the extent the exit-code rule depends on it;
the wider help/flag inconsistency is P2-7.

### Making the exit code testable

Exit codes cannot be tested today. `tests/helpers.js` re-implements `main()`'s ladder **in-process**
— it cannot call the real one, because `printHelp()` and `outputFailure()` call `process.exit`, and
no test requires `dist/cli.js` at all. A change to `cli.ts` therefore changes nothing in the suite
unless the harness is edited to mirror it, and that mirror drifts silently.

The fix removes the duplicate rather than adding a third copy:

- extract the ladder into an exported `runCli(argv, io)` returning an exit code;
- the bin calls `process.exit(runCli(...))`;
- the harness calls `runCli` instead of mirroring it;
- one spawn-based test observes the real process exit (`spawnSync(process.execPath,
  ["dist/cli.js", "lst"])`), so the bin path is covered at least once.

---

## Cross-cutting changes

**`runCli` is the release's structural change.** It is what makes §3 testable and what removes the
harness's hand-maintained copy of the dispatch ladder. It is also the piece `0.4.1` builds on: a
lock-takeover test and a prune test both want to drive the real entry point rather than a mirror.

**No new command surface.** No `CommandId`, no `COMMANDS` entry, no renderer case, no nested-help
path. That is the main reason this release is low-risk, and it is why the two `0.4.1` items are
expensive by comparison — each of them needs all four.

**`getStatus()` gains a parameter.** Its only caller is the `status` case in `handlers.ts`, which
already holds `paths.toolHomeDir`. Putting the tool-home path into the `--json` payload is a contract
addition, so it is stated here rather than folded into the renderer fix.

**Comments cite roadmap IDs.** `P1-1`, `P1-2`, `P1-3`, `P1-4`, `P1-5`, and `P1-9` are the source
records, per the convention in `CLAUDE.md`.

---

## Testing

Beyond the existing suite:

- **Flag parsing** — all three orderings, including `aps remove --claude --force <name>` and
  `aps --claude list`, which does not resolve at all today.
- **`getSingleOption`** — `aps add` with no flags still reaches the interactive path rather than
  erroring, which is the regression the deletion could cause.
- **Exit codes** — one spawn-based test for the real process exit, plus the bucket table as cases.
- **`status`** — asserts a non-empty tool home in both human and JSON output; the field has never
  been populated, so no existing test covers it.
- **Claude workflow** — add, switch, list, current, show, remove, with `APS_CLAUDE_DIR` asserted
  before anything runs.
- **Fixture** — the three `provider-workflow` tests pass from generated fixtures, on a tree with no
  `dev-codex/local-sandbox`.
- **Teardown** — no temporary directory survives a suite run, including a failing one.

## Implementation Notes

Filled in when the work landed. Deviations first, then what the machine showed.

### Deviations from this design

**`--codex-dir` now rejects a flag as its value, which the PRD listed as recorded-but-not-changed.**
The PRD's non-goal says the fix is "scoped to boolean flags and the command-resolution order it
depends on", and names `--codex-dir` consuming `--json` as a path as something that stays. It had to
change instead. Once exit codes became observable, `aps list --codex-dir --json` resolved a
directory literally named `--json`, dropped the JSON request, and then **reported an empty provider
list as success** — exit `0` with a plausible-looking answer. A wrong answer is worse than a
refusal, and this release is specifically about failures becoming visible, so shipping a
success-shaped wrong answer inside it was not defensible. The branch reads raw `argv`, so the guard
is a `startsWith("-")` check on the next token; a directory whose name really starts with a dash can
still be written with a `./` prefix. `--version` matching anywhere in `argv` is unchanged, as the
PRD says.

**A refusal for `--claude` on commands with no Claude path is new behaviour, not in this design.**
`--claude` is global, so the parser accepts it anywhere. Ignoring it made `aps status --claude`
report Codex state under a flag that asked about Claude, and nothing in the output said so. The
rejection is `INVALID_ARGUMENT` and carries `supportedCommands`, so the error names the six commands
that do have a Claude path. It is placed after the `isClaudeCommand` early return, so the Claude
commands themselves are untouched.

**`getSingleOption()`'s `required` parameter was deleted as designed, but the third argument had to
be dropped at every call site rather than made to throw.** As the design predicted, `handlers.ts`
depends on receiving `null` to fall through to the interactive collector, and `aps add` with no
flags is a documented usage form. No call site relied on the old parameter.

**`tests/cli-process.spec.js` was added to the in-process suite, which this design does not mention.**
The acceptance criteria require a test that observes a real process exit code, and the in-process
harness structurally cannot produce one. Putting it in the main suite rather than deferring it to
the E2E suite keeps `npm test` satisfying the written contract on its own, so a contributor who runs
one command still gets it.

### What the machine showed

**A dead flag, found by the E2E suite and fixed here.** `--create-profile` was parsed in
`handlers.ts`, threaded into both `addProvider` and `editProvider`, and then dropped: neither app
service ever passed `upsertProfiles` to `createConfigMutationPlan`. `git show HEAD` confirms it was
inert at HEAD as well — the flag appeared in `handlers.ts` and both app files but nowhere in
`registry.ts`. The interactive `add` collector was the worse half: it prompts for a model and a base
URL precisely *because* it believes it is writing that section, and it was writing nothing at all.
Both `add` and `edit` now pass `upsertProfiles`, and `edit`'s guard counts `--create-profile` as an
action in its own right so `aps edit p --create-profile` is not refused as an empty update.

**`migrate` is the one command that ignores `APS_CODEX_DIR`.** `codexDirExplicit` is set only by a
literal `--codex-dir`, so a spec that sets the environment variable and calls `migrate` resolves
candidates against its own defaults. This is why the E2E suite's guard is structural — it asserts
every root inside the sandbox before a child process runs — rather than a convention each spec is
trusted to follow.

**`backups list` and `backups prune` are asymmetric on an empty tree.** `list` reports nothing found;
`prune` reports `kept 0` and exits 0. Both are correct, and the asymmetry is now asserted rather
than discovered by a user, because "prune deleted nothing" and "prune failed" must not look alike.

**Windows renames are transiently refused under load.** `writeTextFileAtomic()` aborted a mutation
with `EPERM` on a destination that Defender or the indexer was momentarily holding open, which
rolled the mutation back for no reason. `renameWithRetryOnWindows()` retries `EPERM`/`EACCES`/`EBUSY`
with a short backoff and rethrows anything else immediately; `tests/atomic-write.spec.js` pins the
retry count, the permanent-failure path, and the no-retry path. The `chmod`-skipped-on-Windows
finding from `0.3.1` is unchanged and is not re-litigated here.

**The suite now runs where it is checked out.** `makeCodexFixture()` generates the Codex files per
test, so `dev-codex/local-sandbox` — gitignored, and absent on a fresh clone — is never read. This
is what lets the four CI legs be green without a checked-in fixture directory, and it is the
precondition for `0.4.1`, whose specs need to construct crash states the checkout cannot supply.
