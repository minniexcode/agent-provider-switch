# Changelog

## 1.0.0 - 2026-10-08

Rename release. The tool stopped being Codex-only when `0.3.0` added Claude Code as a second target, and this release makes the name say so. One breaking change, no compatibility shims, no command-surface change.

The old identity is gone rather than aliased. The binary is `aps`, the package is `@minniexcode/agent-provider-switch`, the tool home is `~/.config/agent-provider-switch`, the environment variables are `APS_HOME` / `APS_CODEX_DIR` / `APS_CLAUDE_DIR`, and the state files are `agent-provider-switch.json` and `.aps.lock`. The GitHub repository rename is a manual step outside this change.

### Added

- Automatic migration of a pre-`1.0.0` tool home. The first command after an upgrade moves the old home to the new location, so existing provider records, Claude profiles, and backups stay the state the tool reads. The move is a same-filesystem rename — never a copy-then-delete, never a merge — and it is skipped when `APS_HOME` is set, when the new home already exists, or when the old lock has a live owner.
- `docs/PRD/agent-provider-switch-prd-v1.0.0.md` and `docs/Design/agent-provider-switch-v1.0.0-design.md`.
- `tests/tool-home-migration.spec.js` covering the move, every no-op guard, and the `APS_HOME` short-circuit.

### Changed

- The tool home, the tool config filename, the lock filename, the environment variables, the binary name, the npm package name, and the `AgentProviderSwitchConfig` type all carry the new identity from this release.
- Every identity literal now resolves through `src/storage/codex-paths.ts`. `dispatch.ts` and `claude-handlers.ts` previously rebuilt the tool-config, lock, and backups paths by hand, which is how an identity change leaves one spot stale.
- All prior `docs/PRD/*` and `docs/Design/*` files are reissued under the new name — filenames and prose alike — so the repository reads as one tool throughout. They remain records of the releases they describe.

### Notes

- The old binary name is not kept as an alias. A forwarding script would keep it in `PATH`, in the docs, and in shell history indefinitely, which is the cost this release exists to stop paying.
- A backup manifest taken before the rename records absolute paths under the old tool home, and rollback containment derives its allowed roots from the new one, so a pre-rename backup can be rejected with `ROLLBACK_PATH_REJECTED`. Prune pre-rename backups after upgrading.

## 0.4.1 - 2026-09-20

Stateful-recovery release. Two commands added, both aimed at a state the tool could previously enter and not leave: a lock whose owner no longer exists, and a backups directory that grows without bound.

### Added

- `aps unlock [--force]` — clears a lock left behind by a process that is provably gone. Idempotent: a missing lock is success. Refuses when the recorded owner is still alive, and names it; `--force` is the documented override.
- `aps backups prune [--keep N]` — deletes backup directories newest-first, keeping `N` (default 20). Never deletes a directory that a surviving manifest still names, so a rollback route is protected by every backup that references it, not only the newest.
- Automatic retention: every mutating command prunes to the default depth and reports how many backups it removed.
- `doctor` reports an occupied or stale lock as a finding, with the owning pid.
- `LOCK_STALE` error code and a stale-lock takeover path in `runMutation()`.
- `tests/lock-recovery.spec.js`, `tests/backup-retention.spec.js`, `tests/atomic-write.spec.js`, `tests/arg-parsing.spec.js`, `tests/cli-process.spec.js`, and the `tests/e2e/` real-process suite with its own runner and CI step.
- PRD v0.4.0/Design v0.4.0 and PRD v0.4.1/Design v0.4.1 fact sources.

### Changed

- Backup directory names gain zero-padded milliseconds and are created exclusively, so two mutations in the same second no longer overwrite each other's backup. The created directory reports its own path rather than being re-derived from the timestamp.
- A mutation that fails and rolls back successfully no longer leaves its own backup directory behind.
- Windows: `writeTextFileAtomic()` retries a rename that fails with `EPERM`/`EACCES`/`EBUSY`. Those codes are what an antivirus or indexer produces by holding the destination open for a moment, and treating them as permanent aborted a mutation that would have succeeded.
- `add --create-profile` and `edit --create-profile` now actually write the `[profiles.<id>]` section. The flag was parsed, threaded to both app services, and then dropped, so it had never had an effect; the interactive `add` collector, which prompts for the model and base URL precisely because it believes it writes that section, was writing nothing.
- `--claude` on a command with no Claude path is refused (`INVALID_ARGUMENT`, naming the supported commands) instead of being silently ignored. `aps status --claude` used to report Codex state under a flag that asked about Claude.

### Fixed

- `--codex-dir` no longer accepts a flag as its value. `aps list --codex-dir --json` resolved a directory literally named `--json`, dropped the JSON request, and reported an empty provider list as success.

## 0.4.0 - 2026-09-20

