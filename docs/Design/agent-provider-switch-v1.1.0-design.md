# agent-provider-switch v1.1.0 Design Document

**Shared Claude defaults.** Additive release on the `1.x` line. No architecture change: both
registries, the projection model, the lock discipline, the rollback containment, and the `0.3.1`
secret-handling contracts are unchanged, and the Codex path is untouched. A tool home without the new
`claudeDefaults` block behaves exactly as `1.0.0` did.

Its companion is `docs/Design/agent-provider-switch-v1.0.0-design.md` (the rename and the legacy tool
home migration).

**Citation convention.** This document names symbols (`mergeClaudeSettings()`,
`resolveClaudeProviderRecord()`) rather than line numbers, because a citation that is wrong within one
commit is worse than one that is vague.

This release closes no roadmap finding.

## Overview

A Claude provider is stored as a complete `settings.json` blob, and most of that blob is the same in
every provider. The feature is a layering: the shared part lives once, in the tool config, and each
record stores only its delta. Three decisions shape everything else in this document.

**The merge is read-side.** The stored record stays a delta, and `switch --claude` is the only thing
that expands it. Writing the expansion back would turn the defaults into a copy in every record — the
duplication this release exists to remove.

**The resolved view is a separate field, not a replacement for `settings`.** This is the decision most
likely to be "simplified" away, and it is wrong to do so; §3 explains why.

**Nothing changes without opting in.** No block means no merge, so upgrading cannot alter what a
switch writes for someone who never adds one.

## 1. The tool config carries the block

`AgentProviderSwitchConfig` gains an optional `claudeDefaults: { settings }`. Its inner shape mirrors a
provider record on purpose, so resolving a record is the symmetric
`merge(claudeDefaults.settings, record.settings)`, and a future target-level field (a note, tags) has
somewhere to live without reshaping the block. It is namespaced so a future `codexDefaults` cannot
collide.

**The landmine.** `validateToolConfig()` does not preserve the parsed object; it *rebuilds*
`{ version, defaultCodexDir }`. A new key written by hand into `agent-provider-switch.json` would be
silently erased on the next read, so the type and the validator had to change together. The rebuilt
object gains `claudeDefaults` only when it is present: an absent block must stay absent rather than
become an explicit `undefined` that a deep-equality check would read as a difference.

`validateClaudeDefaults()` refuses unknown keys under the block instead of dropping them. The likeliest
hand-written mistake is `env` placed directly under `claudeDefaults`, with no `settings` wrapper;
dropping it silently would leave every provider with no inherited env and no message saying why.

The tool config is read once per dispatch in `executeCommand` — it already was, for `defaultCodexDir`
— and now also lands on `CommandExecutionContext.toolConfig`. `handleClaudeCommand` derives
`defaults = ctx.toolConfig?.claudeDefaults?.settings ?? null` once and passes it to every service. No
second file read.

## 2. The merge rule

`src/domain/claude-settings-merge.ts` holds four pure functions, none of which mutates its inputs or
returns an object aliasing them.

| Function | Contract |
|---|---|
| `mergeClaudeSettings(defaults, overrides)` | Plain objects merge recursively; the override wins; arrays and scalars are replaced wholesale; a `null` override deletes the key. The result never contains a `null` object member. |
| `diffClaudeSettings(defaults, full)` | The smallest delta `d` with `merge(defaults, d)` deep-equal to `merge(defaults, full)`. Idempotent. |
| `collectInheritedPaths(defaults, overrides)` | Dotted paths whose effective value comes from the defaults. **Paths, never values.** |
| `collectDroppedPaths(defaults, full)` | Dotted paths in `full` that `diff` drops because they equal a default. |

**`env` has no special case.** It is an object of scalar leaves, so the recursion merges it key by key.
That is why the default block covers the whole `settings` object rather than only `env`: one rule
covers both, and `env` is simply the part that repeats most.

**Arrays are replaced, not merged.** Merging `permissions.allow` element-wise would make it impossible
for a provider to *narrow* an inherited list, and there is no principled way to merge two arrays whose
order matters. A provider that wants a different list states it in full.

**`null` is the deletion marker.** A `null` in a record removes the inherited key; a `null` over an
absent key is a no-op. `diff` keeps a `null` only where it deletes a real default — dropping that one
would make the deleted value reappear — and a `null` *default* is read as absent, including one nested
inside a default object. A plain deep clone of the defaults would copy such a `null` straight into the
result, which is why defaults go through the same layering as overrides.

**An empty object does not clear.** `"enabledPlugins": {}` over a default with entries merges nothing
into it and so inherits it. This is the cost of `null` being the single deletion marker, and it is the
one place the rule is surprising; it is stated in the help text and in `docs/cli-usage.md`.

**Slimming is inheritance-first.** `diff` drops entries deep-equal to a default, so a key the defaults
set and the input omits is inherited. That is the feature — "import a five-key file, get your standard
settings" — but it means slimming is not a byte-preserving round trip. What it guarantees is the
invariant `merge(d, diff(d, x)) == merge(d, x)`.

