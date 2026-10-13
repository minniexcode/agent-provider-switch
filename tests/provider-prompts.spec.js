"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeCodexFixture, makeToolHomeWithManagedState, withClaudeEnv, withEnv } = require("./helpers");

const { parseArgs } = require("../dist/commands/args.js");
const { executeCommand } = require("../dist/commands/dispatch.js");

/**
 * One fake prompt runtime, driven by both targets.
 *
 * The suite calls `executeCommand()` rather than `runBuiltCli()` because the runtime is a parameter
 * of the execution step and not of `runCli()`: the real entry always builds the inquirer-backed
 * runtime, so injecting one here is the only way to exercise a prompt without a TTY. Everything
 * else on the path — parsing, the scope guard, the legacy-home migration, path resolution, the
 * shared workflow and the mutation wrapper — is the production code.
 *
 * `choices` is logged rather than asserted against in `selectOne`, so a test can see which
 * registry answered the prompt; `choose` is the answer, and `null` means "this invocation was not
 * supposed to prompt".
 */
function makeRuntime({ interactive = true, choose = null, confirm = false } = {}) {
  const log = [];
  return {
    log,
    isInteractive: () => interactive,
    inputText: async (message) => {
      log.push({ kind: "inputText", message });
      return "";
    },
    inputSecret: async (message) => {
      log.push({ kind: "inputSecret", message });
      return "";
    },
    selectOne: async (message, choices) => {
      log.push({ kind: "selectOne", message, choices: choices.map((choice) => choice.value) });
      if (choose === null) {
        throw new Error("this invocation was not supposed to ask for a provider");
      }
      return choose;
    },
    selectMany: async (message) => {
      log.push({ kind: "selectMany", message });
      return [];
    },
    confirmAction: async (message) => {
      log.push({ kind: "confirmAction", message });
      return confirm;
    },
    writeLine: () => {},
  };
}

/** The kinds of prompt a run recorded, in order. */
function promptKinds(runtime) {
  return runtime.log.map((entry) => entry.kind);
}

/** Runs one invocation through the real execution step with an injected prompt runtime. */
async function runWithRuntime(argv, runtime) {
  const parsed = parseArgs(argv);
  const ctx = { command: parsed.command, options: parsed.globalOptions, targets: [] };
  return executeCommand(ctx, parsed, runtime);
}

/** Captures the error a command throws, so a refusal can be asserted on like a result. */
async function failureOf(argv, runtime) {
  try {
    await runWithRuntime(argv, runtime);
  } catch (error) {
    return error;
  }
  throw new Error(`aps ${argv.join(" ")} was expected to fail`);
}

