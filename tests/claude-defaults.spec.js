"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runBuiltCli, runJsonCli, setClaudeDefaults, withClaudeEnv } = require("./helpers");

const SECRET = "sk-shared-secret-value";

// The shared block: three env keys (one of them a credential), two scalars, and a permissions
// object whose members are arrays — the shapes the real defaults file is made of.
const DEFAULTS_SETTINGS = {
  env: {
    CLAUDE_CODE_EFFORT_LEVEL: "XHIGH",
    MCP_CONNECT_TIMEOUT_MS: "30000",
    SHARED_AUTH_TOKEN: SECRET,
  },
  model: "sonnet",
  theme: "dark",
  permissions: { allow: ["Read(*)"], deny: [] },
};

// A provider stored as its delta: only what is this provider's own.
const DELTA = {
  settings: {
    env: {
      ANTHROPIC_BASE_URL: "https://delta.example",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "delta-sonnet",
    },
  },
  note: "delta",
};

const EXPECTED_EFFECTIVE = {
  env: {
    CLAUDE_CODE_EFFORT_LEVEL: "XHIGH",
    MCP_CONNECT_TIMEOUT_MS: "30000",
    SHARED_AUTH_TOKEN: SECRET,
    ANTHROPIC_BASE_URL: "https://delta.example",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "delta-sonnet",
  },
  model: "sonnet",
  theme: "dark",
  permissions: { allow: ["Read(*)"], deny: [] },
};

/**
 * Same wrapper as the workflow spec: refuses a call without `--json`, because `canPrompt()` is
 * true whenever the suite runs in a terminal and a missing flag would hang on a prompt.
 */
async function runClaude(toolHomeDir, args) {
  assert.ok(args.includes("--json"), `Claude spec invocations must pass --json: ${args.join(" ")}`);
  return runJsonCli({ toolHomeDir, args });
}

