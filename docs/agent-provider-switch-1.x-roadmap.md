# agent-provider-switch 1.x Roadmap

A decision document for the `1.1.x` → `1.3.0` line, written against the tree at `1.1.0`.

It **supersedes the plan half** of `docs/agent-provider-switch-2.x-roadmap.md`. That file's §2 issue
inventory is still the ID source for `P0-*` / `P1-*` / `P2-*` citations and is not restated here; its
§1, §3, §4, and §5 are superseded, and the reason is §1 below.

This is **a decision document, not a fact source**, on the same terms as the file it supersedes. It
is deliberately not wired into the version assertions in `tests/release-contract.spec.js`.

Every claim about the working tree below cites a file or a symbol and was verified against `1.1.0`.

---

## 1. The correction

The `0.3.x` roadmap rejected a generic target abstraction and a `--target` flag, on this reasoning:

> The Claude path is ~700 lines; the payoff does not justify a storage-format migration. Confirmed
> as the direction for this cycle.

That was a bet that the tool stays a two-target tool. **The bet is now known to be wrong: a third
target is certain.** The cost of the abstraction therefore does not have to be justified against two
targets — it has to be paid before the third one arrives, because writing a third copy of six
parallel service layers is the expensive path, not the cheap one.

Two smaller errors in that file are worth naming, because both made it harder to read:

- **The version framing never matched the project.** The file is called `2.x-roadmap.md` and opens by
  planning the `0.3.x` → `0.4.x` line. There is no `2.x` and there never was a plan for one.
- **It presented a settled decision as a permanent one.** "Confirmed as the direction for this
  cycle" became "explicitly rejected" in §4 of the same document, which read as a standing principle
  rather than a decision with a horizon.

What survives from that document intact: the §2 inventory (verified line by line, and its IDs are
cited by shipped PRDs and Design documents, so they must not be renumbered), the §4 rejections that
are not about targets, and §5's decisions on secret handling and lock discipline.

## 2. Where we are at `1.1.0`

**Surface.** 21 commands in `src/commands/registry.ts`; 7 of them reachable on the Claude path
(`CLAUDE_COMMANDS` in `src/commands/claude-handlers.ts`). Two targets, one tool home, one lock file,
one `backups/` directory and one `latest.json` shared between them.

**Records are structurally different, and that is the load-bearing fact for `1.2.0`.**

| | Codex | Claude |
|---|---|---|
| Record (`src/domain/`) | `{ profile, apiKey, model?, baseUrl?, note?, tags? }` — flat | `{ settings, note?, tags? }` — one blob |
| Secret location | `record.apiKey` | `record.settings.env.ANTHROPIC_AUTH_TOKEN` |
| Shared layer | none | optional `claudeDefaults.settings` in the tool config |
| Projection | `config.toml` (byte-offset patch) + `auth.json`, two files | `settings.json`, one whole-file atomic replace |
| File root shape | `{ providers: { … } }` | `{ providers: { … } }` |

The root shapes are already identical. The records are not, and cannot be made so without inventing
a union — which is why §8 rejects unifying them.

**"Which target" is answered three times, by convention.** `isClaudeCommand()` returns a boolean;
each Claude service hand-writes `target: "claude"` into its own payload; each Claude mutation encodes
it again as the `claude-` prefix on its operation name, which reaches `backups/` as the manifest's
`reason`. `1.1.1` turns these into a value; the third one is still a convention `1.1.3` relies on.

**Six near-duplicate file pairs** are the duplication `1.2.0` exists to remove:

| Layer | Codex | Claude |
|---|---|---|
| domain | `providers.ts` | `claude-providers.ts` |
| storage | `providers-repo.ts`, `codex-paths.ts` | `claude-providers-repo.ts`, `claude-paths.ts` |
| app | `add/list/show/get-current/switch/remove-provider.ts` | `claude-add/list/show/current/switch/remove-provider.ts` |
| commands | `handlers.ts` | `claude-handlers.ts` |

**The suite is trustworthy now.** CI runs on Linux and Windows against Node 20 and 22
(`.github/workflows/ci.yml`), the `dev-codex/local-sandbox` fixture dependency is gone, and the
harness drives `runCli()` in-process rather than mirroring it. That is what makes a refactor of this
size reviewable: `1.2.0` can assert "every existing spec passes unmodified", which was not true at
`0.3.1`.

