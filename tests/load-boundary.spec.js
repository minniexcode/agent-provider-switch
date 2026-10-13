"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { makeTempDir, repoRoot } = require("./helpers");

/**
 * Records which modules the entry point loads, in a process of its own.
 *
 * In-process this question cannot be asked: the suite calls `runBuiltCli()` after other specs have
 * already required the app services, so the `require` cache is warm and every module looks loaded.
 * A child process started fresh is the only place "did `--help` load this?" has an answer.
 *
 * The recorder wraps `Module._load` rather than diffing `require.cache` afterwards, because it has
 * to see the entry file itself and because a spec that forgot to clear the cache would otherwise
 * pass by accident.
 */
const RECORDER = `
const path = require("path");
const Module = require("module");
const root = process.argv[1];
const loaded = [];
const original = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (error) {
    resolved = request;
  }
  loaded.push(resolved);
  return original.apply(this, arguments);
};
const { runCli } = require(path.join(root, "dist", "cli.js"));
runCli(process.argv.slice(2), { stdout: function () {}, stderr: function () {} }).then(function () {
  const relative = [];
  for (const file of loaded) {
    if (file.startsWith(root + path.sep)) {
      relative.push(path.relative(root, file).split(path.sep).join("/"));
    } else if (!file.startsWith("node:")) {
      relative.push(file);
    }
  }
  process.stdout.write(JSON.stringify([...new Set(relative)]));
});
`;

/**
 * Runs one invocation in a fresh child process and returns the modules it loaded.
 *
 * The ambient `APS_*` variables and `NODE_ENV` are dropped for the same reason
 * `tests/cli-process.spec.js` drops them: an inherited root would let the child read this
 * developer's own tool home while the suite believes it is isolated.
 */
function loadedBy(args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("APS_")) {
      delete env[name];
    }
  }
  delete env.NODE_ENV;
  env.APS_HOME = makeTempDir("agent-provider-switch-load-home-");
  env.APS_CODEX_DIR = makeTempDir("agent-provider-switch-load-codex-");
  env.APS_CLAUDE_DIR = path.join(makeTempDir("agent-provider-switch-load-claude-"), "claude");

  const result = spawnSync(process.execPath, ["-e", RECORDER, repoRoot, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, null, `the recorder was terminated by a signal: ${result.signal}`);
  assert.equal(result.status, 0, `the recorder failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * The layer a pre-dispatch command must not load: the app services, the prompts and the Codex
 * runtime probe.
 *
 * Directory prefixes rather than a file list, so a service added later is covered without editing
 * this test — the boundary is the layering, not the current census.
 */
const EXECUTION_LAYER = [/^dist\/app\//, /^dist\/interaction\//, /^dist\/runtime\//];

/**
 * `inquirer`, matched on its resolved path rather than on the bare specifier.
 *
 * The recorder reports what `Module._resolveFilename` returned, so a package import arrives as
 * `node_modules/inquirer/dist/index.js`. Testing for `"inquirer"` would be a check that can never
 * fail, which is worse than no check — it reads as coverage.
 */
const INQUIRER = /(^|[\\/])node_modules[\\/]inquirer[\\/]/;

/** Registry I/O, which `help` has no reason to touch either. */
const REGISTRY_IO = [
  /^dist\/storage\/providers-repo\.js$/,
  /^dist\/storage\/claude-providers-repo\.js$/,
  /^dist\/storage\/provider-registry-repo\.js$/,
  /^dist\/storage\/config-repo\.js$/,
  /^dist\/storage\/tool-config-repo\.js$/,
  /^dist\/storage\/backup-repo\.js$/,
  /^dist\/storage\/lock-repo\.js$/,
  /^dist\/storage\/tool-home-migration\.js$/,
];

module.exports = {
  name: "entry load boundary",
  tests: [
    {
      name: "--help and --version load no execution service, prompt runtime, or registry I/O",
      run() {
        // `cli.ts` imports the dispatcher dynamically so these two can finish before it. That
        // dynamic import alone does not establish the boundary — a static import anywhere on the
        // path from the entry to the dispatcher's dependencies defeats it — and the registry used
        // to be exactly that: its entries carried the handler, so printing help imported every
        // app service, the inquirer runtime and the Codex probe (design §4.3, P2 entry boundary).
        for (const args of [["--help"], ["--version"], ["help", "add"]]) {
          const loaded = loadedBy(args);
          const offenders = loaded.filter(
            (file) =>
              EXECUTION_LAYER.some((pattern) => pattern.test(file)) ||
              REGISTRY_IO.some((pattern) => pattern.test(file)) ||
              INQUIRER.test(file)
          );
          assert.deepEqual(
            offenders,
            [],
            `aps ${args.join(" ")} must not load the execution layer, and loaded: ${offenders.join(", ")}`
          );
          assert.ok(
            loaded.includes("dist/commands/registry.js"),
            `aps ${args.join(" ")} must still read the command declarations`
          );
        }
      },
    },
    {
      name: "a real command does load them, so the boundary is a boundary and not an empty list",
      run() {
        // The counter-assertion. A recorder that recorded nothing — a mistyped root, a child that
        // exited early, a `_load` wrapper installed too late — would make the test above pass and
        // prove nothing. Running one command that genuinely needs the layer is what tells the two
        // failure modes apart.
        const loaded = loadedBy(["list", "--json"]);
        assert.ok(
          loaded.some((file) => file.startsWith("dist/app/")),
          "aps list --json must load the app services"
        );
        assert.ok(
          loaded.some((file) => INQUIRER.test(file)),
          "aps list --json must load the prompt runtime, which is what makes --help's silence about it meaningful"
        );
      },
    },
  ],
};
