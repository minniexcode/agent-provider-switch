"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeCodexFixture, makeTempDir, withEnv } = require("./helpers");

const { migrateLegacyToolHome, ensureLegacyToolHomeMigrated } = require("../dist/storage/tool-home-migration.js");

const LEGACY_HOME_NAME = "codex-switch";
const NEW_HOME_NAME = "agent-provider-switch";
const LEGACY_CONFIG_NAME = "codex-switch.json";
const NEW_CONFIG_NAME = "agent-provider-switch.json";
const LEGACY_LOCK_NAME = ".codex-switch.lock";
const NEW_LOCK_NAME = ".aps.lock";

/**
 * A pid that cannot belong to a running process. Small values are unsafe: on Windows
 * `process.kill(4, 0)` raises EPERM, which reads as alive, and pid 0 does not throw at all.
 */
const DEAD_PID = 999999999;

const PROVIDERS_DOCUMENT = {
  providers: {
    legacyp: {
      profile: "legacyp",
      apiKey: "sk-legacy-fixture",
      model: "gpt-5-mini",
      baseUrl: "https://legacy.example.com/v1",
    },
  },
};

/**
 * Builds the on-disk shape a pre-rename install has: the old directory name, the old config
 * filename, and the old lock filename.
 *
 * The fixture is hand-written rather than produced by running the tool, because the tool now
 * writes the new names — seeding through it would leave nothing for the rename step to do, and
 * the test would pass while proving nothing about real legacy state.
 */
