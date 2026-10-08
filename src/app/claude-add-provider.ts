import * as fs from "node:fs";
import { cliError } from "../domain/errors";
import { cleanClaudeProviderRecord, ClaudeProviderRecord, resolveClaudeProviderRecord } from "../domain/claude-providers";
import { collectDroppedPaths, diffClaudeSettings } from "../domain/claude-settings-merge";
import { readClaudeProvidersFileIfExists, writeClaudeProvidersFile } from "../storage/claude-providers-repo";
import { runMutation } from "./run-mutation";
import { CommandResult } from "./types";

/**
 * Adds a new Claude provider profile from a settings file or direct input.
 *
 * With a defaults block the imported settings are slimmed to the entries that differ from it, so the
 * record is a delta rather than a copy. `full` opts out and keeps every entry — which pins them: a
 * slimmed record follows a later change to the defaults, a full one keeps the value it spelled out.
 * Either way the record is resolved over the defaults when read, so a key the file omits is still
 * inherited; `full` stores more, it does not stop inheritance.
 *
 * `defaults` is required rather than optional: omitting it would quietly store a full copy and the
 * caller would never find out the record was not slimmed.
 */
export async function claudeAddProvider(args: {
  lockPath: string;
  backupsDir: string;
  latestBackupPath: string;
  claudeProvidersPath: string;
  providerName: string;
  defaults: Record<string, unknown> | null;
  full?: boolean;
  fromFile?: string;
  settings?: Record<string, unknown>;
  note?: string;
  tags?: string[];
}): Promise<CommandResult> {
  let settings: Record<string, unknown>;

  if (args.fromFile) {
    if (!fs.existsSync(args.fromFile)) {
      throw cliError("INVALID_ARGUMENT", `Settings file not found: ${args.fromFile}`);
    }
    try {
      settings = JSON.parse(fs.readFileSync(args.fromFile, "utf8")) as Record<string, unknown>;
    } catch {
      throw cliError("INVALID_ARGUMENT", `Failed to parse settings file: ${args.fromFile}`);
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw cliError("INVALID_ARGUMENT", "Settings file must contain a JSON object.");
    }
  } else if (args.settings) {
    settings = args.settings;
  } else {
    throw cliError("INVALID_ARGUMENT", "Either --from-file or settings must be provided.");
  }

  // No defaults block means nothing to slim against, so the file is stored as it came.
  const slim = args.defaults !== null && !args.full;
  const stored = slim ? diffClaudeSettings(args.defaults, settings) : settings;
  const droppedPaths = slim ? collectDroppedPaths(args.defaults, settings) : [];

  const record: ClaudeProviderRecord = cleanClaudeProviderRecord({
    settings: stored,
    note: args.note,
    tags: args.tags,
  });

  return runMutation({
    lockPath: args.lockPath,
    backupsDir: args.backupsDir,
    latestBackupPath: args.latestBackupPath,
    operation: "claude-add",
    files: [
      { absolutePath: args.claudeProvidersPath, relativePath: "claude-providers.json" },
    ],
    mutate: () => {
      const existing = readClaudeProvidersFileIfExists(args.claudeProvidersPath);
      if (existing.providers[args.providerName]) {
        throw cliError("CLAUDE_PROVIDER_ALREADY_EXISTS", `Claude provider "${args.providerName}" already exists.`, {
          provider: args.providerName,
          suggestion: 'Use a different name or run `aps remove --claude <name>` first.',
        });
      }
      existing.providers[args.providerName] = record;
      writeClaudeProvidersFile(args.claudeProvidersPath, existing);
      // The model reported is the one a switch would write, not whatever the stored delta holds.
      const { effective } = resolveClaudeProviderRecord(record, args.defaults);
      return {
        target: "claude",
        provider: args.providerName,
        model: (effective.model as string) ?? null,
        // Paths only. A non-empty list is what lets the renderer say the record was slimmed.
        droppedPaths,
      };
    },
  });
}
