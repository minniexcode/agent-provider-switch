import { CommandResult } from "../app/types";
import { cliError } from "../domain/errors";
import { resolveTarget } from "../domain/target";
import { createPromptRuntime, CliPromptRuntime } from "../interaction/prompt";
import { createToolHomePaths, resolveCodexDir } from "../storage/codex-paths";
import { readToolConfigIfExists } from "../storage/tool-config-repo";
import { ensureLegacyToolHomeMigrated } from "../storage/tool-home-migration";
import { assertFlagsApply } from "./flag-guards";
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
  ctx.toolConfig = toolConfig;
  ctx.options.codexDir = resolveCodexDir(ctx.options.codexDir ?? undefined, toolConfig);

  // A definite target from here on. It is set to `null` before anything below can throw, so a
  // refusal raised by a guard, by the conflict rule, or by the handler itself still renders with
  // a `target` field rather than an absent one — `JSON.stringify` drops an `undefined` key, and a
  // consumer reading `target` would then have to guess whether the build predates the field.
  ctx.target = null;

  // Both flag judgements live here rather than in `handleRegisteredCommand`, for one reason: the
  // resolved target has to reach `ctx` before the handler runs, because the handler is what throws
  // the failures the envelope has to describe. The lock step below is the reason the guard cannot
  // run any earlier — it is the first point where the command id is known to be a real one.
  //
  // The guard is asked first, and it judges each flag on its own. Only once both `--claude` and
  // `--codex` are individually acceptable does the question of whether they contradict each other
  // arise, and that question belongs to `resolveTarget()`: a pair rule inside the guard loop would
  // have to be re-checked per entry and would report the conflict on whichever flag the table
  // happened to list second.
  assertFlagsApply(ctx.command, parsed.commandOptions);

  // `definition.id`, not `ctx.command`: the context's `command` is the wider
  // `CommandId | "help" | "version"` union that the pre-dispatch render paths need, while the
  // definition found above is proof that a real command id resolved. Passing the narrowed value
  // keeps `resolveTarget()`'s parameter honest instead of widening it to the union.
  const resolution = resolveTarget({
    command: definition.id,
    claudeRequested: parsed.commandOptions.has("--claude"),
    codexRequested: parsed.commandOptions.has("--codex"),
  });
  if ("refusal" in resolution) {
    throw cliError(resolution.refusal.code, resolution.refusal.message, { command: ctx.command });
  }
  ctx.target = resolution.target;

  const result = await definition.handler(ctx, parsed, runtime);
  if (migrationWarnings.length === 0) {
    return result;
  }

  // Migration warnings lead: the home moving is the context for everything the handler reports.
  return { ...result, warnings: [...migrationWarnings, ...(result.warnings ?? [])] };
}
