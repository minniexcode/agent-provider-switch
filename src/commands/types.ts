import type { TargetId } from "../domain/target";
import type { AgentProviderSwitchConfig } from "../storage/codex-paths";
import type { ToolConfigInspection } from "../app/inspect-tool-config";

/**
 * Global flags that apply to every CLI command.
 */
export type GlobalOptions = {
  json: boolean;
  reveal: boolean;
  codexDir: string | null;
  codexDirExplicit?: boolean;
};

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
 * Parsed CLI input split into a stable command id, positional arguments, and options.
 */
export type ParsedCommand = {
  command: CommandId | null;
  positionals: string[];
  globalOptions: GlobalOptions;
  commandOptions: Map<string, string[]>;
  helpRequested: boolean;
  helpTarget: string | null;
  versionRequested: boolean;
};

/**
 * Execution context shared between parsing and rendering.
 */
export type CommandExecutionContext = {
  command: CommandId | "help" | "version";
  options: GlobalOptions;
  /**
   * The targets this invocation covers, resolved once by `executeCommand`.
   *
   * Required rather than optional, so every construction site states its answer instead of
   * defaulting to `undefined` — the same convention `restoreManifest`'s allowlist and the Claude
   * services' `defaults` argument follow. `[]` means "no command resolved": the help, version, and
   * pre-dispatch failure paths built in `cli.ts` all pass it, and they must, because those never
   * reach dispatch to have it filled in.
   *
   * A list rather than `1.1.1`'s single `target`, because a command may cover two targets at once
   * (`doctor`, `status`, `backups list` report both unless narrowed). The envelope's singular
   * `target` is derived from this by `singleTarget()`, so the two can never disagree.
   */
  targets: TargetId[];
  /**
   * The parsed tool config, set by `executeCommand` from the read it already performs for
   * `defaultCodexDir`. Absent when no tool config exists, and absent in any context built
   * outside dispatch, so consumers treat it as optional.
   */
  toolConfig?: AgentProviderSwitchConfig | null;
  /**
   * The reporting-safe inspection of the shared tool config, set by `executeCommand` for the
   * commands that report rather than mutate.
   *
   * Both readers exist because the two callers want opposite things from a broken file: `switch`
   * must refuse to write a delta against defaults it could not read, while `doctor` has to say what
   * it could not read and keep going. `toolConfig` above stays the strict one for the mutation
   * path; this is the field the report builders consume.
   */
  toolConfigInspection?: ToolConfigInspection;
  /**
   * Set by `executeCommand` when the Codex directory cannot be determined without guessing —
   * the shared config is unreadable and neither `--codex-dir` nor `APS_CODEX_DIR` named one.
   *
   * A non-null value means the runtime-derived readings of a report are `unavailable` and the
   * `~/.codex` fallback must not be used. The tool-home registry path is unaffected: it does not
   * come from the shared config.
   */
  codexDirUnavailableReason?: string | null;
};

export type CommandGroup = "read" | "write" | "recovery";

export type CommandDefinition = {
  id: CommandId;
  tokens: string[];
  group: CommandGroup;
  summary: string;
  usage: string[];
  details: string[];
  examples: string[];
  /**
   * Declares which of this command's flags take no value.
   *
   * This is declaration and help metadata, not the parser's input: the set is applied globally
   * in the parser's first pass, because `--claude` has to be understood before the command is
   * even known. Declaring it here is what keeps a second source of truth from being useful —
   * a test asserts every name listed across the registry is one the parser actually strips, so
   * a flag declared boolean but unknown to the parser cannot silently swallow the next token.
   */
  booleanFlags?: string[];
  handler: CommandHandler;
};

export type CommandHandler = (
  ctx: CommandExecutionContext,
  parsed: ParsedCommand,
  runtime: import("../interaction/prompt").CliPromptRuntime
) => Promise<import("../app/types").CommandResult> | import("../app/types").CommandResult;