## 3. The `1.1.x` line

Three releases, all planned, each with a PRD and a Design document.

| Release | Subject | PRD | Design |
|---|---|---|---|
| `1.1.1` | The target becomes explicit: `--codex`, one `resolveTarget()`, `target` on the envelope. Additive. | `docs/PRD/agent-provider-switch-prd-v1.1.1.md` | `docs/Design/agent-provider-switch-v1.1.1-design.md` |
| `1.1.2` | One error vocabulary: five codes merged, renamed, or deleted; `data.target` removed. The line's only contract break. | `…prd-v1.1.2.md` | `…v1.1.2-design.md` |
| `1.1.3` | The six shared-state commands report both targets; a scope table replaces three ad-hoc decisions. | `…prd-v1.1.3.md` | `…v1.1.3-design.md` |

**The endpoint of this line is a split.** At `1.1.3` the target is a first-class value everywhere it
is *observed* — the JSON envelope, the error vocabulary, diagnostics, backups, and the flag
guards — and nowhere it is *implemented*. The storage repositories, record schemas, projection
rules, and app services are still two independent copies, and a third target would still mean
writing all of them.

That split is deliberate. `1.1.x` is small, additive (except for the one declared break), and
testable against the existing suite. `1.2.0` is the release that spends the seam.

## 4. `1.2.0` — the target descriptor

**Goal.** Replace "one parallel code path per target" with "one descriptor table plus one executor",
without changing the CLI surface, the JSON contract, or either stored file format.

**What a descriptor declares.** The list is the deliverable; its exact TypeScript shape is `1.2.0`'s
Design document's job.

- Identity: `id`, label, tool-home environment variable, default target directory, registry file name.
- Record schema: parse, validate, serialize — with validation messages that name the target.
- **Secret location**: which part of the record holds the credential, and therefore what `show`
  masks and `--reveal` reveals.
- **Projection**: how a record becomes the target's real configuration (one file or several, atomic
  replace or byte-offset patch) and how the active provider is read back out of it.
- **Optional shared layer**: whether the target supports a defaults block, and how a stored delta is
  resolved against it. Codex has none; Claude has `claudeDefaults`.
- Capability: which verbs apply, i.e. `1.1.3`'s scope table.

**What it collapses.** The six file pairs in §2 become one implementation each, parameterized by
descriptor. `doctor`, `status`, and `backups list` stop naming two targets explicitly and iterate the
table instead. The interactive selectors (`promptForProviderSelection` and
`promptForClaudeProviderSelection`, which re-implements it) become one.

**`--target <id>` is added, and `--claude` / `--codex` stay.** Two booleans do not generalize: with a
third target the conflict matrix is pairwise and a fourth makes it quadratic. `--target` is the
general form, the existing booleans remain as aliases, and this is additive — the change to `0.3.x`'s
rejection is that *replacing* the aliases is still rejected while *adding* the general form is
adopted. `1.1.3`'s scope table already gives the new flag its per-command acceptance rule.

**Non-goals.** No storage-format change. No merging of `providers.json` and
`claude-providers.json`. No third target. No CLI break — the commands, flags, and JSON stay as
`1.1.3` left them, which is what makes this a `1.2.0` rather than a `2.0.0`.

**Design against the two targets that exist.** Codex is the flat-record, two-file-projection,
field-secret extreme; Claude is the blob-record, shared-defaults, nested-secret, whole-file-replace
extreme. Those two are the design pressure. Guessing at a third target's shape before it is chosen
would produce an abstraction fitted to a hypothesis, and the whole point is that the third target
should cost one file.

**State of this release's documentation.** Direction settled here; its PRD and Design are not
written. They are the next documents this line needs, and they should be written before any `1.2.0`
code, on the same terms as `1.1.x`: the Design judges `1.2.0` by whether every existing spec passes
unmodified.

## 5. `1.3.0` — the third target

**Not scheduled.** A third target is certain, and it is not now: `1.2.0` has to land first, or the
third target pays for the abstraction twice.

Once `1.2.0` is in, a new target should cost a descriptor, a projection implementation, its rows in
the capability table, and its own tests — and nothing else. If it costs more than that, `1.2.0` was
designed against the wrong two targets and the honest response is to fix the abstraction before
adding the target.

## 6. Still open from the `0.3.x` inventory

Verified at `1.1.0`. Anything not listed here is either closed by a shipped release or was not
re-verified for this document.

