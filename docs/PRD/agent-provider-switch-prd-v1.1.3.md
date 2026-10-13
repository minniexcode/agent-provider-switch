# agent-provider-switch v1.1.3 PRD

## Summary

`1.1.3` makes the **shared-state commands** see both targets. Six commands are the subject:
`doctor`, `status`, `backups list`, `backups prune`, `rollback`, and `unlock`. Between them they
cover every piece of state the two targets have in common — one `backups/` directory, one
`latest.json` pointer, one lock file — and every piece they each keep to themselves. All six
currently present as Codex-only, and that presentation is wrong in three different ways:

- **A Claude-only user has no diagnostics.** `doctor` and `status` read `config.toml`,
  `providers.json`, `auth.json`, and the Codex CLI. A user who runs only `--claude` commands has no
  command that looks at `claude-providers.json`, `settings.json`, or the `claudeDefaults` block.
  Asking for one is refused: `aps doctor --claude` fails with `INVALID_ARGUMENT`, and the list of
  commands it names does not include anything diagnostic.
- **`backups list` shows Claude backups with no label.** The directory holds both targets' backups
  and their manifests record an operation name (`claude-switch`) that nothing surfaces. A user
  reading the list cannot tell which entries would restore a Claude settings file.
- **`aps rollback` silently undoes whatever ran last, on either target.** It restores the newest
  backup, which may be a `switch --claude` from four minutes ago. The output names the restored
  files, so it is recoverable, but the command never says which target it acted on.

This release fixes all three by making the target a dimension of these commands rather than an
assumption: `doctor` and `status` report both targets by default and narrow with `--claude` or
`--codex`, `backups list` labels every entry, and the three commands that operate on genuinely
shared state — `backups prune`, `rollback`, `unlock` — **refuse both flags** instead of pretending
to narrow.

Design detail: `docs/Design/agent-provider-switch-v1.1.3-design.md`. This release closes no roadmap
finding. It is the last of the three `1.1.x` releases and the only one that changes what a command
does.

## Version

- Version line: `1.1.3`
- Predecessor: `1.1.2`
- Status: **planned.** Backward compatible in the sense that matters: no stored file changes shape,
  no command loses a capability, and every existing invocation keeps working. It changes what
  `doctor`, `status`, and `backups list` *report*, which is the feature.

## Goals

- **Every target-scoped command answers about the targets it was asked about.** Nothing is silently
  Codex.
- **The default is both, and narrowing is explicit.** `aps doctor` reports Codex and Claude;
  `aps doctor --claude` reports Claude alone and does not probe the Codex CLI, which is the
  difference between a useful answer and noise for a Claude-only user.
- **A command that cannot narrow says so.** `backups prune`, `rollback`, and `unlock` hold or
  operate on state that is not per-target, so `--claude` and `--codex` are refused with a reason
  rather than accepted and ignored.
- **A target that was never set up is not a finding.** A machine with no Codex state at all reports
  Codex as unconfigured instead of unhealthy, so a Claude-only install can be `healthy: true`.
- **Shared state is described honestly.** `rollback` reports which targets the restored backup
  touched; `backups list` reports each entry's target, including for manifests written before this
  release.
- **The scope table is the seam.** One table states, per command, which targets it covers and
  whether a flag narrows them. That table is what a third target extends, and it is the reason this
  release precedes the abstraction rather than following it.

## Non-Goals

- **No third target.** `TargetId` stays `"codex" | "claude"`. This release builds the place a third
  one is declared, not the third one.
- **No target abstraction.** The storage repositories, record shapes, app services, and handler
  switches stay per-target. What ships is a *scope* table, not an injected `TargetContext`. That
  refactor is `1.2.0`, and doing it here would mean designing the abstraction against two targets
  and discovering its shape with the third.
- **No per-target backup retention.** `backups/` keeps one retention policy over a shared directory,
  and a directory any surviving manifest references is still never deleted. `--keep` is unchanged.
- **No `rollback --claude`.** "Restore the newest backup *from this target*" is a real feature and a
  real risk: restoring a backup that is not the newest is a different operation, and it would make
  `aps rollback` mean one thing with a flag and another without. The reported `targets` field gives
  the user the information without the footgun.
- **No Claude `init` or `add`-from-nothing.** `doctor` reports that `claude-providers.json` is
  absent; nothing creates it. `add --claude` remains the only way, unchanged.
- **No unification of the two targets' check sets.** Where a check exists on both sides and means
  the same thing, both are reported with their own `target` on the issue. An issue is never
  deduplicated across targets.

## Behaviour By Command

Bare means no target flag. "Refused" is `INVALID_ARGUMENT` naming the flags that would be ignored.

| Command | bare | `--codex` | `--claude` |
|---|---|---|---|
| `doctor` | Codex and Claude | Codex only | Claude only |
| `status` | Codex and Claude | Codex only | Claude only |
| `backups list` | every entry, each labelled | Codex entries | Claude entries |
| `backups prune` | shared retention | **refused** | **refused** |
| `rollback` | shared; reports what it restored | **refused** | **refused** |
| `unlock` | shared lock | **refused** | **refused** |

The seven Claude-capable commands and the eight Codex-only ones are unchanged from `1.1.2`. This
release adds no capability to any command and removes none; `add`, `switch`, `list`, `show`,
`current`, `remove`, and `config compact` behave exactly as they did.

### `targets` joins `target` on the envelope

A command can now cover two targets, so the envelope gains `targets`, the list of targets in scope,
and `target` keeps its place as the single-target case:

| Field | `aps doctor --json` | `aps doctor --claude --json` |
|---|---|---|
| `targets` | `["codex", "claude"]` | `["claude"]` |
| `target` | `null` | `"claude"` |

`targets` is authoritative and `target` is a convenience alias that is non-null exactly when one
target is in scope. **One value changes as a direct consequence:** `aps doctor --json` carried
`"target": "codex"` in `1.1.1` and `1.1.2`, which was true when `doctor` was Codex-only, and carries
`null` here because the fact changed. `1.1.2` was the release that promised to be this line's only
breaking one; this is not a second break but a correction to a field added two releases earlier, and
the CHANGELOG says so rather than leaving it to be discovered.

**`--codex-dir` with `--claude` is refused** on the three commands that accept both. The Codex
directory is not in scope when the caller asked about Claude, and the flag would otherwise be
accepted and ignored — the failure mode this codebase closes everywhere else.

## `doctor`

The command is split into a Codex check set and a Claude check set, composed by the selected targets.
Each issue gains a `target` field.

**Codex checks** (unchanged): `config.toml` exists and has a top-level `model_provider` and `model`,
provider/profile consistency, `auth.json` validity, live-state drift, and the Codex CLI probe.

**Claude checks** (new): `claude-providers.json` exists and parses; every stored record resolves
against the shared defaults; `settings.json` exists; the live settings match a managed provider, or
the active Claude settings are unmanaged. A record whose stored delta has an explicit `null` that
deletes a default that is no longer there is reported, because the written file then silently omits
a key the user believes is set.

**Narrowing skips the other set entirely.** `aps doctor --claude` never probes the Codex CLI. On a
machine without Codex installed, that is the difference between one actionable Claude finding and
that finding buried under `CODEX_NOT_INSTALLED`.

**A target that has never been set up is `configured: false`, not an issue.** A target counts as
configured when its registry file exists or its runtime directory exists. An unconfigured target
contributes no issues and does not affect `healthy`, and it is reported so the user can tell
"nothing here" from "nothing wrong".

This is the release's one behaviour change to an existing command. A Codex user who has ever run
`aps init` has `providers.json`, so their diagnostics are identical. A user with no Codex state at
all now sees `healthy: true` where `1.1.2` would have reported `CONFIG_NOT_FOUND` — which is the
correct answer for a tool they never set up, and the reason a Claude-only install can be healthy at
all.

**`healthy` covers the selected targets only.** `aps doctor --claude` is healthy when the Claude
side is healthy, whatever the Codex side is doing.

## `status`

`status` gains a `claude` section alongside its existing Codex fields: the Claude directory,
whether `claude-providers.json` and `settings.json` exist, the active provider as resolved against
the defaults, and how many entries of each record are inherited.

The existing top-level fields keep their names and positions, so an existing consumer of
`status --json` reads the same keys. A narrowed invocation reports only the target it named.

## `backups list`

Every entry gains a `target`. New manifests record it directly; manifests written before `1.1.3` are
classified from what they already carry, and an entry that cannot be classified is reported as
`unknown` rather than guessed at. `unknown` entries appear in the unfiltered list only.

## `rollback`

Its output gains `targets`, the set of targets the restored backup touched, derived from the
manifest's file paths. `aps rollback` after a `switch --claude` now says it restored Claude state.
The command's behaviour, prompts, and containment checks are unchanged.

## Release Mechanics

- `package.json` and both spots in `package-lock.json` move to `1.1.3`.
- `tests/release-contract.spec.js` takes `1.1.3`, and the PRD/Design existence window slides to
  `1.1.3 → 1.0.0`.
- `CHANGELOG.md` gains a `1.1.3` entry that names the `doctor` behaviour change for an unconfigured
  target.
- `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, and `docs/Tests/testing.md` carry
  the new version. `docs/cli-usage.md` gains the command/target matrix above.
- Publishing is a manual step.

## Acceptance Criteria

1. `aps doctor` reports both targets and returns `healthy: true` on a machine with no state for
   either target, with both reported as unconfigured.
2. On a machine with only Claude state, `aps doctor` is healthy and reports Codex as unconfigured;
   `aps doctor --codex` reports the Codex issues.
3. `aps doctor --claude` never invokes the Codex CLI probe, and succeeds on a machine where the
   Codex CLI is absent.
4. Every `doctor` issue carries a `target`, and `healthy` is computed over the selected targets only.
5. `aps doctor --claude --codex` is refused as a conflict; `aps doctor --claude --codex-dir X` is
   refused as an inapplicable flag.
6. `aps status` carries a `claude` section and every `1.1.2` top-level field, unchanged; a narrowed
   `status` reports only its target.
7. `aps backups list` labels every entry with a target; a manifest written before `1.1.3` is
   classified from its operation name, and an unclassifiable one is `unknown`.
8. `aps backups prune --claude` and `aps backups prune --codex` are refused, and bare
   `aps backups prune` is unchanged, including its retention and its never-delete-a-referenced-
   directory rule.
9. `aps rollback` reports the targets it restored; `aps rollback --claude` is refused.
10. `aps unlock --claude` and `aps unlock --codex` are refused; bare `aps unlock` is unchanged.
11. The seven Claude-capable commands and the Codex-only commands behave exactly as in `1.1.2`,
    asserted by the existing suites passing unmodified.
12. `npm run build`, `npx tsc --noEmit`, `node tests/run-tests.js`, and `npm run test:e2e` pass.
