"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const cliEntry = path.join(repoRoot, "dist", "cli.js");

/**
 * Every sandbox this run created. Cleaned by `cleanupSandboxes()` in the runner's `finally`,
 * with a process-exit backstop.
 */
const sandboxes = new Set();

/**
 * Raised by a spec that cannot run in this environment. The runner counts and prints these
 * rather than swallowing them: a silently skipped case is indistinguishable from a passing one,
 * which is the failure mode this whole suite exists to remove.
 */
class Skip extends Error {}

function skip(reason) {
  throw new Skip(reason);
}

/**
 * Resolves `candidate` and refuses it unless it stays strictly inside `sandboxRoot`.
 *
 * Structural rather than conventional. `resolveClaudeDir()` falls back to the real `~/.claude`
 * when `APS_CLAUDE_DIR` is unset, and `switch --claude` replaces `settings.json` wholesale —
 * so a root that escapes is not a failed assertion, it is a destroyed developer configuration.
 *
 * Compared as a path relative to the sandbox rather than by string prefix, so a sibling such as
 * `/tmp/e2e-12` cannot satisfy a sandbox of `/tmp/e2e-1`.
 */
function assertInsideSandbox(sandboxRoot, candidate, label) {
  const root = path.resolve(sandboxRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolved outside the E2E sandbox: ${resolved} is not under ${root}`);
  }

  return resolved;
}

/**
 * Refuses a sandbox that is not under the system temp directory.
 *
 * `os.tmpdir()` is itself inside the home directory on Windows, so the meaningful invariant is
 * containment in temp, not separation from home.
 */
function assertSandboxRoot(root) {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`the E2E sandbox must live under the system temp directory, got ${resolved}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Creates an isolated tree: one temp root holding the tool home, the Codex target, and the
 * Claude target. Every check below runs before any child process starts.
 */
function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-e2e-"));
  sandboxes.add(root);
  assertSandboxRoot(root);

  const sandbox = {
    root,
    home: assertInsideSandbox(root, path.join(root, "home"), "APS_HOME"),
    codex: assertInsideSandbox(root, path.join(root, "codex"), "APS_CODEX_DIR"),
    claude: assertInsideSandbox(root, path.join(root, "claude"), "APS_CLAUDE_DIR"),
  };

  for (const directory of [sandbox.home, sandbox.codex, sandbox.claude]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  // A tool home without managed state fails every command on a missing registry, so the two
  // files `init` would create are written up front. Tests that specifically cover `init` use
  // `createSandbox({ bare: true })`.
  const version = require(path.join(repoRoot, "package.json")).version;
  writeJson(path.join(sandbox.home, "providers.json"), { providers: {} });
  writeJson(path.join(sandbox.home, "codex-switch.json"), { version });

  return sandbox;
}

/**
 * Creates an isolated tree with no managed state at all, for exercising `init`.
 */
function createBareSandbox() {
  const sandbox = createSandbox();
  fs.rmSync(path.join(sandbox.home, "providers.json"), { force: true });
  fs.rmSync(path.join(sandbox.home, "codex-switch.json"), { force: true });
  return sandbox;
}

/**
 * Writes a Codex runtime fixture into the sandbox.
 *
 * `modelProvider` adds the top-level selector. The managed-projection contract reads only that
 * key — there is no fallback to the legacy top-level `profile` — so a fixture without it cannot
 * resolve an active provider at all, and every "which provider is current" assertion would be
 * vacuous. `baseUrl` sets the matching `[model_providers.<id>]` section so a test can seed a
 * deliberate mismatch against the record it registers.
 */
function seedCodex(
  sandbox,
  { modelProvider = null, legacyProfile = null, baseUrl = "https://free.example.com/v1" } = {}
) {
  const rootFields = [
    modelProvider ? `model_provider = ${JSON.stringify(modelProvider)}` : null,
    legacyProfile ? `profile = ${JSON.stringify(legacyProfile)}` : null,
  ].filter(Boolean);

  fs.writeFileSync(
    path.join(sandbox.codex, "config.toml"),
    `${rootFields.length > 0 ? `${rootFields.join("\n")}\n\n` : ""}` +
      `[profiles.packycode]\nmodel = "gpt-5"\nmodel_provider = "packycode"\n` +
      `\n[profiles.freemodel]\nmodel = "gpt-5-mini"\nmodel_provider = "freemodel"\n` +
      `\n[model_providers.packycode]\nbase_url = "https://relay.example.com/v1"\n` +
      `\n[model_providers.${modelProvider ?? "freemodel"}]\nbase_url = ${JSON.stringify(baseUrl)}\n`,
    "utf8"
  );

  // Any JSON object satisfies the auth file's validity check, and `switch` overwrites it.
  writeJson(path.join(sandbox.codex, "auth.json"), { token: "fixture" });

  return sandbox;
}

/**
 * Writes the shape a clean Codex config actually has, by hand rather than through `seedCodex`.
 *
 * The fixture's legacy `[profiles.*]` sections are findings in their own right, so a test that
 * asserts "healthy" — a clean `doctor`, or a `status` whose next step is the generic one — cannot
 * start from it. `baseUrl` is parameterised so a drift case can write the projected section and the
 * registry out of step.
 */
function writeCleanCodex(sandbox, baseUrl = "https://freemodel.example/v1") {
  fs.writeFileSync(
    path.join(sandbox.codex, "config.toml"),
    'model = "gpt-5-mini"\n' +
      'model_provider = "freemodel"\n' +
      "\n" +
      "[model_providers.freemodel]\n" +
      `base_url = "${baseUrl}"\n`,
    "utf8"
  );
  writeJson(path.join(sandbox.codex, "auth.json"), { OPENAI_API_KEY: "sk-fixture" });
}

/**
 * Builds the child environment explicitly rather than inheriting it.
 *
 * Ambient `APS_*` is dropped so an inherited value cannot redirect a root out of the sandbox,
 * and `NODE_ENV` is dropped because `NODE_ENV=development` retargets Codex resolution at
 * `<cwd>/dev-codex/local-sandbox` and adds the real `~/.codex` to migrate's candidate list.
 */
function buildChildEnv(sandbox, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("APS_") || name === "NODE_ENV") {
      continue;
    }
    env[name] = value;
  }

  // Re-verified here, not only at creation: this is the last point before a child that writes.
  env.APS_HOME = assertInsideSandbox(sandbox.root, sandbox.home, "APS_HOME");
  env.APS_CODEX_DIR = assertInsideSandbox(sandbox.root, sandbox.codex, "APS_CODEX_DIR");
  env.APS_CLAUDE_DIR = assertInsideSandbox(sandbox.root, sandbox.claude, "APS_CLAUDE_DIR");

  return { ...env, ...extra };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Runs one real `node dist/cli.js <args>` in a child process and captures its real exit code.
 */
function runCli(sandbox, args, options = {}) {
  // `migrate` is the one command that does not take APS_CODEX_DIR as authoritative:
  // `codexDirExplicit` is set only by a literal `--codex-dir`, so without it migrate runs
  // ambient discovery, which reaches the real `~/.codex` and returns CODEX_DIR_AMBIGUOUS —
  // or silently adopts the developer's own Codex directory when the sandbox has none.
  // Refused here rather than documented, because the failure is invisible in the result.
  if (args[0] === "migrate" && !args.includes("--codex-dir")) {
    throw new Error(
      "E2E isolation: migrate must be invoked with an explicit --codex-dir, " +
        "because APS_CODEX_DIR alone does not stop its ambient discovery"
    );
  }

  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: options.cwd ?? sandbox.root,
    env: buildChildEnv(sandbox, options.env),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status === null) {
    throw new Error(`the CLI was terminated by signal ${result.signal}: codexs ${args.join(" ")}`);
  }

  // Failures write the envelope to stderr and successes to stdout, matching the bin.
  const channel = result.status === 0 ? result.stdout : result.stderr;

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    text: channel,
    json: tryParseJson(channel),
    args,
  };
}

