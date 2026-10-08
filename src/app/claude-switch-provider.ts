import * as fs from "node:fs";
import * as path from "node:path";
import { resolveClaudeProviderRecord } from "../domain/claude-providers";
import { cliError } from "../domain/errors";
import { readClaudeProvidersFile } from "../storage/claude-providers-repo";
import { writeClaudeSettings } from "../storage/claude-providers-repo";
import { runMutation } from "./run-mutation";
import { CommandResult } from "./types";

/**
 * Switches Claude Code to the target provider by replacing settings.json.
 *
 * `defaults` is required rather than optional: this is the one place a stored delta becomes a
 * real settings file, so a caller that forgot the argument would write a file missing every
 * inherited key. Pass `null` to say there is no defaults block.
 */
export async function claudeSwitchProvider(args: {
  lockPath: string;
  backupsDir: string;
  latestBackupPath: string;
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  providerName: string;
  defaults: Record<string, unknown> | null;
}): Promise<CommandResult> {
  const providers = readClaudeProvidersFile(args.claudeProvidersPath);
  const provider = providers.providers[args.providerName];
  if (!provider) {
    throw cliError("CLAUDE_PROVIDER_NOT_FOUND", `Claude provider "${args.providerName}" was not found.`, {
      availableProviders: Object.keys(providers.providers).sort(),
    });
  }

  // The stored record stays a delta; only the file written to Claude Code is expanded.
  const { effective } = resolveClaudeProviderRecord(provider, args.defaults);

  const claudeDir = path.dirname(args.claudeSettingsPath);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  return runMutation({
    lockPath: args.lockPath,
    backupsDir: args.backupsDir,
    latestBackupPath: args.latestBackupPath,
    operation: "claude-switch",
    files: [
      { absolutePath: args.claudeSettingsPath, relativePath: "claude-settings.json" },
    ],
    mutate: () => {
      writeClaudeSettings(args.claudeSettingsPath, effective);
      const env = effective.env as Record<string, string> | undefined;
      return {
        target: "claude",
        provider: args.providerName,
        model: (effective.model as string) ?? null,
        baseUrl: env?.ANTHROPIC_BASE_URL ?? null,
      };
    },
  });
}
