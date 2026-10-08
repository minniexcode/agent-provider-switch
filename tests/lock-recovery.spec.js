"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  makeCodexFixture,
  makeTempDir,
  makeToolHomeWithManagedState,
  repoRoot,
  runJsonCli,
} = require("./helpers");

/**
 * The shared lock path inside a tool home.
 *
 * Spelled out here rather than imported from the build so the on-disk location is pinned by
 * the test: moving the lock without updating this fails loudly instead of silently passing
 * against a path nothing else uses.
 */
function lockPathFor(toolHomeDir) {
  return path.join(toolHomeDir, ".aps.lock");
}

function writeLock(lockPath, record) {
  fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * A pid that cannot belong to a running process. Small values are unsafe: on Windows
 * `process.kill(4, 0)` raises EPERM, which reads as alive, and pid 0 does not throw at all.
 */
const DEAD_PID = 999999999;

/**
 * Runs one `add`, the cheapest command that goes through `runMutation` and therefore takes
 * the lock.
 */
function addProvider(toolHomeDir, codexDir, name) {
  return runJsonCli({
    toolHomeDir,
    args: [
      "add",
      name,
      "--profile",
      name,
      "--model",
      "gpt-5-mini",
      "--api-key",
      `sk-${name}`,
      "--base-url",
      "https://gamma.example/v1",
      "--json",
      "--codex-dir",
      codexDir,
    ],
  });
}

module.exports = {
  name: "stale-lock recovery",
  tests: [
    {
      name: "a process killed inside the critical section leaves a lock the next mutation takes over",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        const lockPath = lockPathFor(toolHomeDir);

        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        // The child acquires the lock and exits from inside the critical section. `process.exit`
        // does not unwind `finally`, so the lock file survives with a pid that is already gone —
        // the exact residue a `kill -9` leaves, and the condition P0-5 describes.
        //
        // The child prints nothing: `process.exit()` right after a write to a POSIX pipe can
        // truncate it, so stdout would be an unreliable signal on Linux CI. The lock file is the
        // evidence — it exists only if the callback ran, and a child that returned normally would
        // have released it through the `finally`.
        //
        // The paths are interpolated rather than passed through argv: with `node -e`, the first
        // extra argument lands in `process.argv[1]`, which is version-dependent. JSON.stringify
        // also escapes Windows backslashes into valid string literals.
        //
        // The child does not require tests/helpers.js: its `process.on("exit")` backstop would
        // delete the very temporary directory holding the lock.
        const lockRepoPath = path.join(repoRoot, "dist", "storage", "lock-repo.js");
        const script = [
          `const { withCodexLock } = require(${JSON.stringify(lockRepoPath)});`,
          `withCodexLock(${JSON.stringify(lockPath)}, "crash-fixture", () => {`,
          `  process.exit(0);`,
          `});`,
        ].join("\n");

        execFileSync(process.execPath, ["-e", script]);

        assert.ok(fs.existsSync(lockPath), "the crash fixture must strand the lock");
        const stranded = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        assert.equal(typeof stranded.pid, "number");
        assert.equal(stranded.operation, "crash-fixture");

        // The whole point: no manual file deletion is involved.
        const result = await addProvider(toolHomeDir, codexDir, "after-crash");
        assert.equal(result.status, 0, `a stale lock must not block the next write: ${result.stderr}`);
        assert.equal(result.payload.ok, true);
        assert.ok(
          result.payload.warnings.some((warning) => warning.includes("stale codex-switch lock")),
          `expected a takeover warning, got ${JSON.stringify(result.payload.warnings)}`
        );
        assert.equal(fs.existsSync(lockPath), false, "the lock must be released once the mutation finishes");
      },
    },
    {
      name: "releaseLock removes only a record this process owns",
      run() {
        const { acquireLock, releaseLock } = require("../dist/storage/lock-repo.js");
        const toolHomeDir = makeTempDir("codex-switch-lock-");
        const lockPath = lockPathFor(toolHomeDir);

        acquireLock(lockPath, "owned-by-this-process");
        releaseLock(lockPath);
        assert.equal(fs.existsSync(lockPath), false, "a lock this process owns must be removed");

        // Deleting whatever sits at the path is a correctness bug once takeover exists: the
        // process that read a stale record would delete the lock a different process had just
        // claimed, and both would mutate.
        writeLock(lockPath, {
          pid: DEAD_PID,
          operation: "another-process",
          createdAt: new Date().toISOString(),
          hostname: os.hostname(),
        });
        releaseLock(lockPath);
        assert.ok(fs.existsSync(lockPath), "a lock owned by another pid must be left alone");
      },
    },
    {
      name: "unlock is an idempotent success when no lock exists",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();

        // No `--codex-dir`: unlock runs before the Codex directory guard, because the lock lives
        // in the tool home and requiring a target runtime would make the command unusable in the
        // situation it exists for.
        const result = await runJsonCli({ toolHomeDir, args: ["unlock", "--json"] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.ok, true);
        assert.equal(result.payload.data.removed, false);
        assert.equal(result.payload.data.owner, null);
        assert.match(result.payload.data.reason, /no lock file was present/);

        // Running it twice must stay a success rather than turning into an error.
        const again = await runJsonCli({ toolHomeDir, args: ["unlock", "--json"] });
        assert.equal(again.status, 0, again.stderr);
      },
    },
    {
      name: "unlock clears a dead owner without --force and reports what it removed",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const lockPath = lockPathFor(toolHomeDir);

        writeLock(lockPath, {
          pid: DEAD_PID,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: os.hostname(),
        });

        const result = await runJsonCli({ toolHomeDir, args: ["unlock", "--json"] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.data.removed, true);
        assert.equal(result.payload.data.forced, false);
        assert.equal(result.payload.data.owner.pid, DEAD_PID);
        assert.equal(result.payload.data.owner.operation, "switch");
        assert.match(result.payload.data.reason, /dead/);
        assert.equal(fs.existsSync(lockPath), false);
      },
    },
    {
      name: "unlock refuses a live owner without --force and clears it with --force",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const lockPath = lockPathFor(toolHomeDir);

        // This process's own pid is unambiguously alive, so the probe has a live owner to find.
        writeLock(lockPath, {
          pid: process.pid,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: os.hostname(),
        });

        const refused = await runJsonCli({ toolHomeDir, args: ["unlock", "--json"] });
        assert.equal(refused.status, 1);
        assert.equal(refused.payload.error.code, "LOCK_CONFLICT");
        assert.equal(refused.payload.error.details.activePid, process.pid);
        assert.ok(fs.existsSync(lockPath), "a refused unlock must not remove the lock");

        const forced = await runJsonCli({ toolHomeDir, args: ["unlock", "--force", "--json"] });
        assert.equal(forced.status, 0, forced.stderr);
        assert.equal(forced.payload.data.removed, true);
        assert.equal(forced.payload.data.forced, true);
        assert.equal(forced.payload.data.owner.pid, process.pid);
        assert.match(forced.payload.data.reason, /--force/);
        assert.equal(fs.existsSync(lockPath), false);
      },
    },
    {
      name: "an unreadable lock record is recoverable rather than a permanent block",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        const lockPath = lockPathFor(toolHomeDir);

        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        // Torn JSON: what a kill between open and write leaves behind, and the shape P0-5
        // produces most often. Treating it as an unknown owner would restore the permanent
        // lockout this feature exists to remove.
        fs.writeFileSync(lockPath, '{"pid": 4242, "operati', "utf8");

        const result = await addProvider(toolHomeDir, codexDir, "after-truncation");
        assert.equal(result.status, 0, `an unreadable lock must not block writes: ${result.stderr}`);
        assert.ok(
          result.payload.warnings.some((warning) => warning.includes("unreadable codex-switch lock")),
          `expected an unreadable-record warning, got ${JSON.stringify(result.payload.warnings)}`
        );
      },
    },
    {
      name: "a pid that could never have been written is malformed, not live",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const lockPath = lockPathFor(toolHomeDir);

        // process.kill(0, 0) does not throw, so a zero pid would read as alive and block every
        // future write. The writer only ever records `process.pid`, a positive integer, so a
        // zero can only come from a hand edit or corruption — never from a live writer.
        writeLock(lockPath, {
          pid: 0,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: os.hostname(),
        });

        const result = await runJsonCli({ toolHomeDir, args: ["unlock", "--json"] });
        assert.equal(result.status, 0, `pid 0 must not read as a live owner: ${result.stderr}`);
        assert.equal(result.payload.data.removed, true);
        assert.equal(fs.existsSync(lockPath), false);
      },
    },
    {
      name: "a lock written on another host fails closed",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const lockPath = lockPathFor(toolHomeDir);

        // A differently named host cannot be probed here at all, so the pid is meaningless
        // locally and is never trusted in either direction.
        writeLock(lockPath, {
          pid: DEAD_PID,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: "some-other-machine.invalid",
        });

        const refused = await runJsonCli({ toolHomeDir, args: ["unlock", "--json"] });
        assert.equal(refused.status, 1);
        assert.equal(refused.payload.error.code, "LOCK_CONFLICT");
        assert.match(refused.payload.error.details.note, /different host/);
        assert.ok(fs.existsSync(lockPath));

        const forced = await runJsonCli({ toolHomeDir, args: ["unlock", "--force", "--json"] });
        assert.equal(forced.status, 0, forced.stderr);
        assert.equal(forced.payload.data.owner.hostname, "some-other-machine.invalid");
        assert.equal(fs.existsSync(lockPath), false);
      },
    },
    {
      name: "a record without a hostname reads as local, for backward compatibility",
      run() {
        const { inspectLock } = require("../dist/storage/lock-repo.js");
        const toolHomeDir = makeTempDir("codex-switch-lock-");
        const lockPath = lockPathFor(toolHomeDir);

        // Records written before `hostname` existed have no such field. Reading their absence as
        // a foreign machine would strand every pre-existing lock behind `--force`.
        writeLock(lockPath, { pid: DEAD_PID, operation: "switch", createdAt: new Date().toISOString() });
        assert.equal(inspectLock(lockPath).status, "dead");
      },
    },
    {
      name: "a live owner blocks a write and names the escape hatch",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        const lockPath = lockPathFor(toolHomeDir);

        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        writeLock(lockPath, {
          pid: process.pid,
          operation: "switch",
          createdAt: new Date().toISOString(),
          hostname: os.hostname(),
        });

        const result = await addProvider(toolHomeDir, codexDir, "blocked");
        assert.equal(result.status, 1);
        assert.equal(result.payload.error.code, "LOCK_CONFLICT");
        assert.equal(result.payload.error.details.activePid, process.pid);
        assert.equal(result.payload.error.details.requestedOperation, "add");
        assert.equal(result.payload.error.details.activeHost, os.hostname());
        assert.match(result.payload.error.details.remedy, /unlock --force/);
        assert.ok(fs.existsSync(lockPath), "a refused write must leave the lock in place");
      },
    },
  ],
};
