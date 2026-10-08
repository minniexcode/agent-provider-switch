import { claudeSettingsMatch, resolveClaudeProvidersFile, summarizeClaudeSettings } from "../domain/claude-providers";
import { readClaudeProvidersFileIfExists } from "../storage/claude-providers-repo";
import { readClaudeSettings } from "../storage/claude-providers-repo";
import { CommandResult } from "./types";

/**
 * Lists all registered Claude providers with active detection.
 *
 * Both the summary columns and the active marker are computed from the resolved settings: a stored
 * record is a delta, so reading `record.settings` directly would render an empty model and base
 * URL and could never match the live settings.json.
 */
export async function claudeListProviders(args: {
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  defaults: Record<string, unknown> | null;
}): Promise<CommandResult> {
  const file = resolveClaudeProvidersFile(readClaudeProvidersFileIfExists(args.claudeProvidersPath), args.defaults);
  const currentSettings = readClaudeSettings(args.claudeSettingsPath);

  const providers = Object.entries(file.providers).map(([name, record]) => {
    const summary = summarizeClaudeSettings(record.effective);
    const isActive = currentSettings ? claudeSettingsMatch(record.effective, currentSettings) : false;
    return {
      name,
      model: summary.model,
      baseUrl: summary.baseUrl,
      theme: summary.theme,
      note: record.note ?? null,
      tags: record.tags ?? [],
      isActive,
    };
  });

  return {
    data: {
      target: "claude",
      providers,
      count: providers.length,
    },
  };
}
