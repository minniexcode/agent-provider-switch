import { ProviderOptionBag } from "../app/targets/types";
import { cliError } from "../domain/errors";
import { isTargetId, TargetId, TargetSelection, targetOfAlias, TARGET_IDS } from "../domain/target";
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
 *
 * `--codex` and `--claude` are here rather than in `GlobalOptions` because they carry no value.
 * They are stripped by the same pass that resolves `--target <id>`, and the pair feeds the single
 * normalized `targetSelection` on the parsed result; being recorded in `commandOptions` as well is
 * diagnostics only, since nothing decides behaviour from their presence any more.
 */
const BOOLEAN_FLAGS = new Set(["--claude", "--codex", "--force", "--merge", "--overwrite", "--create-profile", "--full", "--dry-run"]);

/**
 * Parses argv into command positionals, global flags, and command-scoped options.
 */
export function parseArgs(argv: string[]): ParsedCommand {
  let json = false;
  let reveal = false;
  let codexDir: string | null = null;
  let codexDirExplicit = false;
  const remaining: string[] = [];
  // Boolean flags are recorded as they are stripped, because `hasFlag()` reads this map. The flag
  // has to stay present; only its value is now always "true".
  const commandOptions = new Map<string, string[]>();
  // Every selector the caller typed, in the order it appeared, as the id it names plus the spelling
  // used. Collected rather than resolved in place so a conflict is reported once, after the whole
  // argument list has been read.
  const selectors: { id: TargetId; token: string }[] = [];

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

    // Refused rather than left to the valued-option pass, which would record a flag nobody reads
    // and let `aps list --target=claude` report Codex state as if the target had been honoured.
    if (value.startsWith("--target=")) {
      throw cliError("INVALID_ARGUMENT", `--target does not take an "=" form: write --target ${value.slice(9)}.`, {
        option: "--target",
        received: value,
      });
    }

    if (value === "--target") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw cliError("INVALID_ARGUMENT", "--target requires a target id.", {
          option: "--target",
          received: next ?? null,
          availableTargets: [...TARGET_IDS],
        });
      }
      if (!isTargetId(next)) {
        // Exact match only: there are no implicit aliases, so a near miss is a miss.
        throw cliError("INVALID_ARGUMENT", `Unknown target: ${next}`, {
          option: "--target",
          received: next,
          availableTargets: [...TARGET_IDS],
        });
      }
      selectors.push({ id: next, token: `--target ${next}` });
      index += 1;
      continue;
    }

    // This widens a pre-existing wart rather than introducing one: any option *value* that
    // spells a stripped token is recorded as the literal "true". Before this set existed,
    // `aps edit p --note --json` already yielded `--note: ["true"]`; five more names join
    // that class. Fixing it needs a real value-vs-flag model, which is out of scope here.
    if (BOOLEAN_FLAGS.has(value)) {
      commandOptions.set(value, ["true"]);
      const alias = targetOfAlias(value);
      if (alias) {
        selectors.push({ id: alias, token: value });
      }
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

  // Resolved here, after the whole argument list has been read and before anything acts on it. A
  // contradictory selector is an argument error wherever it appears on the line, including next to
  // `--help`: refusing it there is the same rule `--codex-dir` already follows.
  const targetSelection = resolveSelection(selectors);

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
      targetSelection,
      helpRequested: true,
      helpTarget: remaining.slice(1).join(" ") || null,
      versionRequested: false,
    };
  }

  const versionRequested = remaining.includes("--version") || remaining.includes("-v");
  if (versionRequested) {
    return defaultParsed(null, commandOptions, targetSelection, {
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
    targetSelection,
    helpRequested,
    helpTarget: helpRequested && definition ? definition.tokens.join(" ") : null,
    versionRequested: false,
  };
}

/**
 * Normalizes every selector an invocation carried into one selection.
 *
 * Both the shorthand flags and `--target <id>` land here, which is what makes them equivalent: the
 * pair `--claude --target claude` coalesces into one Claude selection, and `--codex --target claude`
 * is refused rather than resolved by precedence. Repeating the same target is noise rather than a
 * contradiction, so it is deduplicated instead of reported — only *different* targets conflict.
 *
 * The conflict is raised here rather than in the scope resolver because it is a property of the
 * argument list, not of the command: `--claude --codex` contradicts itself on a command that does
 * not exist yet, and no downstream reader has to know that.
 */
function resolveSelection(selectors: { id: TargetId; token: string }[]): TargetSelection {
  const distinct: TargetId[] = [];
  for (const selector of selectors) {
    if (!distinct.includes(selector.id)) {
      distinct.push(selector.id);
    }
  }

  if (distinct.length === 0) {
    return { kind: "implicit" };
  }

  if (distinct.length > 1) {
    // Quoted by the tokens rather than by the ids, because the caller has to recognize the line
    // they typed. `joinWithAnd` keeps the two-flag sentence byte-identical to the one this refusal
    // has always produced.
    const tokens = selectors.map((selector) => selector.token);
    throw cliError("INVALID_ARGUMENT", `${joinWithAnd(tokens)} name different targets and cannot be combined.`, {
      options: tokens,
      targets: distinct,
    });
  }

  const id = distinct[0];
  const typed = selectors.find((selector) => selector.id === id);
  return { kind: "explicit", id, token: typed ? typed.token : `--target ${id}` };
}

/**
 * Joins tokens into a readable list: "a and b", "a, b and c".
 */
function joinWithAnd(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * Creates a parsed result for built-in synthetic commands such as help/version.
 */
function defaultParsed(
  command: CommandId | null,
  commandOptions: Map<string, string[]>,
  targetSelection: TargetSelection,
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
    targetSelection,
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

/**
 * Wraps the parsed options as the accessor a target reads its own flags through.
 *
 * Delegates to the two functions above rather than restating their rules, so a target and the
 * commands layer can never disagree about what `--model` means when it was given twice.
 */
export function createOptionBag(options: Map<string, string[]>): ProviderOptionBag {
  return {
    value: (flag) => getSingleOption(options, flag),
    values: (flag) => options.get(flag) ?? [],
    has: (flag) => hasFlag(options, flag),
  };
}
