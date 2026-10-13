"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  makeTempDir,
  setClaudeDefaults,
  withClaudeEnv,
  runJsonCli,
} = require("./helpers");

/**
 * Reads the Claude section of a `status --claude` envelope.
 */
function claudeSection(payload) {
  return payload.data.claude;
}

/**
 * The value inside a report reading, for the assertions that only care about the value.
 *
 * Every field of the section is a tagged reading, so a test that compared one to a bare value would
 * be asserting the old contract. Reaching through the tag here keeps each assertion about the
 * question being asked rather than about the envelope's spelling.
 */
function valueOf(reading) {
  return reading && reading.status === "ok" ? reading.value : undefined;
}

/**
 * A provider row, without the identity detail a test is not asking about.
 */
function rowShape(provider) {
  return {
    name: provider.name,
    model: provider.model,
    baseUrl: provider.baseUrl,
    inherited: provider.inherited,
    active: provider.active,
  };
}

const DEFAULTS = {
  model: "sonnet",
  env: { ANTHROPIC_BASE_URL: "https://defaults.example.com" },
};

module.exports = {
  name: "claude status",
  tests: [
    {
      name: "an empty Claude root is a success that reports itself as unconfigured",
      async run() {
        // The whole reason `configured` exists. `status` is a report, not a probe, so a target the
        // user has never pointed at this tool is described rather than failed: the count is a
        // successful zero, the paths are still named, and nothing throws.
        //
        // The zero arrives as `{ status: "ok", value: 0 }` and not as `null`: "there are no
        // providers here" and "the count could not be established" are the two answers this release
        // separates, and an empty root is the first of them.
        const result = await runJsonCli({
          toolHomeDir: makeTempDir("agent-provider-switch-empty-home-"),
          args: ["status", "--claude", "--json"],
        });

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.payload.targets, ["claude"]);
        const claude = claudeSection(result.payload);
        assert.deepEqual(claude.configured, { status: "ok", value: false });
        assert.deepEqual(claude.registry, { status: "absent" });
        assert.deepEqual(claude.live, { status: "absent" });
        assert.deepEqual(claude.activation, { status: "ok", value: "not-activated" });
        assert.deepEqual(claude.defaults, { status: "ok", value: { present: false } });
        assert.deepEqual(claude.providerCount, { status: "ok", value: 0 });
        assert.deepEqual(claude.inheritance, { status: "ok", value: {} });
        // A missing registry leaves an *empty* candidate set, not an unknown one, so matching still
        // answers: nothing is managed and nothing is live.
        assert.deepEqual(claude.matching, {
          status: "ok",
          value: { state: "not-activated", activeProvider: null, candidates: [] },
        });
        assert.equal(claude.settingsStatus, "absent");
        assert.equal(claude.settingsInvalidReason, null);
        assert.deepEqual(claude.providers, []);

        // Nothing here is a fault, and nothing was left unread: an unused target is a healthy one.
        assert.deepEqual(result.payload.data.issues, []);
        assert.equal(result.payload.data.healthy, true);
        assert.equal(result.payload.data.complete, true);

        // The paths are reported even though nothing is there, because they are where the user has
        // to put something — a report that omitted them would say "nothing" without saying "where".
        const paths = valueOf(claude.paths);
        assert.ok(paths.claudeDir.endsWith("claude"), paths.claudeDir);
        assert.ok(paths.claudeProvidersPath.endsWith("claude-providers.json"));
        assert.ok(paths.claudeSettingsPath.endsWith("settings.json"));
      },
    },
    {
      name: "a registered provider is reported resolved against the shared defaults",
      async run() {
        await withClaudeEnv({ env: { ANTHROPIC_AUTH_TOKEN: "sk-provider-token" } }, async ({ toolHomeDir, importFile }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS);

          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "alpha", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);

          const result = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          assert.equal(result.status, 0, result.stderr);

          const claude = claudeSection(result.payload);
          assert.deepEqual(claude.configured, { status: "ok", value: true });
          assert.deepEqual(claude.registry, { status: "ok", value: { providerCount: 1 } });
          assert.deepEqual(claude.live, { status: "absent" });
          assert.deepEqual(claude.defaults, { status: "ok", value: { present: true } });
          assert.deepEqual(claude.providerCount, { status: "ok", value: 1 });
          // The record overrides nothing the defaults supply, so every default path is inherited —
          // the count is per provider, and the row carries the same two paths it was counted from.
          assert.deepEqual(claude.inheritance, { status: "ok", value: { alpha: 2 } });

          const [alpha] = claude.providers;
          assert.deepEqual(rowShape(alpha), {
            name: "alpha",
            // Resolved, not raw: the stored record is a delta and holds neither of these.
            model: "sonnet",
            baseUrl: "https://defaults.example.com",
            inherited: ["env.ANTHROPIC_BASE_URL", "model"],
            active: false,
          });
          // Nothing has been switched to, so no row is a candidate for the live settings either.
          assert.equal(alpha.candidate, false);
          assert.equal(alpha.ambiguous, false);
          assert.deepEqual(alpha.differencePaths, []);

          // A registry with no live configuration is a *prepared* target: not activated, and not a
          // fault either.
          assert.deepEqual(valueOf(claude.matching), {
            state: "not-activated",
            activeProvider: null,
            candidates: [],
          });
          assert.equal(result.payload.data.healthy, true);
        });
      },
    },
    {
      name: "the live settings decide which row is marked active",
      async run() {
        await withClaudeEnv({ model: "opus" }, async ({ toolHomeDir, importFile }) => {
          // Two providers that do not resolve to the same settings. A single import file would make
          // the two records identical, and the match would then report both as candidates.
          const otherFile = path.join(path.dirname(importFile), "other-settings.json");
          fs.writeFileSync(otherFile, `${JSON.stringify({ model: "haiku" }, null, 2)}\n`, "utf8");

          for (const [name, file] of [["alpha", importFile], ["beta", otherFile]]) {
            const added = await runJsonCli({
              toolHomeDir,
              args: ["add", "--claude", name, "--from-file", file, "--json"],
            });
            assert.equal(added.status, 0, added.stderr);
          }

          const before = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          assert.equal(before.status, 0, before.stderr);
          assert.equal(valueOf(claudeSection(before.payload).matching).state, "not-activated");

          const switched = await runJsonCli({
            toolHomeDir,
            args: ["switch", "--claude", "beta", "--json"],
          });
          assert.equal(switched.status, 0, switched.stderr);

          const after = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          const claude = claudeSection(after.payload);
          assert.equal(claude.settingsStatus, "ok");
          assert.deepEqual(valueOf(claude.live), { present: true });
          assert.deepEqual(claude.activation, { status: "ok", value: "activated" });

          const match = valueOf(claude.matching);
          assert.equal(match.state, "managed");
          assert.equal(match.activeProvider, "beta");
          assert.deepEqual(match.candidates, [
            { name: "beta", consistent: true, differencePaths: [] },
          ]);

          // Derived from the per-row markers rather than computed a second time, so the two cannot
          // name different providers.
          assert.deepEqual(
            claude.providers.map((provider) => [provider.name, provider.active]),
            [["alpha", false], ["beta", true]]
          );
          assert.deepEqual(after.payload.data.issues, []);
          assert.equal(after.payload.data.healthy, true);
        });
      },
    },
    {
      name: "an ambiguous match names every candidate and claims none of them",
      async run() {
        // Two records from the same file resolve to the same effective settings, so the live file
        // cannot be attributed to either one. The answer is enumerating them: choosing the first
        // would report a provider the user may not be using, and reporting the count twice would
        // hide that there is a question at all.
        await withClaudeEnv(
          { model: "sonnet", env: { ANTHROPIC_BASE_URL: "https://shared.example.com" } },
          async ({ toolHomeDir, importFile }) => {
            for (const name of ["alpha", "beta"]) {
              const added = await runJsonCli({
                toolHomeDir,
                args: ["add", "--claude", name, "--from-file", importFile, "--json"],
              });
              assert.equal(added.status, 0, added.stderr);
            }

            const switched = await runJsonCli({
              toolHomeDir,
              args: ["switch", "--claude", "alpha", "--json"],
            });
            assert.equal(switched.status, 0, switched.stderr);

            const result = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
            assert.equal(result.status, 0, result.stderr);
            const claude = claudeSection(result.payload);

            const match = valueOf(claude.matching);
            assert.equal(match.state, "ambiguous");
            // Null for ambiguous, with `state` carrying the meaning: a claimed active provider here
            // would be the guess the identity rule forbids.
            assert.equal(match.activeProvider, null);
            assert.deepEqual(match.candidates, [
              { name: "alpha", consistent: true, differencePaths: [] },
              { name: "beta", consistent: true, differencePaths: [] },
            ]);
            assert.deepEqual(
              claude.providers.map((provider) => [provider.name, provider.active, provider.candidate, provider.ambiguous]),
              [["alpha", false, true, true], ["beta", false, true, true]]
            );

            // Ambiguity is a state, not a fault: the installation is doing exactly what the user
            // configured, and nothing here is broken.
            assert.deepEqual(result.payload.data.issues, []);
            assert.equal(result.payload.data.healthy, true);

            // The list says the same thing in one place, which is what keeps a consumer from
            // having to scan rows to notice the tie.
            const listed = await runJsonCli({ toolHomeDir, args: ["list", "--claude", "--json"] });
            assert.equal(listed.status, 0, listed.stderr);
            assert.equal(listed.payload.data.matchState, "ambiguous");
            assert.equal(listed.payload.data.activeProvider, null);
            assert.deepEqual(
              listed.payload.data.providers.map((provider) => [provider.name, provider.isActive, provider.ambiguous]),
              [["alpha", false, true], ["beta", false, true]]
            );
          }
        );
      },
    },
    {
      name: "identity includes the authentication source, so a swapped token is a different provider",
      async run() {
        // The paths the identity rule reads are the ones a Claude Code session authenticates with.
        // Leaving the token out would report a settings file pointing at another account as the
        // provider the user switched to — the drift comparison would not have caught it either,
        // because drift is only consulted once identity has already matched.
        await withClaudeEnv({ model: "sonnet", env: { ANTHROPIC_AUTH_TOKEN: "sk-alpha-token" } }, async ({ toolHomeDir, importFile }) => {
          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "alpha", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);

          const switched = await runJsonCli({ toolHomeDir, args: ["switch", "--claude", "alpha", "--json"] });
          assert.equal(switched.status, 0, switched.stderr);

          const matched = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          assert.equal(valueOf(claudeSection(matched.payload).matching).state, "managed");

          // The same file, the same base URL, the same model — and another account's token.
          const settingsPath = valueOf(claudeSection(matched.payload).paths).claudeSettingsPath;
          const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          settings.env.ANTHROPIC_AUTH_TOKEN = "sk-somebody-else";
          fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

          const after = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          const match = valueOf(claudeSection(after.payload).matching);
          assert.equal(match.state, "unmanaged", "a different token is a different identity");
          assert.equal(match.activeProvider, null);
          assert.deepEqual(match.candidates, []);

          // Unmanaged is a state and not a fault — the live settings are valid, they are simply
          // not one of the registered providers.
          assert.deepEqual(after.payload.data.issues, []);
          assert.equal(after.payload.data.healthy, true);
        });
      },
    },
    {
      name: "a matching identity that differs elsewhere is a note, and the paths say where",
      async run() {
        // Identity and consistency are separate answers. `alpha` is still the provider the user
        // switched to after its settings gain an unrelated key, and calling that drift a fault
        // would fail a healthy install over a permission flag.
        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir, importFile }) => {
          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "alpha", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);
          const switched = await runJsonCli({ toolHomeDir, args: ["switch", "--claude", "alpha", "--json"] });
          assert.equal(switched.status, 0, switched.stderr);

          const switchedStatus = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          const settingsPath = valueOf(claudeSection(switchedStatus.payload).paths).claudeSettingsPath;
          const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          settings.permissions = { allow: ["Bash(ls:*)"] };
          fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

          const result = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          assert.equal(result.status, 0, result.stderr);
          const match = valueOf(claudeSection(result.payload).matching);

          // Still managed, still the same provider — with the difference reported beside it.
          assert.equal(match.state, "managed");
          assert.equal(match.activeProvider, "alpha");
          assert.equal(match.candidates[0].consistent, false);
          assert.deepEqual(match.candidates[0].differencePaths, ["permissions"]);
          assert.deepEqual(claudeSection(result.payload).providers[0].differencePaths, ["permissions"]);

          // The note names paths and never values: a difference path can point at a credential, so
          // a summary that carried the value would print a secret.
          assert.deepEqual(
            result.payload.data.notes.map((note) => [note.code, note.paths, note.target]),
            [["CONFIGURATION_DRIFT", ["permissions"], "claude"]]
          );
          assert.deepEqual(result.payload.data.issues, []);
          assert.equal(result.payload.data.healthy, true);
        });
      },
    },
    {
      name: "a malformed registry is a finding a report still carries, not a failed report",
      async run() {
        // The split this release draws between producing a report and the report's verdict. A
        // registry that cannot be parsed is a diagnosed fault *inside* a successful answer: the
        // paths, the evidence, and the lock are all still known, and `healthy: false` is how the
        // fault is expressed. The exit code stays 0 until the report itself cannot be produced.
        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir }) => {
          fs.writeFileSync(
            path.join(toolHomeDir, "claude-providers.json"),
            `${JSON.stringify({ providers: [] }, null, 2)}\n`,
            "utf8"
          );

          const status = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          assert.equal(status.status, 0, status.stderr);
          assert.equal(status.payload.ok, true);
          assert.equal(status.payload.target, "claude");

          const claude = claudeSection(status.payload);
          assert.equal(claude.registry.status, "invalid");
          // A count that could not be taken is unavailable, never zero: the file is there and it
          // has content, so "no providers" would be a claim nothing supports.
          assert.equal(claude.providerCount.status, "unavailable");
          assert.equal(claude.matching.status, "unavailable");
          assert.equal(claude.configured.status, "ok");
          // Malformed content is still evidence: the file exists, and its existence is a fact
          // independent of whether its content can be used.
          assert.equal(claude.configured.value, true);

          assert.deepEqual(
            status.payload.data.issues.map((issue) => [issue.code, issue.target]),
            [["PROVIDERS_PARSE_ERROR", "claude"]]
          );
          assert.equal(status.payload.data.healthy, false);
          assert.equal(status.payload.data.complete, false);

          // `doctor` reaches the same conclusion through the same readers.
          const doctor = await runJsonCli({ toolHomeDir, args: ["doctor", "--json", "--claude"] });
          assert.equal(doctor.status, 0, doctor.stderr);
          assert.deepEqual(
            doctor.payload.data.issues.map((issue) => issue.code),
            ["PROVIDERS_PARSE_ERROR"]
          );
          assert.equal(doctor.payload.data.issues[0].target, "claude");
          assert.equal(doctor.payload.data.healthy, false);
        });
      },
    },
    {
      name: "the section carries no settings blob and no secret value",
      async run() {
        // The reason the Claude section is assembled rather than the record echoed back: a Claude
        // record's settings hold the env the provider authenticates with, so the section reports
        // paths and resolved scalars and never the object itself. Asserted on the serialized
        // payload, because that is the thing a caller receives.
        await withClaudeEnv({ env: { ANTHROPIC_AUTH_TOKEN: "sk-provider-token" } }, async ({ toolHomeDir, importFile }) => {
          setClaudeDefaults(toolHomeDir, DEFAULTS);
          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "alpha", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);

          const result = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          const claude = claudeSection(result.payload);

          // A row carries the summary columns and the identity detail, and no settings object. The
          // key list is asserted rather than a spot check, so a field added to a row is a
          // deliberate change to what a caller receives.
          assert.deepEqual(Object.keys(claude.providers[0]), [
            "name",
            "model",
            "baseUrl",
            "inherited",
            "active",
            "candidate",
            "ambiguous",
            "differencePaths",
          ]);
          assert.equal(claude.settings, undefined);
          assert.equal(result.stdout.includes("sk-provider-token"), false, "a stored secret reached stdout");

          // The section itself is the shared contract plus Claude's own detail, and nothing else —
          // no raw record, no defaults block.
          assert.deepEqual(Object.keys(claude), [
            "configured",
            "paths",
            "registry",
            "live",
            "activation",
            "defaults",
            "providerCount",
            "inheritance",
            "matching",
            "settingsStatus",
            "settingsInvalidReason",
            "providers",
          ]);
        });
      },
    },
  ],
};