function writeRegistry(toolHomeDir, providers) {
  fs.writeFileSync(path.join(toolHomeDir, "claude-providers.json"), `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

function readRegistry(toolHomeDir) {
  return JSON.parse(fs.readFileSync(path.join(toolHomeDir, "claude-providers.json"), "utf8"));
}

function readLiveSettings(claudeDir) {
  return JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
}

module.exports = {
  name: "claude settings defaults",
  tests: [
    {
      name: "switch writes the merged settings and leaves the stored record a delta",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, { delta: DELTA });

          const result = await runClaude(toolHomeDir, ["switch", "--claude", "delta", "--json"]);
          assert.equal(result.payload.ok, true, result.stderr);

          assert.deepEqual(readLiveSettings(claudeDir), EXPECTED_EFFECTIVE);
          // The expansion happens at write time only. Persisting it would turn the defaults back
          // into a copy in every record.
          assert.deepEqual(readRegistry(toolHomeDir).providers.delta, DELTA);
          assert.equal(result.payload.data.model, "sonnet");
          assert.equal(result.payload.data.baseUrl, "https://delta.example");
        });
      },
    },
    {
      name: "without a defaults block a record is written verbatim, explicit nulls included",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          // No claudeDefaults: nothing is merged, so a `null` is plain data rather than a deletion.
          const full = { model: "opus", apiKeyHelper: null, env: { ANTHROPIC_BASE_URL: "https://full.example" } };
          writeRegistry(toolHomeDir, { full: { settings: full } });

          const result = await runClaude(toolHomeDir, ["switch", "--claude", "full", "--json"]);
          assert.equal(result.payload.ok, true, result.stderr);

          assert.deepEqual(readLiveSettings(claudeDir), full);
        });
      },
    },
    {
      name: "an explicit null in a record deletes the inherited key on switch",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, {
            delta: { settings: { theme: null, env: { ANTHROPIC_BASE_URL: "https://delta.example" } } },
          });

          await runClaude(toolHomeDir, ["switch", "--claude", "delta", "--json"]);

          const live = readLiveSettings(claudeDir);
          assert.equal("theme" in live, false);
          assert.equal(live.model, "sonnet");
        });
      },
    },
    {
      name: "list and current resolve a delta record, and mark it active after a switch",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, { delta: DELTA });

          const before = await runClaude(toolHomeDir, ["list", "--claude", "--json"]);
          const [listed] = before.payload.data.providers;
          // Read from the raw record these would be null: the delta carries no model.
          assert.equal(listed.model, "sonnet");
          assert.equal(listed.baseUrl, "https://delta.example");
          assert.equal(listed.theme, "dark");
          assert.equal(listed.isActive, false);

          await runClaude(toolHomeDir, ["switch", "--claude", "delta", "--json"]);

          const after = await runClaude(toolHomeDir, ["list", "--claude", "--json"]);
          assert.equal(after.payload.data.providers[0].isActive, true);

          const current = await runClaude(toolHomeDir, ["current", "--claude", "--json"]);
          assert.equal(current.payload.data.status, "managed");
          assert.equal(current.payload.data.active, "delta");
        });
      },
    },
    {
      name: "show resolves the record, masks inherited secrets, and lists inherited paths without values",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, { delta: DELTA });

          const result = await runClaude(toolHomeDir, ["show", "--claude", "delta", "--json"]);
          const { data } = result.payload;

          assert.equal(data.model, "sonnet");
          assert.equal(data.baseUrl, "https://delta.example");
          assert.deepEqual(Object.keys(data.env).sort(), Object.keys(EXPECTED_EFFECTIVE.env).sort());
          // A shared credential is masked in `env` like any other, even though the record never
          // stored it.
          assert.notEqual(data.env.SHARED_AUTH_TOKEN, SECRET);
          assert.equal(result.stdout.includes(SECRET), false, "the inherited secret must not reach stdout");
          assert.equal("settings" in data, false);
          assert.equal("overrides" in data, false);

          assert.deepEqual(data.inherited, [
            "env.CLAUDE_CODE_EFFORT_LEVEL",
            "env.MCP_CONNECT_TIMEOUT_MS",
            "env.SHARED_AUTH_TOKEN",
            "model",
            "permissions.allow",
            "permissions.deny",
            "theme",
          ]);
        });
      },
    },
    {
      name: "show --reveal returns the effective settings and the stored overrides",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, { delta: DELTA });

          const result = await runClaude(toolHomeDir, ["show", "--claude", "delta", "--reveal", "--json"]);
          const { data } = result.payload;

          // `settings` is what a switch writes; `overrides` is what is stored. Revealing only the
          // delta would show a file that is not the one Claude Code ends up with.
          assert.deepEqual(data.settings, EXPECTED_EFFECTIVE);
          assert.deepEqual(data.overrides, DELTA.settings);
          assert.equal(data.env.SHARED_AUTH_TOKEN, SECRET);
          assert.equal(data.revealed, true);
        });
      },
    },
    {
      name: "show reports no inherited paths when there is no defaults block",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          writeRegistry(toolHomeDir, { full: { settings: { model: "opus", env: { ANTHROPIC_BASE_URL: "https://full.example" } } } });

          const result = await runClaude(toolHomeDir, ["show", "--claude", "full", "--json"]);
          assert.deepEqual(result.payload.data.inherited, []);
          assert.equal(result.payload.data.model, "opus");
        });
      },
    },
    {
      name: "show's human output marks inherited entries and summarizes them",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, { delta: DELTA });

          // The provider name is positional, so there is nothing to prompt for and no `--json`
          // is needed to keep the suite from blocking.
          const result = await runBuiltCli({ toolHomeDir, args: ["show", "--claude", "delta"] });
          assert.equal(result.status, 0, result.stderr);

          assert.match(result.stdout, /model: sonnet \(inherited\)/);
          assert.match(result.stdout, /theme: dark \(inherited\)/);
          assert.match(result.stdout, /MCP_CONNECT_TIMEOUT_MS=30000 \(inherited\)/);
          assert.match(result.stdout, /inherited: env\(3\), model, permissions\(2\), theme/);
          // The record's own entries carry no marker, and the inherited credential stays masked.
          assert.match(result.stdout, /ANTHROPIC_BASE_URL=https:\/\/delta\.example\n/);
          assert.equal(result.stdout.includes(SECRET), false);
          assert.match(result.stdout, /SHARED_AUTH_TOKEN=.* \(inherited\)/);
        });
      },
    },
    {
      name: "remove does not expand the defaults into the surviving records",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          const survivor = { settings: { env: { ANTHROPIC_BASE_URL: "https://survivor.example" } }, note: "survivor" };
          writeRegistry(toolHomeDir, { doomed: DELTA, survivor });

          const result = await runClaude(toolHomeDir, ["remove", "--claude", "doomed", "--force", "--json"]);
          assert.equal(result.payload.ok, true, result.stderr);

          // `remove` reads the whole file and writes it back, so a resolved reader would have
          // materialized every default into this record.
          assert.deepEqual(readRegistry(toolHomeDir).providers, { survivor });
        });
      },
    },
    {
      name: "a malformed claudeDefaults block fails loudly with INVALID_CONFIG",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          const configPath = path.join(toolHomeDir, "agent-provider-switch.json");
          // `env` directly under claudeDefaults, with no `settings` wrapper.
          fs.writeFileSync(
            configPath,
            JSON.stringify({ version: "1.1.0", claudeDefaults: { env: { MCP_CONNECT_TIMEOUT_MS: "30000" } } }),
            "utf8"
          );
          writeRegistry(toolHomeDir, { delta: DELTA });

          const result = await runClaude(toolHomeDir, ["list", "--claude", "--json"]);
          assert.equal(result.status, 1);
          assert.equal(result.payload.error.code, "INVALID_CONFIG");
          assert.match(result.payload.error.details.cause, /only supports "settings"/);
        });
      },
    },
  ],
};
