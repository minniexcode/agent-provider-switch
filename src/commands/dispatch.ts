import { CommandResult } from "../app/types";
import { cliError } from "../domain/errors";
import { createPromptRuntime, CliPromptRuntime } from "../interaction/prompt";
import { createToolHomePaths, resolveCodexDir } from "../storage/codex-paths";
import { readToolConfigIfExists } from "../storage/tool-config-repo";
import { ensureLegacyToolHomeMigrated } from "../storage/tool-home-migration";
import { findCommandDefinition } from "./registry";
import { CommandExecutionContext, ParsedCommand } from "./types";

/**
 * Resolves the shared command definition and executes its registered handler.
 */
export async function executeCommand(
  ctx: CommandExecutionContext,
  parsed: ParsedCommand,
  runtime: CliPromptRuntime = createPromptRuntime()
): Promise<CommandResult> {
  const definition = findCommandDefinition(ctx.command);
  if (!definition) {
    throw cliError("UNKNOWN_COMMAND", `Unknown command: ${ctx.command}`);
  }

  // The one funnel every command passes through, whichever target it names — `handleClaudeCommand`
  // is only reachable from a registered handler — so a single call site covers Codex and Claude
  // alike. It runs before the tool-home paths are built, because those resolve to the new home.
  // A throw after this point drops the notice: `renderFailure` has no warnings channel. Migration
  // failure is therefore reported as a warning rather than an error inside the module itself, and
  // never turns into a hard failure here.
  const migrationWarnings = ensureLegacyToolHomeMigrated().warnings;

  const toolConfigPath = createToolHomePaths().toolConfigPath;
  const toolConfig = readToolConfigIfExists(toolConfigPath);
  ctx.options.codexDir = resolveCodexDir(ctx.options.codexDir ?? undefined, toolConfig);

  const result = await definition.handler(ctx, parsed, runtime);
  if (migrationWarnings.length === 0) {
    return result;
  }

  // Migration warnings lead: the home moving is the context for everything the handler reports.
  return { ...result, warnings: [...migrationWarnings, ...(result.warnings ?? [])] };
}
