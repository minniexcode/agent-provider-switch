import { cliError } from "../domain/errors";
import { acceptsTargetFlag, scopeOf, TargetFlag } from "../domain/target";
import { getKnownCommandIds } from "./registry";
import { CommandId } from "./types";

/**
 * A global boolean flag and the commands that actually do something with it.
 */
type FlagGuard = {
  flag: string;
  accepts: (command: CommandId) => boolean;
  supportedCommands: () => string[];
  /** Whether the flag only means something alongside `--claude`. */
  requiresClaude: boolean;
};

/**
 * The commands that accept one target flag, sorted for a stable refusal message.
 *
 * Derived from `TARGET_SCOPES` rather than kept beside it. `1.1.1` built this list from a
 * hand-maintained `CLAUDE_COMMANDS` set that had to be kept in step with the guard by hand; the
 * table is now the only place the answer lives, so the message and the check cannot disagree.
 */
function supportedTargetCommands(flag: TargetFlag): string[] {
  return getKnownCommandIds()
    .filter((command) => acceptsTargetFlag(command, flag))
    .sort();
}

/**
 * Every global boolean flag a command may not simply ignore.
 *
 * The parser strips these tokens by exact equality before it knows which command it is parsing, so
 * it accepts them anywhere. Accepted-and-ignored is the dangerous reading: `aps backups prune
 * --dry-run` would delete real backups under a flag that promised not to, and `aps status
 * --claude` would report Codex state under a flag that asked about Claude. Each entry here turns
 * that into a refusal that names what the flag does apply to.
 *
 * The table judges one flag at a time. Whether two flags contradict *each other* is a property of
 * the pair and belongs to `resolveTarget()` — see `dispatch.ts`.
 */
const FLAG_GUARDS: FlagGuard[] = [
  {
    flag: "--claude",
    accepts: (command) => acceptsTargetFlag(command, "--claude"),
    supportedCommands: () => supportedTargetCommands("--claude"),
    requiresClaude: false,
  },
  {
    // Naming the default must not fail, so this entry has almost no refusal surface: every
    // command that acts on Codex state accepts it. It nevertheless refuses two real cases —
    // `config compact`, which has no Codex form, and the shared-state commands, where the flag
    // names a narrowing that does not exist.
    flag: "--codex",
    accepts: (command) => acceptsTargetFlag(command, "--codex"),
    supportedCommands: () => supportedTargetCommands("--codex"),
    requiresClaude: false,
  },
  {
    flag: "--full",
    accepts: (command) => command === "add",
    supportedCommands: () => ["add"],
    requiresClaude: true,
  },
  {
    // The motivating case for the whole table: `aps backups prune --dry-run` deletes real backups
    // under a flag that promised a preview.
    flag: "--dry-run",
    accepts: (command) => command === "config-compact",
    supportedCommands: () => ["config-compact"],
    requiresClaude: true,
  },
];

/**
 * Builds the sentence a refusal carries.
 *
 * The generic form is a last resort rather than the rule. Two refusals have a reason worth
 * stating: a `shared` command refuses both target flags because the flag asks a question with no
 * answer, and `config compact` refuses `--codex` because it has no Codex form at all. Neither is
 * a missing capability, and reporting one as a missing capability would be the wrong fix.
 */
function refusalMessageFor(guard: FlagGuard, command: CommandId): string {
  if (guard.flag === "--codex" && command === "config-compact") {
    return "config compact has no Codex form: it rewrites Claude provider records, so it requires --claude.";
  }
  if (scopeOf(command) === "shared") {
    return `"${command}" operates on state every target shares, so it cannot be narrowed with ${guard.flag}.`;
  }
  return `"${command}" does not support ${guard.flag}.`;
}

/**
 * Throws `INVALID_ARGUMENT` when a flag was passed to a command that would ignore it.
 *
 * Called by `executeCommand` before the Claude early-return in `handleRegisteredCommand`, not
 * after it. A Claude-capable command such as `switch --claude --full` reaches the Claude path, so
 * a check placed after that branch would never see the stray flag.
 *
 * `globalOptions` is what makes the `--codex-dir` check possible: that flag is stripped by the
 * parser into the global options rather than recorded in the command-option map, so it is not a
 * guard entry and cannot be seen without it.
 */
export function assertFlagsApply(
  command: CommandId,
  commandOptions: Map<string, string[]>,
  globalOptions: { codexDirExplicit?: boolean } = {}
): void {
  const claudeRequested = commandOptions.has("--claude");

  for (const guard of FLAG_GUARDS) {
    if (!commandOptions.has(guard.flag)) {
      continue;
    }

    if (!guard.accepts(command)) {
      throw cliError("INVALID_ARGUMENT", refusalMessageFor(guard, command), {
        command,
        supportedCommands: guard.supportedCommands(),
      });
    }

    if (guard.requiresClaude && !claudeRequested) {
      throw cliError("INVALID_ARGUMENT", `${guard.flag} only applies together with --claude.`, {
        command,
        flag: guard.flag,
      });
    }
  }

  // Only the `both` commands refuse this pair. On a `switchable` command `aps list --claude
  // --codex-dir X` was a long-standing accepted form that never read the directory, and changing
  // it is not this release's business; on `doctor`, `status`, and `backups list` the Codex
  // directory is genuinely part of what the command would otherwise report, so naming one under
  // `--claude` is a request the command cannot honour.
  if (globalOptions.codexDirExplicit && claudeRequested && scopeOf(command) === "both") {
    throw cliError(
      "INVALID_ARGUMENT",
      `"${command}" reports both targets; --codex-dir does not apply when --claude narrows it to Claude.`,
      { command, flag: "--codex-dir" }
    );
  }
}
