import type { CommandId } from "../commands/types";

/**
 * The targets this CLI can manage.
 *
 * Closed on purpose. Adding a third target is a type change that fails at every exhaustive
 * switch, which is the shape we want while the abstraction that makes one cheap does not exist
 * yet (roadmap `1.2.0`).
 */
export type TargetId = "codex" | "claude";

/**
 * Every target id, in the order the tool presents them. Codex first because it is the default.
 */
export const TARGET_IDS: readonly TargetId[] = ["codex", "claude"];

/**
 * The target flags, which are the only way a caller narrows a command.
 */
export type TargetFlag = "--claude" | "--codex";

/**
 * The outcome of asking "which target did this invocation name".
 *
 * `target: null` is a definite answer, not a failure to reach one: the parse-failure and
 * unrecognized-command paths have no command to describe, and saying "no target" is what keeps
 * the envelope field honest for them. A refusal is the other outcome, and it is reserved for a
 * request that contradicts itself.
 */
export type TargetResolution =
  | { target: TargetId | null }
  | { refusal: { code: "INVALID_ARGUMENT"; message: string } };

/**
 * Resolves the target one invocation names, or refuses a request that names two.
 *
 * Pure: three scalars in, no filesystem, no parsed-options map. That is what makes the whole
 * accept/refuse matrix testable without building a tool home.
 *
 * It deliberately does **not** consult the set of Claude-capable commands. That set answers "does
 * this command have a Claude code path", which is a different question from "which target did the
 * caller name"; the flag guards are what make the two agree, and folding them together would mean
 * editing the capability set to add a target-aware command.
 *
 * A conflict is a refusal rather than a precedence rule. `--claude --codex` could quietly let one
 * win, but a hidden precedence silently discards a flag the user typed.
 *
 * In `1.1.3` this function's `target` arm answers only for a command that covers one target; a
 * command that covers two asks `selectedTargets()` instead, and dispatch reads this one for its
 * refusal alone. `TARGET_SCOPES` below is where that distinction lives.
 */
export function resolveTarget(input: {
  command: CommandId | null;
  claudeRequested: boolean;
  codexRequested: boolean;
}): TargetResolution {
  if (input.claudeRequested && input.codexRequested) {
    return {
      refusal: {
        code: "INVALID_ARGUMENT",
        message: "--claude and --codex name different targets and cannot be combined.",
      },
    };
  }

  if (input.command === null) {
    return { target: null };
  }

  // `--codex` is the default, so naming it explicitly changes nothing here. It is resolved rather
  // than ignored so that the flag has one meaning everywhere: it appears in `target` and in the
  // envelope whether or not it was typed.
  return { target: input.claudeRequested ? "claude" : "codex" };
}

/**
 * What a command does with the target flags, and therefore which targets it covers.
 *
 * The five values are the five answers the questions actually have, not a hierarchy:
 *
 * - `switchable` — has both a Codex and a Claude code path; the flag picks one, and Codex is the
 *   default.
 * - `codex-only` — acts on Codex state; `--claude` is refused, `--codex` is accepted and changes
 *   nothing, because naming the default must never fail.
 * - `claude-only` — has no Codex form at all, so `--claude` is required rather than optional.
 * - `both` — reports on both targets at once, and a flag narrows the report instead of choosing a
 *   code path.
 * - `shared` — operates on state the targets share (one backups tree, one pointer, one lock), so
 *   neither flag is a smaller answer and both are refused.
 */
export type TargetScope = "switchable" | "codex-only" | "claude-only" | "both" | "shared";

/**
 * Every command's target scope.
 *
 * `Record<CommandId, TargetScope>` rather than a `Map` built at runtime: a command added to the
 * union without an entry here is a compile error, which is the whole point of the table. Three
 * consumers used to hold this fact separately — `CLAUDE_COMMANDS`, the `--claude` guard, and the
 * dispatch decision — and a new command could satisfy all three differently.
 */
