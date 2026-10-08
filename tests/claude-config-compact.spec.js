"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runBuiltCli, runJsonCli, setClaudeDefaults, withClaudeEnv } = require("./helpers");

const DEFAULTS_SETTINGS = {
  env: {
    CLAUDE_CODE_EFFORT_LEVEL: "XHIGH",
    MCP_CONNECT_TIMEOUT_MS: "30000",
    SHARED_AUTH_TOKEN: "sk-shared-secret-value",
  },
  model: "sonnet",
  theme: "dark",
  permissions: { allow: ["Read(*)"], deny: [] },
};

// Full copies of the defaults plus one provider-specific entry each: the shape the real file has.
function fullRecord(baseUrl, extra = {}) {
  return {
    ...DEFAULTS_SETTINGS,
    env: { ...DEFAULTS_SETTINGS.env, ANTHROPIC_BASE_URL: baseUrl },
    ...extra,
  };
}

const ALREADY_COMPACT = { settings: { env: { ANTHROPIC_BASE_URL: "https://compact.example" } }, note: "compact" };

async function runClaude(toolHomeDir, args) {
  assert.ok(args.includes("--json"), `Claude spec invocations must pass --json: ${args.join(" ")}`);
  return runJsonCli({ toolHomeDir, args });
}

function registryPath(toolHomeDir) {
  return path.join(toolHomeDir, "claude-providers.json");
}

