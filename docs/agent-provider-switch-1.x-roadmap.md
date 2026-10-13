# agent-provider-switch 1.x Roadmap

A decision document for the `1.1.x` → `1.3.0` line. The original inventory was written against
`1.1.0`; §4 was reviewed against the accepted `1.1.3` implementation on 2026-10-13, and implemented
as `1.2.0` on 2026-10-14.

It **supersedes the plan half** of `docs/agent-provider-switch-2.x-roadmap.md`. That file's §2 issue
inventory is still the ID source for `P0-*` / `P1-*` / `P2-*` citations and is not restated here; its
§1, §3, §4, and §5 are superseded, and the reason is §1 below.

This is **a decision document, not a fact source**, on the same terms as the file it supersedes. It
is deliberately not wired into the version assertions in `tests/release-contract.spec.js`.

Historical observations in §2 were verified against `1.1.0`. The confirmed `1.2.0` rules and
their current-code evidence are recorded in [the 1.2.0 review](Reviews/agent-provider-switch-1.2.0-prd-review.md).

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

The root shapes are already identical. The records differ, but that does not prevent shared
registry code or combined storage: a discriminator or target-specific codec can preserve both
shapes. §4 retains the separate files as a scope choice for this refactor.

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
size reviewable: `1.2.0` can preserve the existing behavior assertions while updating module
paths, test wiring, and version assertions as needed, which was not possible at `0.3.1`.

## 3. The `1.1.x` line

Three target-related stages after `1.1.0`, each with a PRD and a Design document. The final reviewed
rules are normative; implementation alignment and verification are tracked separately in
[the 1.1.x review](Reviews/agent-provider-switch-1.1.x-prd-review.md).

| Release | Subject | PRD | Design |
|---|---|---|---|
| `1.1.1` | The target becomes explicit: `--codex`, one `resolveTarget()`, `target` on the envelope. Additive. | `docs/PRD/agent-provider-switch-prd-v1.1.1.md` | `docs/Design/agent-provider-switch-v1.1.1-design.md` |
| `1.1.2` | One error vocabulary: five codes merged, renamed, or deleted; `data.target` removed. Declared error/payload contract changes. | `…prd-v1.1.2.md` | `…v1.1.2-design.md` |
| `1.1.3` | The six shared-state commands report both targets; a scope table replaces three ad-hoc decisions. | `…prd-v1.1.3.md` | `…v1.1.3-design.md` |
| `1.2.0` | One implementation of the six provider verbs, reached through target adapters; `--target <id>` added. Code rather than data: stored formats and the JSON contract are unchanged. | `…prd-v1.2.0.md` | `…v1.2.0-design.md` |

The reviewed line accepts breaking changes for the author's single-user CLI. `1.1.2` changes
error codes and removes `data.target`; `1.1.3` adds authoritative envelope `targets`, changes
the bare `target` alias for six commands, rejects target flags on shared commands, and makes
diagnostic availability and identity ambiguity explicit. New optional manifest metadata is a
stored-shape addition; older valid backups remain readable without migration. No release promises
to be the line's only contract break.

**The endpoint of this line is a split.** At `1.1.3` the target is a first-class value everywhere it
is *observed* — the JSON envelope, the error vocabulary, diagnostics, backups, and the flag
guards — and nowhere it is *implemented*. The storage repositories, record schemas, projection
rules, and app services are still two independent copies, and a third target would still mean
writing all of them.

That split is deliberate. `1.1.x` keeps per-target implementation while making observed scope
explicit. Contract changes require corresponding regression assertions in the suite. `1.2.0` is the release that spends the seam.

## 4. `1.2.0` — the target descriptor

**Goal and baseline.** Replace parallel target implementations with a descriptor table, shared
command workflows, and target adapters. Add `--target <id>` alongside the existing aliases.
Preserve the accepted `1.1.3` normal operation semantics, JSON fields and meanings, and both stored
formats. This is a scope choice for the author's single-user tool, not an external compatibility
promise. The [1.1.x acceptance](Reviews/agent-provider-switch-1.1.x-implementation-verification.md)
stands; its deferred boundary improvements are not prerequisites for this refactor.

