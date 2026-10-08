# agent-provider-switch v0.3.1 PRD

## Summary

`0.3.1` is a security patch release for the `0.3.0` dual-target line of `@minniexcode/agent-provider-switch`. It adds no new command surface and changes no architecture. It closes the secret-handling asymmetry between the Codex path (written with masking in mind) and the Claude path (which returned live tokens), and fixes two write-safety defects found alongside it.

Source of record for the findings: `docs/agent-provider-switch-2.x-roadmap.md` §2 — `P0-1` (Claude token masking), `P1-7`, `P1-8`, plus the file-permission, non-atomic-write, and rollback-manifest findings. This release predates the roadmap's renumbering: the write and rollback findings are `P0-4` and `P0-6` in the current inventory, and the permission finding has since left it. Design detail: `docs/Design/agent-provider-switch-v0.3.1-design.md`.

## Version

- Version line: `0.3.1`
- Target package version: `0.3.1`
- Status: current repository development line
- Predecessor: `0.3.0`

## Goals

- Stop `show --claude <name>` from returning live `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` values in human or `--json` output.
- Provide an explicit, discoverable escape hatch for reading real values back.
- Give every file this tool writes an owner-only permission floor on POSIX.
- Widen error-detail redaction beyond the previous single `apikey` substring test.
- Tell users when `export` writes plaintext keys, instead of writing them silently.
- Make the atomic-write helper actually atomic, and route the one non-atomic write through it.
- Prevent a tampered backup manifest from turning `rollback` into an arbitrary file write.

## Non-Goals

`0.3.1` does not implement:

- Any change to the boolean-flag parser. `--reveal` is parsed as a global flag by exact token match; fixing the `--flag value` greediness is Phase 2 work (roadmap P1-1).
- Backup retention or lock recovery changes (Phase 2).
- A `--redact` export mode. The goal is that a user cannot export keys without being told, not that a redacted variant exists.
- Unification of the Codex and Claude `show` JSON contracts. Codex `show --json` keeps emitting the full `apiKey`; it is a documented automation contract, and changing it would be a breaking JSON-contract change.
- Automatic migration or re-permissioning of files written by earlier versions. Files resolve on their next write, and a one-line `chmod` is documented for immediate remediation.
- Any Windows ACL work. The exposure there is at the NTFS ACL layer and is left to the operator; see Design v0.3.1 Implementation Notes.

## Current Command Surface

Unchanged from `0.3.0` except for the new global flag:

- `show <provider> [--claude] [--reveal]` — the only command whose behaviour changes.
- All other commands from `0.3.0` are unchanged: `init`, `migrate`, `list [--claude]`, `current [--claude]`, `status`, `config show`, `config list-profiles`, `add` (with `--claude`), `edit`, `switch [--claude]`, `remove [--claude]`, `import`, `export`, `backups list`, `rollback`, `doctor`, `setup` (deprecated).

## Secret Handling Model

`--reveal` is a **global** flag, parsed alongside `--json` and `--codex-dir`. It is not a per-command option, because the second parser pass treats any `--x <non-flag>` pair as a valued option and would swallow a provider name that follows it.

`show --claude` defaults:

- `env` values whose key matches the shared secret pattern are masked, preserving a short fingerprint.
- The raw `settings` blob is **omitted**, not masked. It is opaque and can nest arbitrarily, so there is no reliable rule for which of its values are credentials.
- The payload carries `revealed: false`, so renderers can distinguish masked output without re-deriving whether masking happened.

With `--reveal`: real `env` values are returned, `settings` is included, and `revealed: true`.

The secret pattern is a single shared constant (`SECRET_KEY_PATTERN`) used by the service layer, the human renderer, and error-detail redaction. It matches `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` while leaving `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_ATTRIBUTION_HEADER`, `MCP_CONNECT_TIMEOUT_MS`, and the `CLAUDE_CODE_*` feature flags untouched.

`list --claude` and `current --claude` return only name, model, and base URL, so no secret is reachable there and they are unchanged.

## File Permission Model

Managed files are written `0600`; directories this tool creates are `0700`. Both apply on POSIX only.

- The `mode` argument alone is a floor, not an exact value, because the process umask masks it. `chmod` is applied after the rename so the final mode is exact.
- `mkdir` mode applies only to directories that do not already exist, so a pre-existing `~/.codex` or `~/.claude` is never re-permissioned.
- On Windows `chmod` only toggles the read-only bit, so it is skipped rather than presented as security. Access there is governed by NTFS ACLs.
- Reading a file does not silently re-permission it: read-only commands staying read-only is worth more than closing a short window on a local single-user machine.
- Backup payloads are copies, so they inherit the source mode once the sources are `0600`.

## Write Safety

- The atomic-write helper's rename is now the only step that touches the destination. The previous implementation removed the destination first, leaving a window in which it did not exist. `rename` alone replaces an existing destination on both POSIX and Windows.
- The temp file stays a sibling of the destination, so the rename never crosses a filesystem.
- `auth.json` is written through the same helper, closing the last non-atomic write on the mutation path and bringing the file under the permission fix.

## Rollback Containment

`restoreManifest()` requires an `allowedRoots` argument. Every restore path must resolve inside one of those roots, or the restore is rejected with `ROLLBACK_PATH_REJECTED`.

The allowlist is sourced from the caller, never from the backup manifest: the manifest is a file on disk, and a root recorded inside it would be editable by the same change that redirects a restore path. The parameter is required rather than optional, so a future call site cannot silently skip the check.

`rollbackBackup()` surfaces `ROLLBACK_PATH_REJECTED` verbatim rather than folding it into `ROLLBACK_FAILED`, because a rejected manifest is not a transient failure.

## Acceptance Criteria

- Package metadata reports `0.3.1` in `package.json` and `package-lock.json`.
- `aps --version` prints `0.3.1`.
- `aps show --claude <name>` masks credential-shaped env values and omits `settings`, in both human and `--json` output.
- `aps show --claude <name> --reveal` returns real values and includes `settings`.
- `--reveal` placed before the provider name still resolves that name as a positional.
- `aps list --claude` and `aps current --claude` expose no secret material.
- `aps export` reports `containsSecrets` and emits a plaintext-key warning when the registry holds API keys.
- `printErrorDetails` redacts nested and non-`apikey` secret keys.
- On POSIX, a managed write leaves the file at mode `600` and a created directory at `700`.
- `writeTextFileAtomic` leaves the destination present and intact at rename time.
- `restoreManifest` rejects a restore path outside the allowed roots and leaves the named file untouched.
- `npm run build` passes without errors.
- `--reveal` is documented in `README.md`, `README.CN.md`, `README.AI.md`, `docs/cli-usage.md`, the top-level help text, and the `show` usage line.
