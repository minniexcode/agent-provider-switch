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
        // Every invocation below is narrowed with `--codex`, which is the 1.1.3 replacement for the
        // bare form: a bare `doctor` now covers both targets, and `createSandbox()` creates the
        // Claude root, so the bare form reports Claude findings these Codex assertions know nothing
        // about. Without the flag the issue lines below would also gain a `[codex]` prefix. The
        // two-target case is covered by its own test at the end of this suite.
        const withCodex = { PATH: sandboxPathWithFakeCodex(sandbox) };
        const withoutCodex = { PATH: sandboxPathWithoutCodex(sandbox) };
        const healthy = runOk(sandbox, ["doctor", "--codex", "--json"], { env: withCodex });
        assert.equal(
          healthy.json.data.healthy,
          true,
          `expected a healthy tree, got ${JSON.stringify(healthy.json.data.issues)}`
        );
        assert.deepEqual(healthy.json.data.issues, []);
        // Configured and healthy are separate answers, and both live in the target's section: a
        // registry file is the evidence that Codex has been used here, and it is a reading rather
        // than a boolean so that "no evidence" and "could not tell" stay apart.
        assert.deepEqual(healthy.json.data.codex.configured, { status: "ok", value: true });
        assert.equal(healthy.json.data.claude, undefined, "a narrowed run must carry one target's fields");

        const humanHealthy = runCli(sandbox, ["doctor", "--codex"], { env: withCodex });
        assert.match(humanHealthy.stdout, /^Doctor summary: healthy\. No action required\.$/m);

        const stripped = runOk(sandbox, ["doctor", "--codex", "--json"], { env: withoutCodex });
        assert.deepEqual(stripped.json.data.issues.map((issue) => issue.code), ["CODEX_NOT_INSTALLED"]);

        const humanStripped = runCli(sandbox, ["doctor", "--codex"], { env: withoutCodex });
        assert.match(humanStripped.stdout, /^Doctor summary: 1 issue\(s\) need attention\.$/m);
        assert.match(humanStripped.stdout, /^- CODEX_NOT_INSTALLED: codex CLI is not available on PATH\.$/m);
        assert.match(humanStripped.stdout, /^  next step: inspect the issue details/m);

        // A registry with no runtime configuration is a *prepared* target, not a broken one. The
        // findings this used to assert — a missing `config.toml`, and a missing top-level selector —
        // were retired with the activation gate: the second was `MODEL_PROVIDER_MISSING`, which told
        // a user who had never switched anything that their Codex setup needed repair. The probe is
        // not run either, so a host without the Codex CLI is not faulted for a target that is not
        // activated.
        const prepared = createSandbox();
        writeJson(path.join(prepared.home, "providers.json"), {
          providers: {
            freemodel: {
              profile: "freemodel",
              apiKey: "sk-freemodel",
              baseUrl: "https://freemodel.example/v1",
              model: "gpt-5-mini",
            },
          },
        });
        const preparedResult = runOk(prepared, ["doctor", "--codex", "--json"], { env: withoutCodex });
        assert.deepEqual(preparedResult.json.data.issues, []);
        assert.equal(preparedResult.json.data.healthy, true);
        assert.deepEqual(preparedResult.json.data.codex.activation, { status: "ok", value: "not-activated" });
        assert.deepEqual(preparedResult.json.data.codex.configured, { status: "ok", value: true });

        // The same state reached from the other side: a `config.toml` that exists and carries no
        // top-level selector. It is `not-activated` too, and its absent model, its unlinked profile,
        // and the missing CLI are all facts about a target nobody has pointed this tool at.
        const unselected = createSandbox();
        writeJson(path.join(unselected.home, "providers.json"), {
          providers: {
            freemodel: {
              profile: "freemodel",
              apiKey: "sk-freemodel",
              baseUrl: "https://freemodel.example/v1",
              model: "gpt-5-mini",
            },
          },
        });
        fs.writeFileSync(
          path.join(unselected.codex, "config.toml"),
          'model = "gpt-5-mini"\n\n[model_providers.freemodel]\nbase_url = "https://freemodel.example/v1"\n',
          "utf8"
        );
        const unselectedResult = runOk(unselected, ["doctor", "--codex", "--json"], { env: withoutCodex });
        assert.deepEqual(unselectedResult.json.data.issues, []);
        assert.deepEqual(unselectedResult.json.data.codex.matching, {
          status: "ok",
          value: { state: "not-activated", activeProvider: null, candidates: [] },
        });

        // Drift is what a hand-edit of config.toml produces: the projection moves and the registry
        // does not. Rewriting the section is the only way to reach it, since every managed write
        // keeps the two in step.
        const drifted = createSandbox();
        writeCleanCodex(drifted);
        addProvider(drifted, "freemodel");
        // The projection moves and the registry does not, which is what the section being
        // hand-edited afterwards looks like.
        writeCleanCodex(drifted, "https://somewhere-else.example/v1");

        const drift = runOk(drifted, ["doctor", "--codex", "--json"], { env: withoutCodex });
        assert.ok(
          drift.json.data.issues.some((issue) => issue.code === "PROVIDER_BASE_URL_MISMATCH"),
          `expected a projection mismatch, got ${JSON.stringify(drift.json.data.issues.map((issue) => issue.code))}`
        );
        const driftHuman = runCli(drifted, ["doctor", "--codex"], { env: withoutCodex });
        assert.match(driftHuman.stdout, /^  next step: rerun `aps edit <provider> --base-url <url>`/m);

        // The lock arms of the same switch. The lock is the one target-neutral reading, so it is
        // inspected once outside the target collectors under any scope — never once per target.
        writeLock(drifted, { pid: DEAD_PID, operation: "switch", createdAt: new Date().toISOString() });
        const stale = runOk(drifted, ["doctor", "--codex", "--json"], { env: withoutCodex });
        // A dead owner is recoverable, so the reading says `abnormal` and the finding carries the
        // repair. The reading is `ok` because the lock was successfully inspected: the state is
        // known, which is a different question from whether it is a fault.
        assert.deepEqual(stale.json.data.shared.lock, { status: "ok", value: "abnormal" });
        assert.ok(stale.json.data.issues.some((issue) => issue.code === "LOCK_STALE"));

        const staleHuman = runCli(drifted, ["doctor", "--codex"], { env: withoutCodex });
        assert.match(staleHuman.stdout, /^  shared lock: abnormal$/m);
        assert.match(staleHuman.stdout, /^  next step: the next write command clears it automatically, or run `aps unlock`$/m);

        // A lock held by a running operation is the case the old `LOCK_OCCUPIED` finding got wrong:
        // every write command fails while it is present, so turning it into a fault meant a
        // background `aps` run could make `doctor` call the install broken. It is now a state, and
        // the human line says so without a next step to act on.
        writeLock(drifted, { pid: process.pid, operation: "switch", createdAt: new Date().toISOString() });
        const occupied = runOk(drifted, ["doctor", "--codex", "--json"], { env: withoutCodex });
        assert.deepEqual(occupied.json.data.shared.lock, { status: "ok", value: "busy" });
        assert.equal(
          occupied.json.data.issues.some((issue) => issue.code.startsWith("LOCK_")),
          false,
          `a live lock must not be a finding: ${JSON.stringify(occupied.json.data.issues.map((issue) => issue.code))}`
        );

        const occupiedHuman = runCli(drifted, ["doctor", "--codex"], { env: withoutCodex });
        assert.match(occupiedHuman.stdout, /^  shared lock: busy$/m);
        assert.doesNotMatch(occupiedHuman.stdout, /LOCK_OCCUPIED/);

        // Legacy wiring shares one next step across all three of its codes.
        const legacy = createSandbox();
        seedCodex(legacy, { modelProvider: "freemodel", legacyProfile: "freemodel" });
        addProvider(legacy, "freemodel");
        const legacyHuman = runCli(legacy, ["doctor", "--codex"], { env: withoutCodex });
        assert.match(legacyHuman.stdout, /^- LEGACY_PROFILE_SELECTOR: /m);
        assert.match(legacyHuman.stdout, /^  next step: rerun `aps switch <provider>` to project/m);
      },
    },
    {
      name: "the bare doctor covers both targets, and still refuses the pair and the narrowing contradiction",
      run() {
        const sandbox = createSandbox();
        writeCleanCodex(sandbox);
        addProvider(sandbox, "freemodel");
        const withoutCodex = { PATH: sandboxPathWithoutCodex(sandbox) };

        // Both targets in scope, so a consumer gets one report per run. The Codex findings come from
        // the probe and the Claude ones from the runtime directory `createSandbox()` created, which
        // has neither a registry nor a settings file in it.
        const bare = runOk(sandbox, ["doctor", "--json"], { env: withoutCodex });
        assert.deepEqual(bare.json.targets, ["codex", "claude"]);
        assert.equal(bare.json.target, null);
        // Each target answers the evidence question in its own section, and the Claude root the
        // sandbox created is empty: a directory is not evidence, so the answer is `false` rather
        // than an unmanaged machine being mistaken for a configured one.
        assert.deepEqual(bare.json.data.codex.configured, { status: "ok", value: true });
        assert.deepEqual(bare.json.data.claude.configured, { status: "ok", value: false });

        const issues = bare.json.data.issues;
        for (const issue of issues) {
          assert.ok("target" in issue, `an issue must name a target: ${issue.code}`);
        }
        assert.deepEqual(
          issues.filter((issue) => issue.target === "codex").map((issue) => issue.code),
          ["CODEX_NOT_INSTALLED"]
        );
        // An empty Claude root raises nothing. A missing registry is a determinate zero records and
        // a missing `settings.json` is not-activated; neither is a fault, so the findings that used
        // to be raised here — `PROVIDERS_NOT_FOUND`, `CLAUDE_SETTINGS_NOT_FOUND` — are gone.
        assert.deepEqual(
          issues.filter((issue) => issue.target === "claude").map((issue) => issue.code),
          []
        );

        // Two prefixes rather than one, because a bare issue line comes from either check set and a
        // reader who cannot tell them apart cannot tell what to fix. `[codex]` is not printed on a
        // narrowed run, where there is nothing to disambiguate.
        const human = runCli(sandbox, ["doctor"], { env: withoutCodex });
        assert.match(human.stdout, /^Doctor summary: 1 issue\(s\) need attention\.$/m);
        assert.match(human.stdout, /^- \[codex\] CODEX_NOT_INSTALLED: /m);
        assert.doesNotMatch(human.stdout, /\[claude\]/, "an empty Claude root has no findings to label");

        // The pair is a refusal rather than a two-target report, whichever spelling asks for it.
        const pair = runFail(sandbox, ["doctor", "--claude", "--codex", "--json"]);
        assert.equal(pair.json.error.code, "INVALID_ARGUMENT");
        assert.match(pair.json.error.message, /cannot be combined/);
        assert.deepEqual(pair.json.targets, []);

        // And a `--codex-dir` under `--claude` is refused rather than dropped: the directory is part
        // of what the command would otherwise report, and naming one contradicts the narrowing.
        const contradictory = runFail(sandbox, ["doctor", "--claude", "--codex-dir", sandbox.codex, "--json"]);
        assert.equal(contradictory.json.error.code, "INVALID_ARGUMENT");
        assert.match(contradictory.json.error.message, /--codex-dir does not apply/);
      },
    },
    {
      name: "a Claude-only machine has no Codex findings to report",
      run() {
        const sandbox = createSandbox();
        // A registry and a settings file for Claude, and nothing at all for Codex: the runtime
        // directory exists but holds no config.toml, which is what every sandbox looks like.
        const file = path.join(sandbox.root, "claude-settings.json");
        writeJson(file, { model: "claude-sonnet-5", env: { ANTHROPIC_BASE_URL: "https://claude.example" } });
        runOk(sandbox, ["add", "--claude", "alpha", "--from-file", file, "--json"]);
        runOk(sandbox, ["switch", "--claude", "alpha", "--json"]);

        // The narrow form is the Claude-only machine's view of `doctor`: the Codex probe is not run
        // at all, so a host without the Codex CLI is not told it has a Codex problem.
        const withoutCodex = { PATH: sandboxPathWithoutCodex(sandbox) };
        const claude = runOk(sandbox, ["doctor", "--claude", "--json"], { env: withoutCodex });
        assert.deepEqual(claude.json.targets, ["claude"]);
        assert.deepEqual(claude.json.data.issues, []);
        assert.equal(claude.json.data.healthy, true);
        assert.deepEqual(claude.json.data.claude.configured, { status: "ok", value: true });
        // The active provider is the `managed` match rather than a field beside it, so the identity
        // question has one answer and no second copy to disagree with.
        assert.deepEqual(claude.json.data.claude.matching, {
          status: "ok",
          value: {
            state: "managed",
            activeProvider: "alpha",
            candidates: [{ name: "alpha", consistent: true, differencePaths: [] }],
          },
        });

        const human = runCli(sandbox, ["doctor", "--claude"], { env: withoutCodex });
        assert.match(human.stdout, /^Doctor summary: healthy\. No action required\.$/m);
      },
    },
  ],
};
