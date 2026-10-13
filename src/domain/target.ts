import type { CommandId, TargetOperation } from "./command";

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
 *
 * The single source of registration order: metadata, capability lists and report composition all
 * iterate this array rather than hard-coding a sequence.
 */
export const TARGET_IDS: readonly TargetId[] = ["codex", "claude"];

/**
 * The target flags, which are the only way a caller narrows a command.
 */
export type TargetFlag = "--claude" | "--codex";

/**
 * What is known statically about one target.
 *
 * Static data only. Nothing here may read a file, resolve a path, or probe a runtime — the
 * execution binding that does those things is assembled separately, and keeps this declaration
 * usable from help, the parser and the pure scope checks without loading a single service.
 */
export type TargetMetadata = {
  id: TargetId;
  /** Human-facing name, used in refusal sentences and report headings. */
  label: string;
  /** The shorthand flags that name this target, without the `--target <id>` spelling. */
  aliases: readonly string[];
  /** The record file this target's registry lives in, inside the shared tool home. */
  registryFile: string;
  /** The environment variable that overrides this target's runtime directory. */
  runtimeDirEnv: string;
  /** Every command this target implements, and therefore accepts. */
  operations: readonly TargetOperation[];
  /** The registry file names this target owns, for backup-origin classification. */
  backupArtifacts: readonly string[];
};

/**
 * Codex, the default target.
 *
 * `operations` is the capability declaration the guard, dispatch, help and report selection all
 * read. It is deliberately the opposite of a list of id prefixes: a command is offered to a target
 * exactly when the target declares it, so adding a target means declaring what it can do rather
 * than editing a central branch.
 */
const CODEX_METADATA: TargetMetadata = {
  id: "codex",
  label: "Codex",
  aliases: ["--codex"],
  registryFile: "providers.json",
  runtimeDirEnv: "APS_CODEX_DIR",
  operations: [
    "add",
    "list",
    "show",
    "current",
    "switch",
    "remove",
    "init",
    "migrate",
    "setup",
    "edit",
    "import",
    "export",
    "config-show",
    "config-list-profiles",
    "doctor",
    "status",
    "backups-list",
  ],
  backupArtifacts: ["providers.json"],
};

/**
 * Claude Code.
 *
 * `config compact` is here and not on Codex because Codex records are already flat: there is
 * nothing to compact, which is why the command has no Codex form rather than an unimplemented one.
 */
const CLAUDE_METADATA: TargetMetadata = {
  id: "claude",
  label: "Claude",
  aliases: ["--claude"],
  registryFile: "claude-providers.json",
  runtimeDirEnv: "APS_CLAUDE_DIR",
  operations: [
    "add",
    "list",
    "show",
    "current",
    "switch",
    "remove",
    "config-compact",
    "doctor",
    "status",
    "backups-list",
  ],
  backupArtifacts: ["claude-providers.json"],
};

/**
 * Every target's static declaration, keyed by id.
 *
 * A record rather than a list so a lookup by id cannot silently miss; the ordered list below is
 * what anything that iterates the targets uses.
 */
export const TARGET_METADATA: Readonly<Record<TargetId, TargetMetadata>> = {
  codex: CODEX_METADATA,
  claude: CLAUDE_METADATA,
};

/**
 * Every target declaration, in registration order.
 */
export const TARGET_METADATA_LIST: readonly TargetMetadata[] = TARGET_IDS.map((id) => TARGET_METADATA[id]);

const ALIAS_TO_TARGET: ReadonlyMap<string, TargetId> = new Map(
  TARGET_METADATA_LIST.flatMap((metadata) => metadata.aliases.map((alias) => [alias, metadata.id] as const))
);

/**
 * Resolves a shorthand flag such as `--claude` to the target it names, or null.
 *
 * A generated lookup rather than an `if` chain, so the alias set has one declaration — the
 * metadata — and a target that renames its flag cannot leave a stale comparison behind.
 */
export function targetOfAlias(token: string): TargetId | null {
  return ALIAS_TO_TARGET.get(token) ?? null;
}

/**
 * Reports whether a token is a target id, spelled exactly.
 *
 * There are no implicit aliases: `codex` and `claude` are the ids, and anything else is a
 * misspelling to be refused rather than guessed at.
 */
export function isTargetId(value: string): value is TargetId {
  return Object.prototype.hasOwnProperty.call(TARGET_METADATA, value);
}

/**
 * Reports whether one target declares an operation.
 */
export function targetSupports(operation: TargetOperation, target: TargetId): boolean {
  return TARGET_METADATA[target].operations.includes(operation);
}

/**
 * The targets declaring one operation, in registration order.
 */
export function targetsDeclaring(operation: TargetOperation): TargetId[] {
  return TARGET_IDS.filter((id) => targetSupports(operation, id));
}

