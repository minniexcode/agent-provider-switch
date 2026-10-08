"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createSandbox,
  runCli,
  runFail,
  runOk,
  sandboxPathWithoutCodex,
  sandboxPathWithFakeCodex,
  seedCodex,
  writeCleanCodex,
  writeJson,
} = require("./sandbox");

/**
 * A pid that cannot belong to a running process. Small values are unsafe: on Windows
 * `process.kill(4, 0)` raises EPERM, which reads as alive, and pid 0 does not throw at all.
 */
const DEAD_PID = 999999999;

function lockPathFor(sandbox) {
  return path.join(sandbox.home, ".aps.lock");
}

function writeLock(sandbox, record) {
  writeJson(lockPathFor(sandbox), record);
}

function addProvider(sandbox, name, extra = []) {
  return runOk(sandbox, [
    "add",
    name,
    "--profile",
    name,
    "--model",
    "gpt-5-mini",
    "--api-key",
    `sk-${name}`,
    "--base-url",
    `https://${name}.example/v1`,
    "--json",
    ...extra,
  ]);
}

function backupDirs(sandbox) {
  const directory = path.join(sandbox.home, "backups");
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

module.exports = {
  name: "lock recovery, backups, and rollback",
  tests: [
    {
      name: "unlock is idempotent, clears a dead lock, and refuses a live one",
      run() {
        const sandbox = createSandbox();

        // Nothing to clear is success, not an error: a script that unlocks before a batch must not
        // fail because a previous run already cleared it.
        const absent = runOk(sandbox, ["unlock", "--json"]);
        assert.equal(absent.json.data.removed, false);
        assert.match(absent.json.data.reason, /no lock file was present/);

        // A record whose owner is gone reads as recoverable, which is the state a crashed process
        // leaves behind and the reason the command exists.
        writeLock(sandbox, {
          pid: DEAD_PID,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: require("node:os").hostname(),
        });

        const doctor = runOk(sandbox, ["doctor", "--json"]);
        const stale = doctor.json.data.issues.find((issue) => issue.code === "LOCK_STALE");
        assert.ok(stale, "a dead lock must be reported as stale");
        assert.match(stale.remedy, /aps unlock/);

        const cleared = runOk(sandbox, ["unlock", "--json"]);
        assert.equal(cleared.json.data.removed, true);
        assert.equal(cleared.json.data.forced, false);
        assert.match(cleared.json.data.reason, /cleared because the recorded owner is dead/);
        assert.equal(cleared.json.data.owner.pid, DEAD_PID);
        assert.equal(fs.existsSync(lockPathFor(sandbox)), false);

        const humanAbsent = runCli(sandbox, ["unlock"]);
        assert.match(humanAbsent.stdout, /^No agent-provider-switch lock to clear \(no lock file was present\)\.$/m);

        // A pid that is genuinely running is refused, because clearing it would let a second
        // operation into the critical section the lock is holding. The runner's own process is the
        // live owner, and it is alive for the whole of this spawn.
        writeLock(sandbox, {
          pid: process.pid,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: require("node:os").hostname(),
        });

        const refused = runFail(sandbox, ["unlock", "--json"]);
        assert.equal(refused.json.error.code, "LOCK_CONFLICT");
        assert.equal(refused.json.error.details.activePid, process.pid);
        assert.match(refused.json.error.details.remedy, /aps unlock --force/);
        assert.ok(fs.existsSync(lockPathFor(sandbox)), "a refused unlock must leave the lock in place");

        // ...and --force is the documented escape hatch for a recycled pid.
        const forced = runOk(sandbox, ["unlock", "--force", "--json"]);
        assert.equal(forced.json.data.removed, true);
        assert.equal(forced.json.data.forced, true);
        assert.match(forced.json.data.reason, /--force was given/);

        const humanForced = runCli(sandbox, ["unlock"]);
        assert.match(humanForced.stdout, /^No agent-provider-switch lock to clear/m);
      },
    },
    {
      name: "backups prune keeps the newest backups and never deletes a referenced directory",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        for (const name of ["alpha", "beta", "gamma", "delta"]) {
          addProvider(sandbox, name);
        }

        const before = backupDirs(sandbox);
        assert.equal(before.length, 4, `expected one backup per mutation, got ${before.length}`);

        const pruned = runOk(sandbox, ["backups", "prune", "--keep", "2", "--json"]);
        assert.equal(pruned.json.data.keep, 2);
        assert.equal(pruned.json.data.removedCount, 2);

        for (const removed of pruned.json.data.removed) {
          assert.equal(
            fs.existsSync(path.join(sandbox.home, "backups", removed)),
            false,
            `prune reported removing ${removed} but left it on disk`
          );
        }

        const after = backupDirs(sandbox);
        assert.equal(after.length, 2);
        assert.deepEqual(
          after,
          pruned.json.data.removed.reduce((kept, removed) => kept.filter((name) => name !== removed), before)
        );

        // A directory named by the manifest a no-argument rollback resolves through must survive
        // even when it falls outside the keep window, because deleting it would break rollback.
        const oldest = after[0];
        writeJson(path.join(sandbox.home, "backups", "latest.json"), {
          version: 1,
          createdAt: new Date().toISOString(),
          reason: "switch",
          backupDir: path.join(sandbox.home, "backups", oldest),
          files: [],
        });

        const protectedRun = runOk(sandbox, ["backups", "prune", "--keep", "1", "--json"]);
        assert.equal(protectedRun.json.data.protectedCount, 1);
        assert.deepEqual(protectedRun.json.data.removed, []);
        assert.ok(
          protectedRun.json.warnings.some((warning) => /surviving manifest still references it/.test(warning)),
          `expected the protection to be explained, got ${JSON.stringify(protectedRun.json.warnings)}`
        );
        assert.ok(fs.existsSync(path.join(sandbox.home, "backups", oldest)));

        const human = runCli(sandbox, ["backups", "prune", "--keep", "1"]);
        assert.equal(human.status, 0);
        assert.match(human.stdout, /^Retention kept 1 backup\(s\) and removed 0\.$/m);
        assert.match(human.stdout, /^Kept 1 backup\(s\) that a surviving manifest still references\.$/m);

        // A directory with no manifest cannot be shown to be expendable, so it is reported rather
        // than deleted — the state a crash most often produces.
        fs.mkdirSync(path.join(sandbox.home, "backups", "orphan"), { recursive: true });
        const withOrphan = runOk(sandbox, ["backups", "prune", "--json"]);
        assert.equal(withOrphan.json.data.unreadableCount, 1);
        assert.ok(fs.existsSync(path.join(sandbox.home, "backups", "orphan")));

        // --keep is validated rather than coerced: parseInt("5abc") is 5, so the raw string is
        // matched against an integer pattern before conversion.
        for (const bad of ["0", "5abc", "-1"]) {
          const invalid = runFail(sandbox, ["backups", "prune", "--keep", bad, "--json"]);
          assert.equal(invalid.json.error.code, "INVALID_ARGUMENT");
          assert.equal(invalid.json.error.details.received, bad);
        }
      },
    },
    {
      name: "rollback restores a specific backup and refuses a manifest pointing outside the roots",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");
        addProvider(sandbox, "spare");
        runOk(sandbox, ["switch", "gamma", "--json"]);

        const listed = runOk(sandbox, ["backups", "list", "--json"]);
        // Ordered newest first, so the snapshot that predates `spare` while already containing
        // `gamma` is the second-oldest: each mutation backs the files up before it writes.
        const chronological = [...listed.json.data.backups].reverse();
        const target = chronological[1];
        assert.ok(target.backupId, "a backup id must be listed for the rollback to name");
        assert.equal(chronological.length, 3, "expected one backup per mutation");

        const rolled = runOk(sandbox, ["rollback", target.backupId, "--json"]);
        assert.equal(rolled.json.data.backupId, target.backupId);
        assert.ok(rolled.json.data.restoredFiles.includes("providers.json"));

        const providers = JSON.parse(fs.readFileSync(path.join(sandbox.home, "providers.json"), "utf8"));
        assert.deepEqual(Object.keys(providers.providers), ["gamma"]);

        // An id that matches nothing fails as a lookup, not as a partial restore.
        const missing = runFail(sandbox, ["rollback", "20200101-000000000-nope", "--json"]);
        assert.ok(missing.json.error.code, "a bad id must produce a structured error");

        // The allowlist is the caller's, never the manifest's. Rewriting a manifest so its restore
        // path escapes the managed roots is exactly the tamper the check exists for, and the write
        // is possible here only because the sandbox owns the backup directory.
        //
        // Read from disk rather than spread from the listing: `backups list` returns a summary
        // item, not the manifest, and a hand-built object would be rejected as malformed long
        // before the path check the assertion is aiming at.
        const outside = path.join(sandbox.root, "escaped.json");
        const tampered = JSON.parse(
          fs.readFileSync(path.join(target.backupPath, "manifest.json"), "utf8")
        );
        tampered.files = [
          { relativePath: "providers.json", restorePath: outside, existed: true, backupFileName: "providers.json" },
        ];
        writeJson(path.join(sandbox.home, "backups", "latest.json"), tampered);

        const rejected = runFail(sandbox, ["rollback", "--json"]);
        assert.equal(rejected.json.error.code, "ROLLBACK_PATH_REJECTED");
        assert.equal(rejected.json.error.details.restorePath, outside);
        assert.equal(fs.existsSync(outside), false, "a rejected restore must not write outside the roots");
      },
    },
    {
      name: "doctor reports a healthy tree and names a next step for each issue it can see",
      run() {
        const sandbox = createSandbox();
        writeCleanCodex(sandbox);
        addProvider(sandbox, "freemodel");

        // Both ends of the runtime probe are pinned, never left to the host. The healthy case gets a
        // stand-in `codex` and the missing case gets an empty PATH, so the result is the same on a
        // developer machine that has the real CLI and on a CI runner that does not. The healthy case
        // used to run on the ambient PATH, which passed locally and failed on every CI leg with
        // CODEX_NOT_INSTALLED.
        const withCodex = { PATH: sandboxPathWithFakeCodex(sandbox) };
        const withoutCodex = { PATH: sandboxPathWithoutCodex(sandbox) };
        const healthy = runOk(sandbox, ["doctor", "--json"], { env: withCodex });
        assert.equal(
          healthy.json.data.healthy,
          true,
          `expected a healthy tree, got ${JSON.stringify(healthy.json.data.issues)}`
        );
        assert.deepEqual(healthy.json.data.issues, []);

        const humanHealthy = runCli(sandbox, ["doctor"], { env: withCodex });
        assert.match(humanHealthy.stdout, /^Doctor summary: healthy\. No action required\.$/m);

        const stripped = runOk(sandbox, ["doctor", "--json"], { env: withoutCodex });
        assert.deepEqual(stripped.json.data.issues.map((issue) => issue.code), ["CODEX_NOT_INSTALLED"]);

        const humanStripped = runCli(sandbox, ["doctor"], { env: withoutCodex });
        assert.match(humanStripped.stdout, /^Doctor summary: 1 issue\(s\) need attention\.$/m);
        assert.match(humanStripped.stdout, /^- CODEX_NOT_INSTALLED: codex CLI is not available on PATH\.$/m);
        assert.match(humanStripped.stdout, /^  next step: inspect the issue details/m);

        // A missing config.toml and a missing registry are separate findings with separate fixes.
        const bare = createSandbox();
        const bareResult = runOk(bare, ["doctor", "--json"], { env: withoutCodex });
        const bareCodes = bareResult.json.data.issues.map((issue) => issue.code);
        assert.ok(bareCodes.includes("CONFIG_NOT_FOUND"), `expected CONFIG_NOT_FOUND, got ${bareCodes.join(", ")}`);

        const bareHuman = runCli(bare, ["doctor"], { env: withoutCodex });
        assert.match(bareHuman.stdout, /^  next step: restore or create config\.toml/m);

        // Drift is what a hand-edit of config.toml produces: the projection moves and the registry
        // does not. Rewriting the section is the only way to reach it, since every managed write
        // keeps the two in step.
        const drifted = createSandbox();
        writeCleanCodex(drifted);
        addProvider(drifted, "freemodel");
        // The projection moves and the registry does not, which is what the section being
        // hand-edited afterwards looks like.
        writeCleanCodex(drifted, "https://somewhere-else.example/v1");

        const drift = runOk(drifted, ["doctor", "--json"], { env: withoutCodex });
        assert.ok(
          drift.json.data.issues.some((issue) => issue.code === "PROVIDER_BASE_URL_MISMATCH"),
          `expected a projection mismatch, got ${JSON.stringify(drift.json.data.issues.map((issue) => issue.code))}`
        );
        const driftHuman = runCli(drifted, ["doctor"], { env: withoutCodex });
        assert.match(driftHuman.stdout, /^  next step: rerun `aps edit <provider> --base-url <url>`/m);

        // The lock arms of the same switch, which have their own next steps.
        writeLock(drifted, { pid: DEAD_PID, operation: "switch", createdAt: new Date().toISOString() });
        const staleHuman = runCli(drifted, ["doctor"], { env: withoutCodex });
        assert.match(staleHuman.stdout, /^  next step: the next write command clears it automatically, or run `aps unlock`$/m);

        writeLock(drifted, { pid: process.pid, operation: "switch", createdAt: new Date().toISOString() });
        const occupiedHuman = runCli(drifted, ["doctor"], { env: withoutCodex });
        assert.match(occupiedHuman.stdout, /^  next step: wait for the running operation, or run `aps unlock --force`/m);
        assert.match(occupiedHuman.stdout, /^- LOCK_OCCUPIED: /m);

        // Legacy wiring shares one next step across all three of its codes.
        const legacy = createSandbox();
        seedCodex(legacy, { modelProvider: "freemodel", legacyProfile: "freemodel" });
        addProvider(legacy, "freemodel");
        const legacyHuman = runCli(legacy, ["doctor"], { env: withoutCodex });
        assert.match(legacyHuman.stdout, /^- LEGACY_PROFILE_SELECTOR: /m);
        assert.match(legacyHuman.stdout, /^  next step: rerun `aps switch <provider>` to project/m);
      },
    },
  ],
};
