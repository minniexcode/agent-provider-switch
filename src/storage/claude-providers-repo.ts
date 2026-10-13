import * as fs from "node:fs";
import { cliError, normalizeError } from "../domain/errors";
import {
  ClaudeProvidersFile,
  ClaudeProviderRecord,
  sortClaudeProviders,
  validateClaudeProvidersShape,
} from "../domain/claude-providers";
import { writeTextFileAtomic } from "./fs-utils";

/**
 * Reads and validates claude-providers.json from disk.
 */
export function readClaudeProvidersFile(providersPath: string): ClaudeProvidersFile {
  if (!fs.existsSync(providersPath)) {
    throw cliError("PROVIDERS_NOT_FOUND", "claude-providers.json not found. Run `aps add --claude` first.", {
      file: providersPath,
    });
  }
  const raw = fs.readFileSync(providersPath, "utf8");
  try {
    return validateClaudeProvidersShape(JSON.parse(raw));
  } catch (error: unknown) {
    throw cliError("PROVIDERS_PARSE_ERROR", "Failed to parse claude-providers.json.", {
      file: providersPath,
      cause: normalizeError(error).message,
    });
  }
}

/**
 * Reads claude-providers.json when it exists, otherwise returns an empty registry.
 */
export function readClaudeProvidersFileIfExists(providersPath: string): ClaudeProvidersFile {
  return fs.existsSync(providersPath) ? readClaudeProvidersFile(providersPath) : { providers: {} };
}

/**
 * Persists claude-providers.json using deterministic key ordering.
 */
export function writeClaudeProvidersFile(providersPath: string, providers: ClaudeProvidersFile): void {
  writeTextFileAtomic(providersPath, `${JSON.stringify(sortClaudeProviders(providers), null, 2)}\n`);
}

/**
 * Returns a single Claude provider record or throws a typed not-found error.
 */
export function readClaudeProviderRecord(providersPath: string, providerName: string): ClaudeProviderRecord {
  const providers = readClaudeProvidersFile(providersPath);
  const record = providers.providers[providerName];
  if (!record) {
    throw cliError("PROVIDER_NOT_FOUND", `Claude provider "${providerName}" was not found.`, {
      provider: providerName,
      file: providersPath,
      availableProviders: Object.keys(providers.providers).sort(),
    });
  }

  return record;
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
