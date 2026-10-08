"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./helpers");
const { readToolConfigIfExists, writeToolConfig } = require("../dist/storage/tool-config-repo");

/**
 * Writes a tool config with the given raw content and returns its path.
 */
function writeRawConfig(content) {
  const toolConfigPath = path.join(makeTempDir("agent-provider-switch-tool-config-"), "agent-provider-switch.json");
  fs.writeFileSync(toolConfigPath, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return toolConfigPath;
}

const DEFAULTS = {
  settings: {
    env: { CLAUDE_CODE_EFFORT_LEVEL: "XHIGH", MCP_CONNECT_TIMEOUT_MS: "30000" },
    model: "sonnet",
    theme: "dark",
  },
};

module.exports = {
  name: "tool config",
  tests: [
    {
      name: "claudeDefaults survives a read",
      run() {
        // The validator rebuilds the object rather than preserving it, so this is the test that
        // fails if the block is ever dropped again.
        const toolConfigPath = writeRawConfig({ version: "1.1.0", claudeDefaults: DEFAULTS });
        const config = readToolConfigIfExists(toolConfigPath);
        assert.deepEqual(config.claudeDefaults, DEFAULTS);
      },
    },
    {
      name: "claudeDefaults survives a write/read round trip",
      run() {
        const toolConfigPath = writeRawConfig({ version: "1.1.0" });
        writeToolConfig(toolConfigPath, { version: "1.1.0", claudeDefaults: DEFAULTS });
        assert.deepEqual(readToolConfigIfExists(toolConfigPath).claudeDefaults, DEFAULTS);
        assert.deepEqual(JSON.parse(fs.readFileSync(toolConfigPath, "utf8")).claudeDefaults, DEFAULTS);
      },
    },
    {
      name: "an absent claudeDefaults stays absent",
      run() {
        const toolConfigPath = writeRawConfig({ version: "0.0.10" });
        const config = readToolConfigIfExists(toolConfigPath);
        assert.equal("claudeDefaults" in config, false);

        writeToolConfig(toolConfigPath, config);
        assert.equal("claudeDefaults" in JSON.parse(fs.readFileSync(toolConfigPath, "utf8")), false);
      },
    },
    {
      name: "claudeDefaults does not disturb defaultCodexDir",
      run() {
        const toolConfigPath = writeRawConfig({
          version: "1.1.0",
          defaultCodexDir: "/somewhere/.codex",
          claudeDefaults: DEFAULTS,
        });
        const config = readToolConfigIfExists(toolConfigPath);
        assert.equal(config.defaultCodexDir, "/somewhere/.codex");
        assert.deepEqual(config.claudeDefaults, DEFAULTS);
      },
    },
    {
      name: "a claudeDefaults that is not an object is refused",
      run() {
        for (const bad of ["dark", 3, true, null, [1, 2]]) {
          const toolConfigPath = writeRawConfig({ version: "1.1.0", claudeDefaults: bad });
          assert.throws(
            () => readToolConfigIfExists(toolConfigPath),
            (error) => error.code === "INVALID_CONFIG" && /claudeDefaults must be an object/.test(error.details.cause),
            `claudeDefaults: ${JSON.stringify(bad)}`
          );
        }
      },
    },
    {
      name: "claudeDefaults without a settings object is refused",
      run() {
        for (const bad of [{}, { settings: "x" }, { settings: null }, { settings: [] }]) {
          const toolConfigPath = writeRawConfig({ version: "1.1.0", claudeDefaults: bad });
          assert.throws(
            () => readToolConfigIfExists(toolConfigPath),
            (error) => error.code === "INVALID_CONFIG" && /claudeDefaults\.settings must be an object/.test(error.details.cause),
            `claudeDefaults: ${JSON.stringify(bad)}`
          );
        }
      },
    },
    {
      name: "a misplaced key under claudeDefaults is refused instead of dropped",
      run() {
        // `env` directly under claudeDefaults is the likeliest hand-written mistake. Dropping it
        // silently would leave every provider with no inherited env and no message saying why.
        const toolConfigPath = writeRawConfig({
          version: "1.1.0",
          claudeDefaults: { env: { MCP_CONNECT_TIMEOUT_MS: "30000" }, settings: {} },
        });
        assert.throws(
          () => readToolConfigIfExists(toolConfigPath),
          (error) =>
            error.code === "INVALID_CONFIG" &&
            /only supports "settings"/.test(error.details.cause) &&
            /"env"/.test(error.details.cause)
        );
      },
    },
  ],
};