export const TARGET_SCOPES: Record<CommandId, TargetScope> = {
  "config-show": "codex-only",
  "config-list-profiles": "codex-only",
  "config-compact": "claude-only",
  init: "codex-only",
  migrate: "codex-only",
  setup: "codex-only",
  list: "switchable",
  show: "switchable",
  current: "switchable",
  status: "both",
  edit: "codex-only",
  add: "switchable",
  switch: "switchable",
  remove: "switchable",
  import: "codex-only",
  export: "codex-only",
  "backups-list": "both",
  "backups-prune": "shared",
  doctor: "both",
  unlock: "shared",
  rollback: "shared",
};

/**
 * Returns one command's declared scope.
 */
export function scopeOf(command: CommandId): TargetScope {
  return TARGET_SCOPES[command];
}

/**
 * Resolves a scope from a token that is only known to be a string, or `null` when it names no
 * command.
 *
 * Needed because the execution context widens `command` to `CommandId | "help" | "version"` for
 * the pre-dispatch render paths, and the Claude early-return reads that context rather than a
 * command definition. An unknown token answers `null` instead of a made-up scope.
 */
export function scopeOfName(command: string): TargetScope | null {
  return Object.prototype.hasOwnProperty.call(TARGET_SCOPES, command)
    ? TARGET_SCOPES[command as CommandId]
    : null;
}

/**
 * Reports whether a command accepts one target flag.
 *
 * This is a wider question than {@link routesToClaudeHandler}: `both` accepts `--claude` without
 * having a Claude handler that could produce the whole answer. Conflating the two would either
 * send `doctor` to a handler that returns a Claude-only payload, or refuse `--claude` on the one
 * command a Claude-only user needs.
 */
export function acceptsTargetFlag(command: CommandId, flag: TargetFlag): boolean {
  const scope = scopeOf(command);
  return flag === "--claude"
    ? scope === "switchable" || scope === "claude-only" || scope === "both"
    : scope === "switchable" || scope === "codex-only" || scope === "both";
}

/**
 * Reports whether a command's dispatch for this flag pair belongs to `handleClaudeCommand`.
 *
 * True for a `switchable` command that named Claude and for a `claude-only` command, which has no
 * Codex path to fall back to. **False for `both`**, deliberately: `doctor`, `status`, and
 * `backups list` have no Claude handler that could produce the whole result, so routing them
 * there would answer half the question the caller asked.
 */
export function routesToClaudeHandler(command: CommandId): boolean {
  const scope = scopeOf(command);
  return scope === "switchable" || scope === "claude-only";
}

/**
 * Returns the targets a command covers for one invocation.
 *
 * The only function that reads the flags for a `both` command. For every other scope it returns
 * the single target the command covers, or `[]` for `shared`, which has no target to name.
 *
 * A `--claude --codex` pair is *not* handled here: `resolveTarget()` refuses it before a handler
 * runs, because a contradiction between two flags is a property of the pair rather than of the
 * command's scope.
 */
export function selectedTargets(command: CommandId, options: Map<string, string[]>): TargetId[] {
  switch (scopeOf(command)) {
    case "switchable":
      return [options.has("--claude") ? "claude" : "codex"];
    case "codex-only":
      return ["codex"];
    case "claude-only":
      return ["claude"];
    case "both":
      if (options.has("--claude")) return ["claude"];
      if (options.has("--codex")) return ["codex"];
      return [...TARGET_IDS];
    case "shared":
      return [];
  }
}

/**
 * Collapses a target list into the envelope's single-target convenience field.
 *
 * Non-null exactly when one target is in scope. `[]` and a two-target list both answer `null`,
 * which is why `targets` is the authoritative field and this one is an alias.
 */
export function singleTarget(targets: TargetId[]): TargetId | null {
  return targets.length === 1 ? targets[0] : null;
}
