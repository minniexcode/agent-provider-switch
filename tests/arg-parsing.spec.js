"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  makeCodexFixture,
  makeToolHomeWithManagedState,
  repoRoot,
  runBuiltCli,
  runJsonCli,
} = require("./helpers");

/**
 * Runs one invocation and reports its exit code with whichever stream carried the outcome.
 */
async function invoke(args) {
  const result = await runBuiltCli(args);
  return {
    status: result.status,
    text: result.status === 0 ? result.stdout : result.stderr,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

module.exports = {
  name: "argument parsing and exit codes",
  tests: [
    {
      name: "the three exit-code buckets hold for every input the design enumerates",
      async run() {
        // Bucket 1 — nothing to resolve. `--help` reached the right outcome by accident before
        // the parser stopped skipping index 0; the rest were the same accident.
        for (const args of [[], ["--json"], ["--help"], ["-h"]]) {
          const result = await invoke(args);
          assert.equal(result.status, 0, `expected ${JSON.stringify(args)} to exit 0`);
          assert.match(result.stdout, /^agent-provider-switch$/m, JSON.stringify(args));
        }

        // Bucket 2 — a recognized command-group root. Both of these are help topics without
        // being command ids, which is why the predicate has to be the help-topic one.
        for (const root of ["config", "backups"]) {
          const result = await invoke([root]);
          assert.equal(result.status, 0, `aps ${root} must exit 0`);
          assert.match(result.stdout, new RegExp(`^aps ${root}$`, "m"));
          assert.match(result.stdout, new RegExp(`Available ${root} commands:`));
        }

        // Bucket 3 — a token that resolves to nothing. Before this release every one of these
        // printed top-level help with exit 0, which is indistinguishable from success.
        for (const args of [["lst"], ["version"], ["definitely-not-a-command"]]) {
          const result = await invoke(args);
          assert.equal(result.status, 1, `expected ${JSON.stringify(args)} to exit 1`);
          assert.match(result.stderr, /INVALID_ARGUMENT: Unknown command: /);
        }

        // `--help` wins over a topic that cannot be resolved, rather than erroring on the topic.
        const ignored = await invoke(["--help", "list"]);
        assert.equal(ignored.status, 0);
        assert.match(ignored.stdout, /^agent-provider-switch$/m);
      },
    },
    {
      name: "a failure envelope is written to stderr on the --json path",
      async run() {
        const result = await runJsonCli({ args: ["lst", "--json"] });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "", "a JSON failure must not write to stdout");
        assert.equal(result.payload.ok, false);
        assert.equal(result.payload.error.code, "INVALID_ARGUMENT");
        assert.ok(
          result.payload.error.details.availableCommands.includes("backups prune"),
          "the error must enumerate the real command surface"
        );
      },
    },
    {
      name: "--json --codex-dir with no value still produces the envelope",
      async run() {
        // `parseArgs()` throws before a parse result exists, so the catch cannot read `--json`
        // from it. Reading the flag off the raw argv is the only way this path stays machine
        // readable — which is the whole point of passing --json.
        const result = await runJsonCli({ args: ["status", "--json", "--codex-dir"] });
        assert.equal(result.status, 1);
        assert.equal(result.payload.ok, false);
        assert.equal(result.payload.error.code, "INVALID_ARGUMENT");
        assert.match(result.payload.error.message, /--codex-dir requires a path value/);
      },
    },
    {
      name: "the boolean flag set makes every documented ordering resolve the name",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture({ modelProvider: "gamma" });
        const args = [
          "add",
          "spare",
          "--profile",
          "spare",
          "--model",
          "gpt-5-mini",
          "--api-key",
          "sk-spare",
          "--base-url",
          "https://spare.example/v1",
          "--json",
          "--codex-dir",
          codexDir,
        ];
        assert.equal((await runJsonCli({ toolHomeDir, args })).status, 0);

        // `--force` is a boolean flag, so it never claims the following token. Before this,
        // `remove --force spare` parsed `--force: ["spare"]` and left no provider name at all.
        // The fixture's active route is `gamma`, so removing any other provider succeeds and
        // the assertion below cannot be satisfied by an unrelated refusal.
        const forced = await runJsonCli({
          toolHomeDir,
          args: ["remove", "spare", "--force", "--json", "--codex-dir", codexDir],
        });
        assert.equal(forced.status, 0, `remove --force <name> must resolve: ${forced.stderr}`);
        assert.equal(forced.payload.data.provider, "spare");
      },
    },
    {
      name: "a boolean flag placed before the command still resolves it",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();

        // The flag is stripped in the parser's first pass, before command resolution, so it is
        // position-independent. `aps --claude list` printed top-level help before this.
        const result = await runJsonCli({
          toolHomeDir,
          args: ["--claude", "list", "--json", "--codex-dir", codexDir],
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.data.target, "claude");
        assert.deepEqual(result.payload.data.providers, []);

        // And the case the design singles out as not working at all before the fix.
        const unknown = await runBuiltCli(["--claude", "remove", "--json"]);
        assert.equal(unknown.status, 1);
        assert.doesNotMatch(unknown.stderr, /Unknown command/, "the command must resolve, then fail on its own terms");
      },
    },
    {
      name: "help is detected over the whole argv rather than at visited indices",
      async run() {
        // `-h` does not start with `--`, so the greedy option pass would happily record it as
        // `--api-key`'s value. Detection is symmetric with `--version`/`-v`, which has always
        // been a whole-array scan, because the exit-code rule depends on help being reliable.
        const result = await invoke(["add", "probe", "--api-key", "-h"]);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /^aps add$/m);
      },
    },
    {
      name: "every declared boolean flag is one the parser actually strips",
      run() {
        const { getCommandDefinitions } = require("../dist/commands/registry.js");
        const { getBooleanFlagNames } = require("../dist/commands/args.js");
        const parserFlags = new Set(getBooleanFlagNames());

        // A name declared boolean but unknown to the parser would parse cleanly and then
        // swallow the next token — the exact defect this release exists to remove.
        const declared = new Map();
        for (const command of getCommandDefinitions()) {
          for (const flag of command.booleanFlags ?? []) {
            assert.ok(
              parserFlags.has(flag),
              `${command.id} declares ${flag} as boolean, but the parser does not strip it`
            );
            declared.set(flag, (declared.get(flag) ?? 0) + 1);
          }
        }

        // A flag read by a handler but declared nowhere is how `--create-profile` and
        // `import --merge` stayed undocumented. This is the check that keeps the next one visible.
        for (const flag of parserFlags) {
          assert.ok(declared.has(flag), `${flag} is stripped by the parser but declared by no command`);
        }
        assert.deepEqual([...parserFlags].sort(), ["--claude", "--create-profile", "--force", "--full", "--merge", "--overwrite"]);
      },
    },
    {
      name: "the resolveClaudeProviderName workaround is gone",
      run() {
        // It existed only to dig a provider name back out of the `--claude` flag's value, which
        // is impossible once the flag is boolean. It is module-private, so a runtime assertion
        // cannot see it; the source is the only place its return would show up.
        const source = fs.readFileSync(path.join(repoRoot, "src", "commands", "claude-handlers.ts"), "utf8");
        assert.doesNotMatch(source, /resolveClaudeProviderName/);
      },
    },
    {
      name: "status reports a non-empty tool home in both output modes",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture({ modelProvider: "freemodel" });
        const expected = path.resolve(toolHomeDir);

        // The renderer read a nested `storage.toolHome.root` that the payload never carried, so
        // this line has always printed empty while docs/cli-usage.md claimed it was reported.
        // `toolHomeDir` is passed explicitly: a call that omits it gets its own temporary tool
        // home, and the assertion would then compare two unrelated paths.
        const human = await runBuiltCli({ toolHomeDir, args: ["status", "--codex-dir", codexDir] });
        assert.equal(human.status, 0, human.stderr);
        assert.match(human.stdout, new RegExp(`^\\s+tool home: ${escapeRegExp(expected)}$`, "m"));

        const json = await runJsonCli({
          toolHomeDir,
          args: ["status", "--json", "--codex-dir", codexDir],
        });
        assert.equal(json.payload.data.toolHomeRoot, expected);
      },
    },
  ],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
