import { cliError } from "../domain/errors";
import { createPromptRuntime, CliPromptRuntime } from "../interaction/prompt";
import { createToolHomePaths, resolveCodexDir } from "../storage/codex-paths";
import { readToolConfigIfExists } from "../storage/tool-config-repo";
import { findCommandDefinition } from "./registry";
import { CommandExecutionContext, ParsedCommand } from "./types";

/**
 * Resolves the shared command definition and executes its registered handler.
 */
export async function executeCommand(
  ctx: CommandExecutionContext,
  parsed: ParsedCommand,
  runtime: CliPromptRuntime = createPromptRuntime()
) {
  const definition = findCommandDefinition(ctx.command);
  if (!definition) {
    throw cliError("UNKNOWN_COMMAND", `Unknown command: ${ctx.command}`);
  }

  const toolConfigPath = createToolHomePaths().toolConfigPath;
  const toolConfig = readToolConfigIfExists(toolConfigPath);
  ctx.options.codexDir = resolveCodexDir(ctx.options.codexDir ?? undefined, toolConfig);

  return definition.handler(ctx, parsed, runtime);
}
