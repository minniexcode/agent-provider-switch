import { claudeSettingsMatch, resolveClaudeProvidersFile, summarizeClaudeSettings } from "../domain/claude-providers";
import { readClaudeProvidersFileIfExists, readClaudeSettings } from "../storage/claude-providers-repo";
import { CommandResult } from "./types";

/**
 * Detects which Claude provider matches the current settings.json.
 *
 * Matching runs against the resolved settings, since that is what `switch` wrote: a delta-stored
 * record compared raw would never be reported as managed.
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
        target: "claude",
        active: null,
        status: "no-settings",
        message: "No Claude Code settings.json found.",
      },
    };
  }

  const file = resolveClaudeProvidersFile(readClaudeProvidersFileIfExists(args.claudeProvidersPath), args.defaults);
  const summary = summarizeClaudeSettings(currentSettings);

  for (const [name, record] of Object.entries(file.providers)) {
    if (claudeSettingsMatch(record.effective, currentSettings)) {
      return {
        data: {
          target: "claude",
          active: name,
          model: summary.model,
          baseUrl: summary.baseUrl,
          status: "managed",
        },
      };
    }
  }

  return {
    data: {
      target: "claude",
      active: null,
      model: summary.model,
      baseUrl: summary.baseUrl,
      status: "unmanaged",
      message: "Current settings do not match any registered Claude provider.",
    },
  };
}
