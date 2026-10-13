import { claudeAddProvider } from "../app/claude-add-provider";
import { claudeConfigCompact } from "../app/claude-config-compact";
import { claudeGetCurrent } from "../app/claude-current";
import { claudeListProviders } from "../app/claude-list-providers";
import { claudeRemoveProvider } from "../app/claude-remove-provider";
import { claudeShowProvider } from "../app/claude-show-provider";
import { claudeSwitchProvider } from "../app/claude-switch-provider";
import { CommandResult } from "../app/types";
import { cliError } from "../domain/errors";
import { routesToClaudeHandler, scopeOfName } from "../domain/target";
import { createClaudePaths } from "../storage/claude-paths";
import { createToolHomePaths } from "../storage/codex-paths";
import { canPrompt, confirmProviderRemoval } from "../interaction/interactive";
import { getSingleOption, hasFlag } from "./args";
import { CommandExecutionContext, CommandId, ParsedCommand } from "./types";
import { createPromptRuntime } from "../interaction/prompt";
import { readClaudeProvidersFileIfExists } from "../storage/claude-providers-repo";
import { resolveClaudeProvidersFile } from "../domain/claude-providers";
import { matchClaudeProviders } from "../domain/claude-identity";
import { readClaudeSettings } from "../storage/claude-providers-repo";

/**
 * Returns true when this dispatch belongs to `handleClaudeCommand`.
 *
 * Different from "accepts `--claude`", and the difference is the point: `doctor`, `status`, and
 * `backups list` accept the flag and must still reach their own handler, because they report on
 * both targets and no Claude handler could produce the whole answer. `TARGET_SCOPES` states that
 * distinction once; both this function and the flag guard read it.
 *
 * A `claude-only` command routes here whether or not the flag is present — it has no Codex form to
 * fall back to, and its own handler is where the missing-flag refusal is raised.
 */
export function isClaudeCommand(command: string | null, commandOptions: Map<string, string[]>): boolean {
  if (!command) return false;
  const scope = scopeOfName(command);
  // The lookup above is what proves the token is a real command id, which is what makes the
  // narrowing cast safe and keeps the routing question answered by one predicate.
  if (scope === null || !routesToClaudeHandler(command as CommandId)) return false;

  // A `claude-only` command routes here whether or not the flag is present: it has no Codex form
  // to fall back to, and its handler is where the missing-flag refusal is raised. A `switchable`
  // one routes here only when it named Claude. `both` never reaches this function.
  return scope === "claude-only" || commandOptions.has("--claude");
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
  // Read once, here, and handed to every service. Each one that turns a stored record into
  // something shown or written needs it, and a service that forgot would silently work on a
  // delta — so the argument is required everywhere rather than defaulted.
  const defaults = ctx.toolConfig?.claudeDefaults?.settings ?? null;

  switch (ctx.command) {
    case "add": {
      // `--claude` is a boolean flag, so it never claims the following token: the name is a
      // positional in every ordering, including `aps --claude add <name>`.
      let providerName: string | null = parsed.positionals[0] ?? null;
      const fromFile = getSingleOption(parsed.commandOptions, "--from-file");
      const note = getSingleOption(parsed.commandOptions, "--note");
      const tags = parsed.commandOptions.get("--tag") ?? [];
      const full = hasFlag(parsed.commandOptions, "--full");

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
          defaults,
          full,
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
        defaults,
        full,
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
          defaults,
          "Choose a Claude provider to switch to"
        );
      }

      if (!providerName) {
        throw cliError("PROVIDER_NOT_FOUND", "Missing provider name for switch --claude command.");
      }

      return claudeSwitchProvider({
        lockPath,
        backupsDir,
        latestBackupPath,
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        claudeSettingsPath: claudePaths.claudeSettingsPath,
        providerName,
        defaults,
      });
    }

    case "list":
      return claudeListProviders({
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        claudeSettingsPath: claudePaths.claudeSettingsPath,
        defaults,
      });

    case "show": {
      // `--claude` is a boolean flag, so it never claims the following token: the name is a
      // positional in every ordering, including `aps --claude add <name>`.
      let providerName: string | null = parsed.positionals[0] ?? null;
      if (!providerName && canPrompt(runtime, ctx.options.json)) {
        providerName = await promptForClaudeProviderSelection(
          claudePaths.claudeProvidersPath,
          claudePaths.claudeSettingsPath,
          defaults,
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
        defaults,
      });
    }

    case "current":
      return claudeGetCurrent({
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        claudeSettingsPath: claudePaths.claudeSettingsPath,
        defaults,
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
          defaults,
          "Choose a Claude provider to remove"
        );
      }

      if (!providerName) {
        throw cliError("PROVIDER_NOT_FOUND", "Missing provider name for remove --claude command.");
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

    case "config-compact": {
      // `aps config compact` has no Codex form, so `claude-only` routes it here whether or not the
      // flag was typed — which puts the missing-flag refusal here rather than in the Codex switch
      // that no longer sees it. Checked before the defaults block below, because with neither the
      // flag nor a defaults block the flag is the thing the user left off.
      if (!parsed.commandOptions.has("--claude")) {
        throw cliError("INVALID_ARGUMENT", "config compact requires --claude: it rewrites Claude provider records.", {
          command: ctx.command,
        });
      }

      // Unlike every other consumer, this one cannot run without defaults: compacting against
      // nothing would report success while changing nothing. Refuse, and say where the block goes.
      if (defaults === null) {
        throw cliError(
          "INVALID_ARGUMENT",
          `config compact needs a claudeDefaults block in ${toolHomePaths.toolConfigPath}. ` +
            'Add one as { "claudeDefaults": { "settings": { ... } } } and run it again.',
          { file: toolHomePaths.toolConfigPath }
        );
      }

      return claudeConfigCompact({
        lockPath,
        backupsDir,
        latestBackupPath,
        claudeProvidersPath: claudePaths.claudeProvidersPath,
        defaults,
        dryRun: hasFlag(parsed.commandOptions, "--dry-run"),
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
  defaults: Record<string, unknown> | null,
  message: string
): Promise<string> {
  // Resolved, because the choice labels and the "(current)" marker describe what a switch writes.
  // This site sits outside src/app/, so it is the one a search of the Claude services would miss.
  const file = resolveClaudeProvidersFile(readClaudeProvidersFileIfExists(claudeProvidersPath), defaults);
  const names = Object.keys(file.providers).sort();
  if (names.length === 0) {
    throw cliError("PROVIDERS_NOT_FOUND", "No Claude providers registered. Run `aps add --claude` first.");
  }

  const currentSettings = readClaudeSettings(claudeSettingsPath);
  const match = matchClaudeProviders({
    live: currentSettings,
    providers: Object.fromEntries(names.map((name) => [name, file.providers[name].effective])),
  });
  const choices = names.map((name) => {
    const record = file.providers[name];
    // "(current)" requires a unique match. On an ambiguous one the marker would be a claim the
    // comparison did not make; the row says "(candidate)" instead, which is what is actually known.
    const suffix =
      match.state === "managed" && match.activeProvider === name
        ? " (current)"
        : match.state === "ambiguous" && match.candidates.some((candidate) => candidate.name === name)
          ? " (candidate)"
          : "";
    const env = record.effective.env as Record<string, string> | undefined;
    const model = (record.effective.model as string) ?? "";
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