**The shared workflow and the target adapter have different jobs.** Each of `add`, `list`, `show`,
`current`, `switch`, and `remove` has one common implementation. The common layer owns dispatch,
registry access, provider lookup, selection and confirmation, and mutation orchestration. The
adapter supplies target-specific input, record rules, effective settings, matching, summaries,
operation policies, configuration change plans, and presentation. A descriptor that simply calls
one of the old complete command handlers does not satisfy this goal.

For example, Codex `add` prepares TOML configuration while Claude `add` stores a settings record;
Codex `remove` protects the unique active route and supports `--switch-to`, while Claude `remove`
only deletes its registry record. The shared workflow preserves those differences through adapter
policies rather than duplicating the entire command. One implementation per workflow does not
require all source code to live in one physical file.

**What a descriptor and its adapter declare.** The exact TypeScript interfaces belong in the Design:

- Identity and paths: `id`, label, target-directory environment variable and resolution policy,
  registry filename, managed runtime files, and artifact ownership. `APS_HOME` is the one shared
  tool home; `APS_CODEX_DIR` and `APS_CLAUDE_DIR` identify target runtime roots.
- Record codec: parse, validate, and serialize with target-appropriate messages. Common registry
  code handles collections; codecs preserve the different record schemas.
- Effective settings: optional target defaults and resolution of stored settings. Claude stored
  deltas remain raw in the registry; resolved settings are used for projection and read views.
- Matching and summaries: how active settings relate to saved providers and how choices are shown.
- Operation policies and projection: target-specific preconditions, affected-file lists, and plans
  for native configuration writes. Codex uses TOML patching and auth projection; Claude replaces
  settings.json with effective settings.
- Presentation and secrets: target-specific JSON and human views, including masking and reveal
  behavior. A single secret field path is insufficient to describe the existing show contracts.
- Capabilities and diagnostics: supported operations, report sections, and optional extra checks.
  Codex CLI probing is a Codex capability, not a requirement imposed on every target.

**Scope is a command policy; capability is a target policy.** A command declares how it selects
targets, its default scope, and whether an explicit selection is required. A target declares the
operations it implements. Guards, dispatch, help, and report selection consume these declarations
instead of keeping separate target lists. Keep the current 21 commands' supported behavior:

| Command class | Bare invocation | Explicit target |
|---|---|---|
| Six common provider verbs | Codex | Codex or Claude |
| Codex-only commands | Codex | Codex accepted; Claude refused |
| `config compact` | Requires explicit Claude selection | Claude accepted; Codex refused |
| `doctor`, `status`, `backups list` | Both targets | Narrows to the selected target |
| `backups prune`, `rollback`, `unlock` | Shared operation | All target selectors refused |

Common code does not automatically give Claude `edit`, `import`, or `export` support.

**Normalize selectors once.** `--target codex` equals `--codex`; `--target claude` equals
`--claude`. The valued flag works before or after command tokens without swallowing provider
positionals. Multiple selectors for the same target are deduplicated; different targets are
refused. Missing values and unknown ids use `INVALID_ARGUMENT`; repeated `--target` values follow
the same rule rather than silently choosing the last. All guards and handlers use the normalized
selection, including `--full`, `config compact --dry-run`, and the existing target-directory rules.
`--target` provides a general selection interface; alias conflict detection itself can already be
linear by collecting distinct selected ids.

**Apply the abstraction across the call chain.** `doctor` and `status` compose reports by iterating
selected descriptors; `backups list` uses declared roots and artifact ownership. Target presenters
supply target sections, and a target out of scope is not read or probed. Common interactive
selection and confirmation use the existing injectable prompt runtime; target adapters supply
input fields, labels, and matching information. Historical backup-name classification remains a
centralized compatibility rule, distinct from current descriptor-driven ownership.

