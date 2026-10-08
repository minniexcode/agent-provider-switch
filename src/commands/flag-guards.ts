import { cliError } from "../domain/errors";
import { getClaudeCommandNames, supportsClaudeTarget } from "./claude-handlers";

/**
 * A global boolean flag and the commands that actually do something with it.
 */
type FlagGuard = {
  flag: string;
  accepts: (command: string) => boolean;
  supportedCommands: () => string[];
  /** Whether the flag only means something alongside `--claude`. */
  requiresClaude: boolean;
};

/**
 * Every global boolean flag a command may not simply ignore.
 *
 * The parser strips these tokens by exact equality before it knows which command it is parsing, so
 * it accepts them anywhere. Accepted-and-ignored is the dangerous reading: `aps backups prune
 * --dry-run` would delete real backups under a flag that promised not to, and `aps status
 * --claude` would report Codex state under a flag that asked about Claude. Each entry here turns
 * that into a refusal that names what the flag does apply to.
 */
const FLAG_GUARDS: FlagGuard[] = [
  {
    flag: "--claude",
    accepts: supportsClaudeTarget,
    supportedCommands: getClaudeCommandNames,
    requiresClaude: false,
  },
  {
    flag: "--full",
    accepts: (command) => command === "add",
    supportedCommands: () => ["add"],
    requiresClaude: true,
  },
];

/**
 * Throws `INVALID_ARGUMENT` when a flag was passed to a command that would ignore it.
 *
 * Runs before the Claude early-return in `handleRegisteredCommand`, not after it. A Claude-capable
 * command such as `switch --claude --full` reaches the Claude path, so a check placed after that
 * branch would never see the stray flag.
 */
export function assertFlagsApply(command: string, commandOptions: Map<string, string[]>): void {
  const claudeRequested = commandOptions.has("--claude");

  for (const guard of FLAG_GUARDS) {
    if (!commandOptions.has(guard.flag)) {
      continue;
    }

    if (!guard.accepts(command)) {
      throw cliError("INVALID_ARGUMENT", `"${command}" does not support ${guard.flag}.`, {
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
}
