import { matchClaudeProviders } from "../domain/claude-identity";
import { resolveClaudeProvidersFile, summarizeClaudeSettings } from "../domain/claude-providers";
import { readClaudeProvidersFileIfExists } from "../storage/claude-providers-repo";
import { readClaudeSettings } from "../storage/claude-providers-repo";
import { CommandResult } from "./types";

/**
 * Lists all registered Claude providers with active detection.
 *
 * Both the summary columns and the active marker are computed from the resolved settings: a stored
 * record is a delta, so reading `record.settings` directly would render an empty model and base
 * URL and could never match the live settings.json.
 *
 * **A row is marked `isActive` only when the identity match is unique.** When several providers
 * match, every one of them is a candidate and none of them is claimed to be the active route: the
 * rows say `ambiguous: true`, and the summary says so too. Marking them all active would read as
 * "these are all in use", which is the opposite of what the match found.
 */
export async function claudeListProviders(args: {
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  defaults: Record<string, unknown> | null;
}): Promise<CommandResult> {
  const file = resolveClaudeProvidersFile(readClaudeProvidersFileIfExists(args.claudeProvidersPath), args.defaults);
  const currentSettings = readClaudeSettings(args.claudeSettingsPath);

  const match = matchClaudeProviders({
    live: currentSettings,
    providers: Object.fromEntries(
      Object.entries(file.providers).map(([name, record]) => [name, record.effective])
    ),
  });
  const candidates = new Map(match.candidates.map((candidate) => [candidate.name, candidate]));

  const providers = Object.entries(file.providers).map(([name, record]) => {
    const summary = summarizeClaudeSettings(record.effective);
    const candidate = candidates.get(name);
    return {
      name,
      model: summary.model,
      baseUrl: summary.baseUrl,
      theme: summary.theme,
      note: record.note ?? null,
      tags: record.tags ?? [],
      isActive: match.state === "managed" && match.activeProvider === name,
      isCandidate: candidate !== undefined,
      ambiguous: match.state === "ambiguous" && candidate !== undefined,
      // Paths only, and empty for a non-candidate row, so the list stays safe to print next to a
      // masked env: a difference path can name a credential but never carries one.
      differencePaths: candidate?.differencePaths ?? [],
    };
  });

  return {
    data: {
      providers,
      count: providers.length,
      matchState: match.state,
      activeProvider: match.activeProvider,
    },
  };
}
