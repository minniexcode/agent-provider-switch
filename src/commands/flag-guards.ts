import { cliError } from "../domain/errors";
import {
  acceptsTarget,
  resolveCommandTargets,
  scopeOf,
  TARGET_METADATA,
  TargetId,
  TargetScopeRefusal,
  TargetSelection,
} from "../domain/target";
import { findCommandDefinition, getKnownCommandIds } from "./registry";
import { CommandId } from "./types";

/**
 * The commands that can be asked about one target, sorted for a stable refusal message.
 *
 * Derived from the target declarations rather than kept beside them: the capability table is the
 * only place the answer lives, so the message and the check cannot disagree.
 */
function commandsAccepting(target: TargetId): string[] {
  return getKnownCommandIds()
    .filter((command) => acceptsTarget(command, target))
    .sort();
}

/**
 * The public spelling of a command, for a sentence a user has to recognize.
 */
function commandLabel(command: CommandId): string {
  return findCommandDefinition(command)?.tokens.join(" ") ?? command;
}

/**
 * The two spellings that select one target: the shorthand flag and the `--target` form.
 */
function selectorLabel(target: TargetId): string {
  return `${TARGET_METADATA[target].aliases[0]} (or --target ${target})`;
}

/**
 * A flag that is only meaningful together with one target's selection.
 *
 * The declaration is per flag and per command: `--full` means "keep the file's entries verbatim"
 * for Claude `add` and nothing at all anywhere else, and `--dry-run` is a promise the commands
 * that do not implement it must not accept. A flag that is accepted and then ignored is worse than
 * a refusal, which is why these two have entries rather than being read where they are used.
 */
type TargetOnlyFlag = {
  flag: string;
  command: CommandId;
  target: TargetId;
};

const TARGET_ONLY_FLAGS: TargetOnlyFlag[] = [
  { flag: "--full", command: "add", target: "claude" },
  { flag: "--dry-run", command: "config-compact", target: "claude" },
];

/**
 * Builds the sentence a scope refusal carries.
 *
 * The generic form is a last resort rather than the rule. Two refusals have a reason worth
 * stating: a `shared` command refuses a selection because it asks a question with no answer, and
 * `config compact` refuses Codex because it has no Codex form at all. Neither is a missing
 * capability, and reporting one as a missing capability would be the wrong fix.
 */
function refusalMessageFor(refusal: TargetScopeRefusal): string {
  switch (refusal.kind) {
    case "shared":
      return `"${refusal.command}" operates on state every target shares, so it cannot be narrowed with ${refusal.token}.`;
    case "no-form":
      return `${commandLabel(refusal.command)} has no ${TARGET_METADATA[refusal.target].label} form: it requires an explicit ${selectorLabel(refusal.required)}.`;
    case "requires-selection":
      return `${commandLabel(refusal.command)} requires ${selectorLabel(refusal.target)}: it has no default target, so the target must be named.`;
    case "unsupported":
      return `"${refusal.command}" does not support ${refusal.token}.`;
  }
}

/**
 * Turns one refusal into the error the CLI reports, with the details its consumers read.
 *
 * Every refusal names the commands the selection *would* apply to, so a caller does not have to
 * guess whether the argument or the command was the mistake. The missing-selection refusal is the
 * exception: the command is right and the target is known, so a list of alternatives would be noise.
 */
function refusalError(refusal: TargetScopeRefusal) {
  const message = refusalMessageFor(refusal);
  if (refusal.kind === "requires-selection") {
    return cliError("INVALID_ARGUMENT", message, { command: refusal.command });
  }

  return cliError("INVALID_ARGUMENT", message, {
    command: refusal.command,
    supportedCommands: commandsAccepting(refusal.target),
  });
}

/**
 * Settles one invocation's scope and refuses any flag that would be ignored, returning the targets
 * it covers.
 *
 * Called by `executeCommand` before anything reads a file, and before the Claude routing decision,
 * not after it: a Claude-capable command such as `switch --claude --full` reaches the Claude path,
 * so a check placed after that branch would never see the stray flag.
 *
 * The order is normative. Selection is resolved first — including the requirement that
 * `config compact` name its target — because a flag that only applies to a Claude command has no
 * answer at all on a command Claude cannot run. Both judgements read the same normalized
 * `TargetSelection`, so `--claude` and `--target claude` cannot disagree anywhere downstream.
 *
 * `globalOptions` is what makes the `--codex-dir` check possible: that flag is stripped by the
 * parser into the global options rather than recorded in the command-option map, so it is not one
 * of the entries above and cannot be seen without it.
 */
export function assertFlagsApply(
  command: CommandId,
  selection: TargetSelection,
  commandOptions: Map<string, string[]>,
  globalOptions: { codexDirExplicit?: boolean } = {}
): TargetId[] {
  const decision = resolveCommandTargets(command, selection);
  if ("refusal" in decision) {
    throw refusalError(decision.refusal);
  }

  for (const entry of TARGET_ONLY_FLAGS) {
    if (!commandOptions.has(entry.flag)) {
      continue;
    }

    const applies =
      command === entry.command && selection.kind === "explicit" && selection.id === entry.target;
    if (!applies) {
      throw cliError(
        "INVALID_ARGUMENT",
        `${entry.flag} only applies to ${TARGET_METADATA[entry.target].label}: pass ${selectorLabel(entry.target)} with "${commandLabel(entry.command)}".`,
        { command, flag: entry.flag, supportedCommands: [entry.command] }
      );
    }
  }

  // Only the `both` commands refuse this pair. On a `switchable` command `aps list --claude
  // --codex-dir X` was a long-standing accepted form that never read the directory, and changing
  // it is not this release's business; on `doctor`, `status`, and `backups list` the Codex
  // directory is genuinely part of what the command would otherwise report, so naming one under a
  // Claude selection is a request the command cannot honour.
  if (globalOptions.codexDirExplicit && selection.kind === "explicit" && selection.id === "claude" && scopeOf(command) === "both") {
    throw cliError(
      "INVALID_ARGUMENT",
      `"${command}" reports both targets; --codex-dir does not apply when --claude narrows it to Claude.`,
      { command, flag: "--codex-dir" }
    );
  }

  return decision.targets;
}
