import { matchClaudeProviders } from "../domain/claude-identity";
import { resolveClaudeProvidersFile, summarizeClaudeSettings } from "../domain/claude-providers";
import { readClaudeProvidersFileIfExists, readClaudeSettings } from "../storage/claude-providers-repo";
import { CommandResult } from "./types";

/**
 * Detects which Claude provider matches the current settings.json.
 *
 * Matching runs against the resolved settings, since that is what `switch` wrote: a delta-stored
 * record compared raw would never be reported as managed.
 *
 * `ambiguous` is a state of its own rather than a `managed` with a name. Two registered providers
 * can share an address and a model set while differing in the credential they authenticate with, so
 * naming either one would be the guess `matchClaudeProviders()` refuses to make — and `current` is
 * exactly where a guess would be believed, because its whole job is to name the active provider.
 */
export async function claudeGetCurrent(args: {
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  defaults: Record<string, unknown> | null;
}): Promise<CommandResult> {
  const currentSettings = readClaudeSettings(args.claudeSettingsPath);
  if (!currentSettings) {
    return {
      data: {
        active: null,
        status: "no-settings",
        message: "No Claude Code settings.json found.",
      },
    };
  }

  const file = resolveClaudeProvidersFile(readClaudeProvidersFileIfExists(args.claudeProvidersPath), args.defaults);
  const summary = summarizeClaudeSettings(currentSettings);

  const match = matchClaudeProviders({
    live: currentSettings,
    providers: Object.fromEntries(
      Object.entries(file.providers).map(([name, record]) => [name, record.effective])
    ),
  });

  if (match.state === "managed") {
    return {
      data: {
        active: match.activeProvider,
        model: summary.model,
        baseUrl: summary.baseUrl,
        status: "managed",
      },
    };
  }

  if (match.state === "ambiguous") {
    return {
      data: {
        active: null,
        model: summary.model,
        baseUrl: summary.baseUrl,
        status: "ambiguous",
        // Names only: which candidates matched on identity, without claiming one of them is active.
        candidates: match.candidates.map((candidate) => candidate.name),
        message: "Current settings match more than one registered Claude provider.",
      },
    };
  }

  return {
    data: {
      active: null,
      model: summary.model,
      baseUrl: summary.baseUrl,
      status: "unmanaged",
      message: "Current settings do not match any registered Claude provider.",
    },
  };
}
