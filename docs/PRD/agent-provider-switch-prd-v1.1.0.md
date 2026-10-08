# agent-provider-switch v1.1.0 PRD

## Summary

`1.1.0` lets Claude Code providers share their common settings.

A Claude provider has always been stored as a **complete** `settings.json` blob. That is the right
unit to *switch*, and the wrong unit to *store*: measured against a real tool home (4 providers,
197 lines), 10 `env` keys and 4 top-level keys were byte-identical in every record, and two of the
providers shared another 33 lines of `permissions`, `enabledPlugins`, and `extraKnownMarketplaces`
verbatim. Only 5–8 keys per record were that provider's own. The file stopped reading as "here is how
these providers differ", and changing one shared flag meant editing every record by hand.

This release adds an optional **`claudeDefaults`** block to the tool config
(`agent-provider-switch.json`). A provider record then stores only its delta, and `switch --claude`
writes the two layered together — the same shape as a global config with small per-target overrides.
The records file shrinks, every surviving line is a real difference, and a change to a default
reaches every provider at its next switch.

**Measured, not estimated.** Against that same tool home, with a defaults block derived mechanically
from the keys all four providers spell identically (no hand curation), `config compact` took
`claude-providers.json` from 6971 B / 198 lines to 4347 B / 138 lines — about 38% smaller — and all four
providers switched to byte-identical settings before and after. A hand-written block can go further:
the two `copilot` providers share more with each other (`permissions`, `enabledPlugins`,
`extraKnownMarketplaces`) than they do with the other two, and an intersection over all four cannot
capture that.

Nothing is required. A tool home without the block behaves exactly as `1.0.0` did, and existing full
records stay valid: resolving a full record over the defaults is a no-op for every key it spells out.

Design detail: `docs/Design/agent-provider-switch-v1.1.0-design.md`. This release closes no roadmap
finding.

## Version

- Version line: `1.1.0`
- Predecessor: `1.0.0`
- Status: **implemented.** Backward compatible; a minor release because the change is additive.

## Goals

- **Store only what differs.** A provider record holds the entries that are its own; what every
  provider shares lives once, in the tool config.
- **One merge rule, stated once.** Objects merge recursively, the record wins, arrays are replaced
  wholesale, and `null` deletes an inherited key. No special case for `env`.
- **No behaviour change without opting in.** No block means nothing is merged and a record is written
  verbatim, explicit `null` members included.
- **Slimming never changes what a switch writes.** `merge(defaults, slim(defaults, x))` equals
  `merge(defaults, x)`, for every input, and the suite pins it with seeded randomized properties.
- **A one-shot way to convert existing records.** `config compact --claude`, with a `--dry-run` that
  takes no lock and writes nothing.
- **Inherited values are visible without being leaked.** `show --claude` marks which entries came from
  the defaults and reports their dotted paths — paths only, never values — and an inherited credential
  is masked like any other.
- **A stray flag is refused, not ignored.** `--full` and `--dry-run` are rejected on every command
  that would do nothing with them.

## Non-Goals

- **No command writes the `claudeDefaults` block.** It is hand-edited and documented with a
  copy-pasteable example. `config compact` refuses when it is absent rather than guessing which keys
  are shared; a wrong auto-seed (dragging a per-provider `ANTHROPIC_BASE_URL` into the shared block)
  is worse than typing the shared keys once.
- **No Codex equivalent.** Codex records are already flat six-field rows with nothing to share.
  `claudeDefaults` is namespaced so a future `codexDefaults` cannot collide.
- **No export or import of Claude provider records.** Both commands remain Codex-only, so there is
  still no built-in way to back up `claude-providers.json` as data.
- **No write-side expansion.** The stored record stays a delta. Persisting the expanded result would
  turn the defaults back into a copy in every record.
- **No auto-rewrite of existing records.** Compaction is an explicit command; upgrading changes
  nothing on disk.

## The `claudeDefaults` Block

```json
{
  "version": "1.1.0",
  "claudeDefaults": {
    "settings": {
      "env": { "CLAUDE_CODE_EFFORT_LEVEL": "XHIGH", "MCP_CONNECT_TIMEOUT_MS": "30000" },
      "model": "sonnet",
      "theme": "dark"
    }
  }
}
```

The inner shape mirrors a provider record's, so resolving a record is
`merge(claudeDefaults.settings, record.settings)`.

**Validation.** A `claudeDefaults` that is not an object, a missing or non-object `settings`, or any
other key under `claudeDefaults` is `INVALID_CONFIG`. Unknown keys are refused rather than dropped:
the likeliest hand-written mistake is putting `env` directly under `claudeDefaults`, and silently
ignoring it would leave every provider with no inherited env and no message saying why.

