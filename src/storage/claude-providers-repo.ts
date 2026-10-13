import * as fs from "node:fs";
import {
  ClaudeProvidersFile,
  ClaudeProviderRecord,
  sortClaudeProviders,
  validateClaudeProvidersShape,
} from "../domain/claude-providers";
import { RegistryRepo, createRegistryRepo } from "./provider-registry-repo";
import { writeTextFileAtomic } from "./fs-utils";

/**
 * The Claude registry as a generic repo over its own codec.
 *
 * The codec is the Claude pair, never a merged view: `settings` is stored as the delta it is, and
 * the repo hands back exactly what the file holds. `readClaudeProvidersFile` is what `remove`
 * writes back, so a resolved reader here would materialize the defaults into every surviving
 * record. Resolving is done by `resolveClaudeProvidersFile()`, by read-only callers, afterwards.
 */
function repoFor(providersPath: string): RegistryRepo<ClaudeProviderRecord> {
  return createRegistryRepo<ClaudeProviderRecord>(
    providersPath,
    { decode: validateClaudeProvidersShape, encode: sortClaudeProviders },
    {
      label: "claude-providers.json",
      // Unlike Codex, a missing Claude registry has a remedy the user has not been told yet.
      missingMessage: "claude-providers.json not found. Run `aps add --claude` first.",
      notFoundSubject: "Claude provider",
      // A near-miss name is the common case on a filesystem path, so the alternative is named.
      notFoundDetails: (file) => ({ availableProviders: Object.keys(file.providers).sort() }),
    }
  );
}

/**
 * Reads and validates claude-providers.json from disk.
 */
export function readClaudeProvidersFile(providersPath: string): ClaudeProvidersFile {
  return repoFor(providersPath).read("required");
}

/**
 * Reads claude-providers.json when it exists, otherwise returns an empty registry.
 */
export function readClaudeProvidersFileIfExists(providersPath: string): ClaudeProvidersFile {
  return repoFor(providersPath).read("empty-if-missing");
}

/**
 * Persists claude-providers.json using deterministic key ordering.
 */
export function writeClaudeProvidersFile(providersPath: string, providers: ClaudeProvidersFile): void {
  repoFor(providersPath).write(providers);
}

/**
 * Returns a single Claude provider record or throws a typed not-found error.
 */
export function readClaudeProviderRecord(providersPath: string, providerName: string): ClaudeProviderRecord {
  const repo = repoFor(providersPath);
  return repo.find(repo.read("required"), providerName);
}

/**
 * What is at the Claude settings path.
 *
 * Three answers rather than two, because "no file" and "a file nothing can read" call for
 * different fixes and the reader is the only place that can tell them apart. Collapsing them is
 * how a corrupt `settings.json` gets reported as an unmanaged one: the file is there, so it is
 * not missing, and it parsed to nothing compare-able, so no provider matched it. The reported
 * remedy would then be "register the provider you are using" when the real one is "repair the
 * file".
 */
export type ClaudeSettingsState =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; settings: Record<string, unknown> };

/**
 * Reads the current Claude Code settings.json from disk, and says what stopped it when it cannot.
 */
export function readClaudeSettingsState(settingsPath: string): ClaudeSettingsState {
  if (!fs.existsSync(settingsPath)) {
    return { status: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error: unknown) {
    return { status: "invalid", reason: `settings.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  // A top-level array or scalar parses cleanly and is still not settings. It has to be refused
  // here: `validateClaudeProvidersShape()`'s rules are the registry's, and this is the file Claude
  // Code itself reads, so an array would otherwise reach the identity comparison as an object with
  // no members and read as "matches nothing" rather than as "cannot be read".
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", reason: "settings.json must contain a JSON object." };
  }

  return { status: "ok", settings: parsed as Record<string, unknown> };
}

/**
 * Reads the current Claude Code settings.json from disk.
 *
 * The two-answer form, for the callers that only need the settings and are already gated on the
 * file existing. `null` means "nothing to compare against", which is the honest answer for an
 * absent file and for an unreadable one alike; a caller that has to tell a user *why* should use
 * {@link readClaudeSettingsState}.
 */
export function readClaudeSettings(settingsPath: string): Record<string, unknown> | null {
  const state = readClaudeSettingsState(settingsPath);
  return state.status === "ok" ? state.settings : null;
}

/**
 * Writes Claude Code settings.json atomically.
 */
export function writeClaudeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  writeTextFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
