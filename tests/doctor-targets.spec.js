"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  makeTempDir,
  makeToolHomeWithManagedState,
  withClaudeEnv,
  runJsonCli,
} = require("./helpers");
const { resolveLockPath } = require("../dist/storage/codex-paths.js");
const { setCodexSpawnImplementation, resetCodexSpawnImplementation } = require("../dist/runtime/codex-cli.js");

/**
 * A Codex directory that does not exist, named through `--codex-dir`.
 *
 * `runBuiltCli()` points `APS_CODEX_DIR` at a temporary directory it creates, and a directory that
 * exists is not evidence of anything — but a *node* that does not exist is the cleanest way to say
 * "no runtime artifacts here" without relying on the helper's choice of path.
 */
function absentCodexDir() {
  return path.join(makeTempDir("agent-provider-switch-absent-codex-"), "nested", "codex");
}

/**
 * Runs `callback` with the Codex CLI probe answered by a stand-in instead of the host's PATH.
 *
 * The probe shells out, so a unit spec that asserts an *activated* Codex report would otherwise
 * pass on a developer machine with the real CLI installed and fail on a CI runner without it. The
 * answer is injected through the module's own seam rather than by rewriting `PATH`, which keeps the
 * child-process question out of an in-process suite.
 *
 * The recorded calls are handed to the callback: "the probe did not run" is an assertion several of
 * these tests need to make, and it is only observable from inside the stand-in.
 */
async function withCodexProbe(answer, run) {
  const calls = [];
  setCodexSpawnImplementation((command, args) => {
    calls.push([command, ...args]);
    if (answer === "supported") {
      return { error: undefined, status: 0, stdout: "codex-cli 0.200.0\n", stderr: "" };
    }
    return {
      error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
      status: null,
      stdout: "",
      stderr: "",
    };
  });

  try {
    return await run(calls);
  } finally {
    resetCodexSpawnImplementation();
  }
}

/**
 * Writes a live Claude settings.json, creating the directory when the fixture did not.
 */
function writeClaudeSettings(claudeDir, text) {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), text, "utf8");
}

/**
 * Writes a `claude-providers.json` by hand, which is the only way to state a damaged registry.
 */
function writeRegistry(toolHomeDir, fileName, contents) {
  fs.writeFileSync(path.join(toolHomeDir, fileName), contents, "utf8");
}

/**
 * The value inside a report reading.
 */
function valueOf(reading) {
  return reading && reading.status === "ok" ? reading.value : undefined;
}

/**
 * Every issue a `doctor` payload carries, so a caller can filter rather than index.
 */
function issuesOf(payload) {
  return payload.data.issues ?? [];
}

/**
 * Every note, which is the other list: findings worth printing that are not faults.
 */
function notesOf(payload) {
  return payload.data.notes ?? [];
}

/**
 * One `[code, target]` pair per issue, the shape most of these assertions are about.
 */
function issuePairs(payload) {
  return issuesOf(payload).map((issue) => [issue.code, issue.target]);
}