/**
 * Runs a command that must succeed and returns its envelope, failing with the CLI's own message
 * when it does not.
 */
function runOk(sandbox, args, options) {
  const result = runCli(sandbox, args, options);
  if (result.status !== 0) {
    throw new Error(`expected codexs ${args.join(" ")} to succeed:\n${result.stderr}`);
  }
  if (!result.json) {
    throw new Error(`expected a JSON envelope from codexs ${args.join(" ")}:\n${result.text}`);
  }
  return result;
}

/**
 * Runs a command that must fail and returns its envelope.
 */
function runFail(sandbox, args, options) {
  const result = runCli(sandbox, args, options);
  if (result.status === 0) {
    throw new Error(`expected codexs ${args.join(" ")} to fail, but it exited 0:\n${result.stdout}`);
  }
  if (!result.json) {
    throw new Error(`expected a JSON error envelope from codexs ${args.join(" ")}:\n${result.text}`);
  }
  return result;
}

/**
 * A `PATH` that contains nothing, so `probeCodexRuntime()` deterministically reports the codex
 * CLI as missing. Node itself is launched by absolute path, so this cannot affect the child's
 * ability to start.
 */
function sandboxPathWithoutCodex(sandbox) {
  const emptyPath = path.join(sandbox.root, "empty-path");
  fs.mkdirSync(emptyPath, { recursive: true });
  return emptyPath;
}

function removeSandbox(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort: a directory a child process still holds open (Windows EBUSY) is left behind
    // rather than turning a suite that already passed into a failure.
  }
}

function cleanupSandboxes() {
  for (const root of [...sandboxes]) {
    sandboxes.delete(root);
    removeSandbox(root);
  }
}

// `process.exit` runs exit listeners, so this also covers a failing run and an early exit.
process.on("exit", cleanupSandboxes);

module.exports = {
  repoRoot,
  cliEntry,
  Skip,
  skip,
  assertInsideSandbox,
  assertSandboxRoot,
  createSandbox,
  createBareSandbox,
  seedCodex,
  writeCleanCodex,
  buildChildEnv,
  runCli,
  runOk,
  runFail,
  sandboxPathWithoutCodex,
  cleanupSandboxes,
  writeJson,
};
