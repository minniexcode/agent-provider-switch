import { claudeConfigCompact } from "../app/claude-config-compact";
import { CommandResult } from "../app/types";
import { isProviderVerb, ProviderVerb } from "../domain/command";
import { cliError } from "../domain/errors";
import { createClaudePaths } from "../storage/claude-paths";
import { createToolHomePaths } from "../storage/tool-home-paths";
import { createOptionBag, hasFlag } from "./args";
import { bindClaudeTarget } from "./target-bindings";
import { CommandExecutionContext, ParsedCommand } from "./types";
import { createPromptRuntime } from "../interaction/prompt";

/**
 * Dispatches a Claude-selected command to the appropriate Claude service.
 *
 * The routing decision lives in `handleRegisteredCommand`, which reads the normalized
 * `targetSelection` and asks `routesToClaudeHandler()`; a `claude-only` command reaches here
 * because the scope resolver required its target to be named, not because this switch decides it.
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
  /** The lock and backups tree Codex mutations run under, shared with every other target. */
  const shared = {
    lockPath: toolHomePaths.lockPath,
    backupsDir: toolHomePaths.backupsDir,
    latestBackupPath: toolHomePaths.latestBackupPath,
  };
  /** The request shape every shared verb takes, built from this invocation. */
  const providerRequest = (verb: ProviderVerb) => ({
    verb,
    positionals: parsed.positionals,
    view: { json: ctx.options.json, reveal: ctx.options.reveal },
    runtime,
    options: createOptionBag(parsed.commandOptions),
    shared,
  });

  // The six provider verbs go through the shared workflows, the same ones the Codex handler calls.
  // They are recognized from the shared vocabulary rather than from a second list of six case
  // labels: `executeProvider` is the one place that decides which workflow a verb picks, so naming
  // the verbs here too would be another copy of the same table, free to drift when it grows.
  //
  // This is not the routing decision. The Claude selections that reach this function are exactly
  // the ones the scope resolver permits here, so the verb is answered rather than re-decided.
  if (isProviderVerb(ctx.command)) {
    return bindClaudeTarget({
      claudeProvidersPath: claudePaths.claudeProvidersPath,
      claudeSettingsPath: claudePaths.claudeSettingsPath,
      defaults,
      shared,
    }).executeProvider(providerRequest(ctx.command));
  }

  switch (ctx.command) {
    case "config-compact": {
      // The requirement that Claude be named explicitly is not checked here. It used to be, and
      // that was the defect the unified scope entry point removes: the guard, the help text and
      // this handler each carried a copy of "config compact has no Codex form", and the copy that
      // ran last was the one users saw. `executeCommand` now refuses the unnamed invocation before
      // any file is read, from the same declaration the other two are built from.

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