Foundation release: no new command and no storage change. It makes the failure surface honest to scripts and makes the suite runnable where it is checked out.

### Added

- CI on Windows and Linux against Node 20 and 22: install, type-check, `npm test`.
- `runCli(argv, io)` as the single implementation of the entry ladder. It takes line-oriented sinks and returns an exit code instead of calling `process.exit`, so the in-process tests exercise the real dispatch rather than a hand-written mirror of it.
- Temporary-directory registry with an `exit` backstop; `makeCodexFixture()` generates the Codex `config.toml` / `auth.json` per test instead of copying a gitignored directory.
- `--claude` runtime coverage end to end: `tests/claude-provider-workflow.spec.js`, driven through `withClaudeEnv()` so it cannot reach a real `~/.claude`.
- `tests/release-contract.spec.js` asserts the version in `package.json`, both `package-lock.json` fields, and `--version` output, and that the PRD/Design pair for each line exists.

### Changed

- `--claude`, `--force`, `--merge`, `--overwrite`, and `--create-profile` are true boolean flags and no longer consume the token after them. `--claude` is position-independent, so `aps --claude list` resolves.
- An unrecognized command exits `1` with `INVALID_ARGUMENT` instead of exiting `0` with the top-level help. A bare group root (`aps config`) still prints that group's help and exits `0`.
- A synchronous parse failure produces the structured error envelope when `--json` is present, instead of escaping as a stack trace.
- `status` reports the tool-home root in both human and JSON output. The field was populated only in the JSON payload under a path the human renderer never read, so the human view printed an empty string.
- `resolveClaudeProviderName()` deleted; Claude provider names arrive as positionals like the Codex ones.
- `getSingleOption()`'s `required` parameter deleted — both of its branches returned `null`.

### Security

- Codex `show --json` continues to return the full `apiKey` by design. It is a documented automation contract and is unchanged by this release; Claude `show` still masks in both modes.

## 0.3.1 - 2026-09-20

Security patch release for the `0.3.0` dual-target line. No architecture change: the `--claude` path, both registries, and the command surface are unchanged.

### Added

- Global `--reveal` flag. `show --claude <name>` now masks credential-shaped env values by default; `--reveal` is the explicit opt-in that prints the real values and includes the raw `settings` blob.
- `export` reports `secretCount` and `containsSecrets`, and emits a warning when exported provider records contain API keys in plaintext.
- New `src/domain/secrets.ts` as the single source of truth for secret-key detection and masking; `maskSecret()` moved there from `src/domain/providers.ts`.
- `ROLLBACK_PATH_REJECTED` error code.
- `tests/secret-handling.spec.js` covering masking, `--reveal`, error-detail redaction, atomic writes, export warnings, and rollback containment.
- PRD v0.3.1 and Design v0.3.1 fact sources.

### Changed

- Managed files are written with owner-only permissions (`0600` for files, `0700` for directories the tool creates) on macOS and Linux. The `chmod` is skipped on Windows, where access is governed by NTFS ACLs and `chmod` only toggles the read-only bit.
- Error details are redacted by walking the whole detail tree against the shared secret-key pattern, instead of skipping only top-level keys containing `apikey`.
- `restoreManifest()` requires an `allowedRoots` argument, sourced from the caller rather than the backup manifest, so a tampered manifest cannot redirect a restore outside the managed roots.
- The `show --claude` payload gained `revealed`, and omits `settings` unless `--reveal` is passed.
- Human `show --claude` output notes when values were masked so `--reveal` is discoverable.

### Fixed

- `writeTextFileAtomic()` no longer deletes the destination before renaming. The previous `rm`-then-`rename` left a window where the destination did not exist; `rename` alone already replaces an existing file on both platforms.
- `auth.json` writes go through the atomic helper instead of a bare `fs.writeFileSync`, closing the last non-atomic write on the mutation path and bringing the file under the permission fix.

### Security

- `show --claude <name>` no longer returns live `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` values, in human or `--json` output.
- Codex `show --json` still returns the full `apiKey` by design; it is a documented automation contract and is unchanged in this release.
- On Windows, `chmod`-based permission tightening is inert. The exposure there is at the NTFS ACL layer and is documented as an operator action in `docs/agent-provider-switch-2.x-roadmap.md` (P0-2).

## 0.3.0 - 2026-07-18

Claude Code provider switching release.

### Added

- Claude Code provider management via `--claude` flag on `add`, `switch`, `list`, `show`, `current`, `remove` commands.
- `aps add --claude <name> --from-file <settings.json>` imports a Claude Code settings file as a named profile.
- `aps switch --claude <name>` atomically replaces `~/.claude/settings.json` with the stored profile.
- `aps current --claude` detects which registered profile matches the active Claude settings.
- `aps list --claude` shows all Claude profiles with active detection.
- `aps show --claude <name>` displays full Claude profile details including env vars.
- `aps remove --claude <name>` removes a Claude profile from the registry.
- Separate `claude-providers.json` storage in tool home directory.
- `APS_CLAUDE_DIR` environment variable to override the Claude Code directory.
- PRD v0.3.0 and Design v0.3.0 fact sources.

