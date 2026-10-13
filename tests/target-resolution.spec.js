"use strict";

const assert = require("node:assert/strict");
const { makeToolHomeWithManagedState, runJsonCli } = require("./helpers");

const { parseArgs } = require("../dist/commands/args.js");
const { TARGET_IDS, TARGET_METADATA } = require("../dist/domain/target.js");

/**
 * Parses one argument list and reports only the selector it normalized.
 */
function selectionOf(argv) {
  return parseArgs(argv).targetSelection;
}

/**
 * Runs one argument list that must be refused, and reports the error.
 */
function refusalOf(argv) {
  try {
    parseArgs(argv);
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${JSON.stringify(argv)} to be refused`);
}

module.exports = {
  name: "target selection",
  tests: [
    {
      name: "the target ids and their shorthand flags are declared once",
      run() {
        assert.deepEqual([...TARGET_IDS], ["codex", "claude"]);
        assert.deepEqual([...TARGET_METADATA.codex.aliases], ["--codex"]);
        assert.deepEqual([...TARGET_METADATA.claude.aliases], ["--claude"]);
        // The registries this tool reads, named where the target is described rather than only in
        // the storage module that opens them.
        assert.equal(TARGET_METADATA.codex.registryFile, "providers.json");
        assert.equal(TARGET_METADATA.claude.registryFile, "claude-providers.json");
        assert.equal(TARGET_METADATA.codex.runtimeDirEnv, "APS_CODEX_DIR");
        assert.equal(TARGET_METADATA.claude.runtimeDirEnv, "APS_CLAUDE_DIR");
      },
    },
    {
      name: "no selector is a different answer from naming the default target",
      run() {
        // The distinction `config compact` and the shared commands are built on: a bare command
        // line has not chosen anything, and `--codex` has.
        assert.deepEqual(selectionOf(["list"]), { kind: "implicit" });
        assert.deepEqual(selectionOf(["list", "--codex"]), {
          kind: "explicit",
          id: "codex",
          token: "--codex",
        });
        assert.deepEqual(selectionOf(["list", "--claude"]), {
          kind: "explicit",
          id: "claude",
          token: "--claude",
        });
        assert.deepEqual(selectionOf(["list", "--target", "claude"]), {
          kind: "explicit",
          id: "claude",
          token: "--target claude",
        });
        assert.deepEqual(selectionOf(["--target", "codex", "doctor"]), {
          kind: "explicit",
          id: "codex",
          token: "--target codex",
        });
      },
    },
    {
      name: "--target is position-independent and never swallows the provider name",
      run() {
        // Before the command: the token pair is consumed in the first pass, which is what makes the
        // prefix form resolve at all instead of being read as the command.
        const prefix = parseArgs(["--target", "claude", "add", "p"]);
        assert.equal(prefix.command, "add");
        assert.deepEqual(prefix.positionals, ["p"]);

        // After the command, and between two other arguments.
        const suffix = parseArgs(["add", "p", "--target", "claude", "--note", "hello"]);
        assert.equal(suffix.command, "add");
        assert.deepEqual(suffix.positionals, ["p"]);
        assert.deepEqual(suffix.commandOptions.get("--note"), ["hello"]);

        // Consumed rather than recorded: a `--target` left in the option map would be handed to the
        // valued-option pass and re-read by nothing, which is how a flag ends up accepted-and-ignored.
        assert.equal(prefix.commandOptions.has("--target"), false);
      },
    },
    {
      name: "repeating one target coalesces, and two different targets are refused",
      run() {
        // Repeating the same target is noise, not a contradiction.
        const repeated = selectionOf(["--claude", "--target", "claude", "--target", "claude"]);
        assert.deepEqual(repeated, { kind: "explicit", id: "claude", token: "--claude" });

        // Two different targets, in either spelling, and in either order. A precedence rule would
        // silently discard a flag the caller typed, so the pair never resolves.
        for (const argv of [
          ["--claude", "--codex", "list"],
          ["--codex", "--target", "claude", "list"],
          ["--target", "claude", "--claude", "--target", "codex", "list"],
        ]) {
          const error = refusalOf(argv);
          assert.equal(error.code, "INVALID_ARGUMENT", JSON.stringify(argv));
          assert.match(error.message, /cannot be combined/, JSON.stringify(argv));
        }

        // The two-flag sentence is the one this refusal has always produced, and the caller reads it
        // as a description of their own command line.
        assert.equal(
          refusalOf(["--claude", "--codex", "list"]).message,
          "--claude and --codex name different targets and cannot be combined."
        );
      },
    },
    {
      name: "--target refuses a missing value, a flag, an unknown id, and the = form",
      run() {
        const missing = refusalOf(["list", "--target"]);
        assert.equal(missing.code, "INVALID_ARGUMENT");
        assert.match(missing.message, /--target requires a target id/);

        // `--json` is never a target id, and reading the next token blind would record it as one.
        const flag = refusalOf(["list", "--target", "--json"]);
        assert.match(flag.message, /--target requires a target id/);

        const unknown = refusalOf(["list", "--target", "claud"]);
        assert.equal(unknown.code, "INVALID_ARGUMENT");
        assert.match(unknown.message, /Unknown target: claud/);
        assert.deepEqual(unknown.details.availableTargets, ["codex", "claude"]);

        // Refused rather than left to the valued-option pass, which would record a flag nobody reads
        // and let `aps list --target=claude` report Codex state as if the target had been honoured.
        const equals = refusalOf(["list", "--target=claude"]);
        assert.match(equals.message, /does not take an "=" form/);
      },
    },
    {
      name: "the five documented --target invocations run",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();

        // Prefix form, before the command.
        const prefix = await runJsonCli({ toolHomeDir, args: ["--target", "claude", "list", "--json"] });
        assert.equal(prefix.status, 0, prefix.stderr);
        assert.deepEqual(prefix.payload.targets, ["claude"]);
        assert.equal(prefix.payload.target, "claude");

        // Suffix form, after it.
        const suffix = await runJsonCli({ toolHomeDir, args: ["list", "--target", "claude", "--json"] });
        assert.equal(suffix.status, 0, suffix.stderr);
        assert.deepEqual(suffix.payload.targets, ["claude"]);

        // Naming the default target explicitly has to work too, or the selector is a one-way door.
        const codex = await runJsonCli({ toolHomeDir, args: ["list", "--target", "codex", "--json"] });
        assert.equal(codex.status, 0, codex.stderr);
        assert.deepEqual(codex.payload.targets, ["codex"]);

        // `doctor` narrows a two-target report rather than choosing a code path, so this is the
        // invocation that proves the selector reaches the report composer too.
        const doctor = await runJsonCli({ toolHomeDir, args: ["doctor", "--target", "claude", "--json"] });
        assert.equal(doctor.status, 0, doctor.stderr);
        assert.deepEqual(doctor.payload.targets, ["claude"]);
      },
    },
    {
      name: "--target claude drives add, compact and the --full flag it gates",
      async run() {
        const { withClaudeEnv, setClaudeDefaults } = require("./helpers");
        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir, importFile }) => {
          // `config compact` requires a Claude selection; it also cannot run without defaults, so
          // the block is written here rather than left to the refusal path.
          setClaudeDefaults(toolHomeDir, { model: "sonnet" });

          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "delta", "--target", "claude", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);
          assert.equal(added.payload.data.provider, "delta");

          // `--full` is declared per command and per target, so the selector has to satisfy it the
          // same way the shorthand does.
          const full = await runJsonCli({
            toolHomeDir,
            args: ["add", "whole", "--target", "claude", "--from-file", importFile, "--full", "--json"],
          });
          assert.equal(full.status, 0, full.stderr);
          assert.deepEqual(full.payload.data.droppedPaths, []);

          const listed = await runJsonCli({ toolHomeDir, args: ["--target", "claude", "list", "--json"] });
          assert.deepEqual(
            listed.payload.data.providers.map((provider) => provider.name).sort(),
            ["delta", "whole"]
          );

          // The dry run is the one that would take the lock and write if the target were ignored.
          const compact = await runJsonCli({
            toolHomeDir,
            args: ["config", "compact", "--target", "claude", "--dry-run", "--json"],
          });
          assert.equal(compact.status, 0, compact.stderr);
          assert.equal(compact.payload.command, "config-compact");
        });
      },
    },
    {
      name: "a named selection reaches the resolved target, and the default does not need to be named",
      async run() {
        // Asked of a `switchable` command: a bare `status` covers two targets and answers `null`
        // instead, which is where the scope spec takes over.
        const explicit = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["list", "--codex", "--json"],
        });
        assert.equal(explicit.payload.target, "codex");

        const implicit = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["list", "--json"],
        });
        assert.equal(implicit.payload.target, "codex");
      },
    },
    {
      name: "the envelope carries the resolved target on success and on failure",
      async run() {
        // Success: `list --claude` against an empty tool home. The Claude root is arranged by
        // `runBuiltCli`, so this cannot reach the developer's real ~/.claude.
        const success = await runJsonCli({
          args: ["list", "--claude", "--json"],
        });
        assert.equal(success.status, 0, success.stderr);
        assert.equal(success.payload.target, "claude");
        assert.deepEqual(success.payload.targets, ["claude"]);
        assert.equal(success.payload.command, "list");

        // Failure: the refusal is raised before the handler runs, so the envelope has to describe
        // the requested target rather than the one that would have applied. `null` is asserted
        // with `in` as well as by value, because a dropped key and an explicit null read the same
        // through `JSON.stringify` unless the key's presence is checked.
        //
        // The pair is the example because it is the refusal that survives `1.1.3`: the narrowed
        // `status --claude` this used to assert against is a supported invocation now.
        const refused = await runJsonCli({ args: ["doctor", "--claude", "--codex", "--json"] });
        assert.equal(refused.status, 1);
        assert.equal(refused.payload.error.code, "INVALID_ARGUMENT");
        assert.match(refused.payload.error.message, /cannot be combined/);
        assert.ok("target" in refused.payload, "the failure envelope must state a target");
        assert.equal(refused.payload.target, null);
        // `[]` rather than the two targets the flags disagree about: nothing was resolved, and a
        // list here would claim the command had a target when it did not.
        assert.deepEqual(refused.payload.targets, []);

        // The same refusal arrives for the `--target` spelling, because the parser resolves both
        // before a command is named.
        const targeted = await runJsonCli({ args: ["doctor", "--target", "claude", "--codex", "--json"] });
        assert.equal(targeted.status, 1);
        assert.equal(targeted.payload.error.code, "INVALID_ARGUMENT");
        assert.deepEqual(targeted.payload.targets, []);
      },
    },
    {
      name: "a failure raised after resolution reports the resolved target, not null",
      async run() {
        // The same error code as the refusals above, arriving from the handler instead of from the
        // resolution. `target` is the field that tells the two apart, which is the reason it is
        // written on the failure path at all: before this release the only signal that a failed
        // `--claude` invocation had anything to do with Claude was the error code's name.
        const result = await runJsonCli({ args: ["show", "--claude", "--json"] });
        assert.equal(result.status, 1);
        assert.equal(result.payload.error.code, "INVALID_ARGUMENT");
        assert.match(result.payload.error.message, /Missing provider name for show --claude/);
        assert.equal(result.payload.target, "claude");
        // A failure after the scope was accepted keeps it: the scope was decided from the command
        // line before any file was read, so nothing the handler does afterwards can un-resolve it.
        assert.deepEqual(result.payload.targets, ["claude"]);

        // The `--target` spelling reaches the same failure with the same scope.
        const targeted = await runJsonCli({ args: ["show", "--target", "claude", "--json"] });
        assert.equal(targeted.status, 1);
        assert.equal(targeted.payload.error.code, "INVALID_ARGUMENT");
        assert.equal(targeted.payload.target, "claude");

        // And the Codex form of the same mistake, which resolves to the other target.
        const codex = await runJsonCli({ args: ["show", "--json"] });
        assert.equal(codex.status, 1);
        assert.equal(codex.payload.error.code, "INVALID_ARGUMENT");
        assert.equal(codex.payload.target, "codex");
      },
    },
    {
      name: "the target lives on the envelope and nowhere in the payload",
      async run() {
        // `data.target` was a second copy, written by hand in each Claude service. 1.1.1 moved the
        // human renderer off it, which is what made it removable, and 1.1.2 removed it; the
        // envelope is written once from the resolved target, so a payload cannot disagree with it.
        const result = await runJsonCli({ args: ["list", "--claude", "--json"] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.target, "claude");
        assert.equal(result.payload.data.target, undefined);

        const codex = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["list", "--json"],
        });
        assert.equal(codex.status, 0, codex.stderr);
        assert.equal(codex.payload.data.target, undefined);
        assert.equal(codex.payload.target, "codex");
      },
    },
    {
      name: "--codex is stripped position-independently, so it never swallows the next token",
      async run() {
        // The defect the boolean-flag set exists to prevent: `--codex` reaching the greedy option
        // pass would record `list` as its value and leave no command to resolve.
        const leading = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["--codex", "list", "--json"],
        });
        assert.equal(leading.status, 0, leading.stderr);
        assert.equal(leading.payload.command, "list");
        assert.equal(leading.payload.target, "codex");
      },
    },
  ],
};
