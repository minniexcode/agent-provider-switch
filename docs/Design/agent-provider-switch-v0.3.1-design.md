# agent-provider-switch v0.3.1 Design Document

Security patch release for the `0.3.0` dual-target line. No architecture change: the `--claude`
parallel path, both registries, and the command surface are untouched.

## Overview

`0.3.0` shipped Claude Code provider switching. Claude profiles are stored as complete
`settings.json` blobs, and those blobs contain `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`. The
Codex path was written with secret handling in mind (`maskSecret()`, a documented masking contract);
the Claude path was not. This release closes that asymmetry and fixes two write-safety defects that
were found alongside it.

Source of record for the findings: `docs/agent-provider-switch-2.x-roadmap.md` §2 — `P0-1` (Claude token
masking), `P1-7`, `P1-8`, plus the file-permission, non-atomic-write, and rollback-manifest
findings. This release predates the roadmap's renumbering: the write and rollback findings are
`P0-4` and `P0-6` in the current inventory, and the permission finding has since left it.

## Scope

**In:**

1. Mask Claude secrets in `show --claude`; add a global `--reveal` escape hatch.
2. Tighten file permissions on everything the tool writes (POSIX only).
3. Widen error-detail redaction beyond the current `"apikey"` substring test.
4. Warn when `export` writes plaintext keys.
5. Make the atomic-write helper actually atomic; route the one non-atomic write through it.
6. Containment check on rollback restore paths.

**Out:** every Phase 2 and Phase 3 item in the roadmap.

---

## 1. Secret Masking and `--reveal`

### The problem

`claudeShowProvider()` returns the raw `env` map **and** the complete `settings` blob
(`src/app/claude-show-provider.ts:25-26`). The human renderer then prints every env entry verbatim
(`src/cli/output.ts:392-398`), and `--json` carries the same payload. Every Claude profile on the
authoring machine contains a live token.

### Flag placement — global, not per-command

`--reveal` is parsed as a **global** flag alongside `--json` and `--codex-dir`, in
`parseArgs()`'s first pass (`src/commands/args.ts:15-34`).

This is deliberate. The second pass treats any `--x` followed by a non-`--` token as
`--x <value>` (`src/commands/args.ts:75-88`), so registering `--reveal` as a command option would
make `aps show --reveal deepseek` swallow `deepseek`. Pass 1 matches tokens by exact equality, so
a global flag sidesteps that parser behaviour entirely. Fixing the parser is Phase 2 work
(roadmap P1-1); this release does not depend on it.

`GlobalOptions` gains one field:

```ts
export type GlobalOptions = {
  json: boolean;
  reveal: boolean;          // NEW
  codexDir: string | null;
  codexDirExplicit?: boolean;
};
```

### Masking rule

New module `src/domain/secrets.ts` — the single source of truth, so the service layer and the
renderer cannot drift apart:

```ts
export const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|auth)/i;

export function isSecretKey(key: string): boolean;
export function maskSecret(value: string): string;          // MOVED from src/domain/providers.ts:147-155
export function maskSecretValues(values: Record<string, string>): Record<string, string>;
export function redactSecretValues(value: unknown): unknown; // recursive, for error details
```

`maskSecret()` moves out of `providers.ts` (it has exactly one importer,
`src/app/show-provider.ts:1`, which is updated). Keeping it there would put a shared secret utility
inside the Codex domain module, which is the wrong home once Claude depends on it.

Pattern check against the real env keys present on the authoring machine: it matches
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` and nothing else. `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_ATTRIBUTION_HEADER`, `MCP_CONNECT_TIMEOUT_MS`, and the `CLAUDE_CODE_*` feature flags
are left alone.

### Payload contract change

```ts
// Before
{ target: "claude", provider, model, baseUrl, theme, note, tags, env, settings }

// After — default
{ target: "claude", provider, model, baseUrl, theme, note, tags,
  env: <masked>, revealed: false }

// After — `--reveal`
{ target: "claude", provider, model, baseUrl, theme, note, tags,
  env, settings, revealed: true }