module.exports = {
  name: "doctor targets",
  tests: [
    {
      name: "an unconfigured target contributes no issue, and does not make the run unhealthy",
      run() {
        // Both targets unconfigured: an empty tool home, no Codex directory, no Claude directory —
        // and a Codex CLI probe that would answer "supported" if it ran at all. The two assertions
        // that matter are the empty issue list and the untouched probe: a machine with no Codex CLI
        // must not be told it has a Codex problem, and a machine that has never been pointed at
        // either target must not be told anything at all.
        return withCodexProbe("supported", (calls) =>
          runJsonCli({
            toolHomeDir: makeTempDir("agent-provider-switch-empty-home-"),
            args: ["doctor", "--json", "--codex-dir", absentCodexDir()],
          }).then((result) => {
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(result.payload.targets, ["codex", "claude"]);
            assert.equal(result.payload.target, null);
            assert.deepEqual(issuesOf(result.payload), []);
            assert.deepEqual(notesOf(result.payload), []);
            assert.equal(result.payload.data.healthy, true);
            assert.equal(result.payload.data.complete, true);

            // In scope and unconfigured, so the payload says so rather than omitting the section.
            // Absence is a fact the report states, not a gap it leaves.
            assert.deepEqual(result.payload.data.codex.configured, { status: "ok", value: false });
            assert.deepEqual(result.payload.data.claude.configured, { status: "ok", value: false });
            assert.deepEqual(result.payload.data.codex.providerCount, { status: "ok", value: 0 });
            assert.deepEqual(result.payload.data.claude.providerCount, { status: "ok", value: 0 });

            // The shared readings are published once, outside the target sections: the lock belongs
            // to neither target, and a per-target copy would make the count depend on the scope.
            assert.deepEqual(result.payload.data.shared.toolConfig, { status: "ok", value: { defaultsPresent: false } });
            assert.deepEqual(result.payload.data.shared.lock, { status: "ok", value: "free" });

            assert.deepEqual(calls, [], "an unconfigured Codex target must not be probed");
          })
        );
      },
    },
    {
      name: "configuration evidence is a file, never a directory",
      async run() {
        // The rule this release changed. A target directory that exists and is empty used to read as
        // "this target has been used", so a user who had created `~/.claude` for their own reasons
        // was told the tool had configured it. Evidence is a registry file, a runtime file, or a
        // defaults block; a directory is where those would go, not a statement that they are there.
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          fs.mkdirSync(claudeDir, { recursive: true });

          const empty = await runJsonCli({
            toolHomeDir,
            args: ["doctor", "--json", "--codex-dir", absentCodexDir()],
          });
          assert.equal(empty.status, 0, empty.stderr);
          const emptyClaude = empty.payload.data.claude;
          assert.deepEqual(emptyClaude.configured, { status: "ok", value: false }, "an empty directory is not evidence");
          assert.deepEqual(emptyClaude.live, { status: "absent" });
          assert.deepEqual(emptyClaude.activation, { status: "ok", value: "not-activated" });

          // Codex is the other half: the fixture tool home holds an empty `providers.json`, so it
          // *is* evidence — an empty registry is a file, and emptiness alone is not a fault.
          const codex = empty.payload.data.codex;
          assert.deepEqual(codex.configured, { status: "ok", value: true });
          assert.deepEqual(codex.registry, { status: "ok", value: { providerCount: 0 } });
          assert.deepEqual(issuesOf(empty.payload), []);
          assert.equal(empty.payload.data.healthy, true);

          // Now the file arrives, and with it the evidence. No registry is involved: `settings.json`
          // on its own is proof this target has been used here, and valid settings no stored record
          // claims are *unmanaged* — a state, not a fault.
          writeClaudeSettings(claudeDir, "{}\n");
          const withFile = await runJsonCli({
            toolHomeDir,
            args: ["doctor", "--json", "--codex-dir", absentCodexDir()],
          });
          assert.equal(withFile.status, 0, withFile.stderr);
          const claude = withFile.payload.data.claude;
          assert.deepEqual(claude.configured, { status: "ok", value: true });
          assert.deepEqual(claude.activation, { status: "ok", value: "activated" });
          assert.deepEqual(claude.matching, {
            status: "ok",
            value: { state: "unmanaged", activeProvider: null, candidates: [] },
          });
          assert.deepEqual(issuesOf(withFile.payload), []);
          assert.equal(withFile.payload.data.healthy, true);
        });
      },
    },
    {
      name: "a prepared Codex target is configured, not activated, and owes nothing",
      run() {
        // The registry/defaults-only case. Something has been prepared for Codex and nothing has been
        // switched, so the Codex runtime is absent — and absent runtime configuration is what
        // "not activated" *means*, not a missing piece of a broken install. This is the case that
        // used to report `CONFIG_NOT_FOUND` on every machine that had added a provider and not yet
        // used it.
        return withCodexProbe("supported", (calls) =>
          runJsonCli({
            toolHomeDir: makeToolHomeWithManagedState(),
            args: ["doctor", "--json", "--codex-dir", absentCodexDir()],
          }).then((result) => {
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(issuesOf(result.payload), [], "a prepared target has nothing wrong with it");

            const codex = result.payload.data.codex;
            assert.deepEqual(codex.configured, { status: "ok", value: true });
            assert.deepEqual(codex.registry, { status: "ok", value: { providerCount: 0 } });
            assert.deepEqual(codex.live, { status: "absent" });
            assert.deepEqual(codex.activation, { status: "ok", value: "not-activated" });
            assert.deepEqual(codex.matching, {
              status: "ok",
              value: { state: "not-activated", activeProvider: null, candidates: [] },
            });

            // Every reading resolved, so the report is complete as well as healthy — the distinction
            // between "nothing is wrong" and "nothing could be looked at".
            assert.equal(result.payload.data.complete, true);
            assert.equal(result.payload.data.healthy, true);
            assert.deepEqual(calls, [], "runtime prerequisites belong to an activated target");
          })
        );
      },
    },
    {
      name: "an activated Codex target with no registry is unmanaged, and still healthy",
      run() {
        // The other direction of the same rule, and the one that proves the probe gate is about
        // activation rather than about the registry: this target has a live `config.toml` with a
        // selector and no `providers.json` at all. Its live route is unmanaged — a state — and the
        // runtime prerequisites do apply, so the CLI is probed and found.
        const codexDir = makeTempDir("agent-provider-switch-codex-");
        fs.writeFileSync(
          path.join(codexDir, "config.toml"),
          `model = "gpt-5"\nmodel_provider = "packycode"\n\n[model_providers.packycode]\nbase_url = "https://relay.example.com/v1"\n`,
          "utf8"
        );

        return withCodexProbe("supported", (calls) =>
          runJsonCli({
            toolHomeDir: makeTempDir("agent-provider-switch-empty-home-"),
            args: ["doctor", "--json", "--codex", "--codex-dir", codexDir],
          }).then((result) => {
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(issuesOf(result.payload), []);
            assert.equal(result.payload.data.healthy, true);
            assert.ok(calls.length > 0, "an activated Codex target is probed");

            const codex = result.payload.data.codex;
            assert.deepEqual(codex.registry, { status: "absent" });
            assert.deepEqual(codex.activation, { status: "ok", value: "activated" });
            assert.deepEqual(valueOf(codex.matching), {
              state: "unmanaged",
              activeProvider: null,
              candidates: [],
            });
            // The count is still a successful zero: the registry is known to be absent, which is a
            // different statement from a registry that could not be read.
            assert.deepEqual(codex.providerCount, { status: "ok", value: 0 });
          })
        );
      },
    },
    {
      name: "an out-of-scope target reads nothing at all, so a narrower run cannot trip on it",
      async run() {
        // One tool home, two runs that differ only in the narrowing, and a Codex registry that
        // cannot be parsed: the Codex finding the bare run reports is exactly the finding the
        // Claude-only run drops. That is what makes this "the Codex arm does not run" rather than
        // "the Codex state happened to be clean".
        const toolHomeDir = makeToolHomeWithManagedState();
        writeRegistry(toolHomeDir, "providers.json", `${JSON.stringify({ providers: [] }, null, 2)}\n`);

        const bare = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--codex-dir", absentCodexDir()] });
        assert.equal(bare.status, 0, bare.stderr);
        assert.deepEqual(issuePairs(bare.payload), [["PROVIDERS_PARSE_ERROR", "codex"]]);
        assert.equal(bare.payload.data.healthy, false);
        assert.equal(bare.payload.data.complete, false);

        const narrowed = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--claude"] });
        assert.equal(narrowed.status, 0, narrowed.stderr);
        assert.deepEqual(narrowed.payload.targets, ["claude"]);
        assert.deepEqual(issuesOf(narrowed.payload), []);
        assert.equal(narrowed.payload.data.healthy, true);

        // The Codex section is dropped rather than blanked: `targets` says what was asked about,
        // and a section left in place with empty readings would read as a target that was consulted
        // and found empty.
        assert.equal(narrowed.payload.data.codex, undefined);
      },
    },
    {
      name: "every issue names the target it is about, and a bare run covers both",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        // Damaged content on both sides, and damage is the one thing both targets can be faulted
        // for on a machine with no live configuration: an unparseable registry is content that was
        // obtained and could not be used, which is not the same statement as a file that is not
        // there.
        writeRegistry(toolHomeDir, "providers.json", `${JSON.stringify({ providers: [] }, null, 2)}\n`);
        writeRegistry(toolHomeDir, "claude-providers.json", `${JSON.stringify({ providers: [] }, null, 2)}\n`);

        const result = await runJsonCli({
          toolHomeDir,
          args: ["doctor", "--json", "--codex-dir", absentCodexDir()],
        });
        assert.equal(result.status, 0, result.stderr);

        const issues = issuesOf(result.payload);
        assert.deepEqual(issuePairs(result.payload), [
          ["PROVIDERS_PARSE_ERROR", "codex"],
          ["PROVIDERS_PARSE_ERROR", "claude"],
        ]);
        for (const issue of issues) {
          assert.ok(
            issue.target === "codex" || issue.target === "claude" || issue.target === null,
            `unexpected target on ${issue.code}: ${issue.target}`
          );
          assert.equal(typeof issue.message, "string");
          assert.equal(typeof issue.path, "string", "a content fault names the file it is about");
        }

        // One code, two targets, and the envelopes stay distinguishable: the section says whose,
        // and the fault is local to it.
        assert.deepEqual(result.payload.data.codex.registry.status, "invalid");
        assert.deepEqual(result.payload.data.claude.registry.status, "invalid");
        assert.equal(result.payload.data.healthy, false);
        assert.equal(result.payload.data.complete, false);
      },
    },
    {
      name: "a live lock is a busy state, and a stale one is the shared issue",
      async run() {
        const toolHomeDir = makeTempDir("agent-provider-switch-locked-home-");
        const lockPath = resolveLockPath(toolHomeDir);
        const args = ["doctor", "--json", "--codex-dir", absentCodexDir()];

        // A record another *machine* wrote, which is the case this process has no standing to call
        // stale. It is a live owner seen from here, so it is busy.
        fs.writeFileSync(
          lockPath,
          `${JSON.stringify(
            { pid: process.pid, operation: "switch", createdAt: new Date().toISOString(), hostname: "elsewhere" },
            null,
            2
          )}\n`,
          "utf8"
        );
        const busy = await runJsonCli({ toolHomeDir, args });
        assert.equal(busy.status, 0, busy.stderr);
        assert.deepEqual(busy.payload.data.shared.lock, { status: "ok", value: "busy" });
        assert.deepEqual(
          issuesOf(busy.payload),
          [],
          "a normal lock owner is a state, not a fault — a background operation must not fail doctor"
        );
        assert.equal(busy.payload.data.healthy, true);

        // A record no live process can own. Written by hand rather than by racing a real operation,
        // because the finding is about the record, and a pid of `0` is the deterministic way to say
        // "gone": probing a plausible-looking pid would make this depend on whether the host happens
        // to have recycled that number onto a running process.
        fs.writeFileSync(
          lockPath,
          `${JSON.stringify({ pid: 0, operation: "switch", createdAt: new Date(0).toISOString() }, null, 2)}\n`,
          "utf8"
        );
        const both = await runJsonCli({ toolHomeDir, args });
        assert.equal(both.status, 0, both.stderr);
        assert.deepEqual(both.payload.data.shared.lock, { status: "ok", value: "abnormal" });

        const lockIssues = issuesOf(both.payload).filter((issue) => issue.target === null);
        assert.deepEqual(lockIssues.map((issue) => issue.code), ["LOCK_STALE"]);
        assert.equal(lockIssues[0].path, lockPath);
        assert.match(String(lockIssues[0].remedy), /aps unlock/);
        assert.equal(both.payload.data.healthy, false);

        // Once, not once per target: `both` puts two targets in scope and the count must not depend
        // on that, so the same finding appears under the other narrowing and under a bare run. The
        // Claude-only form cannot carry `--codex-dir`, which the flag guards refuse on that scope.
        for (const narrowed of [["doctor", "--json", "--claude"], args]) {
          const result = await runJsonCli({ toolHomeDir, args: narrowed });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(
            issuesOf(result.payload).map((issue) => issue.code),
            ["LOCK_STALE"],
            `the same single finding under ${narrowed.join(" ")}`
          );
        }
      },
    },
    {
      name: "an activated Codex target is checked, and the CLI is a finding when it is missing",
      async run() {
        // The complement of the gate: once a target is activated, the runtime prerequisites do
        // apply, and a missing CLI is a real fault — the tool has been pointed at Codex and can no
        // longer reach it. The `config.toml` here is written to be clean and activated, so the only
        // thing that can be reported is the probe's own answer.
        const codexDir = makeTempDir("agent-provider-switch-codex-");
        fs.writeFileSync(
          path.join(codexDir, "config.toml"),
          `model = "gpt-5"\nmodel_provider = "packycode"\n\n[model_providers.packycode]\nbase_url = "https://relay.example.com/v1"\n`,
          "utf8"
        );

        await withCodexProbe("missing", async () => {
          const result = await runJsonCli({
            toolHomeDir: makeToolHomeWithManagedState(),
            args: ["doctor", "--json", "--codex", "--codex-dir", codexDir],
          });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(issuePairs(result.payload), [["CODEX_NOT_INSTALLED", "codex"]]);
          assert.equal(result.payload.data.healthy, false);

          // The Claude-only scope never reaches the probe even for the same installation.
          const claudeOnly = await runJsonCli({
            toolHomeDir: makeToolHomeWithManagedState(),
            args: ["doctor", "--json", "--claude"],
          });
          assert.deepEqual(issuesOf(claudeOnly.payload), []);
          assert.equal(claudeOnly.payload.data.healthy, true);
        });
      },
    },
    {
      name: "notes are not faults, and the lock is inspected once under every scope",
      async run() {
        // A note is worth printing and is not what `healthy` reads, so a report that carries one is
        // still healthy and still complete. The Claude-only scope proves the shared sections are
        // composed from the scope rather than from the target that happened to be selected.
        await withClaudeEnv({}, async ({ toolHomeDir }) => {
          const result = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--claude"] });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(notesOf(result.payload), []);
          assert.deepEqual(result.payload.data.shared.lock, { status: "ok", value: "free" });
          assert.equal(result.payload.data.codex, undefined);
          // The Claude section reports the paths it read even though neither file is there, which is
          // what makes the next command the user runs a knowable one.
          const paths = valueOf(result.payload.data.claude.paths);
          assert.ok(paths.claudeDir.endsWith("claude"));
          assert.ok(paths.claudeSettingsPath.endsWith("settings.json"));
        });
      },
    },
    {
      name: "the two target flags are refused on doctor, and --codex-dir with --claude is refused",
      async run() {
        const pair = await runJsonCli({ args: ["doctor", "--claude", "--codex", "--json"] });
        assert.equal(pair.status, 1);
        assert.equal(pair.payload.error.code, "INVALID_ARGUMENT");
        assert.match(pair.payload.error.message, /cannot be combined/);
        assert.deepEqual(pair.payload.targets, []);

        // The narrowing contradiction: `--codex-dir` names part of what `--claude` just excluded.
        // Refused rather than ignored, which is the whole doctrine behind the flag guards — a
        // `--codex-dir` that is silently dropped is a caller who believes a directory was consulted.
        const narrowed = await runJsonCli({
          args: ["doctor", "--claude", "--codex-dir", absentCodexDir(), "--json"],
        });
        assert.equal(narrowed.status, 1);
        assert.equal(narrowed.payload.error.code, "INVALID_ARGUMENT");
        assert.match(narrowed.payload.error.message, /--codex-dir does not apply when --claude narrows it to Claude/);

        // The refusal is raised by the flags rather than by a handler, so nothing was resolved and
        // the envelope says `[]` — not `["claude"]`, which would claim the command had a target it
        // never got as far as choosing. The key is present either way, which is what a consumer
        // reads to tell "no target" from "a build that predates the field".
        assert.deepEqual(narrowed.payload.targets, []);
        assert.equal(narrowed.payload.target, null);
      },
    },
  ],
};
