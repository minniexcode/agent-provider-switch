"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  makeCodexFixture,
  makeToolHomeWithManagedState,
  runBuiltCli,
  runJsonCli,
} = require("./helpers");

function writeProviders(toolHomeDir, providers) {
  fs.writeFileSync(path.join(toolHomeDir, "providers.json"), `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

module.exports = {
  name: "provider-management workflow",
  tests: [
    {
      name: "init add switch status doctor works through json envelope",
      async run() {
        const codexDir = makeCodexFixture();
        const toolHomeDir = makeToolHomeWithManagedState();

        let result = await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });
        assert.equal(result.payload.ok, true);
        assert.equal(result.payload.command, "init");

        result = await runJsonCli({
          toolHomeDir,
          args: [
            "add",
            "gamma",
            "--profile",
            "gamma",
            "--model",
            "gpt-5-mini",
            "--api-key",
            "sk-gamma",
            "--base-url",
            "https://gamma.example/v1",
            "--json",
            "--codex-dir",
            codexDir,
          ],
        });
        assert.equal(result.payload.ok, true);
        assert.equal(result.payload.data.provider, "gamma");
        assert.equal(result.payload.data.modelProvider, "gamma");

        result = await runJsonCli({ toolHomeDir, args: ["switch", "gamma", "--json", "--codex-dir", codexDir] });
        assert.equal(result.payload.ok, true);
        assert.equal(result.payload.data.provider, "gamma");

        result = await runJsonCli({ toolHomeDir, args: ["status", "--json", "--codex-dir", codexDir] });
        assert.equal(result.payload.ok, true);
        assert.equal(result.payload.data.provider, "gamma");
        assert.equal(result.payload.data.currentModelProvider, "gamma");
        assert.equal(result.payload.data.auth.valid, true);

        result = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--codex-dir", codexDir] });
        assert.equal(result.payload.ok, true);
        assert.equal(result.payload.command, "doctor");
        assert.ok(Array.isArray(result.payload.data.issues));
      },
    },
    {
      name: "list human output omits provider type and reports ambiguous active provider",
      async run() {
        // The top-level selector is what makes the active provider resolvable at all; without it
        // the renderer never reaches the ambiguity branch this test is about.
        const codexDir = makeCodexFixture({ modelProvider: "freemodel" });
        const toolHomeDir = makeToolHomeWithManagedState();
        writeProviders(toolHomeDir, {
          first: { profile: "freemodel", apiKey: "sk-first", baseUrl: "https://free.example/v1", model: "gpt-5.4" },
          second: { profile: "freemodel", apiKey: "sk-second", baseUrl: "https://free.example/v1", model: "gpt-5.4" },
        });

        const result = await runBuiltCli({ toolHomeDir, args: ["list", "--codex-dir", codexDir] });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /Current provider: ambiguous \(first, second\)/);
        assert.match(result.stdout, /first -> freemodel/);
        assert.doesNotMatch(result.stdout, /\[(direct|copilot)\]/i);
      },
    },
    {
      name: "doctor reports baseUrl drift as provider projection drift",
      async run() {
        // The fixture's `[model_providers.freemodel]` carries the generator's default base URL, so
        // the seeded provider below differs from it and the drift is what the test observes.
        const codexDir = makeCodexFixture({ modelProvider: "freemodel" });
        const toolHomeDir = makeToolHomeWithManagedState();
        writeProviders(toolHomeDir, {
          freemodel: { profile: "freemodel", apiKey: "sk-free", baseUrl: "https://drift.example/v1", model: "gpt-5.4" },
        });

        const result = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--codex-dir", codexDir] });
        assert.equal(result.payload.ok, true);
        assert.ok(result.payload.data.issues.some((issue) => issue.code === "PROVIDER_BASE_URL_MISMATCH"));
      },
    },
    {
      name: "doctor distinguishes a stale lock from a live one and stays quiet when there is none",
      async run() {
        const codexDir = makeCodexFixture({ modelProvider: "freemodel" });
        const toolHomeDir = makeToolHomeWithManagedState();
        writeProviders(toolHomeDir, {
          freemodel: { profile: "freemodel", apiKey: "sk-free", baseUrl: "https://free.example/v1", model: "gpt-5.4" },
        });
        const lockPath = path.join(toolHomeDir, ".aps.lock");
        const writeLock = (pid) =>
          fs.writeFileSync(
            lockPath,
            `${JSON.stringify({ pid, operation: "switch", createdAt: new Date().toISOString(), hostname: os.hostname() }, null, 2)}\n`,
            "utf8"
          );

        const issueCodes = (payload) => payload.data.issues.map((issue) => issue.code);

        // A dead owner is recoverable, so it is reported as stale: the next write clears it.
        writeLock(999999999);
        let result = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--codex-dir", codexDir] });
        let issue = result.payload.data.issues.find((entry) => entry.code === "LOCK_STALE");
        assert.ok(issue, `expected LOCK_STALE, got ${JSON.stringify(issueCodes(result.payload))}`);
        assert.equal(issue.activeOperation, "switch");
        assert.equal(issue.lockStatus, "dead");
        assert.match(issue.remedy, /codexs unlock/);

        // A live owner is not recoverable. Every write command fails while it is present, which
        // is why doctor has to surface it rather than leaving the user to hit the error blind.
        writeLock(process.pid);
        result = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--codex-dir", codexDir] });
        issue = result.payload.data.issues.find((entry) => entry.code === "LOCK_OCCUPIED");
        assert.ok(issue, `expected LOCK_OCCUPIED, got ${JSON.stringify(issueCodes(result.payload))}`);
        assert.equal(issue.activePid, process.pid);
        assert.equal(issue.lockStatus, "live");
        assert.match(issue.remedy, /unlock --force/);

        // Reporting "absent" as a finding would make every healthy run look like it had
        // something to fix.
        fs.rmSync(lockPath, { force: true });
        result = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--codex-dir", codexDir] });
        assert.equal(
          issueCodes(result.payload).some((code) => code === "LOCK_STALE" || code === "LOCK_OCCUPIED"),
          false
        );
      },
    },
    {
      name: "switch rewrites a trailing legacy profile line without truncating the projection",
      async run() {
        // A trailing root-level `profile` line is removed at the same boundary where the new
        // top-level keys are inserted. When those two ranges overlapped, the deletion consumed the
        // first character of the inserted text, so `model_provider` landed as `odel_provider` and
        // the active provider could no longer be resolved.
        const codexDir = makeCodexFixture({ legacyProfile: "packycode" });
        const toolHomeDir = makeToolHomeWithManagedState();

        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });
        await runJsonCli({
          toolHomeDir,
          args: [
            "add",
            "gamma",
            "--profile",
            "gamma",
            "--model",
            "gpt-5-mini",
            "--api-key",
            "sk-gamma",
            "--base-url",
            "https://gamma.example/v1",
            "--json",
            "--codex-dir",
            codexDir,
          ],
        });

        const switched = await runJsonCli({ toolHomeDir, args: ["switch", "gamma", "--json", "--codex-dir", codexDir] });
        assert.equal(switched.payload.ok, true);

        const status = await runJsonCli({ toolHomeDir, args: ["status", "--json", "--codex-dir", codexDir] });
        assert.equal(status.payload.data.currentModelProvider, "gamma");

        const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
        assert.match(config, /^model_provider = "gamma"$/m);
        assert.doesNotMatch(config, /^odel_provider/m, "inserted key must not be truncated");
        assert.doesNotMatch(config, /^profile = /m, "the legacy selector must be removed");
      },
    },
    {
      name: "setup remains deprecated pointer",
      async run() {
        const result = await runBuiltCli(["setup"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /COMMAND_DEPRECATED/);
        assert.match(result.stderr, /init, migrate/);
      },
    },
    {
      name: "migrate is advanced adopt helper in help",
      async run() {
        const result = await runBuiltCli(["help", "migrate"]);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /advanced adopt helper/i);
        assert.doesNotMatch(result.stdout, /fresh.*default/i);
      },
    },
  ],
};
