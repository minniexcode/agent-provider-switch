import { cliError } from "../domain/errors";
import { resolveCodexDir } from "../storage/codex-paths";
import { CommandId, ParsedCommand } from "./types";
import { resolveCommandFromArgv } from "./registry";

/**
 * Flags that never take a value.
 *
 * Matched by exact token in the first pass, so the command-option pass below cannot consume the
 * following token as their value. That is what makes `aps add --claude <name>` keep the name
 * as a positional, and what lets `aps --claude list` resolve at all — the flag is
 * position-independent.
 *
 * `--reveal` is deliberately absent. It is stripped by the same exact-token rule a few lines
 * down, so listing it here would be a no-op rather than a fix. It stays global.
 */
const BOOLEAN_FLAGS = new Set(["--claude", "--force", "--merge", "--overwrite", "--create-profile", "--full", "--dry-run"]);

/**
 * Parses argv into command positionals, global flags, and command-scoped options.
 */
export function parseArgs(argv: string[]): ParsedCommand {
  let json = false;
  let reveal = false;
  let codexDir: string | null = null;
  let codexDirExplicit = false;
  const remaining: string[] = [];
  // Boolean flags are recorded as they are stripped, because `hasFlag()` and `isClaudeCommand()`
  // read this map. The flag has to stay present; only its value is now always "true".
  const commandOptions = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      json = true;
      continue;
    }

    if (value === "--reveal") {
      // Parsed here, by exact token match, because the command-option pass below
      // would treat `--reveal <providerName>` as a valued option and swallow the name.
      reveal = true;
      continue;
    }

    // This widens a pre-existing wart rather than introducing one: any option *value* that
    // spells a stripped token is recorded as the literal "true". Before this set existed,
    // `aps edit p --note --json` already yielded `--note: ["true"]`; five more names join
    // that class. Fixing it needs a real value-vs-flag model, which is out of scope here.
    if (BOOLEAN_FLAGS.has(value)) {
      commandOptions.set(value, ["true"]);
      continue;
    }

    if (value === "--codex-dir") {
      const next = argv[index + 1];
      if (!next) {
        throw cliError("INVALID_ARGUMENT", "--codex-dir requires a path value.");
      }
      // A flag is never a path, and this branch reads the raw argv, so it would otherwise take
      // the token verbatim and consume it: `aps list --codex-dir --json` resolved a directory
      // literally named "--json" and reported an empty provider list as success. A wrong answer
      // is worse than a refusal here. A directory whose name really does start with a dash can be
      // written with a `./` prefix, which is what the leading-dash check leaves open.
      if (next.startsWith("-")) {
        throw cliError("INVALID_ARGUMENT", "--codex-dir requires a path value, but the next token is a flag.", {
          option: "--codex-dir",
          received: next,
        });
      }
      codexDir = resolveCodexDir(next);
      codexDirExplicit = true;
      index += 1;
      continue;
    }

    remaining.push(value);
  }

  if (remaining[0] === "help") {
    return {
      command: null,
      positionals: [],
      globalOptions: {
        json,
        reveal,
        codexDir,
        codexDirExplicit,
      },
      commandOptions,
      helpRequested: true,
      helpTarget: remaining.slice(1).join(" ") || null,
      versionRequested: false,
    };
  }

  const versionRequested = remaining.includes("--version") || remaining.includes("-v");
  if (versionRequested) {
    return defaultParsed(null, commandOptions, {
      json,
      reveal,
      codexDir,
      versionRequested: true,
    });
  }

  const { definition, consumedTokens } = resolveCommandFromArgv(remaining);
  const command = definition?.id ?? null;
  const positionals: string[] = [];

  // No fallback to index 1 when nothing resolved. Skipping index 0 was what made an unknown
  // token record nowhere at all, which left `aps --help` and `aps lst` producing the same
  // parse and made "unknown command exits 1" unimplementable without also failing `--help`.
  const startIndex = consumedTokens;

  // Scanned over the whole array, symmetric with --version/-v above, rather than only at the
  // indices the option loop reaches: a valued option would otherwise swallow `--help` as its
  // argument. The exit-code rule in cli.ts is written as though help is reliably detected, so
  // it has to be. The wider help/flag inconsistency is P2-7 and is not closed by this.
  const helpRequested = remaining.includes("--help") || remaining.includes("-h");

  for (let index = startIndex; index < remaining.length; index += 1) {
    const value = remaining[index];
    // Already accounted for by the whole-array scan above; skipped here so it does not also
    // land in `positionals`.
    if (value === "--help" || value === "-h") {
      continue;
    }

    if (value.startsWith("--")) {
      const optionName = value;
      const next = remaining[index + 1];
      if (!next || next.startsWith("--")) {
        commandOptions.set(optionName, ["true"]);
        continue;
      }

      const existing = commandOptions.get(optionName) ?? [];
      existing.push(next);
      commandOptions.set(optionName, existing);
      index += 1;
      continue;
    }

    positionals.push(value);
  }

  return {
    command,
    positionals,
    globalOptions: {
      json,
      reveal,
      codexDir,
      codexDirExplicit,
    },
    commandOptions,
    helpRequested,
    helpTarget: helpRequested && definition ? definition.tokens.join(" ") : null,
    versionRequested: false,
  };
}

/**
 * Creates a parsed result for built-in synthetic commands such as help/version.
 */
function defaultParsed(
  command: CommandId | null,
  commandOptions: Map<string, string[]>,
  overrides?: {
    json?: boolean;
    reveal?: boolean;
    codexDir?: string | null;
    helpRequested?: boolean;
    helpTarget?: string | null;
    versionRequested?: boolean;
  }
): ParsedCommand {
  return {
    command,
    positionals: [],
    globalOptions: {
      json: overrides?.json ?? false,
      reveal: overrides?.reveal ?? false,
      codexDir: overrides?.codexDir ?? null,
      codexDirExplicit: false,
    },
    commandOptions,
    helpRequested: overrides?.helpRequested ?? false,
    helpTarget: overrides?.helpTarget ?? null,
    versionRequested: overrides?.versionRequested ?? false,
  };
}

/**
 * Returns the flags the parser strips as valueless.
 *
 * Exported so the suite can validate every `CommandDefinition.booleanFlags` declaration against
 * the set the parser actually applies — a name declared boolean but absent here would parse fine
 * and then swallow the next token.
 */
export function getBooleanFlagNames(): string[] {
  return [...BOOLEAN_FLAGS];
}

/**
 * Checks whether a boolean-style option was supplied.
 */
export function hasFlag(options: Map<string, string[]>, name: string): boolean {
  return options.has(name);
}

/**
 * Returns the last supplied value for a single-valued command option, or null when absent.
 *
 * Absence is never an error here: callers rely on `null` to fall through to the interactive
 * collector, and `aps add` with no flags is a documented usage form. Presence enforcement
 * lives further down, where it can account for whether a prompt is available.
 */
export function getSingleOption(options: Map<string, string[]>, name: string): string | null {
  const values = options.get(name) ?? [];
  if (values.length === 0) {
    return null;
  }

  return values[values.length - 1];
}
