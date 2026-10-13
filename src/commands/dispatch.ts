import { CommandResult } from "../app/types";
import { cliError } from "../domain/errors";
import { createPromptRuntime, CliPromptRuntime } from "../interaction/prompt";
import { CODEX_DIR_ENV_NAME, resolveCodexDir } from "../storage/codex-paths";
import { createToolHomePaths } from "../storage/tool-home-paths";
import { readToolConfigIfExists } from "../storage/tool-config-repo";
import { ensureLegacyToolHomeMigrated } from "../storage/tool-home-migration";
import { assertFlagsApply } from "./flag-guards";
import { handleRegisteredCommand } from "./handlers";
import { findCommandDefinition } from "./registry";
import { CommandExecutionContext, CommandId, ParsedCommand } from "./types";
import { ToolConfigInspection, inspectToolConfig } from "../app/inspect-tool-config";
import { valueOf } from "../domain/report";

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

  // A definite answer from here on, and before anything touches a file. Every step below can
  // throw, and each of those failures has to render with the scope the invocation was *accepted*
  // at rather than with an absent field — `JSON.stringify` drops an `undefined` key, and a consumer
  // reading `targets` would then have to guess whether the build predates the field. A `[]` here is
  // the value that survives a throw from any of them.
  ctx.targets = [];

  // Scope is settled before any I/O, which is the ordering `1.1.3` makes normative. It has two
  // consequences that are easy to get backwards: a command whose selection is refused never runs
  // the legacy-home migration first (so a `backups prune --claude` cannot move a directory on its
  // way to being rejected), and a failure *after* an accepted scope — a migration fault, an
  // unreadable tool config, a handler error — reports the accepted scope rather than emptying it.
  //
  // One call settles everything a command line can be wrong about, and it returns the accepted
  // targets so the envelope field is written from the decision rather than recomputed from the
  // flags. `config compact`'s requirement that its target be named is part of that decision now: it
  // is a property of the command's policy, so asking it here is the same question the guard asks,
  // and the handler no longer has to ask it again.
  //
  // `definition.id`, not `ctx.command`: the context's `command` is the wider
  // `CommandId | "help" | "version"` union that the pre-dispatch render paths need, while the
  // definition found above is proof that a real command id resolved. Passing the narrowed value
  // keeps these parameters honest instead of widening them to the union.
  ctx.targets = assertFlagsApply(definition.id, parsed.targetSelection, parsed.commandOptions, parsed.globalOptions);

  // The one funnel every command passes through, whichever target it names — `handleClaudeCommand`
  // is only reachable from a registered handler — so a single call site covers Codex and Claude
  // alike. It runs before the tool-home paths are built, because those resolve to the new home.
  // A throw after this point drops the notice: `renderFailure` has no warnings channel. Migration
  // failure is therefore reported as a warning rather than an error inside the module itself, and
  // never turns into a hard failure here.
  const migrationWarnings = ensureLegacyToolHomeMigrated().warnings;

  const toolHomePaths = createToolHomePaths();
  // Two readers, and the choice between them is the command's: a mutation must fail fast on a
  // defaults block it cannot parse, while `doctor` and `status` exist to explain exactly that file.
  // Sharing one reader would force one of the two behaviours on the other.
  if (isReportCommand(definition.id)) {
    const inspection = inspectToolConfig(toolHomePaths.toolConfigPath);
    ctx.toolConfigInspection = inspection;
    ctx.toolConfig = null;
    ctx.options.codexDir = resolveReportCodexDir(ctx, toolHomePaths.toolConfigPath, inspection);
  } else {
    const toolConfig = readToolConfigIfExists(toolHomePaths.toolConfigPath);
    ctx.toolConfig = toolConfig;
    ctx.options.codexDir = resolveCodexDir(ctx.options.codexDir ?? undefined, toolConfig);
  }

  // One handler for every registered command: the registry declares *what* each command is, and the
  // handler switch below it decides what it does. That is deliberate — the handlers are the
  // execution layer `cli.ts` loads dynamically, so this import is what keeps `--help` from pulling
  // in the app services, the inquirer runtime and the Codex probe (design §4.3).
  const result = await handleRegisteredCommand(ctx, parsed, runtime);
  if (migrationWarnings.length === 0) {
    return result;
  }

  // Migration warnings lead: the home moving is the context for everything the handler reports.
  return { ...result, warnings: [...migrationWarnings, ...(result.warnings ?? [])] };
}

/**
 * The commands that report on state rather than changing it, and therefore read the shared config
 * in the reporting style.
 *
 * A list rather than a scope test, because the two answer different questions: `backups list` is a
 * `both` command that never reads the tool config at all, so giving it the lenient reader would
 * buy nothing, and a future reporting command should have to say so here rather than inherit the
 * behaviour from its scope by accident.
 */
const REPORT_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(["doctor", "status"]);

function isReportCommand(command: CommandId): boolean {
  return REPORT_COMMANDS.has(command);
}

/**
 * Resolves the Codex directory for a reporting command, without ever guessing one.
 *
 * `resolveCodexDir()`'s last resort is `~/.codex`, which is the right default for a command about
 * to write there and the wrong answer for a report: it would present an invented path as a finding.
 * So the shared-config step is taken only when the shared config was actually readable, and the
 * two independent sources — the explicit flag and the environment — are honoured either way.
 *
 * When none of the three answers, `codexDirUnavailableReason` is set and the report marks its
 * runtime-derived readings `unavailable`. The registry path is not affected: it is derived from
 * the tool home, which this process resolved without reading the shared config at all.
 */
function resolveReportCodexDir(
  ctx: CommandExecutionContext,
  toolConfigPath: string,
  inspection: ToolConfigInspection
): string {
  if (ctx.options.codexDir) {
    return resolveCodexDir(ctx.options.codexDir, null);
  }
  const fromEnv = process.env[CODEX_DIR_ENV_NAME];
  if (fromEnv) {
    return resolveCodexDir(undefined, null);
  }
  const fromShared = valueOf(inspection.defaultCodexDir);
  if (inspection.defaultCodexDir.status === "ok" && fromShared) {
    return resolveCodexDir(fromShared, null);
  }

  ctx.codexDirUnavailableReason =
    inspection.defaultCodexDir.status === "ok"
      ? `No Codex directory is configured; agent-provider-switch.json (${toolConfigPath}) names none.`
      : `The Codex directory cannot be determined: ${
          inspection.defaultCodexDir.status === "absent"
            ? "no configured default is available"
            : inspection.defaultCodexDir.reason
        }.`;

  // Still resolved, because the handler's path construction needs a directory to build from and
  // the report is what declines to use it — a null here would spread through every call site for
  // no gain. `codexDirUnavailableReason` is what the report reads.
  return resolveCodexDir(undefined, null);
}