### Changed

- Package description updated to reflect dual-target (Codex + Claude Code) support.
- Help text for `add`, `switch`, `list`, `show`, `current`, `remove` updated with `--claude` usage.

## 0.2.2 - 2026-07-15

Version bump and command summary update.

## 0.2.1 - Unreleased

Provider-management-only consolidation release.

- Repositioned the current development line as a local-first Codex provider/model-provider management CLI.
- Removed current-facing Copilot login, `add --copilot`, bridge command, SDK, HTTP proxy bridge, and local bridge runtime contracts from docs and command presentation.
- Added `0.2.1` PRD and design fact sources.
- Updated release-contract coverage around the reduced provider-management command surface.
## 0.1.5 - 2026-07-01

Copilot Bridge process-visibility and redaction patch release.

### Changed

- Added stable Copilot bridge runtime events for assistant intent, message deltas, reasoning deltas, tool lifecycle, permission lifecycle, user-input requests, exit-plan-mode requests, and session status signals.
- Projected Copilot process/status events into Responses streaming commentary items and reasoning/progress updates into Responses reasoning summary events.
- Forwarded adapter runtime events through the bridge worker while keeping Chat Completions streaming text-only.
- Hardened unknown SDK event summaries with key-aware and value-aware redaction plus bounded truncation.
- Added adapter-level regression coverage for raw SDK session event normalization.

## 0.1.4 - Unreleased

Bridge stability and observability release.

### Changed

- Reworked Copilot bridge reuse to retry transient health/auth probe failures before replacing an existing worker.
- Added persisted bridge runtime logging, restart reason tracking, and surfaced `logPath` metadata across bridge, switch, status, and doctor flows.
- Extended bridge runtime state and start results with persisted probe/restart metadata for diagnostics.
- Restored the interactive provider picker `current` hint for legacy top-level `profile` state when `model_provider` is absent or unresolved.
- Replaced the hard-coded test runner with deterministic `tests/*.spec.js` discovery and aligned the widened release gate with the current help, runtime, and workflow contracts.

## 0.1.3 - Unreleased

Copilot login hotfix release.

### Changed

- Replaced the legacy `CopilotClient` constructor fields with the official `RuntimeConnection.forStdio({ path })` SDK connection path.
- Resolved the managed SDK runtime against `@github/copilot/npm-loader.js` instead of relying on implicit bundled package lookup.
- Kept human `copilot --help` and `copilot login` invocations on the bundled `.bin` shim while separating SDK runtime resolution from terminal CLI resolution.
- Added a focused `0.1.3` regression spec covering the Copilot login compatibility fix.

## 0.1.2 - Unreleased

Copilot runtime repair release.

### Changed

- Pinned the managed Copilot runtime installer to `@github/copilot-sdk@1.0.2` instead of installing `latest`.
- Added a Copilot-only Node.js runtime gate. Direct providers still support Node.js `>=18`; Copilot runtime paths require Node.js `>=20`.
- Reworked SDK loading to resolve `@github/copilot-sdk` from the managed runtime install directory via `createRequire()`.
- Replaced session-based auth probing with `CopilotClient.getAuthStatus()`.
- Added explicit Copilot runtime errors for unsupported Node runtime, SDK version, SDK API shape, and bridge upstream timeout.
- Reworked the bridge worker to keep one long-lived Copilot client, create one session per request, disconnect sessions after use, and serialize requests.
- Updated Responses streaming to emit initial SSE events before the upstream request completes and to keep the connection alive with heartbeat comments.
- Added Copilot config projection for `stream_idle_timeout_ms = 300000`.

### Documentation

- Added `0.1.2` PRD and design docs describing the experimental Copilot bridge boundary.
- Removed obsolete `0.0.x` transition docs and old test reports from the active docs tree.

## 0.1.1 - 2026-05-28

Documentation and fact-source completion release.

### Changed

- Added missing `0.1.1` PRD/design fact sources.
- Aligned README, CLI usage, product overview, architecture notes, and AI-facing README around the stable `0.1.x` route model.
- Clarified that `profile` is a managed alias for the Codex `model_provider` route id.

## 0.1.0 - 2026-05-28

First stable documentation baseline.

### Added

- Stable command-surface summary for direct provider and Copilot provider workflows.
- Stable JSON envelope contract for automation.
- Stable split-state model: tool home for managed state, target Codex home for runtime projection.

### Notes

- `migrate` remains an advanced adopt helper.
- `setup` remains a deprecated compatibility entry.
- Development-version policy remains in effect: no automatic migration shims or backward-compatibility preservation logic unless explicitly requested.

