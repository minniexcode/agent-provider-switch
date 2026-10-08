"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  assertInsideSandbox,
  assertSandboxRoot,
  buildChildEnv,
  createSandbox,
  repoRoot,
} = require("./sandbox");

module.exports = {
  name: "sandbox guard",
  tests: [
    {
      name: "a root that escapes the sandbox is refused",
      run() {
        const sandbox = createSandbox();

        for (const escapee of [
          path.join(sandbox.root, "..", "elsewhere"),
          path.resolve(os.homedir()),
          path.join(os.tmpdir(), "some-unrelated-directory"),
        ]) {
          assert.throws(
            () => assertInsideSandbox(sandbox.root, escapee, "APS_CLAUDE_DIR"),
            /resolved outside the E2E sandbox/,
            `expected ${escapee} to be refused`
          );
        }

        // The sandbox root itself is not a valid root for a child: it would put every target in
        // one directory, which is not the isolation the guard is asserting.
        assert.throws(() => assertInsideSandbox(sandbox.root, sandbox.root, "APS_HOME"));
      },
    },
    {
      name: "a sibling whose name extends the sandbox name is refused",
      run() {
        const sandbox = createSandbox();

        // String-prefix containment would accept this and hand a child a directory outside the
        // sandbox; comparison by relative path does not.
        const sibling = `${sandbox.root}-elsewhere`;
        fs.mkdirSync(sibling, { recursive: true });
        assert.throws(
          () => assertInsideSandbox(sandbox.root, sibling, "APS_HOME"),
          /resolved outside the E2E sandbox/
        );
      },
    },
    {
      name: "a legitimate root is accepted and resolved",
      run() {
        const sandbox = createSandbox();
        const nested = path.join(sandbox.root, "nested", "tool-home");

        assert.equal(assertInsideSandbox(sandbox.root, nested, "APS_HOME"), path.resolve(nested));
        assert.equal(assertInsideSandbox(sandbox.root, sandbox.home, "APS_HOME"), sandbox.home);
      },
    },
    {
      name: "a sandbox outside the system temp directory is refused",
      run() {
        assert.throws(() => assertSandboxRoot(repoRoot), /must live under the system temp directory/);
        assert.throws(
          () => assertSandboxRoot(path.resolve(os.homedir())),
          /must live under the system temp directory/
        );

        // And the real thing is accepted, so the check above is not simply always failing.
        assert.doesNotThrow(() => assertSandboxRoot(createSandbox().root));
      },
    },
    {
      name: "the child environment drops ambient roots and NODE_ENV",
      run() {
        const sandbox = createSandbox();
        const previous = {
          APS_HOME: process.env.APS_HOME,
          APS_CLAUDE_DIR: process.env.APS_CLAUDE_DIR,
          NODE_ENV: process.env.NODE_ENV,
        };

        process.env.APS_HOME = path.resolve(os.homedir(), ".config", "codex-switch");
        process.env.APS_CLAUDE_DIR = path.resolve(os.homedir(), ".claude");
        process.env.NODE_ENV = "development";

        let env;
        try {
          env = buildChildEnv(sandbox);
        } finally {
          for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) {
              delete process.env[name];
            } else {
              process.env[name] = value;
            }
          }
        }

        // `NODE_ENV=development` would retarget Codex resolution at dev-codex/local-sandbox and
        // add the real ~/.codex to migrate's candidate list.
        assert.equal(env.NODE_ENV, undefined, "NODE_ENV must not reach the child");
        assert.equal(env.APS_HOME, sandbox.home);
        assert.equal(env.APS_CODEX_DIR, sandbox.codex);
        assert.equal(env.APS_CLAUDE_DIR, sandbox.claude);
      },
    },
    {
      name: "a real child process observes only the sandboxed roots",
      run() {
        const sandbox = createSandbox();

        // The guard's own claim, verified past the process boundary: what the child actually
        // sees is the assertion, not what this module believes it passed.
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            "process.stdout.write(JSON.stringify({home: process.env.APS_HOME, codex: process.env.APS_CODEX_DIR, claude: process.env.APS_CLAUDE_DIR, nodeEnv: process.env.NODE_ENV ?? null}))",
          ],
          { env: buildChildEnv(sandbox), encoding: "utf8" }
        );

        assert.equal(result.status, 0, result.stderr);
        const seen = JSON.parse(result.stdout);
        assert.equal(seen.home, sandbox.home);
        assert.equal(seen.codex, sandbox.codex);
        assert.equal(seen.claude, sandbox.claude);
        assert.equal(seen.nodeEnv, null);

        for (const root of [seen.home, seen.codex, seen.claude]) {
          assert.doesNotThrow(() => assertInsideSandbox(sandbox.root, root, "root"));
        }
      },
    },
  ],
};