```

Two decisions worth recording:

- **`settings` is omitted, not masked, unless `--reveal`.** It is an opaque blob that can nest
  arbitrarily; recursively guessing which of its values are secret is unreliable. Nothing consumes
  `settings` from `show` — the identity fields the command exists to display are already extracted
  by `summarizeClaudeSettings()` (`src/domain/claude-providers.ts:95-106`). Omitting it also makes
  the renderer's `default:` fallback (`src/cli/output.ts:430-431`), which `JSON.stringify`s the whole
  payload, safe by construction.
- **`revealed` is part of the payload**, not implied. It lets the renderer apply its own masking
  pass without having to guess whether the service already did.

### Defence in depth in the renderer

`renderClaudeHumanSuccess()`'s `show` case re-applies the mask:

```ts
const revealed = data.revealed === true;
for (const [key, value] of Object.entries(env)) {
  const display = revealed || !isSecretKey(key) ? value : maskSecret(value);
  lines.push(`    ${key}=${display}`);
}
```

The service layer is the primary masker; this pass guarantees the terminal stays clean even if a
future service-layer change forgets. It is a real second line rather than a redundant copy because
it keys off `revealed` instead of re-deriving whether masking happened.

### Not changed

`list --claude` and `current --claude` return only name, model, and base URL
(`src/app/claude-list-providers.ts:20-30`) — no secret is reachable there, so they are untouched.

---

## 2. File Permissions

### The problem

There is no `chmod` or `mode` call anywhere in `src/`. Every managed file inherits the process
umask, so on POSIX the mode is whatever the environment happens to hand out, with no floor.

The first revision of this document cited a `0666` reading on the authoring machine as evidence.
That reading was from MSYS `stat` on Windows, where the POSIX mode is synthetic — running
`chmod -R go-rwx` on this machine exits 0 and changes nothing, and `icacls` shows no
world-readable ACE. The finding stands on the POSIX argument above, not on that number. The real
exposure on this machine is a separate, ACL-level one; see the correction in Implementation Notes.

### Approach — one choke point

`writeTextFileAtomic()` (`src/storage/fs-utils.ts:15-24`) is already the single write path for all
managed JSON and TOML:

| File | Via |
|---|---|
| `providers.json` | `writeProvidersFile` (`src/storage/providers-repo.ts:33`) |
| `claude-providers.json` | `writeClaudeProvidersFile` (`src/storage/claude-providers-repo.ts:42`) |
| `~/.claude/settings.json` | `writeClaudeSettings` (`:80`) |
| `~/.codex/config.toml` | `config-repo.ts:136`, `:165` |
| `agent-provider-switch.json` | `tool-config-repo.ts:47`, `:59` |
| `backups/*/manifest.json`, `backups/latest.json` | `backup-repo.ts:46`, `:87` |

So the fix goes in two functions rather than at every call site:

```ts
const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE  = 0o700;

export function ensureDir(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: SECURE_DIR_MODE });
}

export function writeTextFileAtomic(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, contents, { encoding: "utf8", mode: SECURE_FILE_MODE });
  fs.renameSync(tempPath, filePath);
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, SECURE_FILE_MODE);
  }
}
```

Two details:

- **`chmod` after the rename, not just the `mode` argument.** The `mode` passed to `writeFileSync`
  is masked by the process umask, so it is a floor rather than an exact value. `chmodSync` is exact.
- **`mkdirSync`'s `mode` applies only to directories it actually creates.** Pre-existing `~/.codex`
  and `~/.claude` are left alone, so this cannot unexpectedly re-permission another tool's home
  directory.

**Windows:** `chmodSync` only toggles the read-only bit there. The guard skips it entirely rather
than pretending to secure something, and the call is a silent no-op on that platform.

### Backups inherit automatically

Backup payload files are created with `fs.copyFileSync` (`src/storage/backup-repo.ts:27`), which
**preserves the source mode**. Once the sources are `0600`, new backups are `0600` without further
work.

### Existing files

Files written before this release keep their previous mode until the next write touches them. Every
mutating command rewrites its target, so this resolves itself in normal use. For immediate
remediation of all files at once, on **macOS and Linux** only:

```bash
chmod -R go-rwx ~/.config/agent-provider-switch ~/.codex/config.toml ~/.codex/auth.json ~/.claude/settings.json
```

On Windows this command is a **no-op** — verified: it exits 0 and leaves every mode unchanged,
because NTFS has no group/other bits for MSYS `chmod` to set. Access there is decided by NTFS ACLs,
which are not this release's subject and are not improved by the code change (§2's `chmodSync` is
skipped on win32 for the same reason).

Reading a file does **not** silently re-permission it. Read-only commands staying read-only is worth
more than closing a short window on a local single-user machine.

---

## 3. Error-Detail Redaction

`printErrorDetails()` skips detail keys whose lowercase name contains `apikey`
(`src/storage/fs-utils.ts:59-61`). `token`, `auth_token`, `authorization`, `secret`, and `api_key`
all pass through, and `formatDetail()` (`:39-47`) `JSON.stringify`s nested objects wholesale.

Replaced by the shared recursive walker:

```ts
export function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSecretKey(key)
          ? (typeof entry === "string" ? maskSecret(entry) : "[redacted]")
          : redactSecretValues(entry),
      ])
    );
  }
  return value;
}
```

`printErrorDetails()` calls it once before formatting and drops its inline substring test.
Checked against every detail key currently produced in `src/` — `file`, `cause`, `provider`,
`availableProviders`, `activeOperation`, `activePid`, `activeSince`, `requestedOperation`,
`rollbackApplied`, `backupPath`, `backupId`, `directory`, `codexDir`, `profile`, `reason` — none
match `SECRET_KEY_PATTERN`, so no existing error message changes.

---

## 4. Export Warning

`exportProviders()` writes the full registry, including `apiKey`, to a user-specified path with no
caution (`src/app/export-providers.ts:11-34`), reporting only `{ exportedTo, count }`.

Add to the payload:

```ts
{
  exportedTo, count,
  secretCount,          // records with a non-empty apiKey
  containsSecrets       // secretCount > 0
}
```

and push a `warnings` entry when `containsSecrets`:

> Exported N provider records containing API keys in plaintext. Do not commit this file.

`CommandResult` already carries an optional `warnings: string[]` (`src/app/types.ts:5-8`), and
`renderHumanSuccess` already renders warnings, so no renderer change is needed for the human path.

An automated `--redact` export mode is **not** in this release. The goal here is that a user cannot
export keys without being told; giving them a redacted variant is a separate feature.

---

## 5. Atomic Write Correctness

### 5a. `writeTextFileAtomic` is not atomic

The current implementation deletes the destination and then renames:

```ts
fs.writeFileSync(tempPath, contents, "utf8");
if (fs.existsSync(filePath)) {
  fs.rmSync(filePath, { force: true });   // ← the window
}
fs.renameSync(tempPath, filePath);
```

Between the `rm` and the `rename` the destination does not exist. The `rm` is also unnecessary:
Node's `fs.renameSync` replaces an existing destination on both platforms — POSIX `rename(2)`
overwrites, and Windows uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`. Removing lines 20-22
restores genuine atomicity with no other change.

The temp file is already a sibling of the destination, so the rename stays within one filesystem,
which is what makes it atomic in the first place. That property must be preserved.

### 5b. `auth.json` bypasses the helper entirely

`writeOpenAiApiKeyAuth()` uses a bare `fs.writeFileSync` (`src/storage/auth-repo.ts:83`) — the only
non-atomic write on the mutation path, and it writes the file that holds `OPENAI_API_KEY`. Route it
through `writeTextFileAtomic()`. This also brings it under the §2 permission fix, which it currently
escapes.

---

## 6. Rollback Path Containment

`restoreManifest()` copies to whatever absolute path the manifest names
(`src/storage/backup-repo.ts:58-81`), and `validateBackupManifest()` checks types only
(`src/domain/backups.ts:22-64`). A tampered manifest turns `rollback` into an arbitrary file write.

The fix is to source the allowlist from the **caller**, not the file. A root recorded inside the
manifest would be tamperable by the same edit that changes the path.

```ts
export function restoreManifest(manifest: BackupManifest, allowedRoots: string[]): void
```

Every `entry.restorePath` must resolve inside one of `allowedRoots`; otherwise throw
`ROLLBACK_PATH_REJECTED`. The check is `path.relative(resolvedRoot, resolvedTarget)` not starting
with `..` and not absolute.

Call sites — both already know the managed roots:

- `src/app/run-mutation.ts:47` — pass the tool home and the target Codex directory.
- `src/app/rollback-backup.ts:14` — same.

The parameter is **required**, not optional, so a future call site cannot silently skip the check.

This is the lowest-value item in the release for a single-user local tool and is the one to drop
first if the phase needs trimming.

---

## Key Types

```ts
// src/commands/types.ts
export type GlobalOptions = {
  json: boolean;
  reveal: boolean;
  codexDir: string | null;
  codexDirExplicit?: boolean;
};

// src/domain/secrets.ts  (new)
export const SECRET_KEY_PATTERN: RegExp;
export function isSecretKey(key: string): boolean;
export function maskSecret(value: string): string;
export function maskSecretValues(values: Record<string, string>): Record<string, string>;
export function redactSecretValues(value: unknown): unknown;

// src/app/claude-show-provider.ts
export async function claudeShowProvider(args: {
  claudeProvidersPath: string;
  providerName: string;
  reveal: boolean;          // NEW
}): Promise<CommandResult>;
```

## Error Codes

One new code, added to the `ErrorCode` union in `src/domain/errors.ts`:

- `ROLLBACK_PATH_REJECTED` — a backup manifest named a restore path outside the allowed roots.

## Files Modified

| File | Change |
|---|---|
| `src/domain/secrets.ts` | **New.** Secret-key pattern, `maskSecret` (moved), the mask/redact helpers |
| `src/domain/providers.ts` | Remove `maskSecret` (moved to `secrets.ts`) |
| `src/domain/errors.ts` | Add `ROLLBACK_PATH_REJECTED` |
| `src/commands/types.ts` | Add `reveal` to `GlobalOptions` |
| `src/commands/args.ts` | Parse `--reveal` in pass 1; new `defaultParsed` field |
| `src/app/claude-show-provider.ts` | Mask env, omit `settings`, add `reveal` + `revealed` |
| `src/app/show-provider.ts` | Update the `maskSecret` import path |
| `src/commands/claude-handlers.ts` | Pass `ctx.options.reveal` into `claudeShowProvider` |
| `src/cli/output.ts` | Mask env in the `show` case unless `revealed` |
| `src/storage/fs-utils.ts` | Secure modes; drop the `rmSync`; recursive redaction in `printErrorDetails` |
| `src/storage/auth-repo.ts` | `writeOpenAiApiKeyAuth` → `writeTextFileAtomic` |
| `src/storage/backup-repo.ts` | `restoreManifest` gains the required `allowedRoots` check |
| `src/app/run-mutation.ts` | Pass `allowedRoots` |
| `src/app/rollback-backup.ts` | Pass `allowedRoots` |
| `src/app/export-providers.ts` | `secretCount` / `containsSecrets` + warning |
| `src/commands/registry.ts` | `show` usage line gains `[--reveal]` |
| `src/commands/help.ts` | List `--reveal` under global options (see Implementation Notes) |
| `README.md` | Document `--reveal`; update the `show` contract note |

## Testing

New `tests/secret-handling.spec.js`:

1. `show --claude <name>` masks `*_TOKEN` / `*_KEY` env values and omits `settings`.
2. `show --claude <name> --reveal` returns the real values.
3. `--reveal` placed before the provider name (`show --reveal <name>`) still resolves the provider —
   this is the regression that fixes the parser interaction for this flag.
4. `list --claude` and `current --claude` are unchanged.
5. `printErrorDetails` masks a nested `{ env: { ANTHROPIC_AUTH_TOKEN } }` detail.
6. `export` reports `containsSecrets: true` and emits a warning.

Extend `tests/provider-workflow.spec.js`:

7. `writeTextFileAtomic` leaves the destination readable at every point (write, then assert the file
   still exists and is intact — the current `rm`-then-rename would fail a concurrent-read probe).

Plus a permissions assertion, skipped on Windows:

8. On POSIX, after a mutation, `claude-providers.json` and `auth.json` report mode `600`.

The Claude-path tests depend on the fixture fix that is currently Phase 2 scope (roadmap P1-9): the
suite cannot run on a fresh clone because `dev-codex/local-sandbox` is gitignored and absent. Either
that fix is pulled forward into this release, or these specs land once it does. **Recommend pulling
it forward** — shipping the security fix with no executable test for the thing being fixed is the
weakest part of this plan.

## Non-Goals

- **Codex `show --json` keeps emitting the full `apiKey`.** It is documented as an automation
  contract (`src/commands/registry.ts:103-106`) and is unchanged. `--reveal` is parsed globally but
  only affects the Claude path in this release. Unifying the two is a breaking JSON-contract change
  and was deliberately deferred.
- No change to the boolean-flag parser (Phase 2), backup retention (Phase 2), or lock recovery
  (Phase 2).
- No automatic migration or re-permissioning of existing files beyond the next-write behaviour
  described in §2.

---

## Implementation Notes

Recorded after implementation, for the parts where the code diverged from this document.

### `allowedRoots` is built by the callers, and §6 is wider than planned

`runMutation()` declares an optional `codexDir`, but none of its nine call sites pass it — they all
pass `lockPath`. Deriving the roots from `codexDir` there would have produced an empty allowlist and
rejected every rollback. It instead uses the caller's own `files` list plus the backup directory's
parent, which is a tighter set than the design assumed and needs no call-site change.

`rollbackBackup()` gained the explicit `allowedRoots` parameter and `handlers.ts` supplies three
roots: the tool home, the Codex directory, and the Claude directory. The third is required because
both targets share one `backups/` directory and one `latest.json`, so `aps rollback` after a
`switch --claude` has to be allowed to restore `~/.claude/settings.json`. That is the only place the
Codex handler reaches for Claude paths, and it is commented as such.

`restoreManifest()` throws `ROLLBACK_PATH_REJECTED`; `rollbackBackup()` re-throws that code verbatim
rather than folding it into `ROLLBACK_FAILED`, because a rejected manifest is not a transient
failure. `runMutation()` still reports `ROLLBACK_FAILED` with the rejection in `rollbackReason` —
there the mutation itself is the primary failure and rollback is a supporting detail.

### Two additions not in this document

- `--reveal` is listed in the top-level help text (`src/commands/help.ts`), not just in the `show`
  usage line. The document named only `registry.ts`; a global flag absent from the global-flag list
  is undiscoverable.
- The human renderer prints `(secret values masked; pass --reveal to print them)` after a masked env
  block, so the escape hatch is reachable from the output a user is looking at.

### Correction: what the permissions work does and does not buy

Verified on the authoring machine after implementation.

- The POSIX mode is synthetic on Windows. `chmod -R go-rwx` over the managed paths exits 0 and
  changes nothing; `stat` still reports `644`. §2's code change is therefore inert here, exactly as
  its win32 guard intends.
- The real exposure on that machine is at the ACL layer and was **not** in the original finding:
  `~/.claude` and `~/.codex` carry an explicit `CodexSandboxUsers:(OI)(CI)(RX)` ACE, whose members
  are `CodexSandboxOffline` and `CodexSandboxOnline` — the Codex Windows sandbox identities. The
  Codex sandbox can read `~/.claude/settings.json`, i.e. `ANTHROPIC_AUTH_TOKEN`.
- `~/.config/agent-provider-switch` carries no such ACE, so the tool's own registry and backup copies are
  the better-protected files. The exposure is on the file `switch --claude` writes, and it is
  inherited from `~/.claude`'s own ACL rather than created by this tool.
- Removing it needs `icacls "…\.claude" /remove:g "CodexSandboxUsers"`. That reaches into another
  tool's directory and is a judgement call about the Codex sandbox's intended reach, so it is left
  to the operator and documented in this note rather than in code.

The lesson worth carrying into Phase 2: on Windows, read `icacls`, not `stat`. A roadmap finding
built on the POSIX mode display will be wrong in both directions — it invents an exposure that is
not there and misses the ACE that is.

### Testing: the fixture fix was not needed

The document recommended pulling the `dev-codex/local-sandbox` fixture fix forward. It was not
needed: every test in `tests/secret-handling.spec.js` builds its tool home and Claude directory
programmatically, so the suite is green on a fresh clone without it. The three `provider-workflow`
fixture failures remain, unchanged and still Phase 2 (roadmap P1-9).

Two tests were added beyond the eight listed: a direct `redactSecretValues` unit test (array
traversal, the `[redacted]` placeholder, and the pattern's non-matches) and a rollback-containment
test that asserts a tampered `restorePath` is rejected and that the file it named is left untouched.
The atomic-write regression test (item 7) lives in the new spec rather than
`tests/provider-workflow.spec.js`, to keep it clear of that file's pre-existing failures.