/** Writes a provider registry into a tool home, without going through the CLI. */
function seedRegistry(toolHomeDir, fileName, providers) {
  fs.writeFileSync(path.join(toolHomeDir, fileName), `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

/** The registered providers in a tool home, read back as names. */
function registryNames(toolHomeDir, fileName) {
  const file = JSON.parse(fs.readFileSync(path.join(toolHomeDir, fileName), "utf8"));
  return Object.keys(file.providers);
}

const CODEX_PROVIDER = {
  profile: "alphap",
  apiKey: "sk-codex-test",
  model: "gpt-test",
  baseUrl: "https://free.example.com/v1",
};

const CLAUDE_PROVIDER = {
  settings: {
    model: "claude-test",
    env: { ANTHROPIC_BASE_URL: "https://claude.example.com" },
  },
};

module.exports = {
  name: "provider prompts",
  tests: [
    {
      name: "one chooser serves both targets, over each target's own registry",
      async run() {
        // Codex: `switch` with no name asks, and the answer comes from the Codex registry.
        const toolHomeDir = makeToolHomeWithManagedState();
        seedRegistry(toolHomeDir, "providers.json", { alpha: CODEX_PROVIDER });
        const codexDir = makeCodexFixture({ modelProvider: "alphap" });

        await withEnv({ APS_HOME: toolHomeDir, APS_CODEX_DIR: codexDir }, async () => {
          const runtime = makeRuntime({ choose: "alpha" });
          const result = await runWithRuntime(["switch"], runtime);

          assert.deepEqual(promptKinds(runtime), ["selectOne"], "an unnamed switch asks exactly once");
          assert.deepEqual(runtime.log[0].choices, ["alpha"]);
          assert.equal(result.data.provider, "alpha");
          assert.match(
            fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
            /model_provider = "alphap"/,
            "the provider the prompt chose is the one actually activated"
          );
        });

        // Claude: the same runtime type, the same call shape, the Claude registry's answer. That
        // the two go through one implementation is the claim; that the choices differ is what makes
        // this a shared chooser rather than one target's list reused.
        await withClaudeEnv(CLAUDE_PROVIDER.settings, async ({ toolHomeDir: claudeHome, claudeDir }) => {
          seedRegistry(claudeHome, "claude-providers.json", { "claude-alpha": CLAUDE_PROVIDER });

          const runtime = makeRuntime({ choose: "claude-alpha" });
          const result = await runWithRuntime(["switch", "--claude"], runtime);

          assert.deepEqual(promptKinds(runtime), ["selectOne"], "an unnamed Claude switch asks exactly once");
          assert.deepEqual(runtime.log[0].choices, ["claude-alpha"]);
          assert.equal(result.data.provider, "claude-alpha");

          const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
          assert.equal(settings.model, "claude-test");
          assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://claude.example.com");
        });
      },
    },
    {
      name: "a declined confirmation cancels before anything is written, for either target",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        seedRegistry(toolHomeDir, "providers.json", { alpha: CODEX_PROVIDER });
        const codexDir = makeCodexFixture({ modelProvider: "alphap" });
        const configBefore = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");

        await withEnv({ APS_HOME: toolHomeDir, APS_CODEX_DIR: codexDir }, async () => {
          const runtime = makeRuntime({ confirm: false });
          const error = await failureOf(["remove", "alpha"], runtime);

          assert.equal(error.code, "PROMPT_CANCELLED");
          assert.deepEqual(
            promptKinds(runtime),
            ["confirmAction"],
            "remove resolves the name before asking, and asks exactly once"
          );

          // Nothing moved: not the registry, not the runtime file, and no backup directory — which
          // is the observable proof that the refusal precedes `runMutation()` rather than undoing it.
          assert.deepEqual(registryNames(toolHomeDir, "providers.json"), ["alpha"]);
          assert.equal(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"), configBefore);
          assert.equal(fs.existsSync(path.join(toolHomeDir, "backups")), false);
        });

        await withClaudeEnv(CLAUDE_PROVIDER.settings, async ({ toolHomeDir: claudeHome, claudeDir }) => {
          seedRegistry(claudeHome, "claude-providers.json", { "claude-alpha": CLAUDE_PROVIDER });

          const runtime = makeRuntime({ confirm: false });
          const error = await failureOf(["remove", "claude-alpha", "--claude"], runtime);

          assert.equal(error.code, "PROMPT_CANCELLED");
          assert.deepEqual(promptKinds(runtime), ["confirmAction"]);
          assert.deepEqual(registryNames(claudeHome, "claude-providers.json"), ["claude-alpha"]);
          assert.equal(
            fs.existsSync(path.join(claudeDir, "settings.json")),
            false,
            "a cancelled removal must not create the file it would have rewritten"
          );
          assert.equal(fs.existsSync(path.join(claudeHome, "backups")), false);
        });
      },
    },
    {
      name: "a non-prompting invocation asks nothing and refuses in its own target's words",
      async run() {
        // `PROVIDER_NOT_FOUND`, not `INVALID_ARGUMENT`: an unnamed `switch` is a missing provider
        // rather than a malformed argument, and that is the code both targets answered with before
        // the shared workflow existed. `show` is the one verb that differs.
        //
        // Two ways to suppress prompting, both checked: a runtime that reports no terminal, and
        // `--json`, which suppresses it even on a terminal. `canPrompt()` is the conjunction, so
        // covering only one of the two would leave the other free to prompt into a script.
        const cases = [
          { name: "a non-interactive runtime", args: ["switch"], interactive: false },
          { name: "--json", args: ["switch", "--json"], interactive: true },
        ];

        const toolHomeDir = makeToolHomeWithManagedState();
        seedRegistry(toolHomeDir, "providers.json", { alpha: CODEX_PROVIDER });
        const codexDir = makeCodexFixture({ modelProvider: "alphap" });

        let codexMessage = "";
        await withEnv({ APS_HOME: toolHomeDir, APS_CODEX_DIR: codexDir }, async () => {
          for (const testCase of cases) {
            const runtime = makeRuntime({ interactive: testCase.interactive });
            const error = await failureOf(testCase.args, runtime);

            assert.equal(error.code, "PROVIDER_NOT_FOUND", `aps ${testCase.args.join(" ")}`);
            assert.deepEqual(runtime.log, [], `${testCase.name} must not touch the prompt runtime`);
            codexMessage = error.message;
          }
        });

        await withClaudeEnv(CLAUDE_PROVIDER.settings, async ({ toolHomeDir: claudeHome }) => {
          seedRegistry(claudeHome, "claude-providers.json", { "claude-alpha": CLAUDE_PROVIDER });

          for (const testCase of cases) {
            const runtime = makeRuntime({ interactive: testCase.interactive });
            const error = await failureOf([...testCase.args, "--claude"], runtime);

            assert.equal(error.code, "PROVIDER_NOT_FOUND", `aps ${testCase.args.join(" ")} --claude`);
            assert.deepEqual(runtime.log, [], `${testCase.name} must not touch the prompt runtime`);

            // Same rule, same code, different sentences: the wording is the target's, and a target
            // that inherited the other's would tell a Claude user to run a Codex command.
            assert.notEqual(error.message, codexMessage);
            assert.match(error.message, /--claude/);
          }
        });

        assert.doesNotMatch(codexMessage, /--claude/);
      },
    },
  ],
};
