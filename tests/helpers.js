"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const repoRoot = path.resolve(__dirname, "..");

/**
 * Every temporary directory this harness created and has not yet removed.
 */
const tempDirs = new Set();

/**
 * Creates a temporary directory and registers it for removal by `cleanupTempDirs()`.
 */
function makeTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(directory);
  return directory;
}

/**
 * Removes one temporary directory, best effort.
 */
function removeTempDir(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: a directory another process still holds open (Windows EBUSY) is left
    // behind rather than turning a test that already passed into a failure.
  }
}

/**
 * Removes every directory `makeTempDir` created. Idempotent, so it is safe to call per suite,
 * repeatedly, and again from the process exit backstop.
 */
function cleanupTempDirs() {
  for (const directory of [...tempDirs]) {
    // Removed from the registry before the attempt, so a directory that cannot be deleted is
    // not retried on every later call.
    tempDirs.delete(directory);
    removeTempDir(directory);
  }
}

// `process.exit` runs exit listeners, so this also covers the failure path and any early exit.
process.on("exit", cleanupTempDirs);

function makeToolHomeWithManagedState() {
  const toolHomeDir = makeTempDir("agent-provider-switch-tool-home-");
  const packageJson = require("../package.json");
  fs.writeFileSync(path.join(toolHomeDir, "providers.json"), `${JSON.stringify({ providers: {} }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(toolHomeDir, "agent-provider-switch.json"), `${JSON.stringify({ version: packageJson.version }, null, 2)}\n`, "utf8");
  return toolHomeDir;
}

/**
 * Writes a `claudeDefaults` block into an existing tool home's config.
 *
 * Separate from `makeToolHomeWithManagedState()` on purpose: that helper writes a bare
 * `{ version }`, and the older Claude specs depend on there being no defaults at all — their green
 * runs are the proof that a home without the block behaves exactly as before.
 */
function setClaudeDefaults(toolHomeDir, settings) {
  const configPath = path.join(toolHomeDir, "agent-provider-switch.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.claudeDefaults = { settings };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Runs `callback` with the given environment variables applied, restoring them afterwards.
 */
async function withEnv(overrides, run) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    // `await` so the restore runs after the callback settles. Without it the `finally` fires
    // as soon as `run()` hands back its promise, and an async callback then resolves paths
    // against the real machine state instead of the temporary one.
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * Runs `callback` against a tool home and a Claude root that cannot reach the real `~/.claude`.
 *
 * The guard is structural rather than a convention each test has to remember. `switch` atomically
 * replaces `<claudeDir>/settings.json`, and `resolveClaudeDir()` silently falls back to the real
 * `~/.claude` when `APS_CLAUDE_DIR` is unset — so a spec that forgets the variable overwrites
 * the developer's live Claude Code settings. Every check below runs before the callback does, and
 * the callback receives only the verified path.
 */
async function withClaudeEnv(settings, run) {
  const toolHomeDir = makeToolHomeWithManagedState();
  const rootDir = makeTempDir("agent-provider-switch-claude-root-");
  // Nested and not yet created, so the switch's directory-creation branch is exercised.
  const claudeDir = path.resolve(rootDir, "nested", "claude");
  const importFile = path.join(rootDir, "incoming-settings.json");
  fs.writeFileSync(importFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  assert.notEqual(
    claudeDir,
    path.resolve(os.homedir(), ".claude"),
    "refusing to run a Claude command against the real ~/.claude"
  );
  assert.ok(
    claudeDir.startsWith(path.resolve(rootDir)),
    `Claude root must stay inside the test temp directory, got ${claudeDir}`
  );

  return withEnv({ APS_CLAUDE_DIR: claudeDir }, () => run({ toolHomeDir, claudeDir, importFile }));
}

/**
 * Creates a Codex directory fixture, replacing the gitignored `dev-codex/local-sandbox` copy.
 *
 * `modelProvider` adds the top-level `model_provider` selector. The managed-projection contract
 * reads only that key — there is no fallback to the legacy top-level `profile` — so a fixture
 * without it cannot resolve an active provider at all. `baseUrl` sets the matching
 * `[model_providers.<id>]` section so a test can seed a deliberate mismatch.
 *
 * `legacyProfile` emits the legacy top-level `profile` selector. As the last root-level key it sits
 * on the boundary where a new top-level key is inserted, which is what
 * `provider-workflow.spec.js` needs to cover the legacy-cleanup write path.
 */
function makeCodexFixture({
  modelProvider = null,
  baseUrl = "https://free.example.com/v1",
  legacyProfile = null,
} = {}) {
  const codexDir = makeTempDir("agent-provider-switch-codex-");
  const rootFields = [
    modelProvider ? `model_provider = ${JSON.stringify(modelProvider)}` : null,
    legacyProfile ? `profile = ${JSON.stringify(legacyProfile)}` : null,
  ].filter(Boolean);

  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    `${rootFields.length > 0 ? `${rootFields.join("\n")}\n\n` : ""}` +
      `[profiles.packycode]\nmodel = "gpt-5"\nmodel_provider = "packycode"\n` +
      `\n[profiles.freemodel]\nmodel = "gpt-5-mini"\nmodel_provider = "freemodel"\n` +
      `\n[model_providers.packycode]\nbase_url = "https://relay.example.com/v1"\n` +
      `\n[model_providers.${modelProvider ?? "freemodel"}]\nbase_url = ${JSON.stringify(baseUrl)}\n`,
    "utf8"
  );

  // Any JSON object satisfies the auth file's validity check, and `switch` overwrites it.
  fs.writeFileSync(path.join(codexDir, "auth.json"), `${JSON.stringify({ token: "fixture" }, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(codexDir, "backups"), { recursive: true });

  return codexDir;
}

/**
 * Executes the built CLI entrypoint in-process and returns its rendered output.
 *
 * Calls `runCli` directly rather than mirroring the production dispatch ladder, so a change
 * to the entrypoint is reflected here instead of silently diverging (P1-3).
 */
async function runBuiltCli(input) {
  const { runCli } = require("../dist/cli.js");
  const args = Array.isArray(input) ? input : input.args;

  const toolHomeDir = !Array.isArray(input) && input.toolHomeDir
    ? path.resolve(input.toolHomeDir)
    : makeTempDir("agent-provider-switch-tool-home-");

  // The Codex directory is never used as the tool home: `--codex-dir` names the target runtime
  // a command operates on, while the tool home holds this tool's own state. A call that names
  // neither is pointed at a temporary Codex directory so it cannot touch the real ~/.codex.
  const overrides = { APS_HOME: toolHomeDir };
  if (!args.includes("--codex-dir")) {
    overrides.APS_CODEX_DIR = makeTempDir("agent-provider-switch-codex-");
  }

  // Claude commands replace `settings.json` wholesale, and `resolveClaudeDir()` falls back to
  // the real `~/.claude` when `APS_CLAUDE_DIR` is unset — so a spec that names `--claude`
  // without arranging the root overwrites the developer's live settings. Guarded here, beside
  // the Codex equivalent, so it does not depend on each spec remembering.
  // `withClaudeEnv()` sets the variable before calling in and is left alone.
  if (args.includes("--claude") && !process.env.APS_CLAUDE_DIR) {
    overrides.APS_CLAUDE_DIR = makeTempDir("agent-provider-switch-claude-");
  }

  const stdout = [];
  const stderr = [];

  const status = await withEnv(overrides, () =>
    runCli(args, {
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    })
  );

  // Temporary directories are owned by the registry, not removed here: an inline cleanup is
  // what previously deleted a caller's Codex directory, because the Codex directory had been
  // borrowed as the tool home.
  return {
    status,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

/**
 * Parses a JSON envelope from either stdout or stderr based on exit status.
 */
async function runJsonCli(input) {
  const result = await runBuiltCli(input);
  const raw = result.status === 0 ? result.stdout : result.stderr;
  return {
    ...result,
    payload: JSON.parse(raw),
  };
}

module.exports = {
  repoRoot,
  makeTempDir,
  removeTempDir,
  cleanupTempDirs,
  withEnv,
  makeToolHomeWithManagedState,
  setClaudeDefaults,
  withClaudeEnv,
  makeCodexFixture,
  runBuiltCli,
  runJsonCli,
};
