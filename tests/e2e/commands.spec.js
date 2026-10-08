"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBareSandbox, createSandbox, runCli, runFail, runOk, seedCodex } = require("./sandbox");

/**
 * Registers `name` against the sandbox's Codex target. Every write command is exercised through
 * this rather than by writing providers.json directly, so the registry under test is one the CLI
 * itself produced.
 */
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
  name: "codex command surface",
  tests: [
    {
      name: "the full managed lifecycle runs end to end as real processes",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        const added = addProvider(sandbox, "gamma", ["--note", "hello", "--tag", "daily"]);
        assert.equal(added.json.data.provider, "gamma");
        assert.equal(added.json.data.modelProvider, "gamma");
        assert.deepEqual(added.json.data.createdModelProviderSections, ["gamma"]);
        // Retention reports what it removed on every mutation, so an automatic prune is visible
        // rather than silent. Nothing to remove on a fresh tool home.
        assert.equal(added.json.data.retentionRemoved, 0);

        const list = runOk(sandbox, ["list", "--json"]);
        assert.ok(list.json.data.providers.some((provider) => provider.name === "gamma"));

        // `show` is the documented asymmetry: the key is masked in human output and returned in
        // full under --json, because that is an automation contract.
        const shown = runOk(sandbox, ["show", "gamma", "--json"]);
        assert.equal(shown.json.data.providerName, "gamma");
        assert.equal(shown.json.data.provider.apiKey, "sk-gamma");
        assert.equal(shown.json.data.provider.note, "hello");
        assert.deepEqual(shown.json.data.provider.tags, ["daily"]);

        const shownHuman = runCli(sandbox, ["show", "gamma"]);
        assert.equal(shownHuman.status, 0);
        // `maskSecret` keeps a short prefix and suffix and replaces the middle, so the assertion
        // is the contract — a masked line that reveals no more than that — rather than an exact
        // asterisk count.
        assert.match(shownHuman.stdout, /^apiKey: sk-\*+ma$/m, "human show must mask the key");
        assert.doesNotMatch(shownHuman.stdout, /sk-gamma/, "the full key must not reach human output");

        const switched = runOk(sandbox, ["switch", "gamma", "--json"]);
        assert.equal(switched.json.data.provider, "gamma");

        const current = runOk(sandbox, ["current", "--json"]);
        assert.equal(current.json.data.modelProvider, "gamma");
        assert.equal(current.json.data.provider, "gamma");

        const edited = runOk(sandbox, ["edit", "gamma", "--note", "revised", "--json"]);
        assert.equal(edited.json.data.provider, "gamma");
        assert.ok(edited.json.data.updatedFields.includes("note"));

        const status = runOk(sandbox, ["status", "--json"]);
        assert.equal(status.json.data.currentModelProvider, "gamma");

        // A second provider, so the one being removed is not the active route: removing the
        // active route requires --switch-to and would be refused for a different reason.
        addProvider(sandbox, "spare");
        const removed = runOk(sandbox, ["remove", "spare", "--force", "--json"]);
        assert.equal(removed.json.data.provider, "spare");

        const after = runOk(sandbox, ["list", "--json"]);
        assert.equal(
          after.json.data.providers.some((provider) => provider.name === "spare"),
          false
        );
      },
    },
    {
      name: "config show and config list-profiles report the projected profiles",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");
        runOk(sandbox, ["switch", "gamma", "--json"]);

        const show = runOk(sandbox, ["config", "show", "--json"]);
        assert.equal(show.json.command, "config-show");
        assert.equal(show.json.data.currentModelProvider, "gamma");
        const gamma = show.json.data.profiles.find((profile) => profile.name === "gamma");
        assert.ok(gamma, "the active profile must appear");
        assert.equal(gamma.isActive, true);

        const human = runCli(sandbox, ["config", "show"]);
        assert.equal(human.status, 0);
        assert.match(human.stdout, /^currentModelProvider: gamma$/m);

        const profiles = runOk(sandbox, ["config", "list-profiles", "--json"]);
        assert.equal(profiles.json.command, "config-list-profiles");
        assert.ok(profiles.json.data.profiles.some((profile) => profile.name === "freemodel"));

        const profilesHuman = runCli(sandbox, ["config", "list-profiles"]);
        assert.equal(profilesHuman.status, 0);
        assert.match(profilesHuman.stdout, /^freemodel managed=false active=false source=/m);
      },
    },
    {
      name: "backups list reports the directories mutations created",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        // Nothing has been written yet, so the directory does not exist — and `backups list`
        // reports that as a failure. Recorded rather than smoothed over: it is exactly why
        // `backups prune` enumerates the directory itself instead of reusing `listBackups()`,
        // so that pruning a machine with nothing to prune is a success. The two commands
        // therefore disagree about an empty tree, deliberately.
        const empty = runFail(sandbox, ["backups", "list", "--json"]);
        assert.equal(empty.json.error.code, "BACKUP_NOT_FOUND");
        const emptyPrune = runOk(sandbox, ["backups", "prune", "--json"]);
        assert.equal(emptyPrune.json.data.removedCount, 0);

        addProvider(sandbox, "gamma");
        addProvider(sandbox, "spare");

        const listed = runOk(sandbox, ["backups", "list", "--json"]);
        assert.equal(listed.json.command, "backups-list");
        assert.ok(listed.json.data.count >= 2, `expected both backups, got ${listed.json.data.count}`);

        const backup = listed.json.data.backups[0];
        assert.equal(typeof backup.backupId, "string");
        assert.equal(typeof backup.createdAt, "string");
        assert.ok(["add", "switch"].includes(backup.reason));
        assert.ok(
          fs.existsSync(backup.backupPath),
          "a listed backup must exist on disk under the sandboxed tool home"
        );

        const human = runCli(sandbox, ["backups", "list"]);
        assert.equal(human.status, 0);
        assert.match(human.stdout, new RegExp(escapeRegExp(backup.backupId)));
      },
    },
    {
      name: "export and import round-trip through the real filesystem",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");
        addProvider(sandbox, "spare");

        const target = path.join(sandbox.root, "exported.json");
        const exported = runOk(sandbox, ["export", target, "--json"]);
        assert.equal(exported.json.data.exportedTo, target);

        const document = JSON.parse(fs.readFileSync(target, "utf8"));
        assert.deepEqual(Object.keys(document.providers).sort(), ["gamma", "spare"]);
        // Export is warned about because it writes plaintext keys to a path the tool does not own.
        assert.ok(
          exported.json.warnings.some((warning) => /plaintext/.test(warning)),
          `expected a plaintext warning, got ${JSON.stringify(exported.json.warnings)}`
        );

        // A second export to the same path is refused without --force.
        const refused = runFail(sandbox, ["export", target, "--json"]);
        assert.equal(refused.json.error.code, "INVALID_IMPORT_FILE");
        const forced = runOk(sandbox, ["export", target, "--force", "--json"]);
        assert.equal(forced.json.data.exportedTo, target);

        // Import into a second tool home, which is the only way to know the file is the source.
        // Import refuses providers whose config.toml profiles are missing or incomplete
        // (MANAGED_PROFILE_FIELDS_MISSING), so the target carries matching sections for each
        // name in the export. That refusal is itself asserted below.
        const second = createSandbox();
        fs.writeFileSync(
          path.join(second.codex, "config.toml"),
          ['model_provider = "gamma"', ""]
            .concat(
              ["gamma", "spare"].flatMap((name) => [
                `[profiles.${name}]`,
                'model = "gpt-5-mini"',
                `model_provider = "${name}"`,
                "",
                `[model_providers.${name}]`,
                `base_url = "https://${name}.example/v1"`,
                "",
              ])
            )
            .join("\n"),
          "utf8"
        );
        fs.writeFileSync(path.join(second.codex, "auth.json"), '{"token":"fixture"}\n', "utf8");

        // A target with no matching profile sections is refused, and the refusal names them.
        const third = createSandbox();
        seedCodex(third, { modelProvider: "freemodel" });
        const refusedImport = runFail(third, ["import", target, "--merge", "--json"]);
        assert.equal(refusedImport.json.error.code, "MANAGED_PROFILE_FIELDS_MISSING");
        assert.deepEqual(refusedImport.json.error.details.profilesNeedingRepair, ["gamma", "spare"]);

        const imported = runOk(second, ["import", target, "--merge", "--json"]);
        assert.equal(imported.json.data.mode, "merge");

        const list = runOk(second, ["list", "--json"]);
        assert.deepEqual(
          list.json.data.providers.map((provider) => provider.name).sort(),
          ["gamma", "spare"]
        );
      },
    },
    {
      name: "init creates the managed state on a bare tool home",
      run() {
        const sandbox = createBareSandbox();

        const human = runCli(sandbox, ["init"]);
        assert.equal(human.status, 0, human.stderr);
        assert.match(human.stdout, /^Initialized agent-provider-switch tool home\.$/m);
        assert.match(human.stdout, /^tool home: /m);
        // The renderer used to print an empty tool home because the payload never carried it.
        assert.doesNotMatch(human.stdout, /^tool home: $/m);

        assert.ok(fs.existsSync(path.join(sandbox.home, "providers.json")));
        assert.ok(fs.existsSync(path.join(sandbox.home, "agent-provider-switch.json")));

        // Running it again is a success that reports the state already existed.
        const again = runOk(sandbox, ["init", "--json"]);
        assert.equal(again.json.data.createdProvidersFile, false);
        assert.equal(again.json.data.providersAlreadyExisted, true);
      },
    },
    {
      name: "migrate refuses non-interactively and names the reason for each refusal",
      run() {
        // migrate's happy path needs a TTY, not a codex binary: it always reaches the
        // interactive profile selector, so every non-interactive path is an error surface.
        // That makes it fully coverable here rather than environment-dependent.
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        const both = runFail(sandbox, ["migrate", "--codex-dir", sandbox.codex, "--merge", "--overwrite", "--json"]);
        assert.equal(both.json.error.code, "INVALID_ARGUMENT");
        assert.match(both.json.error.message, /does not allow both/);

        const interactive = runFail(sandbox, ["migrate", "--codex-dir", sandbox.codex, "--json"]);
        assert.equal(interactive.json.error.code, "INVALID_ARGUMENT");
        assert.match(interactive.json.error.message, /requires an interactive TTY/);
        assert.ok(
          Array.isArray(interactive.json.error.details.availableProfiles),
          "the refusal must say which profiles it could see"
        );
      },
    },
    {
      name: "migrate reports a config with no profiles rather than failing silently",
      run() {
        const sandbox = createSandbox();
        fs.writeFileSync(path.join(sandbox.codex, "config.toml"), 'model = "gpt-5"\n', "utf8");

        const result = runFail(sandbox, ["migrate", "--codex-dir", sandbox.codex, "--json"]);
        assert.equal(result.json.error.code, "PROFILE_NOT_FOUND");
        assert.match(result.json.error.message, /No profiles were found/);
      },
    },
    {
      name: "migrate without --codex-dir is refused by the sandbox guard",
      run() {
        const sandbox = createSandbox();

        // The guard's reason for existing: APS_CODEX_DIR does not stop migrate's ambient
        // discovery, so an unwrapped call inspects the developer's real ~/.codex.
        assert.throws(() => runCli(sandbox, ["migrate", "--json"]), /migrate must be invoked with an explicit --codex-dir/);
      },
    },
    {
      name: "setup stays a deprecated pointer",
      run() {
        const sandbox = createSandbox();
        const result = runFail(sandbox, ["setup", "--json"]);
        assert.equal(result.json.error.code, "COMMAND_DEPRECATED");
        assert.deepEqual(result.json.error.details.replacements, ["init", "migrate"]);
      },
    },
  ],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
