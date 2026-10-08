"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir, makeToolHomeWithManagedState, runBuiltCli, runJsonCli } = require("./helpers");

const AUTH_TOKEN = "sk-ant-oat01-REALTOKENVALUE123456";
const API_KEY = "sk-ant-api03-REALKEYVALUE098765";
const BASE_URL = "https://api.deepseek.example/anthropic";
const PROVIDER_NAME = "deepseek";

/**
 * Runs `callback` against a fresh temporary directory. Removal is owned by the helper
 * registry, so a failure here cannot leave the directory behind or delete it too early.
 */
function withTempDir(prefix, run) {
  return run(makeTempDir(prefix));
}

/**
 * Creates a managed tool home seeded with one Claude provider and clears it afterwards.
 */
async function withClaudeToolHome(run) {
  const toolHomeDir = makeToolHomeWithManagedState();
  fs.writeFileSync(
    path.join(toolHomeDir, "claude-providers.json"),
    `${JSON.stringify({ providers: { [PROVIDER_NAME]: claudeRecord() } }, null, 2)}\n`,
    "utf8"
  );

  const previousClaudeDir = process.env.APS_CLAUDE_DIR;
  try {
    return await withTempDir("codex-switch-claude-dir-", async (claudeDir) => {
      // Point the Claude target at a throwaway directory so `current`/`list` cannot
      // read or write the real ~/.claude during the run.
      process.env.APS_CLAUDE_DIR = claudeDir;
      return await run(toolHomeDir);
    });
  } finally {
    if (previousClaudeDir === undefined) {
      delete process.env.APS_CLAUDE_DIR;
    } else {
      process.env.APS_CLAUDE_DIR = previousClaudeDir;
    }
  }
}

function claudeRecord() {
  return {
    note: "test profile",
    tags: ["test"],
    settings: {
      model: "claude-sonnet-5",
      env: {
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
        ANTHROPIC_API_KEY: API_KEY,
        CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        MCP_CONNECT_TIMEOUT_MS: "30000",
      },
    },
  };
}

