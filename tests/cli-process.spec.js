"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { makeTempDir, repoRoot } = require("./helpers");

/**
 * Spawns the built CLI as a real child process.
 *
 * The ambient `APS_*` variables and `NODE_ENV` are dropped rather than inherited: an
 * inherited `NODE_ENV=development` retargets Codex resolution at `<cwd>/dev-codex/local-sandbox`
 * and adds the real `~/.codex` to migrate's candidate list, and an inherited `APS_HOME` would
 * let a spec operate on the developer's own tool home. All three roots are set explicitly.
 */
function spawnCli(args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("APS_")) {
      delete env[name];
    }
  }
  delete env.NODE_ENV;

  env.APS_HOME = makeTempDir("codex-switch-proc-home-");
  env.APS_CODEX_DIR = makeTempDir("codex-switch-proc-codex-");
  env.APS_CLAUDE_DIR = makeTempDir("codex-switch-proc-claude-");

  const result = spawnSync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  // A null status means the child died on a signal, which would otherwise read as a mismatch
  // between the expected and actual code rather than as the crash it is.
  assert.notEqual(result.status, null, `the CLI was terminated by a signal: ${result.signal}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

module.exports = {
  name: "CLI process exit codes",
  tests: [
    {
      name: "the exit code of the real process matches what dispatch returned",
      run() {
        // The in-process harness calls `runCli` directly, so nothing in the suite observed the
        // code the operating system actually received until this test.
        const cases = [
          { args: ["lst"], status: 1 },
          { args: ["--help"], status: 0 },
          { args: ["-h"], status: 0 },
          { args: ["--version"], status: 0 },
          { args: ["config"], status: 0 },
        ];

        for (const { args, status } of cases) {
          const result = spawnCli(args);
          assert.equal(result.status, status, `codexs ${args.join(" ")} exited ${result.status}`);
        }
      },
    },
    {
      name: "a failure envelope survives a real stderr pipe intact",
      run() {
        const result = spawnCli(["lst", "--json"]);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "", "a JSON failure must not write to stdout");

        // Parsed from the pipe rather than from an in-process string sink, so a truncated or
        // interleaved write fails here instead of passing.
        const payload = JSON.parse(result.stderr);
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, "INVALID_ARGUMENT");
      },
    },
    {
      name: "the full help text arrives through a real pipe",
      run() {
        // The bin assigns `process.exitCode` instead of calling `process.exit`, because exiting
        // immediately after a write to a POSIX pipe can truncate stdout. That decision is only
        // observable across a real pipe: an in-process sink cannot lose bytes.
        const result = spawnCli(["--help"]);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /^codex-switch$/m);
        assert.match(
          result.stdout,
          /codexs help add$/m,
          "the last line of the help text must arrive, so the write was not truncated"
        );
      },
    },
  ],
};