/**
 * What one command does with a target selection.
 *
 * Three shapes rather than one record with nullable fields, because the three answer different
 * questions and only two of them have an operation at all:
 *
 * - `single` — acts on one target. `defaultTarget` is the target used when nothing was named;
 *   `null` means there is none and `requireExplicit` is then true.
 * - `many` — reports on every target declaring the operation, and an explicit selection narrows
 *   the report instead of choosing a code path.
 * - `shared` — operates on state the targets share, so no target can be named at all.
 */
export type CommandTargetPolicy =
  | {
      mode: "single";
      operation: TargetOperation;
      defaultTarget: TargetId | null;
      requireExplicit: boolean;
    }
  | { mode: "many"; operation: TargetOperation }
  | { mode: "shared" };

/**
 * Builds a `single` policy. Codex is the default unless `defaultTarget` says otherwise.
 */
function single(operation: TargetOperation, defaultTarget: TargetId | null = "codex"): CommandTargetPolicy {
  return { mode: "single", operation, defaultTarget, requireExplicit: defaultTarget === null };
}

/**
 * Every command's target policy.
 *
 * `Record<CommandId, CommandTargetPolicy>` rather than a `Map` built at runtime: a command added to
 * the union without an entry here is a compile error, which is the whole point of the table. The
 * scope vocabulary below is *derived* from it — this is the single declaration, and the older
 * `switchable`/`codex-only`/`claude-only`/`both`/`shared` names are a facade over it rather than a
 * second list that could drift.
 *
 * `setup` declares the Codex operation while its handler still returns the deprecated error: the
 * declaration answers "may this be asked of Codex", which is not the same question as "will it do
 * anything".
 */
export const COMMAND_TARGET_POLICIES: Record<CommandId, CommandTargetPolicy> = {
  "config-show": single("config-show"),
  "config-list-profiles": single("config-list-profiles"),
  "config-compact": single("config-compact", null),
  init: single("init"),
  migrate: single("migrate"),
  setup: single("setup"),
  list: single("list"),
  show: single("show"),
  current: single("current"),
  status: { mode: "many", operation: "status" },
  edit: single("edit"),
  add: single("add"),
  switch: single("switch"),
  remove: single("remove"),
  import: single("import"),
  export: single("export"),
  "backups-list": { mode: "many", operation: "backups-list" },
  "backups-prune": { mode: "shared" },
  doctor: { mode: "many", operation: "doctor" },
  unlock: { mode: "shared" },
  rollback: { mode: "shared" },
};

/**
 * Returns one command's declared policy.
 */
export function policyOf(command: CommandId): CommandTargetPolicy {
  return COMMAND_TARGET_POLICIES[command];
}

/**
 * What a command does with the target flags, and therefore which targets it covers.
 *
 * The five values are the five answers the questions actually have, not a hierarchy:
 *
 * - `switchable` — has both a Codex and a Claude code path; the selection picks one, and Codex is
 *   the default.
 * - `codex-only` — acts on Codex state; a Claude selection is refused, a Codex one is accepted and
 *   changes nothing, because naming the default must never fail.
 * - `claude-only` — has no Codex form at all, so a Claude selection is required rather than
 *   optional.
 * - `both` — reports on both targets at once, and a selection narrows the report instead of
 *   choosing a code path.
 * - `shared` — operates on state the targets share (one backups tree, one pointer, one lock), so
 *   neither target is a smaller answer and both are refused.
 *
 * Derived from {@link COMMAND_TARGET_POLICIES}. It stays because the renderer, the flag guard and
 * the Claude routing question all speak this vocabulary, and translating it in three places would
 * be three chances to disagree.
 */
export type TargetScope = "switchable" | "codex-only" | "claude-only" | "both" | "shared";

/**
 * Returns one command's scope, read off its policy.
 */
export function scopeOf(command: CommandId): TargetScope {
  const policy = policyOf(command);
  if (policy.mode === "shared") return "shared";
  if (policy.mode === "many") return "both";
  if (policy.defaultTarget === null) return "claude-only";
  // Two targets implementing one operation is exactly what `switchable` means, so the capability
  // declaration is what decides, not a second list of command names.
  return targetSupports(policy.operation, "claude") ? "switchable" : "codex-only";
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
  return Object.prototype.hasOwnProperty.call(COMMAND_TARGET_POLICIES, command)
    ? scopeOf(command as CommandId)
    : null;
}

/**
 * Reports whether a command can be asked about one target.
 *
 * Narrower than {@link routesToClaudeHandler}: `doctor` accepts a Claude selection without having a
 * Claude handler that could produce the whole answer. Conflating the two would either send `doctor`
 * to a handler that returns a Claude-only payload, or refuse a Claude selection on the one command
 * a Claude-only user needs.
 */
export function acceptsTarget(command: CommandId, target: TargetId): boolean {
  const policy = policyOf(command);
  if (policy.mode === "shared") return false;
  return targetSupports(policy.operation, target);
}

