import { policyOf, TARGET_METADATA, targetsDeclaring } from "../domain/target";
import {
  COMMANDS,
  findCommandDefinitionByTokens,
  getNestedCommandTokens,
  getPublicCommandNames,
  isKnownHelpTopic,
} from "./registry";
import type { CommandId } from "./types";

const GROUP_TITLES = {
  read: "Read Commands",
  write: "Change Commands",
  recovery: "Diagnostics And Recovery",
} as const;

/**
 * Returns the known command names.
 */
export function getKnownCommandNames(): string[] {
  return getPublicCommandNames();
}

/**
 * Checks whether the requested topic is a known command.
 */
export function isKnownCommandNameForHelp(commandName: string): boolean {
  return isKnownHelpTopic(commandName);
}

/**
 * Builds the command help text for the top-level help page or a specific topic.
 */
export function buildHelpText(commandName?: string | null): string {
  if (!commandName) {
    return [
      "agent-provider-switch",
      "",
      "Manage and switch local Codex and Claude Code provider routing safely.",
      "Primary workflow: init -> add -> switch -> status -> doctor.",
      "Advanced adopt flows use migrate only when you already have Codex runtime state to import.",
      "Deprecated entry: setup still exists only to point callers to init or migrate.",
      "",
      "Usage:",
      "  aps <command> [options]",
      "  aps help <command>",
      "",
      ...renderGroupedCommands(),
      "",
       "Global options:",
       "  --json             Output the standard JSON envelope and disable all prompts.",
       "  --target <id>      Act on one target: codex or claude. Equivalent to the shorthand",
       "                     flags below, and refused when two different targets are named.",
       "  --claude           Act on Claude Code state instead of Codex state.",
       "  --codex            Act on Codex state. This is the default, named so that a command",
       "                     line reads the same whichever target it picks.",
       "  --reveal           Print secret values instead of masking them (Claude provider show only).",
       "  --codex-dir <path> Target a specific Codex directory instead of ~/.codex.",
      "  --help             Show top-level or command-specific help.",
      "  --version          Print the current CLI version.",
       "",
       "Environment:",
       "  APS_HOME        Override the agent-provider-switch tool home directory.",
       "  APS_CODEX_DIR   Default Codex directory when --codex-dir is not passed.",
       "  APS_CLAUDE_DIR  Override the Claude Code directory instead of ~/.claude.",
       "  NODE_ENV=development defaults to ./dev-codex/local-sandbox when no override is set.",
      "",
      "Interactive rules:",
      "  Progressive prompts only run in a real TTY and never run under --json.",
      "  Human write commands may guide missing inputs or ask for dangerous-action confirmation.",
      "  Automation should pass explicit arguments and prefer --json for stable parsing.",
      "",
      "Dangerous commands:",
      "  remove deletes provider records.",
      "  import replaces or merges providers.json.",
      "  export may overwrite a target file.",
      "  rollback restores files from a managed backup.",
      "",
      "Examples:",
      "  aps init",
      "  aps add packycode --profile packycode --model gpt-5 --api-key sk-xxx --base-url https://api.example/v1",
      "  aps switch packycode",
      "  aps status",
      "  aps doctor",
      "  aps migrate",
      "  aps config show",
      "  aps backups list",
      "  aps rollback",
      "  aps help add",
    ].join("\n");
  }

  const nestedCommands = getNestedCommandTokens(commandName);
  if (nestedCommands.length > 0) {
    return [
      `aps ${commandName}`,
      "",
      `Available ${commandName} commands:`,
      ...nestedCommands.map((name) => `  ${name}`),
      "",
      "Use `aps help <command>` for detailed usage.",
    ].join("\n");
  }

  const command = findCommandDefinitionByTokens(commandName.split(" "));
  if (!command) {
    return [
      `Unknown help topic: ${commandName}`,
      "",
      "Available commands:",
      ...getKnownCommandNames().map((name) => `  ${name}`),
    ].join("\n");
  }

  return [
    `aps ${command.tokens.join(" ")}`,
    "",
    command.summary,
    "",
    renderTargetHint(command.id),
    "",
    "Usage:",
    ...command.usage.map((usage) => `  ${usage}`),
    "",
    "Details:",
    ...command.details.map((detail) => `  ${detail}`),
    "",
    "Examples:",
    ...command.examples.map((example) => `  ${example}`),
  ].join("\n");
}

/**
 * The target sentence for one command, generated from its policy.
 *
 * Generated rather than hand-written per command, because the alternative is a help text that
 * advertises `--target` on twenty-one commands and silently forgets it on the twenty-second. The
 * prose that cannot be derived — what a command does, and which native features it depends on —
 * stays hand-written in the registry.
 */
function renderTargetHint(command: CommandId): string {
  const policy = policyOf(command);

  if (policy.mode === "shared") {
    return "Targets: state both targets share; neither --claude nor --codex applies.";
  }

  const declared = targetsDeclaring(policy.operation).map((id) => TARGET_METADATA[id].label);

  if (policy.mode === "many") {
    return `Targets: ${joinWithAnd(declared)} by default; --codex, --claude, or --target <id> narrows the report.`;
  }

  if (policy.defaultTarget === null) {
    // One spelling is not enough here: the target is required, so the line has to say how to name
    // it rather than just which one it is.
    const metadata = TARGET_METADATA[targetsDeclaring(policy.operation)[0] ?? "claude"];
    return `Targets: ${metadata.label} only, and it must be named (${metadata.aliases[0]} or --target ${metadata.id}).`;
  }

  if (declared.length === 1) {
    return `Targets: ${declared[0]} only.`;
  }

  return `Targets: ${TARGET_METADATA[policy.defaultTarget].label} by default; --claude or --target claude selects Claude.`;
}

/**
 * Joins names into a readable list: "a and b", "a, b and c".
 */
function joinWithAnd(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function renderGroupedCommands(): string[] {
  const lines: string[] = [];
  for (const group of ["read", "write", "recovery"] as const) {
    lines.push(`${GROUP_TITLES[group]}:`);
    for (const command of COMMANDS.filter((candidate) => candidate.group === group)) {
      lines.push(`  ${command.tokens.join(" ").padEnd(12, " ")} ${command.summary}`);
    }
    lines.push("");
  }

  lines.pop();
  return lines;
}
