#!/usr/bin/env node
import { CommandExecutionContext, ParsedCommand } from "./commands/types";
import { parseArgs } from "./commands/args";
import { buildHelpText, getKnownCommandNames, isKnownCommandNameForHelp } from "./commands/help";
import { cliError, normalizeError } from "./domain/errors";
import { RenderedOutput, renderFailure, renderSuccess } from "./cli/output";

const VERSION = (require("../package.json") as { version?: string }).version ?? "0.0.0";

/**
 * Line-oriented output sinks. Injected so tests drive the real dispatch ladder instead of
 * re-implementing it (P1-3).
 */
export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

const processIo: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/**
 * Writes rendered output through the injected sinks and reports its exit code.
 */
function emit(rendered: RenderedOutput, io: CliIo): number {
  for (const line of rendered.stdout) {
    io.stdout(line);
  }
  for (const line of rendered.stderr) {
    io.stderr(line);
  }
  return rendered.exitCode;
}

/**
 * Runs one CLI invocation and returns its exit code rather than exiting, so exit codes are
 * observable from tests (P1-3). `renderSuccess`/`renderFailure` always populate exactly one
 * stream, so emitting both preserves the original ordering.
 */
export async function runCli(argv: string[], io: CliIo = processIo): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error: unknown) {
    // `parseArgs()` threw, so there is no parsed result to read `--json` from. Reading the flag
    // off the raw argv is the only way this path can honour the envelope contract — without it
    // `aps --json --codex-dir` would print a plain-text error, which is precisely the case
    // the envelope exists to serve. "help" is the existing stand-in for "no command resolved";
    // the unknown-help-topic failure below uses the same one.
    const json = argv.includes("--json");
    return emit(
      renderFailure(
        { command: "help", options: { json, reveal: false, codexDir: null } },
        normalizeError(error)
      ),
      io
    );
  }

  if (parsed.versionRequested) {
    io.stdout(VERSION);
    return 0;
  }

  if (parsed.helpRequested) {
    if (parsed.helpTarget && !isKnownCommandNameForHelp(parsed.helpTarget)) {
      return emit(
        renderFailure(
          { command: "help", options: parsed.globalOptions },
          normalizeError(
            cliError("INVALID_ARGUMENT", `Unknown help topic: ${parsed.helpTarget}`, {
              availableCommands: getKnownCommandNames(),
            })
          )
        ),
        io
      );
    }

    io.stdout(buildHelpText(parsed.helpTarget));
    return 0;
  }

  if (!parsed.command) {
    const unresolved = parsed.positionals[0] ?? null;

    // Bucket 2: a recognized command-group root with no subcommand, such as `aps config`.
    // The help-topic predicate is the correct one here and the command-name predicate is not:
    // the latter is keyed on ids and joined tokens, so bare `config` is absent from it while it
    // is a help topic. `buildHelpText` renders the group's subcommands for it.
    if (unresolved && isKnownCommandNameForHelp(unresolved)) {
      io.stdout(buildHelpText(unresolved));
      return 0;
    }

    // Bucket 1: nothing to resolve at all.
    if (!unresolved) {
      io.stdout(buildHelpText());
      return 0;
    }

    // Bucket 3: a token that resolved to nothing. Until the parser stopped skipping index 0,
    // this was indistinguishable from `--help` and both printed help with exit 0.
    return emit(
      renderFailure(
        { command: "help", options: parsed.globalOptions },
        normalizeError(
          cliError("INVALID_ARGUMENT", `Unknown command: ${unresolved}`, {
            availableCommands: getKnownCommandNames(),
          })
        )
      ),
      io
    );
  }

  const ctx: CommandExecutionContext = {
    command: parsed.command,
    options: parsed.globalOptions,
  };

  try {
    const { executeCommand } = await import("./commands/dispatch");
    const result = await executeCommand(ctx, parsed);
    return emit(renderSuccess(ctx, result), io);
  } catch (error: unknown) {
    return emit(renderFailure(ctx, normalizeError(error)), io);
  }
}

if (require.main === module) {
  // `process.exitCode` rather than `process.exit`: exiting right after a write to a pipe can
  // truncate stdout on POSIX, and the resulting exit code is identical either way.
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