The spec does not rely on examples for that. `tests/claude-settings-merge.spec.js` runs seeded
randomized properties over thousands of generated pairs — the merge/diff invariant, idempotent `diff`,
no `null` member in a merged result, every inherited path carrying the default's value, and no dropped
path appearing in the delta — alongside the hand-written cases. The generator is deterministic, so a
failure prints a replayable case rather than being a flake. Mutating the built module (inverting the
`null` rule, dropping differing scalars, letting `{}` clear) is caught each time.

## 3. Read-side resolution

`src/domain/claude-providers.ts` adds

```ts
type ResolvedClaudeProviderRecord = ClaudeProviderRecord & { effective: Record<string, unknown> };
resolveClaudeProviderRecord(record, defaults): ResolvedClaudeProviderRecord;
resolveClaudeProvidersFile(file, defaults): { providers: Record<string, ResolvedClaudeProviderRecord> };
```

**`effective` is a separate field.** The tempting alternative is to have the reader overwrite
`settings` with the merged result so no call site changes. It is wrong. `remove` reads the whole
providers file, deletes one key, and writes the whole file back; a reader that overwrote `settings`
would make `aps remove --claude X` silently expand the defaults into every surviving record. A reader
that serves a write must stay raw. The resolve helpers live in `domain/` (they are pure) and callers
keep their existing raw readers, so the writers stay on the raw path by construction rather than by
discipline.

**Verbatim without a block.** With `defaults === null` the record is copied unchanged. That is stricter
than merging over an empty object, which would also strip explicit `null` members — a deletion marker
once a block exists, but plain data in a record imported before one did. Without this rule, upgrading
would change what `switch` writes for a user who never opted in.

**`defaults` is a required argument** on `claudeListProviders`, `claudeGetCurrent`, `claudeShowProvider`,
`claudeSwitchProvider`, and `claudeAddProvider`, with `null` meaning "no block". This follows the
repository's existing convention (`restoreManifest()` takes its allowlist as a required parameter for the
same reason): a caller that forgot an optional argument would silently work on a delta, and the one place
that must not is `switch`, where it would write a settings file missing every inherited key.

### The read sites

| Site | Resolves to | Failure if it read the raw record |
|---|---|---|
| `claudeSwitchProvider` — the write and its summary | `effective` | **Writes a delta as `settings.json`**, losing every inherited key. |
| `claudeShowProvider` — summary, `env`, and `--reveal` | `effective` | Empty summary; reveal shows a file that is not the one Claude Code ends up with. |
| `claudeListProviders` — columns and active marker | `effective` | `model` / `baseUrl` render `null`; the active marker never lights. |
| `claudeGetCurrent` — managed-provider match | `effective` | A delta record is never reported as managed. |
| `promptForClaudeProviderSelection` — labels and "(current)" | `effective` | Mis-labels and mis-highlights the choices. |

The interactive selector lives in `claude-handlers.ts`, outside `src/app/`, so a search of the Claude
services would miss it; it is the site most likely to be forgotten by the next change.

`export`, `import`, `doctor`, and `rollback` are not read sites: the first three are Codex-only, and
`rollback` restores raw bytes.

## 4. `add` slimming and `--full`

`claudeAddProvider` slims the imported file with `diffClaudeSettings` when a block exists and `--full`
is absent, and stores it as it came otherwise. It reports `droppedPaths` (paths only) so the human
output can say how many entries matched the defaults and how to keep them.

`--full` stores more; it does **not** stop inheritance. A record is resolved over the defaults when read
either way, so a key a full record omits is still inherited. What `--full` buys is pinning: a slimmed
record follows a later change to the defaults, a full one keeps the value it spelled out.

## 5. `config compact`

`claudeConfigCompact` rewrites every record to its delta. It changes storage, never what a switch
writes: a record is resolved over the defaults whenever it is read, full or delta alike, so the written
file is the same before and after. The spec pins this by switching every provider before and after and
comparing the files.

- **`--dry-run` is a separate branch, not a mutation that skips its write.** It returns before
  `runMutation` is reached, so it cannot take the lock, create a backup, or touch the file. A preview
  that acquired the lock could block on — or collide with — a real operation in another terminal. The
  spec proves it rather than asserting it: it holds a live lock, shows the preview succeeding, and shows a
  real run refused with `LOCK_CONFLICT` under the same lock, so the preview's success is not the lock
  being inert.
- **A run with nothing to change takes the same early exit.** A backup of an unchanged file is noise that
  pushes a useful one toward retention.
- **"Changed" is deep equality, never serialized text.** `diff` builds new objects, so key order can
  shift while no value does; a text comparison would call an already-compact file changed on every run.
- **The real run re-reads under the lock.** The preview ran without it, so another writer may have added
  or removed a provider since, and compacting from a stale read would write it back.
