import { claudeAddProvider } from "../app/claude-add-provider";
import { claudeGetCurrent } from "../app/claude-current";
import { claudeListProviders } from "../app/claude-list-providers";
import { claudeRemoveProvider } from "../app/claude-remove-provider";
import { claudeShowProvider } from "../app/claude-show-provider";
import { claudeSwitchProvider } from "../app/claude-switch-provider";
import { CommandResult } from "../app/types";
import { cliError } from "../domain/errors";
import { createClaudePaths } from "../storage/claude-paths";
import { createToolHomePaths } from "../storage/codex-paths";
import { canPrompt, confirmProviderRemoval } from "../interaction/interactive";
import { getSingleOption, hasFlag } from "./args";
import { CommandExecutionContext, ParsedCommand } from "./types";
import { createPromptRuntime } from "../interaction/prompt";
import { readClaudeProvidersFileIfExists } from "../storage/claude-providers-repo";
import { claudeSettingsMatch } from "../domain/claude-providers";
import { readClaudeSettings } from "../storage/claude-providers-repo";

/**
 * Commands that support the --claude flag.
 */
const CLAUDE_COMMANDS = new Set(["add", "switch", "list", "show", "current", "remove"]);

/**
 * Returns true when the command has a Claude Code path at all.
 */
export function supportsClaudeTarget(command: string | null): boolean {
  return command !== null && CLAUDE_COMMANDS.has(command);
}

/**
 * The Claude-capable command ids, for a refusal that can name them.
 */
export function getClaudeCommandNames(): string[] {
  return [...CLAUDE_COMMANDS].sort();
}

/**
 * Returns true when the parsed command targets Claude Code instead of Codex.
 */
export function isClaudeCommand(command: string | null, commandOptions: Map<string, string[]>): boolean {
  if (!command) return false;
  return CLAUDE_COMMANDS.has(command) && commandOptions.has("--claude");
}

/**
 * Dispatches a --claude-flagged command to the appropriate Claude service.
 */
