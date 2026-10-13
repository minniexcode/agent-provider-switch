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
