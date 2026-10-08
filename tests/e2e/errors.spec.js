"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, runCli, runFail, runOk, seedCodex } = require("./sandbox");

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

module.exports = {
  name: "error surface",
  tests: [
    {
      name: "an unresolvable command is refused without a stack trace",
      run() {
        const sandbox = createSandbox();

        // The 0.4.0 exit-code rule: only a known help topic gets help and exit 0. Anything else
        // that resolves to no command is an error, or a typo would look like success.
        for (const typo of ["lst", "version", "swich", "providers"]) {
          const result = runCli(sandbox, [typo]);
          assert.equal(result.status, 1, `aps ${typo} must exit 1`);
          assert.match(result.stderr, new RegExp(`Unknown command: ${typo}`));
          assert.doesNotMatch(result.stderr, /at Object\.|node:internal/, "no stack trace may reach the user");
        }

        // A recognised group root is help, not an error, because it names a real surface.
        for (const topic of ["config", "backups"]) {
          const result = runCli(sandbox, [topic]);
          assert.equal(result.status, 0, `aps ${topic} must exit 0`);
          assert.match(result.stdout, new RegExp(`^aps ${topic}$`, "m"));
        }

        // The envelope has to be produced for a failure the parser itself raised, which is the one
        // path where there is no parsed result to read `--json` from.
        const enveloped = runFail(sandbox, ["lst", "--json"]);
        assert.equal(enveloped.json.ok, false);
        assert.equal(enveloped.json.error.code, "INVALID_ARGUMENT");
        assert.ok(
          Array.isArray(enveloped.json.error.details.availableCommands),
          "the refusal must name the commands that would have worked"
        );
        assert.match(enveloped.json.command, /^help$/, "an unresolved command reports under help");
      },
    },
    {
      name: "a valued option at the end of argv is an error rather than an empty value",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        // `--codex-dir` is stripped in the parser's first pass, so a missing value leaves the flag
        // itself in argv with nothing after it. The parse must fail loudly rather than resolve a
        // directory named "undefined".
        const bare = runCli(sandbox, ["list", "--codex-dir"]);
        assert.equal(bare.status, 1);
        assert.match(bare.stderr, /--codex-dir/);

        const enveloped = runFail(sandbox, ["list", "--codex-dir", "--json"]);
        assert.equal(enveloped.json.ok, false);
        assert.equal(enveloped.json.error.code, "INVALID_ARGUMENT");
      },
    },
    {
      name: "provider-level refusals name the provider and what would have worked",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");

        const missing = runFail(sandbox, ["show", "ghost", "--json"]);
        assert.equal(missing.json.error.code, "PROVIDER_NOT_FOUND");
        assert.equal(missing.json.error.details.provider, "ghost");
        assert.equal(missing.json.error.details.file, path.join(sandbox.home, "providers.json"));

        const missingHuman = runCli(sandbox, ["show", "ghost"]);
        assert.equal(missingHuman.status, 1);
        assert.match(missingHuman.stderr, /Provider "ghost" was not found\./);

        // A second add under the same name, and an edit of a name that is not registered.
        const duplicate = runFail(sandbox, ["add", "gamma", "--profile", "gamma", "--model", "gpt-5", "--api-key", "sk-x", "--json"]);
        assert.equal(duplicate.json.error.code, "INVALID_IMPORT_FILE");
        assert.match(duplicate.json.error.message, /already exists/);

        const editMissing = runFail(sandbox, ["edit", "ghost", "--note", "x", "--json"]);
        assert.equal(editMissing.json.error.code, "PROVIDER_NOT_FOUND");

        // `edit` with nothing to change is a usage error, not a silent no-op.
        const emptyEdit = runFail(sandbox, ["edit", "gamma", "--json"]);
        assert.equal(emptyEdit.json.error.code, "INVALID_ARGUMENT");
        assert.match(emptyEdit.json.error.message, /requires at least one field to update/);

        // ...and the same command with a switch to an unregistered name is refused rather than
        // projected, because the active route would otherwise point at nothing.
        const badSwitch = runFail(sandbox, ["switch", "ghost", "--json"]);
        assert.equal(badSwitch.json.error.code, "PROVIDER_NOT_FOUND");
      },
    },
    {
      name: "add refuses an incomplete projection and says which field is missing",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        // No --model and no top-level model in config.toml to inherit.
        const noModel = runFail(sandbox, ["add", "gamma", "--profile", "gamma", "--api-key", "sk-gamma", "--base-url", "https://gamma.example/v1", "--json"]);
        assert.equal(noModel.json.error.code, "MANAGED_PROFILE_FIELDS_MISSING");
        assert.deepEqual(noModel.json.error.details.missingFields, ["model"]);
        assert.match(noModel.json.error.details.suggestion, /--model <name>/);

        // No base_url anywhere: not passed, and no existing model_providers section to inherit.
        const noBaseUrl = runFail(sandbox, ["add", "delta", "--profile", "delta", "--model", "gpt-5-mini", "--api-key", "sk-delta", "--json"]);
        assert.equal(noBaseUrl.json.error.code, "MANAGED_PROFILE_FIELDS_MISSING");
        assert.deepEqual(noBaseUrl.json.error.details.missingFields, ["base_url"]);

        // A refusal must not leave a partial registry behind.
        const list = runOk(sandbox, ["list", "--json"]);
        assert.deepEqual(list.json.data.providers, []);
      },
    },
    {
      name: "migrate names why it cannot proceed instead of half-adopting a profile",
      run() {
        const sandbox = createSandbox();
        // Profiles that name a model_provider with no `[model_providers.*]` section: visible in
        // config.toml, but with no base_url to project, so they cannot be adopted. That is the
        // distinction this error exists to carry — `PROFILE_NOT_FOUND` would be the wrong answer,
        // because profiles were found.
        fs.writeFileSync(
          path.join(sandbox.codex, "config.toml"),
          '[profiles.packycode]\nmodel = "gpt-5"\nmodel_provider = "packycode"\n',
          "utf8"
        );

        const notAdoptable = runFail(sandbox, ["migrate", "--codex-dir", sandbox.codex, "--json"]);
        assert.equal(notAdoptable.json.error.code, "MIGRATE_NO_ADOPTABLE_PROFILES");
        assert.ok(Array.isArray(notAdoptable.json.error.details.availableProfiles));
        assert.deepEqual(notAdoptable.json.error.details.adoptableProfiles, []);
        assert.ok(
          Object.keys(notAdoptable.json.error.details.blockingReasonsByProfile).length > 0,
          "each blocked profile must carry its reason"
        );
      },
    },
  ],
};