module.exports = {
  name: "secret handling",
  tests: [
    {
      name: "show --claude masks token and key env values and withholds the settings blob",
      async run() {
        await withClaudeToolHome(async (toolHomeDir) => {
          const result = await runJsonCli({ toolHomeDir, args: ["show", "--claude", PROVIDER_NAME, "--json"] });
          assert.equal(result.payload.ok, true);

          const data = result.payload.data;
          assert.equal(data.revealed, false);
          assert.equal("settings" in data, false, "the raw settings blob must not be returned by default");
          assert.equal(data.env.ANTHROPIC_AUTH_TOKEN, "sk-***56");
          assert.equal(data.env.ANTHROPIC_API_KEY, "sk-***65");
          // Non-secret neighbours must survive masking untouched.
          assert.equal(data.env.ANTHROPIC_BASE_URL, BASE_URL);
          assert.equal(data.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
          assert.equal(data.env.MCP_CONNECT_TIMEOUT_MS, "30000");
          assert.ok(!result.stdout.includes(AUTH_TOKEN));
          assert.ok(!result.stdout.includes(API_KEY));
        });
      },
    },
    {
      name: "show --claude --reveal returns real values and the settings blob",
      async run() {
        await withClaudeToolHome(async (toolHomeDir) => {
          const result = await runJsonCli({
            toolHomeDir,
            args: ["show", "--claude", PROVIDER_NAME, "--reveal", "--json"],
          });
          assert.equal(result.payload.ok, true);

          const data = result.payload.data;
          assert.equal(data.revealed, true);
          assert.equal(data.env.ANTHROPIC_AUTH_TOKEN, AUTH_TOKEN);
          assert.equal(data.env.ANTHROPIC_API_KEY, API_KEY);
          assert.equal(data.settings.model, "claude-sonnet-5");
        });
      },
    },
    {
      name: "show --claude --reveal <name> still resolves the provider name",
      async run() {
        await withClaudeToolHome(async (toolHomeDir) => {
          // The global pass strips --reveal before the command-option pass, so the name
          // that follows it is not swallowed as the flag's value.
          const parsedFirst = await runJsonCli({
            toolHomeDir,
            args: ["show", "--reveal", "--claude", PROVIDER_NAME, "--json"],
          });
          assert.equal(parsedFirst.payload.ok, true);
          assert.equal(parsedFirst.payload.data.provider, PROVIDER_NAME);
          assert.equal(parsedFirst.payload.data.revealed, true);

          const nameLast = await runJsonCli({
            toolHomeDir,
            args: ["show", "--claude", "--reveal", PROVIDER_NAME, "--json"],
          });
          assert.equal(nameLast.payload.ok, true);
          assert.equal(nameLast.payload.data.provider, PROVIDER_NAME);
          assert.equal(nameLast.payload.data.revealed, true);
        });
      },
    },
    {
      name: "list --claude and current --claude expose no secret material",
      async run() {
        await withClaudeToolHome(async (toolHomeDir) => {
          const list = await runBuiltCli({ toolHomeDir, args: ["list", "--claude"] });
          assert.equal(list.status, 0);
          assert.match(list.stdout, new RegExp(PROVIDER_NAME));
          assert.match(list.stdout, /model=claude-sonnet-5/);
          assert.ok(!list.stdout.includes(AUTH_TOKEN));
          assert.ok(!list.stdout.includes(API_KEY));

          const current = await runJsonCli({ toolHomeDir, args: ["current", "--claude", "--json"] });
          assert.equal(current.payload.ok, true);
          assert.equal(current.payload.data.status, "no-settings");
          assert.ok(!current.stdout.includes(AUTH_TOKEN));
        });
      },
    },
    {
      name: "printErrorDetails redacts nested and non-apikey secret keys",
      async run() {
        const { printErrorDetails } = require("../dist/storage/fs-utils.js");
        const lines = printErrorDetails({
          message: "boom",
          details: {
            env: { ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN, ANTHROPIC_BASE_URL: BASE_URL },
            authorization: `Bearer ${API_KEY}`,
            client_secret: "shhh",
            password: "hunter2",
            nested: { api_key: API_KEY },
            credential_bundle: { user: "abc" },
          },
        });
        const rendered = lines.join("\n");

        assert.ok(!rendered.includes(AUTH_TOKEN), "auth token must not survive redaction");
        assert.ok(!rendered.includes(API_KEY), "api key must not survive redaction");
        assert.ok(!rendered.includes("shhh"));
        assert.ok(!rendered.includes("hunter2"));
        assert.ok(!rendered.includes("abc"));
        // Strings keep a fingerprint; a secret key holding a structure has none to keep.
        assert.match(rendered, /sk-\*\*\*56/);
        assert.match(rendered, /\[redacted\]/);
        // Non-secret detail values are still printed.
        assert.match(rendered, /ANTHROPIC_BASE_URL/);
      },
    },
    {
      name: "redactSecretValues walks arrays and preserves non-secret structure",
      async run() {
        const { redactSecretValues, isSecretKey } = require("../dist/domain/secrets.js");

        const redacted = redactSecretValues({
          providers: [
            { name: "alpha", api_key: API_KEY },
            { name: "beta", token: AUTH_TOKEN },
          ],
          endpoint: BASE_URL,
        });

        assert.equal(redacted.providers[0].api_key, "sk-***65");
        assert.equal(redacted.providers[1].token, "sk-***56");
        assert.equal(redacted.providers[0].name, "alpha");
        assert.equal(redacted.endpoint, BASE_URL);

        // The pattern is tuned to Claude env keys: it must not catch their neighbours.
        assert.equal(isSecretKey("ANTHROPIC_AUTH_TOKEN"), true);
        assert.equal(isSecretKey("ANTHROPIC_API_KEY"), true);
        assert.equal(isSecretKey("ANTHROPIC_BASE_URL"), false);
        assert.equal(isSecretKey("CLAUDE_CODE_ATTRIBUTION_HEADER"), false);
        assert.equal(isSecretKey("MCP_CONNECT_TIMEOUT_MS"), false);
      },
    },
    {
      name: "export reports containsSecrets and warns about plaintext keys",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        fs.writeFileSync(
          path.join(toolHomeDir, "providers.json"),
          `${JSON.stringify(
            {
              providers: {
                alpha: { profile: "alpha", apiKey: "sk-alpha-secret", baseUrl: "https://alpha.example/v1" },
                beta: { profile: "beta", apiKey: "sk-beta-secret", baseUrl: "https://beta.example/v1" },
              },
            },
            null,
            2
          )}\n`,
          "utf8"
        );

        await withTempDir("codex-switch-export-", async (tempDir) => {
          const target = path.join(tempDir, "exported.json");
          const result = await runJsonCli({ toolHomeDir, args: ["export", target, "--json"] });
          assert.equal(result.payload.ok, true);
          assert.equal(result.payload.data.count, 2);
          assert.equal(result.payload.data.secretCount, 2);
          assert.equal(result.payload.data.containsSecrets, true);
          assert.equal(result.payload.warnings.length, 1);
          assert.match(result.payload.warnings[0], /plaintext/);
          assert.match(result.payload.warnings[0], /Do not commit this file/);
        });
      },
    },
    {
      name: "writeTextFileAtomic never leaves the destination missing",
      async run() {
        const { writeTextFileAtomic } = require("../dist/storage/fs-utils.js");
        await withTempDir("codex-switch-atomic-", async (tempDir) => {
          const target = path.join(tempDir, "managed.json");
          writeTextFileAtomic(target, '{"generation":1}\n');
          assert.equal(fs.readFileSync(target, "utf8"), '{"generation":1}\n');

          // Intercept the rename to observe the destination at the only instant the
          // previous rm-then-rename implementation left it absent.
          const realRenameSync = fs.renameSync;
          let observed = null;
          fs.renameSync = (from, to) => {
            observed = { destinationExists: fs.existsSync(to), contents: fs.readFileSync(to, "utf8") };
            return realRenameSync(from, to);
          };
          try {
            writeTextFileAtomic(target, '{"generation":2}\n');
          } finally {
            fs.renameSync = realRenameSync;
          }

          assert.equal(observed.destinationExists, true, "destination must exist when the rename runs");
          assert.equal(observed.contents, '{"generation":1}\n', "destination must still hold the old contents at rename time");
          assert.equal(fs.readFileSync(target, "utf8"), '{"generation":2}\n');
          assert.equal(fs.existsSync(`${target}.tmp-${process.pid}`), false, "temp sibling must not linger");
        });
      },
    },
    {
      name: "restoreManifest rejects a restore path outside the allowed roots",
      async run() {
        const { createBackup, restoreManifest } = require("../dist/storage/backup-repo.js");

        await withTempDir("codex-switch-rollback-", async (tempDir) => {
          const allowedRoot = path.join(tempDir, "tool-home");
          const outsideRoot = path.join(tempDir, "outside");
          fs.mkdirSync(allowedRoot, { recursive: true });
          fs.mkdirSync(outsideRoot, { recursive: true });

          const managedPath = path.join(allowedRoot, "providers.json");
          fs.writeFileSync(managedPath, '{"providers":{"alpha":{}}}\n', "utf8");

          const manifest = createBackup(path.join(allowedRoot, "backups"), "test", [
            { absolutePath: managedPath, relativePath: "providers.json" },
          ]);

          // A manifest that names a path outside the managed roots must not be written to.
          const victim = path.join(outsideRoot, "victim.json");
          fs.writeFileSync(victim, '{"untouched":true}\n', "utf8");
          manifest.files[0].restorePath = victim;

          assert.throws(() => restoreManifest(manifest, [allowedRoot]), (error) => error.code === "ROLLBACK_PATH_REJECTED");
          assert.equal(fs.readFileSync(victim, "utf8"), '{"untouched":true}\n', "rejected path must not be written");

          // The same manifest restores once the path is back inside the managed roots.
          manifest.files[0].restorePath = managedPath;
          fs.writeFileSync(managedPath, '{"providers":{}}\n', "utf8");
          restoreManifest(manifest, [allowedRoot]);
          assert.match(fs.readFileSync(managedPath, "utf8"), /"alpha"/);

          // A sibling directory sharing a prefix is not inside the root.
          manifest.files[0].restorePath = `${allowedRoot}-sibling/providers.json`;
          assert.throws(() => restoreManifest(manifest, [allowedRoot]), (error) => error.code === "ROLLBACK_PATH_REJECTED");
        });
      },
    },
    {
      name: "managed writes round-trip and use 0600/0700 on POSIX",
      async run() {
        const { writeTextFileAtomic } = require("../dist/storage/fs-utils.js");
        const { writeClaudeProvidersFile } = require("../dist/storage/claude-providers-repo.js");
        const { writeOpenAiApiKeyAuth } = require("../dist/storage/auth-repo.js");

        await withTempDir("codex-switch-modes-", async (tempDir) => {
          const nestedDir = path.join(tempDir, "created", "deep");
          const claudeProvidersPath = path.join(nestedDir, "claude-providers.json");
          writeClaudeProvidersFile(claudeProvidersPath, { providers: { [PROVIDER_NAME]: claudeRecord() } });

          const authPath = path.join(tempDir, "auth.json");
          writeOpenAiApiKeyAuth(authPath, "sk-direct-provider-key");

          // Applies on every platform: the secure-mode arguments must not corrupt the write.
          assert.equal(JSON.parse(fs.readFileSync(claudeProvidersPath, "utf8")).providers[PROVIDER_NAME].note, "test profile");
          assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).OPENAI_API_KEY, "sk-direct-provider-key");

          if (process.platform === "win32") {
            // chmod only toggles the read-only bit on Windows, so fs-utils skips it there.
            return;
          }

          assert.equal(mode8(claudeProvidersPath), 0o600, "claude-providers.json");
          assert.equal(mode8(authPath), 0o600, "auth.json");
          assert.equal(mode8(nestedDir), 0o700, "created directory");
          assert.equal(mode8(path.join(tempDir, "created")), 0o700, "created parent directory");

          // Overwriting an existing file must re-apply the mode, not just set it on create.
          fs.chmodSync(claudeProvidersPath, 0o644);
          writeTextFileAtomic(claudeProvidersPath, "{}\n");
          assert.equal(mode8(claudeProvidersPath), 0o600, "claude-providers.json after rewrite");
        });
      },
    },
  ],
};

function mode8(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}