**One mutation boundary.** The common workflow invokes the existing `runMutation()` once for the
adapter's affected-file list and change plan. Adapter writes do not nest another mutation wrapper.
Keep one tool home, lock, backups directory, latest pointer, and retention policy. Common storage
writes raw records; it never expands Claude defaults into surviving records during another write.

**Storage is outside this refactor's migration scope.** Retain `providers.json` and
`claude-providers.json`, their schemas, and target-local provider names. Combining them is
technically possible with a discriminator or target partitions, but would introduce independent
choices about `(target, name)` identity, import/export scope, whole-file recovery, and migration.
Different record shapes or the need for a union are not technical reasons that prohibit it.

**Design against the two current targets.** Preserve their actual native configuration differences
without inventing a universal settings schema. No third production target is implemented in
`1.2.0`. Its extension boundary is adding a descriptor, target adapters, registrations/types as
needed, and tests; common workflows, selection, report composition, and presentation dispatch
must not gain another target-specific branch. File count is not an acceptance criterion.

**Acceptance.** Both targets use the same six common workflows; selectors and aliases are
equivalent across provider commands and report filtering, including these normal invocations:

```text
aps --target claude list
aps list --target claude
aps add p --target claude --from-file settings.json --full
aps config compact --target claude --dry-run
aps doctor --target claude --json
```

Preserve normal operation and JSON behavior assertions, shared-command scope, existing backup
reading, defaults/delta behavior, and one mutation boundary. Add selector and common-interaction
coverage; allow test imports, module paths, wiring, and version assertions to change with the
refactor. Run type checking, the in-process suite, and E2E. Review the extension boundary without
requiring a fabricated third target or reopening the deferred 1.1.x defensive backlog.

**Documentation state.** These rules were confirmed through
[the global review](Reviews/agent-provider-switch-1.2.0-prd-review.md) and recorded in
[ADR-0001](adr/0001-share-provider-workflows-through-target-adapters.md). The
[formal 1.2.0 PRD](PRD/agent-provider-switch-prd-v1.2.0.md) and
[Technical Design](Design/agent-provider-switch-v1.2.0-design.md) define the requirements,
adapter contracts, implementation order, and acceptance cases. **Implemented and released as
`1.2.0` on 2026-10-14**, with the current fact sources now pointing at the `1.2.0` pair. The
`1.1.3` documents remain current for the target-scope and two-target-report behavior they describe,
which this release preserved.

## 5. `1.3.0` — the third target

**Not scheduled.** A third target is certain, and it is not now: `1.2.0` has to land first, or the
third target pays for the abstraction twice.

Once `1.2.0` is in, a new target should add a descriptor, its adapters and capabilities, the necessary
registration/type and documentation updates, and its tests. It should not copy shared provider
workflows or add target branches to common selectors, report composition, or presentation
dispatch. A new product capability can require a new common operation; that is different from
duplicating an existing operation for another target.

## 6. Still open from the `0.3.x` inventory

The inventory was verified at `1.1.0`; P2-3 was corrected during the `1.2.0` review. Other rows remain
historical observations unless stated otherwise. Recheck current callers before any deletion.