function writeRegistry(toolHomeDir, providers) {
  fs.writeFileSync(registryPath(toolHomeDir), `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

function readRegistry(toolHomeDir) {
  return JSON.parse(fs.readFileSync(registryPath(toolHomeDir), "utf8"));
}

function readLiveSettings(claudeDir) {
  return JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
}

function backupCount(toolHomeDir) {
  const backupsDir = path.join(toolHomeDir, "backups");
  return fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((name) => name !== "latest.json").length : 0;
}

/**
 * Writes a lock record owned by this very process, so `inspectLock` reads it as live.
 */
function holdLiveLock(toolHomeDir) {
  fs.writeFileSync(
    path.join(toolHomeDir, ".aps.lock"),
    JSON.stringify({
      pid: process.pid,
      operation: "held-by-test",
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
    }),
    "utf8"
  );
}

/**
 * Seeds a tool home with defaults and a mix of full and already-compact records.
 */
function seed(toolHomeDir) {
  setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
  writeRegistry(toolHomeDir, {
    alpha: { settings: fullRecord("https://alpha.example"), note: "alpha note", tags: ["a"] },
    beta: { settings: fullRecord("https://beta.example", { model: "opus" }) },
    compact: ALREADY_COMPACT,
  });
}

module.exports = {
  name: "claude config compact",
  tests: [
    {
      name: "--dry-run reports what would change and leaves the file byte-identical",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          seed(toolHomeDir);
          const before = fs.readFileSync(registryPath(toolHomeDir), "utf8");

          const result = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--dry-run", "--json"]);
          assert.equal(result.payload.ok, true, result.stderr);

          const { data } = result.payload;
          assert.equal(data.dryRun, true);
          assert.equal(data.changedCount, 2);
          assert.equal(data.unchangedCount, 1);
          assert.deepEqual(
            data.providers.map((entry) => [entry.provider, entry.changed]),
            [["alpha", true], ["beta", true], ["compact", false]]
          );
          // Paths, never values: the shared token must not appear anywhere in the report.
          assert.ok(data.providers[0].droppedPaths.includes("env.SHARED_AUTH_TOKEN"));
          assert.equal(result.stdout.includes("sk-shared-secret-value"), false);

          assert.equal(fs.readFileSync(registryPath(toolHomeDir), "utf8"), before);
          assert.equal(backupCount(toolHomeDir), 0, "a preview must not create a backup");
        });
      },
    },
    {
      name: "--dry-run takes no lock: it succeeds while a live lock is held, and a real run is refused",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          seed(toolHomeDir);
          holdLiveLock(toolHomeDir);

          const preview = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--dry-run", "--json"]);
          assert.equal(preview.payload.ok, true, preview.stderr);

          // The control: the same lock does stop a real run, so the preview's success is
          // meaningful rather than the lock being inert.
          const real = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.equal(real.status, 1);
          assert.equal(real.payload.error.code, "LOCK_CONFLICT");
        });
      },
    },
    {
      name: "a real run rewrites full records to deltas, carries note and tags, and takes a backup",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          seed(toolHomeDir);
          const sizeBefore = fs.statSync(registryPath(toolHomeDir)).size;

          const result = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.equal(result.payload.ok, true, result.stderr);
          assert.equal(result.payload.data.dryRun, false);
          assert.equal(result.payload.data.changedCount, 2);
          assert.ok(fs.existsSync(result.payload.data.backupPath), "the backup directory must exist");

          const { providers } = readRegistry(toolHomeDir);
          assert.deepEqual(providers.alpha, {
            settings: { env: { ANTHROPIC_BASE_URL: "https://alpha.example" } },
            note: "alpha note",
            tags: ["a"],
          });
          // `model: "opus"` differs from the default, so it is the provider's own and stays.
          assert.deepEqual(providers.beta.settings, { env: { ANTHROPIC_BASE_URL: "https://beta.example" }, model: "opus" });
          assert.deepEqual(providers.compact, ALREADY_COMPACT);
          assert.ok(fs.statSync(registryPath(toolHomeDir)).size < sizeBefore / 2, "the file should shrink substantially");
        });
      },
    },
    {
      name: "compaction does not change what a switch writes",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          seed(toolHomeDir);
          // A record that omits most defaults: it already inherits them on read, so compaction has
          // no effect on its effective settings — the property this test pins.
          const registry = readRegistry(toolHomeDir);
          registry.providers.sparse = { settings: { env: { ANTHROPIC_BASE_URL: "https://sparse.example" }, theme: "light" } };
          fs.writeFileSync(registryPath(toolHomeDir), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

          const written = {};
          for (const name of ["alpha", "beta", "compact", "sparse"]) {
            await runClaude(toolHomeDir, ["switch", "--claude", name, "--json"]);
            written[name] = readLiveSettings(claudeDir);
          }

          const compacted = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.equal(compacted.payload.ok, true, compacted.stderr);

          for (const name of Object.keys(written)) {
            await runClaude(toolHomeDir, ["switch", "--claude", name, "--json"]);
            assert.deepEqual(readLiveSettings(claudeDir), written[name], `${name} must switch to the same settings`);
          }
        });
      },
    },
    {
      name: "a second run is a no-op: nothing changes, nothing is written, no backup is taken",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          seed(toolHomeDir);
          await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          const afterFirst = fs.readFileSync(registryPath(toolHomeDir), "utf8");
          const backupsAfterFirst = backupCount(toolHomeDir);

          const second = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.equal(second.payload.ok, true, second.stderr);
          assert.equal(second.payload.data.changedCount, 0);
          assert.equal(second.payload.data.backupPath, undefined);

          assert.equal(fs.readFileSync(registryPath(toolHomeDir), "utf8"), afterFirst);
          assert.equal(backupCount(toolHomeDir), backupsAfterFirst);
        });
      },
    },
    {
      name: "an explicit null that deletes a real default survives compaction",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);
          writeRegistry(toolHomeDir, {
            nulled: { settings: { ...fullRecord("https://nulled.example"), theme: null } },
          });

          await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);

          // Dropping the null would make the deleted theme reappear on the next switch.
          assert.equal(readRegistry(toolHomeDir).providers.nulled.settings.theme, null);
          await runClaude(toolHomeDir, ["switch", "--claude", "nulled", "--json"]);
          assert.equal("theme" in readLiveSettings(claudeDir), false);
        });
      },
    },
    {
      name: "compaction is reversible through rollback",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          seed(toolHomeDir);
          const before = fs.readFileSync(registryPath(toolHomeDir), "utf8");

          await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.notEqual(fs.readFileSync(registryPath(toolHomeDir), "utf8"), before);

          const rolledBack = await runClaude(toolHomeDir, ["rollback", "--json"]);
          assert.equal(rolledBack.payload.ok, true, rolledBack.stderr);
          assert.equal(fs.readFileSync(registryPath(toolHomeDir), "utf8"), before);
        });
      },
    },
    {
      name: "refuses, naming the file, when the tool config has no claudeDefaults block",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          writeRegistry(toolHomeDir, { alpha: { settings: fullRecord("https://alpha.example") } });
          const before = fs.readFileSync(registryPath(toolHomeDir), "utf8");

          const result = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.equal(result.status, 1);
          assert.equal(result.payload.error.code, "INVALID_ARGUMENT");
          assert.match(result.payload.error.message, /claudeDefaults/);
          assert.match(result.payload.error.details.file, /agent-provider-switch\.json$/);
          assert.equal(fs.readFileSync(registryPath(toolHomeDir), "utf8"), before);
        });
      },
    },
    {
      name: "reports zero providers, not an error, when there is no registry yet",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS_SETTINGS);

          const result = await runClaude(toolHomeDir, ["config", "compact", "--claude", "--json"]);
          assert.equal(result.payload.ok, true, result.stderr);
          assert.equal(result.payload.data.changedCount, 0);
          assert.deepEqual(result.payload.data.providers, []);
          assert.equal(fs.existsSync(registryPath(toolHomeDir)), false, "compacting nothing must not create the file");
        });
      },
    },
    {
      name: "is refused without --claude, and --dry-run is refused everywhere else",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          const noClaude = await runClaude(toolHomeDir, ["config", "compact", "--json"]);
          assert.equal(noClaude.status, 1);
          assert.equal(noClaude.payload.error.code, "INVALID_ARGUMENT");
          assert.match(noClaude.payload.error.message, /requires --claude/);

          // The motivating case for the flag guard: accepted-and-ignored here would delete backups
          // under a flag that promised a preview.
          const onPrune = await runClaude(toolHomeDir, ["backups", "prune", "--dry-run", "--json"]);
          assert.equal(onPrune.status, 1);
          assert.equal(onPrune.payload.error.code, "INVALID_ARGUMENT");
          assert.deepEqual(onPrune.payload.error.details.supportedCommands, ["config-compact"]);

          const onCodexCompact = await runClaude(toolHomeDir, ["config", "compact", "--dry-run", "--json"]);
          assert.equal(onCodexCompact.status, 1);
          assert.equal(onCodexCompact.payload.error.code, "INVALID_ARGUMENT");
        });
      },
    },
    {
      name: "human output names the providers that move and says nothing was written on a dry run",
      async run() {
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          seed(toolHomeDir);

          const preview = await runBuiltCli({ toolHomeDir, args: ["config", "compact", "--claude", "--dry-run"] });
          assert.equal(preview.status, 0, preview.stderr);
          assert.match(preview.stdout, /Dry run: 2 of 3 Claude providers would be compacted\. Nothing was written\./);
          assert.match(preview.stdout, /alpha: \d+ entries match the defaults/);
          assert.match(preview.stdout, /Run without --dry-run to apply/);
          assert.equal(preview.stdout.includes("compact:"), false, "an unchanged provider is not listed");

          const real = await runBuiltCli({ toolHomeDir, args: ["config", "compact", "--claude"] });
          assert.equal(real.status, 0, real.stderr);
          assert.match(real.stdout, /Compacted 2 of 3 Claude providers/);
          assert.match(real.stdout, /backup: /);

          const again = await runBuiltCli({ toolHomeDir, args: ["config", "compact", "--claude"] });
          assert.match(again.stdout, /All 3 Claude providers already store only what differs from the defaults/);
        });
      },
    },
  ],
};
