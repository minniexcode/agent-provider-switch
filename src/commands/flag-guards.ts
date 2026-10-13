import { cliError } from "../domain/errors";
import { getClaudeCommandNames, supportsClaudeTarget } from "./claude-handlers";
import { getKnownCommandIds } from "./registry";

/**
 * A global boolean flag and the commands that actually do something with it.
 */
type FlagGuard = {
  flag: string;
  accepts: (command: string) => boolean;
  supportedCommands: () => string[];
  /** Whether the flag only means something alongside `--claude`. */
  requiresClaude: boolean;
  /**
   * Replaces the default `"<command>" does not support <flag>.` sentence.
   *
   * Used where the generic form would be misleading rather than merely terse. It is a function of
   * the command so the message stays correct if `accepts` changes, rather than a fixed string
   * that has to be remembered alongside it.
   */
  refusalMessage?: (command: string) => string;
};

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
    accepts: supportsClaudeTarget,
    supportedCommands: getClaudeCommandNames,
    requiresClaude: false,
  },
  {
    // Naming the default must not fail, so this entry has almost no refusal surface: every
    // command accepts it except the one with no Codex form at all. It is nevertheless a real
    // entry, because "accepted everywhere" is exactly the assumption that stops holding the first
    // time a command is Claude-only.
    //
    // `backups prune`, `rollback`, and `unlock` accept it here and will refuse it in `1.1.3`,
    // where the shared-state commands stop pretending to narrow. Refusing it now would need the
    // scope table that release introduces, and shipping half of that table is how a `doctor`
    // ends up reporting one target under a flag that asked about two.
    flag: "--codex",
    accepts: (command) => command !== "config-compact",
    supportedCommands: () => getKnownCommandIds().filter((command) => command !== "config-compact"),
    requiresClaude: false,
    refusalMessage: (command) =>
      command === "config-compact"
        ? "config compact has no Codex form: it rewrites Claude provider records, so it requires --claude."
        : `"${command}" does not support --codex.`,
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
 * Throws `INVALID_ARGUMENT` when a flag was passed to a command that would ignore it.
 *
 * Called by `executeCommand` before the Claude early-return in `handleRegisteredCommand`, not
 * after it. A Claude-capable command such as `switch --claude --full` reaches the Claude path, so
 * a check placed after that branch would never see the stray flag.
 */
export function assertFlagsApply(command: string, commandOptions: Map<string, string[]>): void {
  const claudeRequested = commandOptions.has("--claude");

  for (const guard of FLAG_GUARDS) {
    if (!commandOptions.has(guard.flag)) {
      continue;
    }

    if (!guard.accepts(command)) {
      throw cliError(
        "INVALID_ARGUMENT",
        guard.refusalMessage ? guard.refusalMessage(command) : `"${command}" does not support ${guard.flag}.`,
        {
          command,
          supportedCommands: guard.supportedCommands(),
        }
      );
    }

    if (guard.requiresClaude && !claudeRequested) {
      throw cliError("INVALID_ARGUMENT", `${guard.flag} only applies together with --claude.`, {
        command,
        flag: guard.flag,
      });
    }
  }
}
