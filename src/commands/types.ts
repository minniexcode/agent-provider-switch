import type { AgentProviderSwitchConfig } from "../storage/codex-paths";

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
   * The parsed tool config, set by `executeCommand` from the read it already performs for
   * `defaultCodexDir`. Absent when no tool config exists, and absent in any context built
   * outside dispatch, so consumers treat it as optional.
   */
  toolConfig?: AgentProviderSwitchConfig | null;
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