function makeLegacyHome(rootDir, { config = true, lock = null, providers = true } = {}) {
  const legacyHomeDir = path.join(rootDir, LEGACY_HOME_NAME);
  fs.mkdirSync(path.join(legacyHomeDir, "backups"), { recursive: true });

  if (config) {
    fs.writeFileSync(
      path.join(legacyHomeDir, LEGACY_CONFIG_NAME),
      `${JSON.stringify({ version: "0.4.1" }, null, 2)}\n`,
      "utf8"
    );
  }
  if (lock) {
    fs.writeFileSync(path.join(legacyHomeDir, LEGACY_LOCK_NAME), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
  if (providers) {
    fs.writeFileSync(
      path.join(legacyHomeDir, "providers.json"),
      `${JSON.stringify(PROVIDERS_DOCUMENT, null, 2)}\n`,
      "utf8"
    );
  }

  return legacyHomeDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Runs `run` with `os.homedir()` pointing into a fresh temporary directory.
 *
 * Both variables are set because Node reads `USERPROFILE` on Windows and `HOME` elsewhere. The
 * assertion between the override and the callback is the load-bearing part, and it is why this
 * helper exists instead of each test inlining the variables: if neither took effect, `os.homedir()`
 * still answers with the real home and a migration test would move the developer's live
 * `~/.config/codex-switch` out from under them. Same structure as `withClaudeEnv`, which guards
 * `~/.claude` the same way.
 */
async function withRedirectedHome(run) {
  const homeDir = makeTempDir("codex-switch-home-");
  return withEnv({ HOME: homeDir, USERPROFILE: homeDir }, async () => {
    assert.equal(
      path.resolve(os.homedir()),
      path.resolve(homeDir),
      "refusing to run a migration test against the real home directory"
    );
    assert.ok(
      path.resolve(path.join(os.homedir(), ".config")).startsWith(path.resolve(homeDir)),
      "the redirected home must contain the config root"
    );
    return run(homeDir);
  });
}

/**
 * Runs `run` with `APS_HOME` genuinely unset, so the default-home path is exercised.
 *
 * `withEnv` cannot express this: assigning `undefined` to `process.env` stores the string
 * "undefined", which would resolve to a directory literally named that.
 */
async function withoutToolHomeOverride(run) {
  const saved = process.env.APS_HOME;
  delete process.env.APS_HOME;
  try {
    return await run();
  } finally {
    if (saved === undefined) {
      delete process.env.APS_HOME;
    } else {
      process.env.APS_HOME = saved;
    }
  }
}

module.exports = {
  name: "tool-home migration",
  tests: [
    {
      name: "a legacy home is moved, and both artifacts inside it are renamed",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const legacyHomeDir = makeLegacyHome(rootDir, {
          lock: { pid: DEAD_PID, operation: "switch", createdAt: new Date().toISOString(), hostname: os.hostname() },
        });
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);
        const providersBefore = fs.readFileSync(path.join(legacyHomeDir, "providers.json"), "utf8");

        const result = migrateLegacyToolHome({ newHomeDir, legacyHomeDir });

        assert.deepEqual(result, { migrated: true, warnings: [] });
        assert.equal(fs.existsSync(legacyHomeDir), false, "the legacy home must be gone, not copied from");
        assert.ok(fs.existsSync(newHomeDir), "the tool home must exist at the new path");

        assert.ok(fs.existsSync(path.join(newHomeDir, NEW_CONFIG_NAME)));
        assert.equal(fs.existsSync(path.join(newHomeDir, LEGACY_CONFIG_NAME)), false);
        assert.equal(readJson(path.join(newHomeDir, NEW_CONFIG_NAME)).version, "0.4.1");

        // The lock is renamed rather than deleted or rewritten. Deleting it would erase the record
        // the stale-pid detection reads, and rewriting it would date a takeover that never
        // happened; a rename keeps the residue honest for the first real mutation to take over.
        assert.ok(fs.existsSync(path.join(newHomeDir, NEW_LOCK_NAME)));
        assert.equal(fs.existsSync(path.join(newHomeDir, LEGACY_LOCK_NAME)), false);
        assert.equal(readJson(path.join(newHomeDir, NEW_LOCK_NAME)).pid, DEAD_PID);

        // Untouched payloads: only names change, never contents.
        assert.equal(fs.readFileSync(path.join(newHomeDir, "providers.json"), "utf8"), providersBefore);
        assert.ok(fs.existsSync(path.join(newHomeDir, "backups")), "nested directories move with the home");
      },
    },
    {
      name: "a legacy home without a config or lock file still moves",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const legacyHomeDir = makeLegacyHome(rootDir, { config: false, lock: null });
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);

        const result = migrateLegacyToolHome({ newHomeDir, legacyHomeDir });

        assert.equal(result.migrated, true);
        assert.deepEqual(result.warnings, []);
        assert.equal(fs.existsSync(legacyHomeDir), false);
        assert.ok(fs.existsSync(path.join(newHomeDir, "providers.json")));
        assert.equal(fs.existsSync(path.join(newHomeDir, NEW_CONFIG_NAME)), false, "no config is invented");
      },
    },
    {
      name: "an existing new home wins, and the legacy home is left alone",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const legacyHomeDir = makeLegacyHome(rootDir);
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);
        fs.mkdirSync(newHomeDir, { recursive: true });
        fs.writeFileSync(path.join(newHomeDir, "providers.json"), '{"providers":{"resident":{}}}\n', "utf8");

        const result = migrateLegacyToolHome({ newHomeDir, legacyHomeDir });

        assert.deepEqual(result, { migrated: false, warnings: [] }, "both homes existing is a silent no-op");
        assert.ok(fs.existsSync(path.join(legacyHomeDir, LEGACY_CONFIG_NAME)), "the legacy home must not be touched");
        assert.ok(readJson(path.join(newHomeDir, "providers.json")).providers.resident);
      },
    },
    {
      name: "a missing legacy home, or a non-directory at its path, is a no-op",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);

        const missing = migrateLegacyToolHome({ newHomeDir, legacyHomeDir: path.join(rootDir, LEGACY_HOME_NAME) });
        assert.deepEqual(missing, { migrated: false, warnings: [] });
        assert.equal(fs.existsSync(newHomeDir), false, "the migration must never create the new home itself");

        // A file where the legacy directory should be is corruption, not a tool home. Renaming it
        // would produce a file where every later path join expects a directory.
        fs.writeFileSync(path.join(rootDir, LEGACY_HOME_NAME), "not a directory\n", "utf8");
        const wrongType = migrateLegacyToolHome({ newHomeDir, legacyHomeDir: path.join(rootDir, LEGACY_HOME_NAME) });
        assert.deepEqual(wrongType, { migrated: false, warnings: [] });
        assert.equal(fs.existsSync(newHomeDir), false);
        assert.equal(fs.readFileSync(path.join(rootDir, LEGACY_HOME_NAME), "utf8"), "not a directory\n");
      },
    },
    {
      name: "a lock held by a running process defers the move instead of moving the home out from under it",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const legacyHomeDir = makeLegacyHome(rootDir, {
          // This process's own pid is unambiguously alive, so the probe has a live owner to find.
          lock: { pid: process.pid, operation: "switch", createdAt: new Date().toISOString(), hostname: os.hostname() },
        });
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);

        const result = migrateLegacyToolHome({ newHomeDir, legacyHomeDir });

        assert.equal(result.migrated, false);
        assert.equal(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes(legacyHomeDir), `warning must name the legacy path: ${result.warnings[0]}`);
        assert.ok(result.warnings[0].includes(`pid ${String(process.pid)}`), `warning must name the owner: ${result.warnings[0]}`);
        assert.equal(fs.existsSync(newHomeDir), false);
        assert.ok(fs.existsSync(path.join(legacyHomeDir, LEGACY_CONFIG_NAME)), "a deferred migration renames nothing");
        assert.ok(fs.existsSync(path.join(legacyHomeDir, LEGACY_LOCK_NAME)));
      },
    },
    {
      name: "a lock from another host defers the move, because its owner cannot be probed here",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const legacyHomeDir = makeLegacyHome(rootDir, {
          lock: {
            pid: DEAD_PID,
            operation: "switch",
            createdAt: new Date().toISOString(),
            hostname: "some-other-machine.invalid",
          },
        });
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);

        const result = migrateLegacyToolHome({ newHomeDir, legacyHomeDir });

        assert.equal(result.migrated, false);
        assert.ok(result.warnings[0].includes("another host"), result.warnings[0]);
        assert.equal(fs.existsSync(newHomeDir), false);
      },
    },
    {
      name: "an unreadable lock record does not block the move",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const legacyHomeDir = makeLegacyHome(rootDir);
        // Torn JSON: the residue of a kill mid-write, and the state most likely to be left behind.
        fs.writeFileSync(path.join(legacyHomeDir, LEGACY_LOCK_NAME), '{"pid": 4242, "operati', "utf8");
        const newHomeDir = path.join(rootDir, NEW_HOME_NAME);

        const result = migrateLegacyToolHome({ newHomeDir, legacyHomeDir });

        assert.equal(result.migrated, true);
        assert.deepEqual(result.warnings, []);
        assert.equal(fs.readFileSync(path.join(newHomeDir, NEW_LOCK_NAME), "utf8"), '{"pid": 4242, "operati');
      },
    },
    {
      name: "the two directories naming the same path is a no-op",
      run() {
        const rootDir = makeTempDir("codex-switch-migration-");
        const directory = makeLegacyHome(rootDir);

        const result = migrateLegacyToolHome({ newHomeDir: directory, legacyHomeDir: directory });

        assert.deepEqual(result, { migrated: false, warnings: [] });
        assert.ok(fs.existsSync(path.join(directory, LEGACY_CONFIG_NAME)));
      },
    },
    {
      name: "an explicit APS_HOME suppresses the migration even when the default legacy home is migratable",
      async run() {
        await withRedirectedHome(async (homeDir) => {
          const legacyHomeDir = makeLegacyHome(path.join(homeDir, ".config"));
          const overrideDir = makeTempDir("codex-switch-override-");

          const result = await withEnv({ APS_HOME: overrideDir }, () => ensureLegacyToolHomeMigrated());

          assert.deepEqual(result, { migrated: false, warnings: [] });
          assert.ok(
            fs.existsSync(path.join(legacyHomeDir, LEGACY_CONFIG_NAME)),
            "an explicit tool home must not move anything under the real config root"
          );
          assert.equal(fs.existsSync(path.join(homeDir, ".config", NEW_HOME_NAME)), false);
          assert.deepEqual(fs.readdirSync(overrideDir), [], "nothing may be written to the override either");
        });
      },
    },
    {
      name: "the default wiring migrates the real default paths, and a command then reads the moved data",
      async run() {
        await withRedirectedHome(async (homeDir) => {
          await withoutToolHomeOverride(async () => {
            const configDir = path.join(homeDir, ".config");
            const legacyHomeDir = makeLegacyHome(configDir);
            const newHomeDir = path.join(configDir, NEW_HOME_NAME);
            const codexDir = makeCodexFixture();

            const stdout = [];
            const stderr = [];
            const { runCli } = require("../dist/cli.js");
            const status = await runCli(["list", "--json", "--codex-dir", codexDir], {
              stdout: (line) => stdout.push(line),
              stderr: (line) => stderr.push(line),
            });

            const rendered = stdout.join("\n");
            assert.equal(status, 0, `list against a migrated home must succeed: ${stderr.join("\n")}`);
            assert.ok(
              fs.existsSync(newHomeDir),
              "dispatch must migrate before the tool-home paths resolve"
            );
            assert.equal(fs.existsSync(legacyHomeDir), false, "the legacy home must not survive the first command");
            assert.match(rendered, /legacyp/, "the command must read the providers that moved with the home");

            // A second command proves the now-absent legacy home is handled by the real wiring
            // rather than only by the injected-directory tests above.
            const again = [];
            const againStatus = await runCli(["list", "--json", "--codex-dir", codexDir], {
              stdout: (line) => again.push(line),
              stderr: () => {},
            });
            assert.equal(againStatus, 0, "a second command must not re-run or fail on the migration");
            assert.match(again.join("\n"), /legacyp/);
          });
        });
      },
    },
  ],
};