- **`note` and `tags` are carried over untouched**, and a `null` that deletes a real default is kept.
- **It refuses without a block.** Compacting against nothing would report success while changing
  nothing. The error names the tool config file and where the block goes.

Reversibility is the existing mutation machinery: a real run goes through `runMutation` (lock, backup,
rollback on failure), so `aps rollback` restores the previous `claude-providers.json`, and the spec
checks that.

## 6. Flag guards

`--full` and `--dry-run` join the parser's boolean set in `BOOLEAN_FLAGS`. Declaring a flag only in the
registry's `CommandDefinition.booleanFlags` would not be enough: that field is metadata a test validates
against the parser's set, and a flag the parser does not strip is read by the greedy value pass, which
then swallows the provider name that follows it.

The old single-purpose `--claude` refusal in `handleRegisteredCommand` became a table in
`src/commands/flag-guards.ts`: `{ flag, accepts, supportedCommands, requiresClaude }`. The parser accepts
a global boolean on any command, so accepted-and-ignored is the failure mode to close —
`aps backups prune --dry-run` would delete real backups under a flag that promised a preview.

**The check runs before the Claude early-return.** Placed after it, `switch --claude --full` reaches
`handleClaudeCommand` and the stray flag is never seen. Mutating the guard to accept `--full` everywhere
is caught by the spec for exactly this case.

`config-compact` joins `CLAUDE_COMMANDS`, so the `--claude` guard and `isClaudeCommand` treat it like the
other Claude-capable commands. Without `--claude` it is refused before the Codex-directory check, which
would otherwise be the error the user hears about.

## 7. Secrets and output

- `show --claude` runs the resolved `env` through `maskSecretValues`, so a credential in the defaults is
  masked like any other. The `--json` success path does **no** masking of its own — `renderSuccess`
  serializes `data` as given — so masking is the service's job, and it stays there.
- `maskSecretValues` is flat: it covers the top-level `env` map only. Nothing newly surfaced is a nested
  secret container, because `inherited` and `droppedPaths` carry paths and never values.
- `--reveal` returns `settings` (resolved) and `overrides` (stored). It remains the only way to see real
  values and is never applied by default.
- The `config-compact` human view belongs in `renderClaudeHumanSuccess`, not the outer switch:
  `renderHumanSuccess` short-circuits on `data.target === "claude"`, so a case added to the outer switch
  would be dead code and the command would dump raw JSON.

## 8. Residual risks

- **Editing the defaults changes every provider that inherits the edited key.** That is the point, but
  the live `~/.claude/settings.json` is not rewritten until the next `switch`. After changing a default
  that feeds the identity comparison (`model`, a model-map variable, the base URL), `current --claude`
  reports the active provider as unmanaged until it is switched again. Re-running
  `aps switch --claude <name>` is the fix.
- **A malformed block blocks every command.** The tool config is read on every dispatch, so an
  `INVALID_CONFIG` there fails Codex commands and `unlock` as well as Claude ones. This matches how a
  malformed tool config already behaved and is loud rather than silent; the error names the file and the
  cause.
- **The block is hand-written.** Nothing creates or edits it, and there is no Claude export or import, so
  there is still no built-in way to back up `claude-providers.json` as data.
- **Dotted paths are display strings.** A settings key that itself contains a dot makes a reported path
  ambiguous. Nothing parses a path back, so this is cosmetic.
- **Explicit `null` members change meaning when a block is first added.** In a record imported before any
  block existed they are plain data and are written verbatim; once a block exists they are deletion
  markers and are stripped from the written file.

## 9. Release mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.0`; `src/` has no version constant to
  edit, because `src/cli.ts` and `src/commands/handlers.ts` read `package.json` at runtime.
- `tests/release-contract.spec.js` takes `1.1.0`, keeps `0.2.1` in the version regex for the two
  deliberately-lagging overview and architecture docs, and slides the PRD/Design existence window to
  `["1.1.0", "1.0.0", "0.4.1", "0.4.0", "0.3.1"]`.
- `CHANGELOG.md` gains a `1.1.0` entry and absorbs the `Unreleased` section: the `--help` banner naming
  both targets and `withCodexLock()` becoming `withToolLock()`.
- New specs: `tool-config.spec.js`, `claude-settings-merge.spec.js`, `claude-defaults.spec.js`,
  `claude-config-compact.spec.js`. `arg-parsing.spec.js` and `tests/e2e/claude.spec.js` carry the two
  hardcoded lists this change legitimately alters (the parser's boolean flags, and the Claude-capable
  command set).

## 10. Acceptance criteria

See `docs/PRD/agent-provider-switch-prd-v1.1.0.md`. In short: the block survives a tool-config round
trip; the merge invariants hold under randomized inputs; every read site resolves while `remove` stays
raw; `add` slims and `--full` pins; `config compact` is invisible to a switch, idempotent, reversible,
and its preview takes no lock; a stray `--full` or `--dry-run` is refused rather than ignored; and
`npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