/**
 * Reports whether a command accepts one shorthand target flag.
 */
export function acceptsTargetFlag(command: CommandId, flag: TargetFlag): boolean {
  return acceptsTarget(command, flag === "--claude" ? "claude" : "codex");
}

/**
 * Reports whether a command's dispatch for a Claude selection belongs to the Claude handler.
 *
 * True for a `switchable` command and for a `claude-only` command, which has no Codex path to fall
 * back to. **False for `both`**, deliberately: `doctor`, `status`, and `backups list` have no
 * Claude handler that could produce the whole result, so routing them there would answer half the
 * question the caller asked.
 *
 * Takes a plain string because the execution context widens `command` to
 * `CommandId | "help" | "version"` for the pre-dispatch render paths, and a token that names no
 * command is a definite "no" rather than a mistake — the same contract `scopeOfName()` has.
 */
export function routesToClaudeHandler(command: string): boolean {
  const scope = scopeOfName(command);
  return scope === "switchable" || scope === "claude-only";
}

/**
 * The target one invocation named, after every spelling has been normalized.
 *
 * `implicit` and an explicit selection of the default target are different answers, and the
 * difference is load-bearing: `config compact` requires an explicit Claude selection, and a shared
 * command refuses any selection at all — both would be invisible if a bare invocation and
 * `--codex` collapsed into "the default target".
 *
 * `token` keeps the spelling the caller used, for diagnostics only. Nothing decides behaviour from
 * it; it exists so a refusal can quote the argument the user actually typed.
 */
export type TargetSelection =
  | { kind: "implicit" }
  | { kind: "explicit"; id: TargetId; token: string };

/**
 * A selection this command cannot honour, described as data.
 *
 * The sentence is built by the CLI layer, which is where the public command names live. Returning
 * the reason rather than a message keeps this module free of presentation and lets the guard, the
 * parser and a test all interpret the same fact.
 */
export type TargetScopeRefusal =
  /** The command acts on state the targets share, so no target can narrow it. */
  | { kind: "shared"; command: CommandId; target: TargetId; token: string }
  /** The command exists, but not for this target. */
  | { kind: "unsupported"; command: CommandId; target: TargetId; token: string }
  /**
   * The command has no form for this target at all — as opposed to a missing implementation for
   * one it conceptually has. `required` names the one target it does have.
   */
  | { kind: "no-form"; command: CommandId; target: TargetId; required: TargetId; token: string }
  /** Nothing was named and the command has no default target. */
  | { kind: "requires-selection"; command: CommandId; target: TargetId };

/**
 * The targets a command covers for one invocation, or the reason it covers none.
 */
export type TargetScopeDecision = { targets: TargetId[] } | { refusal: TargetScopeRefusal };

/**
 * Resolves the target scope of one command for one normalized selection.
 *
 * Pure: a command id and a selection in, no options map, no filesystem. That is what makes the
 * whole accept/refuse matrix testable without building a tool home.
 *
 * A conflict between two targets is *not* a case here. It is a property of the argument list
 * rather than of the command, so the parser refuses it before a command is even resolved.
 */
export function resolveCommandTargets(command: CommandId, selection: TargetSelection): TargetScopeDecision {
  const policy = policyOf(command);

  if (policy.mode === "shared") {
    // `[]` rather than the default target: the command names no target, and that is not the same
    // answer as "Codex". A selection is not a smaller answer either — it is a question with no
    // answer, which is why it is refused rather than ignored.
    return selection.kind === "explicit"
      ? { refusal: { kind: "shared", command, target: selection.id, token: selection.token } }
      : { targets: [] };
  }

  if (policy.mode === "many") {
    const declared = targetsDeclaring(policy.operation);
    if (selection.kind === "implicit") return { targets: declared };
    if (!declared.includes(selection.id)) {
      return { refusal: { kind: "unsupported", command, target: selection.id, token: selection.token } };
    }
    return { targets: [selection.id] };
  }

  if (selection.kind === "implicit") {
    if (policy.defaultTarget === null) {
      // The one target this command has is also the only legal answer, and requiring it to be
      // named keeps a destructive command from running on a default nobody chose.
      return {
        refusal: {
          kind: "requires-selection",
          command,
          target: targetsDeclaring(policy.operation)[0] ?? "claude",
        },
      };
    }
    return { targets: [policy.defaultTarget] };
  }

  if (!targetSupports(policy.operation, selection.id)) {
    return policy.defaultTarget === null
      ? {
          refusal: {
            kind: "no-form",
            command,
            target: selection.id,
            required: targetsDeclaring(policy.operation)[0] ?? "claude",
            token: selection.token,
          },
        }
      : { refusal: { kind: "unsupported", command, target: selection.id, token: selection.token } };
  }

  return { targets: [selection.id] };
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