## Merge Rule

Recursive deep merge; the record wins; arrays are replaced wholesale; `null` deletes an inherited key.
The result never contains a `null` object member. A `null` default reads as absent.

Two consequences are documented because both are surprising:

1. **An empty object does not clear.** `"enabledPlugins": {}` over a default with entries inherits
   them. Clearing takes an explicit `null`.
2. **A key the defaults set and a record omits is inherited, not missing.** So `add --claude`
   slimming is inheritance-first and is not a byte-preserving round trip of the imported file.

## Behaviour By Command

| Command | Change |
|---|---|
| `switch --claude` | Writes the resolved settings. The stored record is unchanged. |
| `list --claude` / `current --claude` | Same output shape, computed from the resolved settings, so the `model` / `baseUrl` columns and the active marker keep working for a delta record. |
| `show --claude` | Human output shows the **resolved** settings with each inherited entry marked `(inherited)` and a trailing `inherited:` summary. `--json` adds `inherited` (dotted paths). `--reveal` returns `settings` (resolved) and `overrides` (stored). |
| `add --claude --from-file` | Slims against the defaults and reports how many entries were dropped. `--full` keeps every entry, which pins them against later changes to the defaults. |
| `config compact --claude [--dry-run]` | New. Rewrites every record to its delta. |
| `remove --claude` | Unchanged, and deliberately works on raw records so a delete cannot expand the defaults into the survivors. |

`--full` stores more; it does not stop inheritance. A record is resolved over the defaults when read
either way, so a key a full record omits is still inherited.

## `config compact --claude`

Rewrites every stored Claude provider to the entries that differ from the defaults. It changes only
how a provider is stored: `switch --claude` writes the same file before and after, and `rollback`
undoes the rewrite.

- Requires `--claude`; refuses with `INVALID_ARGUMENT`, naming the file, when the block is absent.
- `--dry-run` takes no lock, creates no backup, and leaves the file byte-identical — it succeeds while
  another operation holds the lock.
- A run in which every record is already a delta writes nothing and takes no backup. Running it twice
  reports zero changes the second time.
- A real run re-reads the file under the lock, carries `note` and `tags` over untouched, and keeps an
  explicit `null` that deletes a real default.

## Flag Guards

`--full` is accepted only by `add --claude`, and `--dry-run` only by `config compact --claude`;
`--claude` additionally by `config compact`. The parser accepts a global boolean anywhere, so each is
refused with `INVALID_ARGUMENT` on any command that would ignore it — including a Claude-capable
command such as `switch --claude --full`. Accepted-and-ignored is the dangerous reading:
`aps backups prune --dry-run` would otherwise delete real backups under a flag that promised a
preview.

## Release Mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.0`.
- `tests/release-contract.spec.js` takes the new version, and the PRD/Design existence window slides to
  `1.1.0 → 0.3.1`.
- `CHANGELOG.md` gains a `1.1.0` entry. It also carries the two repo-only fixes that had been parked
  under `Unreleased` since `1.0.0`: the top-level `--help` banner now names both targets, and the
  shared-lock wrapper is `withToolLock()`.
- `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, and `docs/Tests/testing.md` carry
  the new version and describe the defaults block, not only its version number.
- Publishing is a manual step.

## Acceptance Criteria

1. A hand-written `claudeDefaults` block survives a tool-config read and write; an absent block stays
   absent; a malformed block is `INVALID_CONFIG`.
2. `merge(d, diff(d, x))` equals `merge(d, x)` over randomized inputs including `null`, `{}`, arrays,
   and nested `env`; `diff` is idempotent; a merged result has no `null` object member.
3. `switch --claude` writes the resolved settings while the stored record stays a delta. With no block
   a record is written verbatim, explicit `null` members included.
4. `list`, `current`, `show`, and the interactive selector resolve a delta record, so the active marker
   and the `model` / `baseUrl` columns still work. `remove` does not expand the defaults into the
   survivors.
5. `show --claude` masks an inherited credential, lists inherited paths without values, and `--reveal`
   returns resolved `settings` plus stored `overrides`.
6. `add --claude` slims by default and `--full` keeps everything, wherever `--full` sits relative to the
   provider name.
7. `--full` and `--dry-run` are refused where they would be ignored, including on `switch --claude`.
8. `config compact --claude` does not change what a switch writes, is a no-op the second time, keeps a
   deleting `null`, carries `note` and `tags`, and is reversible through `rollback`.
9. `config compact --claude --dry-run` leaves the file byte-identical, creates no backup, and succeeds
   while a live lock is held; a real run under the same lock is refused with `LOCK_CONFLICT`.
10. `npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
