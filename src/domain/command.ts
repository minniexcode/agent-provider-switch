/**
 * The command and target-operation vocabulary.
 *
 * It lives in `domain/` rather than in `commands/types.ts` because the target declarations are
 * pure domain data and a domain module may not import from the execution layer. `commands/types.ts`
 * re-exports `CommandId`, so the command layer's own imports read as they always did and there is
 * still exactly one declaration of the union.
 */

/**
 * Stable internal command identifiers used by help, parsing, dispatch, and JSON output.
 */
export type CommandId =
  | "config-show"
  | "config-list-profiles"
  | "config-compact"
  | "init"
  | "migrate"
  | "list"
  | "show"
  | "current"
  | "status"
  | "setup"
  | "edit"
  | "add"
  | "switch"
  | "remove"
  | "import"
  | "export"
  | "backups-list"
  | "backups-prune"
  | "doctor"
  | "unlock"
  | "rollback";

/**
 * The six provider verbs both targets answer through the same shared workflows.
 *
 * Narrower than {@link TargetOperation} on purpose: these are the commands whose implementation is
 * generic, while the rest is either a target-exclusive flow or a report.
 */
export type ProviderVerb = "add" | "list" | "show" | "current" | "switch" | "remove";

/**
 * Everything a target can be asked to do.
 *
 * The three excluded ids — `backups prune`, `rollback`, `unlock` — operate on state the targets
 * share (one backups tree, one pointer, one lock), so they are not per-target capabilities and no
 * target declares them.
 */
export type TargetOperation = Exclude<CommandId, "backups-prune" | "rollback" | "unlock">;

/**
 * The six provider verbs, in the order they are documented.
 */
export const PROVIDER_VERBS: readonly ProviderVerb[] = ["add", "list", "show", "current", "switch", "remove"];

/**
 * Reports whether a command token is one of the six shared provider verbs.
 *
 * Takes a plain string because both callers hold `CommandId | "help" | "version"`, and the answer
 * for anything else is a definite "no". It exists so a caller can ask "is this one of the shared
 * verbs?" without spelling the six labels out again: a second list is a second place to forget a
 * verb when the vocabulary grows.
 */
export function isProviderVerb(command: string): command is ProviderVerb {
  return (PROVIDER_VERBS as readonly string[]).includes(command);
}

/**
 * Every verb that reads a target's registry, and therefore every verb that can ask which provider.
 *
 * Wider than {@link ProviderVerb} by exactly one: `edit` takes a provider name, is Codex-exclusive,
 * and is not one of the six shared workflows — but it asks the same question, and the answer has to
 * be the same list. Keeping it in this vocabulary is what lets the chooser be one implementation
 * rather than two that can drift.
 */
export type ProviderChoiceVerb = ProviderVerb | "edit";
