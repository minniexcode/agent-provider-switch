"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withClaudeEnv, runJsonCli } = require("./helpers");

const PROVIDER_NAME = "deepseek";
const AUTH_TOKEN = "sk-ant-oat01-CLAUDESPECVALUE123456";
const API_KEY = "sk-ant-api03-CLAUDESPECKEY098765";
const BASE_URL = "https://api.deepseek.example/anthropic";

const SAMPLE_SETTINGS = {
  model: "claude-sonnet-5",
  env: {
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    ANTHROPIC_API_KEY: API_KEY,
  },
};

/**
 * Runs a Claude command with `--json`, refusing to run one without it.
 *
 * Not cosmetic: `canPrompt()` is `!jsonMode && runtime.isInteractive()`, and `isInteractive()` is
 * `stdin.isTTY && stdout.isTTY` — true under `npm test` in a terminal. An invocation missing
 * `--json` therefore blocks on an inquirer prompt instead of failing, and the suite hangs.
 */
async function runClaude(toolHomeDir, args) {
  assert.ok(args.includes("--json"), `Claude spec invocations must pass --json: ${args.join(" ")}`);
  return runJsonCli({ toolHomeDir, args });
}

/**
 * Reads the Claude provider registry out of the tool home.
 */
function readRegistry(toolHomeDir) {
  return JSON.parse(fs.readFileSync(path.join(toolHomeDir, "claude-providers.json"), "utf8"));
}

/**
 * Registers the sample provider in the tool home.
 */
async function addProvider(toolHomeDir, importFile) {
  const added = await runClaude(toolHomeDir, ["add", "--claude", PROVIDER_NAME, "--from-file", importFile, "--json"]);
  assert.equal(added.payload.ok, true);
  return added;
}

/**
 * Registers the sample provider and switches to it.
 */
async function addAndSwitch(toolHomeDir, importFile) {
  await addProvider(toolHomeDir, importFile);

  const switched = await runClaude(toolHomeDir, ["switch", "--claude", PROVIDER_NAME, "--json"]);
  assert.equal(switched.payload.ok, true);
  return switched;
}

module.exports = {
  name: "claude provider workflow",
  tests: [
    {
      name: "add --claude <name> --from-file records the provider in the tool home",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, importFile }) => {
          const result = await addProvider(toolHomeDir, importFile);

          assert.equal(result.payload.command, "add");
          assert.equal(result.payload.data.target, "claude");
          assert.equal(result.payload.data.provider, PROVIDER_NAME);
          assert.equal(result.payload.data.model, "claude-sonnet-5");
          assert.equal(readRegistry(toolHomeDir).providers[PROVIDER_NAME].settings.model, "claude-sonnet-5");
        });
      },
    },
    {
      name: "add also accepts the provider name positionally",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, importFile }) => {
          // The flag-first and name-first orderings must both resolve, because the arg parser
          // treats `--claude nextToken` as `--claude=nextToken` until that quirk is fixed.
          const result = await runClaude(toolHomeDir, [
            "add",
            PROVIDER_NAME,
            "--claude",
            "--from-file",
            importFile,
            "--json",
          ]);

          assert.equal(result.payload.ok, true);
          assert.equal(result.payload.data.provider, PROVIDER_NAME);
        });
      },
    },
    {
      name: "switch --claude writes settings.json into APS_CLAUDE_DIR",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, claudeDir, importFile }) => {
          const result = await addAndSwitch(toolHomeDir, importFile);

          assert.equal(result.payload.data.target, "claude");
          assert.equal(result.payload.data.provider, PROVIDER_NAME);
          assert.equal(result.payload.data.baseUrl, BASE_URL);

          // Proves the environment variable took effect: without it the write lands in ~/.claude.
          // The directory did not exist, so this also covers the creation branch.
          const settingsPath = path.join(claudeDir, "settings.json");
          assert.equal(fs.existsSync(settingsPath), true, "switch must write inside APS_CLAUDE_DIR");

          const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          assert.equal(written.model, "claude-sonnet-5");
          assert.equal(written.env.ANTHROPIC_BASE_URL, BASE_URL);
          assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, AUTH_TOKEN);
        });
      },
    },
    {
      name: "list --claude reports the switched provider as active",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, importFile }) => {
          await addAndSwitch(toolHomeDir, importFile);

          const result = await runClaude(toolHomeDir, ["list", "--claude", "--json"]);
          assert.equal(result.payload.ok, true);
          assert.equal(result.payload.data.target, "claude");
          assert.equal(result.payload.data.count, 1);
          assert.equal(result.payload.data.providers[0].name, PROVIDER_NAME);
          assert.equal(result.payload.data.providers[0].baseUrl, BASE_URL);
          // Active detection round-trips the settings that switch just wrote.
          assert.equal(result.payload.data.providers[0].isActive, true);
        });
      },
    },
    {
      name: "current --claude resolves the active provider",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, importFile }) => {
          await addAndSwitch(toolHomeDir, importFile);

          const result = await runClaude(toolHomeDir, ["current", "--claude", "--json"]);
          assert.equal(result.payload.ok, true);
          assert.equal(result.payload.data.status, "managed");
          assert.equal(result.payload.data.active, PROVIDER_NAME);
          assert.equal(result.payload.data.model, "claude-sonnet-5");
          assert.equal(result.payload.data.baseUrl, BASE_URL);
        });
      },
    },
    {
      name: "show --claude masks secrets and withholds the settings blob",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, importFile }) => {
          await addProvider(toolHomeDir, importFile);

          const result = await runClaude(toolHomeDir, ["show", "--claude", PROVIDER_NAME, "--json"]);

          assert.equal(result.payload.ok, true);
          assert.equal(result.payload.data.provider, PROVIDER_NAME);
          assert.equal(result.payload.data.revealed, false);
          assert.equal("settings" in result.payload.data, false);
          assert.equal(result.payload.data.env.ANTHROPIC_BASE_URL, BASE_URL);
          assert.ok(!result.stdout.includes(AUTH_TOKEN), "raw auth token must not be printed");
          assert.ok(!result.stdout.includes(API_KEY), "raw API key must not be printed");
        });
      },
    },
    {
      name: "remove --claude --force drops the provider from the registry",
      async run() {
        await withClaudeEnv(SAMPLE_SETTINGS, async ({ toolHomeDir, importFile }) => {
          await addAndSwitch(toolHomeDir, importFile);

          // `--force` is required: without it, a non-JSON run would stop at the confirm prompt.
          const result = await runClaude(toolHomeDir, [
            "remove",
            "--claude",
            PROVIDER_NAME,
            "--force",
            "--json",
          ]);

          assert.equal(result.payload.ok, true);
          assert.equal(result.payload.data.target, "claude");
          assert.equal(result.payload.data.removed, true);
          assert.equal(readRegistry(toolHomeDir).providers[PROVIDER_NAME], undefined);
        });
      },
    },
  ],
};
