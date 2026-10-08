"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createBareSandbox,
  createSandbox,
  runCli,
  runFail,
  runOk,
  seedCodex,
  writeCleanCodex,
} = require("./sandbox");

/**
 * Reads one `key: value` line out of a human-rendered block, so an assertion names the line it
 * means instead of matching a substring that could appear anywhere in the output.
 */
function lineFor(stdout, key) {
  const match = new RegExp(`^\\s*${key}: (.*)$`, "m").exec(stdout);
  return match ? match[1] : null;
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

function authPath(sandbox) {
  return path.join(sandbox.codex, "auth.json");
}

module.exports = {
  name: "human renderers",
  tests: [
    {
      name: "status names each health state it can be in",
      run() {
        // Incomplete: the registry does not exist at all.
        const bare = createBareSandbox();
        const incomplete = runCli(bare, ["status"]);
        assert.equal(incomplete.status, 0, incomplete.stderr);
        assert.equal(lineFor(incomplete.stdout, "runtime health"), "incomplete local state");
        assert.equal(lineFor(incomplete.stdout, "mapped provider"), "(unmanaged or unresolved)");
        assert.equal(lineFor(incomplete.stdout, "provider path"), "unmanaged route");

        const sandbox = createSandbox();
        // A clean config, not the fixture: the fixture's legacy `[profiles.*]` sections are issues,
        // and the next step is computed from them.
        writeCleanCodex(sandbox);
        addProvider(sandbox, "freemodel");
        runOk(sandbox, ["switch", "freemodel", "--json"]);

        const healthy = runCli(sandbox, ["status"]);
        assert.equal(lineFor(healthy.stdout, "runtime health"), "ok");
        assert.equal(lineFor(healthy.stdout, "mapped provider"), "freemodel");
        assert.equal(lineFor(healthy.stdout, "provider path"), "managed provider");
        assert.equal(lineFor(healthy.stdout, "current model"), "gpt-5-mini");
        assert.equal(lineFor(healthy.stdout, "next step"), "run `aps doctor` if you need a deeper diagnostic pass");

        // The line that printed an empty string because the payload never carried the field.
        assert.equal(lineFor(healthy.stdout, "tool home"), sandbox.home);

        // Drift: the projected section is hand-edited away from the registered record.
        const drifted = createSandbox();
        writeCleanCodex(drifted);
        addProvider(drifted, "freemodel");
        runOk(drifted, ["switch", "freemodel", "--json"]);
        writeCleanCodex(drifted, "https://elsewhere.example/v1");
        const drift = runCli(drifted, ["status"]);
        assert.equal(lineFor(drift.stdout, "runtime health"), "provider projection drift");
        // Drift is reported in the health line but not in `warnings`, so the next step falls through
        // to the generic diagnostic. `doctor` is what names the specific repair.
        assert.equal(lineFor(drift.stdout, "next step"), "run `aps doctor` if you need a deeper diagnostic pass");

        // The auth states are checked after drift, so they need a tree that is not already drifted
        // — otherwise the drift branch answers first and the auth assertions never run.
        const plain = createSandbox();
        writeCleanCodex(plain);
        addProvider(plain, "freemodel");
        runOk(plain, ["switch", "freemodel", "--json"]);

        // Missing auth projection: config.toml is intact but auth.json is gone.
        fs.rmSync(authPath(plain), { force: true });
        const noAuth = runCli(plain, ["status"]);
        assert.equal(lineFor(noAuth.stdout, "runtime health"), "auth projection missing");

        // Invalid auth projection: unreadable JSON, which is a different state from absent.
        fs.writeFileSync(authPath(plain), "{ not json", "utf8");
        const badAuth = runCli(plain, ["status"]);
        assert.equal(lineFor(badAuth.stdout, "runtime health"), "auth projection invalid");

        // Ambiguity: two registered providers sharing one model_provider id. The mapped-provider
        // line must refuse to claim a winner rather than picking one.
        const shared = createSandbox();
        seedCodex(shared, { modelProvider: "freemodel" });
        addProvider(shared, "two", ["--profile", "shared"]);
        addProvider(shared, "three", ["--profile", "shared"]);
        runOk(shared, ["switch", "two", "--json"]);
        fs.rmSync(authPath(shared), { force: true });

        const ambiguous = runCli(shared, ["status"]);
        assert.equal(lineFor(ambiguous.stdout, "runtime health"), "active provider ambiguous");
        assert.equal(lineFor(ambiguous.stdout, "mapped provider"), "(ambiguous: three, two)");
        assert.equal(lineFor(ambiguous.stdout, "provider path"), "unmanaged route");
        assert.match(ambiguous.stdout, /^  warnings: 1$/m);
        // Sharing a profile pushes a warning, and a warning outranks the "no provider" branch of the
        // next-step rule — the ambiguity is something `doctor` explains, not something a switch fixes.
        assert.equal(lineFor(ambiguous.stdout, "next step"), "run `aps doctor` to inspect warnings before the next write command");
        assert.match(ambiguous.stdout, /^Warning: Current model provider "shared" is shared by multiple providers/m);

        // The branch below that one: nothing active, and no warning to outrank it. A registry with
        // no config.toml at all is the combination that reaches it — every config.toml state that
        // has no active provider also raises a warning.
        const idle = createSandbox();
        const idleStatus = runCli(idle, ["status"]);
        assert.equal(lineFor(idleStatus.stdout, "runtime health"), "incomplete local state");
        assert.match(idleStatus.stdout, /^  warnings: 0$/m);
        assert.equal(lineFor(idleStatus.stdout, "mapped provider"), "(unmanaged or unresolved)");
        assert.equal(lineFor(idleStatus.stdout, "next step"), "run `aps switch <provider>` after adding or adopting a managed provider");

        // Legacy wiring diverts the next step from the generic one, because reprojecting is the
        // repair. `seedCodex` writes the legacy sections this branch is about.
        const legacy = createSandbox();
        seedCodex(legacy, { modelProvider: "freemodel" });
        addProvider(legacy, "freemodel");
        runOk(legacy, ["switch", "freemodel", "--json"]);

        const legacyStatus = runCli(legacy, ["status"]);
        assert.equal(lineFor(legacyStatus.stdout, "runtime health"), "ok");
        assert.equal(
            lineFor(legacyStatus.stdout, "next step"),
            "run `aps switch <provider>` to reproject the active route and clean legacy fields"
        );
      },
    },
    {
      name: "status prefers naming the active provider's route over the ambiguity line when one exists",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");
        runOk(sandbox, ["switch", "gamma", "--json"]);

        // A resolved provider short-circuits the candidate list, so the ambiguity fallback is
        // unreachable from a healthy tree — asserted here so the two paths stay distinguishable.
        const status = runOk(sandbox, ["status", "--json"]);
        assert.equal(status.json.data.provider, "gamma");
        assert.equal(status.json.data.activeProviderResolvable, true);

        const human = runCli(sandbox, ["status"]);
        assert.equal(lineFor(human.stdout, "mapped provider"), "gamma");
        assert.doesNotMatch(human.stdout, /ambiguous/);
      },
    },
    {
      name: "every mutating command has a human view, not just a JSON envelope",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        // Both providers carry a legacy profile section, because `import --merge` below refuses any
        // provider whose config.toml profile is missing or incomplete — the same requirement the
        // dedicated import test asserts from the other side.
        const added = runCli(sandbox, ["add", "gamma", "--profile", "gamma", "--model", "gpt-5-mini", "--api-key", "sk-gamma", "--base-url", "https://gamma.example/v1", "--create-profile"]);
        assert.equal(added.status, 0, added.stderr);
        assert.match(added.stdout, new RegExp(`^Added provider gamma\\. Backup: ${escapeRegExp(sandbox.home)}`, "m"));
        // `--create-profile` adds a line to the same view rather than changing the first one.
        assert.match(added.stdout, /^Created profiles: gamma$/m);

        const withProfile = runCli(sandbox, ["add", "delta", "--profile", "delta", "--model", "gpt-5-mini", "--api-key", "sk-delta", "--base-url", "https://delta.example/v1", "--create-profile"]);
        assert.equal(withProfile.status, 0, withProfile.stderr);

        // Export and import run before anything makes a provider active. Activating one deletes its
        // legacy profile section — the "clean legacy fields" behaviour — and `import --merge` then
        // refuses the very sections it just removed.
        const exported = path.join(sandbox.root, "exported.json");
        const exportResult = runCli(sandbox, ["export", exported]);
        assert.equal(exportResult.status, 0);
        assert.match(exportResult.stdout, new RegExp(`^Exported providers to ${escapeRegExp(exported)}\\.$`, "m"));

        const imported = runCli(sandbox, ["import", exported, "--merge"]);
        assert.equal(imported.status, 0, imported.stderr);
        assert.match(imported.stdout, /^Imported providers from file using mode merge\. Backup: /m);

        const switched = runCli(sandbox, ["switch", "gamma"]);
        assert.match(switched.stdout, /^Switched to provider gamma using model provider gamma\.$/m);
        assert.match(switched.stdout, /^Model: gpt-5-mini$/m);
        assert.match(switched.stdout, new RegExp(`^Backup: ${escapeRegExp(sandbox.home)}`, "m"));

        const edited = runCli(sandbox, ["edit", "gamma", "--note", "primary"]);
        assert.match(edited.stdout, new RegExp(`^Updated provider gamma\\. Backup: ${escapeRegExp(sandbox.home)}`, "m"));
        assert.match(edited.stdout, /^Updated fields: note$/m);

        const current = runCli(sandbox, ["current"]);
        assert.match(current.stdout, /^Current model provider: gamma$/m);

        const profileConfig = runCli(sandbox, ["config", "list-profiles"]);
        assert.equal(profileConfig.status, 0);
        assert.match(profileConfig.stdout, new RegExp(`^gamma managed=true active=true source=`, "m"));

        const removed = runCli(sandbox, ["remove", "gamma", "--force", "--switch-to", "delta"]);
        assert.equal(removed.status, 0, removed.stderr);
        assert.match(removed.stdout, new RegExp(`^Removed provider gamma\\. Backup: ${escapeRegExp(sandbox.home)}`, "m"));

        // The recovery commands render their results too, and a prune with nothing to do is the
        // case most likely to print an empty line instead of a sentence.
        const noneToPrune = runCli(sandbox, ["backups", "prune"]);
        assert.match(noneToPrune.stdout, /^Retention kept 20 backup\(s\) and removed 0\.$/m);

        const rolled = runCli(sandbox, ["rollback"]);
        assert.equal(rolled.status, 0, rolled.stderr);
        assert.match(rolled.stdout, new RegExp(`^Rollback restored files from ${escapeRegExp(sandbox.home)}`, "m"));
      },
    },
    {
      name: "a failure is rendered for a human on stderr, and as an envelope under --json",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        // Not `runFail`, which requires an envelope — this is the human form, and asserting on it
        // is the point. The code leads the line, so a caller grepping for it does not have to know
        // the message text.
        const human = runCli(sandbox, ["show", "ghost"]);
        assert.equal(human.status, 1);
        // The failure channel is stderr, so a caller piping stdout gets nothing rather than a
        // message that looks like a result.
        assert.equal(human.stdout, "");
        assert.match(human.stderr, /^PROVIDER_NOT_FOUND: Provider "ghost" was not found\.$/m);
        assert.match(human.stderr, /^  provider: ghost$/m);
        assert.doesNotMatch(human.stderr, /\{\s*"ok"/, "human failures must not be JSON");

        const enveloped = runFail(sandbox, ["show", "ghost", "--json"]);
        assert.equal(enveloped.stdout, "", "the envelope belongs on stderr, not stdout");
        assert.equal(enveloped.json.ok, false);
        assert.equal(enveloped.json.command, "show");
        assert.deepEqual(enveloped.json.warnings, []);

        // A refusal that carries structured details still renders them for a human.
        const details = runCli(sandbox, ["add", "gamma", "--profile", "gamma", "--api-key", "sk-gamma"]);
        assert.equal(details.status, 1);
        assert.match(details.stderr, /^MANAGED_PROFILE_FIELDS_MISSING: /m);
        assert.match(details.stderr, /missingFields: model/);

        // ...and a secret passed as an option value must not appear in that rendering, however the
        // command fails. The redaction is recursive over the detail tree, not just the message.
        const secret = "sk-ant-super-secret-value";
        const seeded = runCli(sandbox, ["add", "gamma", "--profile", "gamma", "--model", "gpt-5-mini", "--api-key", "sk-gamma", "--base-url", "https://gamma.example/v1"]);
        assert.equal(seeded.status, 0, seeded.stderr);

        const leaked = runCli(sandbox, ["add", "gamma", "--profile", "gamma", "--model", "gpt-5-mini", "--api-key", secret, "--base-url", "https://gamma.example/v1", "--note", secret]);
        assert.equal(leaked.status, 1, "a duplicate add must fail");
        assert.match(leaked.stderr, /^INVALID_IMPORT_FILE: /m);
        assert.doesNotMatch(leaked.stderr, new RegExp(secret), "a secret must not survive into a failure rendering");
      },
    },
  ],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