| Finding | State |
|---|---|
| **P2-1** dead layers | Open. `src/infra/` (8 files) is still present and still imported by nothing; 5 of the 6 files in `src/cli/` are still dead shims, with `output.ts` the only live one. |
| **P2-2** dead exports | Open. `findProviderByProfile`, `confirmCreateCodexDir`, `planProfileLifecycleOutcome`, and `DEFAULT_LINE_ENDING` still have no callers; `DESTRUCTIVE_REMOVE_BLOCKED` is still declared and only ever rendered. |
| **P2-3** copilot-era remnants | Open. `runCodexLogin()`, `setCodexSpawnImplementation()`, and `resetCodexSpawnImplementation()` in `src/runtime/codex-cli.ts` are referenced only by the dead `src/infra/codex-cli.ts` shim. |
| **P2-5** the hand-rolled TOML parser | Open, recommendation unchanged: make it **fail loudly** rather than swap in a real parser. Its problem is silence, not coverage. |
| **P2-7** help and flag inconsistencies | Partly closed. Boolean flags stopped swallowing the next token in `0.4.0`, and the top-level banner names both targets as of `1.1.0`; the remaining inconsistencies stand. |
| **P2-11** packaging | Open. `engines.node` is still `>=18` while the sole runtime dependency requires `>=20.12`; `files` ships the whole `docs/` tree while excluding `README.CN.md` and `README.AI.md`; there is no `types` field; and `git tag` still returns nothing. |
| **P2-12** machine leftovers | Open, and still needs explicit confirmation before anything outside the repository is touched. |

**Priorities for this line.** P2-1 and P2-2 are the cheapest items on the list and the ones that make
every subsequent change easier to review: deleting a dead layer cannot change behaviour, and it
removes the "two names for every module" problem that makes a refactor of `1.2.0`'s size harder to
follow. They belong in `1.2.0` rather than in a later cleanup release, and the `1.2.0` Design should
sequence them first so the real refactor lands on a tree with one name per module.

The rest are independent and can land in any minor release.

## 7. Decisions carried over, changed, or dropped

| Decision | `0.3.x` | Now |
|---|---|---|
| A generic target abstraction | Rejected | **Accepted.** `1.2.0`. The rejection rested on a two-target assumption that is no longer true. |
| Unifying the domain/storage/app layers behind a shared registry | Rejected as "trading clarity for indirection" | **Accepted**, as `1.2.0`'s core, with the condition that both stored formats are unchanged. |
| A `--target` flag **replacing** `--claude` | Rejected | Still rejected. |
| Adding `--target <id>` **alongside** the existing aliases | Not considered | **Accepted**, `1.2.0`. |
| Merging both registries into one `providers.json` | Rejected | Still rejected. The records are structurally different; a merged file needs a union type. |
| Re-introducing the copilot-sdk, HTTP bridge, or proxy runtime | Rejected | Still rejected. |
| An exit-code taxonomy beyond `0` / `1` | Rejected, no consumer | Still rejected. |
| Codex `show --json` emitting the full `apiKey` | Decided: keep, it is a documented automation contract | Unchanged. `1.1.2` is the line's only contract break and it does not touch this. |
| `--reveal` as a global flag | Decided | Unchanged. |
| Automatic backup retention after every mutation | Decided | Unchanged since `0.4.1`. |

## 8. Explicitly rejected on this line

| Not doing | Why |
|---|---|
| Merging `providers.json` and `claude-providers.json` | The root shapes match and the records do not. A merged file needs a union of a flat record and a settings blob, which makes every reader narrower instead of simpler. |
| Unifying the two record shapes | Same reason, from the other direction. A third target fits the descriptor; the descriptor is not widened to make the shapes uniform. |
| Adding the third target before `1.2.0` | It would be written as a third copy of six layers, and the abstraction would then have to be reverse-engineered from three examples instead of designed against two. |
| A `--target` flag that replaces `--claude` / `--codex` | The aliases are shipped and documented. Adding the general form is additive; removing the aliases is a break with no benefit. |
| Per-target backup retention | `backups/` is one directory with one policy, and a directory any surviving manifest references is never deleted. `1.1.3` refuses `--claude` on `backups prune` for this reason. |
| A third target on the CLI before its descriptor exists | The descriptor is the declaration. A target that arrives before it arrives as a special case. |