| Finding | State |
|---|---|
| **P2-1** dead layers | Open. `src/infra/` (8 files) is still present and still imported by nothing; 5 of the 6 files in `src/cli/` are still dead shims, with `output.ts` the only live one. |
| **P2-2** dead exports | Open. `findProviderByProfile`, `confirmCreateCodexDir`, `planProfileLifecycleOutcome`, and `DEFAULT_LINE_ENDING` still have no callers; `DESTRUCTIVE_REMOVE_BLOCKED` is still declared and only ever rendered. |
| **P2-3** copilot-era remnants | `runCodexLogin()` is still referenced only by the dead shim. The spawn setter/resetter are used by `tests/doctor-targets.spec.js` and must stay. The runtime probe also still produces `CODEX_LOGIN_FAILED`; an old integration label alone is not a reason to delete a live producer. |
| **P2-5** the hand-rolled TOML parser | Open, recommendation unchanged: make it **fail loudly** rather than swap in a real parser. Its problem is silence, not coverage. |
| **P2-7** help and flag inconsistencies | Partly closed. Boolean flags stopped swallowing the next token in `0.4.0`, and the top-level banner names both targets as of `1.1.0`; the remaining inconsistencies stand. |
| **P2-11** packaging | Open. `engines.node` is still `>=18` while the sole runtime dependency requires `>=20.12`; `files` ships the whole `docs/` tree while excluding `README.CN.md` and `README.AI.md`; there is no `types` field; and `git tag` still returns nothing. |
| **P2-12** machine leftovers | Open, and still needs explicit confirmation before anything outside the repository is touched. |

**Priorities for this line.** P2-1 and P2-2 are the cheapest items on the list and the ones that make
every subsequent change easier to review: deleting a dead layer cannot change behaviour, and it
removes the "two names for every module" problem that makes a refactor of `1.2.0`'s size harder to
follow. They belong in `1.2.0` rather than in a later cleanup release, and the `1.2.0` Design should
sequence them first so the real refactor lands on a tree with one name per module.

The cleanup is limited to code confirmed unused in the current tree. Keep test injection points
and live diagnostic behavior; the historical inventory is not a deletion manifest.

The rest are independent and can land in any minor release.

## 7. Decisions carried over, changed, or dropped

| Decision | `0.3.x` | Now |
|---|---|---|
| A generic target abstraction | Rejected | **Accepted.** `1.2.0`. The rejection rested on a two-target assumption that is no longer true. |
| Sharing provider workflows and registry I/O through target adapters | Rejected as "trading clarity for indirection" | **Accepted**, as `1.2.0`'s core. Keep target-specific schemas and rules; stored formats are retained for this cycle's scope. |
| A `--target` flag **replacing** `--claude` | Rejected | Still rejected. |
| Adding `--target <id>` **alongside** the existing aliases | Not considered | **Accepted**, `1.2.0`. |
| Merging both registries into one `providers.json` | Rejected | Outside `1.2.0`'s confirmed scope. Technically possible; storage migration is a separate choice, not blocked by differing record shapes. |
| Re-introducing the copilot-sdk, HTTP bridge, or proxy runtime | Rejected | Still rejected. |
| An exit-code taxonomy beyond `0` / `1` | Rejected, no consumer | Still rejected. |
| Codex `show --json` emitting the full `apiKey` | Decided: keep, it is a documented automation contract | Unchanged. The reviewed `1.1.x` changes do not alter this show/export contract. |
| `--reveal` as a global flag | Decided | Unchanged. |
| Automatic backup retention after every mutation | Decided | Unchanged since `0.4.1`. |

## 8. Explicitly rejected on this line

| Not doing | Why |
|---|---|
| Merging `providers.json` and `claude-providers.json` in this refactor | Common workflows can be shared without changing storage. Migration, cross-target name identity, import/export scope, and whole-file recovery are independent choices deferred from this cycle. |
| Forcing both targets into one universal native settings schema | The tools consume different configuration formats and have different defaults and projection semantics. Shared workflows use target codecs and adapters rather than making every native field optional. |
| Adding the third target before `1.2.0` | It would be written as a third copy of six layers, and the abstraction would then have to be reverse-engineered from three examples instead of designed against two. |
| A `--target` flag that replaces `--claude` / `--codex` | The aliases are shipped and documented. Adding the general form is additive; removing the aliases is a break with no benefit. |
| Per-target backup retention | `backups/` is one directory with one policy, and a directory any surviving manifest references is never deleted. `1.1.3` refuses `--claude` on `backups prune` for this reason. |
| A third target on the CLI before its descriptor exists | The descriptor is the declaration. A target that arrives before it arrives as a special case. |