export async function handleClaudeCommand(
  ctx: CommandExecutionContext,
  parsed: ParsedCommand,
  runtime = createPromptRuntime()
): Promise<CommandResult> {
  const toolHomePaths = createToolHomePaths();
  const claudePaths = createClaudePaths(toolHomePaths.toolHomeDir);
  const lockPath = toolHomePaths.lockPath;
  const backupsDir = toolHomePaths.backupsDir;
  const latestBackupPath = toolHomePaths.latestBackupPath;

  switch (ctx.command) {
    case "add": {
      // `--claude` is a boolean flag, so it never claims the following token: the name is a
      // positional in every ordering, including `aps --claude add <name>`.
      let providerName: string | null = parsed.positionals[0] ?? null;
      const fromFile = getSingleOption(parsed.commandOptions, "--from-file");
      const note = getSingleOption(parsed.commandOptions, "--note");
      const tags = parsed.commandOptions.get("--tag") ?? [];

      if (!providerName) {
        if (ctx.options.json || !runtime.isInteractive()) {
          throw cliError("INVALID_ARGUMENT", "Claude add requires a provider name. Usage: aps add --claude <name> --from-file <path>");
        }
        const inquirer = await import("inquirer");
        const answer = await inquirer.default.prompt([{
          type: "input",
          name: "providerName",
          message: "Claude provider name:",
          validate: (input: string) => input.trim().length > 0 || "Name is required.",
        }]);
        providerName = answer.providerName.trim();
      }

      const resolvedName = providerName as string;

      if (!fromFile) {
        if (ctx.options.json || !runtime.isInteractive()) {
          throw cliError("INVALID_ARGUMENT", "Claude add requires --from-file <path> in non-interactive mode.");
        }
        const inquirer = await import("inquirer");
        const answer = await inquirer.default.prompt([{
          type: "input",
          name: "fromFile",
          message: "Path to Claude settings JSON file:",
          validate: (input: string) => {
            if (input.trim().length === 0) return "Path is required.";
            const fs = require("node:fs");
            if (!fs.existsSync(input.trim())) return `File not found: ${input.trim()}`;
            return true;
          },
        }]);
        return claudeAddProvider({
          lockPath,
          backupsDir,
          latestBackupPath,
          claudeProvidersPath: claudePaths.claudeProvidersPath,
          providerName: resolvedName,
          fromFile: answer.fromFile.trim(),
          note: note ?? undefined,
          tags: tags.length > 0 ? tags : undefined,
        });
      }

      return claudeAddProvider({
        lockPath,
        backupsDir,
        latestBackupPath,
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        providerName: resolvedName,
        fromFile,
        note: note ?? undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
    }

    case "switch": {
      // `--claude` is a boolean flag, so it never claims the following token: the name is a
      // positional in every ordering, including `aps --claude add <name>`.
      let providerName: string | null = parsed.positionals[0] ?? null;
      if (!providerName && canPrompt(runtime, ctx.options.json)) {
        providerName = await promptForClaudeProviderSelection(
          claudePaths.claudeProvidersPath,
          claudePaths.claudeSettingsPath,
          "Choose a Claude provider to switch to"
        );
      }

      if (!providerName) {
        throw cliError("CLAUDE_PROVIDER_NOT_FOUND", "Missing provider name for switch --claude command.");
      }

      return claudeSwitchProvider({
        lockPath,
        backupsDir,
        latestBackupPath,
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        claudeSettingsPath: claudePaths.claudeSettingsPath,
        providerName,
      });
    }

    case "list":
      return claudeListProviders({
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        claudeSettingsPath: claudePaths.claudeSettingsPath,
      });

    case "show": {
      // `--claude` is a boolean flag, so it never claims the following token: the name is a
      // positional in every ordering, including `aps --claude add <name>`.
      let providerName: string | null = parsed.positionals[0] ?? null;
      if (!providerName && canPrompt(runtime, ctx.options.json)) {
        providerName = await promptForClaudeProviderSelection(
          claudePaths.claudeProvidersPath,
          claudePaths.claudeSettingsPath,
          "Choose a Claude provider to show"
        );
      }

      if (!providerName) {
        throw cliError("INVALID_ARGUMENT", "Missing provider name for show --claude command.");
      }

      return claudeShowProvider({
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        providerName,
        reveal: ctx.options.reveal,
      });
    }

    case "current":
      return claudeGetCurrent({
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        claudeSettingsPath: claudePaths.claudeSettingsPath,
      });

    case "remove": {
      // `--claude` is a boolean flag, so it never claims the following token: the name is a
      // positional in every ordering, including `aps --claude add <name>`.
      let providerName: string | null = parsed.positionals[0] ?? null;
      const force = hasFlag(parsed.commandOptions, "--force");

      if (!providerName && canPrompt(runtime, ctx.options.json)) {
        providerName = await promptForClaudeProviderSelection(
          claudePaths.claudeProvidersPath,
          claudePaths.claudeSettingsPath,
          "Choose a Claude provider to remove"
        );
      }

      if (!providerName) {
        throw cliError("CLAUDE_PROVIDER_NOT_FOUND", "Missing provider name for remove --claude command.");
      }

      if (!force && !canPrompt(runtime, ctx.options.json)) {
        throw cliError("INVALID_ARGUMENT", "remove --claude requires --force in non-interactive mode.");
      }

      if (canPrompt(runtime, ctx.options.json)) {
        await confirmProviderRemoval(runtime, providerName);
      }

      return claudeRemoveProvider({
        lockPath,
        backupsDir,
        latestBackupPath,
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        providerName,
      });
    }

    default:
      throw cliError("UNKNOWN_COMMAND", `Command "${ctx.command}" does not support --claude.`);
  }
}

/**
 * Interactive Claude provider selector.
 */
async function promptForClaudeProviderSelection(
  claudeProvidersPath: string,
  claudeSettingsPath: string,
  message: string
): Promise<string> {
  const file = readClaudeProvidersFileIfExists(claudeProvidersPath);
  const names = Object.keys(file.providers).sort();
  if (names.length === 0) {
    throw cliError("CLAUDE_PROVIDERS_NOT_FOUND", "No Claude providers registered. Run `aps add --claude` first.");
  }

  const currentSettings = readClaudeSettings(claudeSettingsPath);
  const choices = names.map((name) => {
    const record = file.providers[name];
    const isActive = currentSettings ? claudeSettingsMatch(record.settings, currentSettings) : false;
    const env = record.settings.env as Record<string, string> | undefined;
    const model = (record.settings.model as string) ?? "";
    const suffix = isActive ? " (current)" : "";
    const baseUrl = env?.ANTHROPIC_BASE_URL ?? "";
    return {
      name: `${name}${suffix} [model=${model}, base=${baseUrl}]`,
      value: name,
    };
  });

  const inquirer = await import("inquirer");
  const answer = await inquirer.default.prompt([{
    type: "list",
    name: "provider",
    message,
    choices,
  }]);

  return answer.provider;
}
