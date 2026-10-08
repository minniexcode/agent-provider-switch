"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, runCli, runFail, runOk } = require("./sandbox");

/**
 * The token the fixture registers. Deliberately distinctive so an assertion can prove the plaintext
 * is absent rather than merely that some asterisks are present.
 */
const AUTH_TOKEN = "sk-ant-e2e-token-value";
const BASE_URL = "https://claude-provider.example";

function settingsDocument(overrides = {}) {
  return {
    model: "claude-sonnet-5",
    env: { ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN },
    theme: "dark",
    ...overrides,
  };
}

/**
 * Writes a settings file where the provider registry expects one and returns its path.
 *
 * Every path here resolves inside the sandbox: `runCli` re-verifies the three roots before each
 * child starts, and a Claude switch replaces `settings.json` wholesale.
 */
function writeSettingsFile(sandbox, name, document = settingsDocument()) {
  const file = path.join(sandbox.root, `${name}-settings.json`);
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return file;
}

function settingsPath(sandbox) {
  return path.join(sandbox.claude, "settings.json");
}

module.exports = {
  name: "Claude Code target",
  tests: [
    {
      name: "the full Claude lifecycle runs against an isolated ~/.claude",
      run() {
        const sandbox = createSandbox();
        const copilotSettings = writeSettingsFile(sandbox, "copilot");
        const zaiSettings = writeSettingsFile(
          sandbox,
          "zai",
          settingsDocument({ env: { ANTHROPIC_BASE_URL: "https://zai.example", ANTHROPIC_AUTH_TOKEN: "sk-ant-zai" } })
        );

        // Nothing registered yet, and no settings.json either: both are states the renderers
        // distinguish, so neither may be reported as a failure.
        const empty = runOk(sandbox, ["list", "--claude", "--json"]);
        assert.equal(empty.json.data.count, 0);
        const emptyHuman = runCli(sandbox, ["list", "--claude"]);
        assert.match(emptyHuman.stdout, /^No Claude providers configured\. Run `aps add --claude/m);

        const noSettings = runOk(sandbox, ["current", "--claude", "--json"]);
        assert.equal(noSettings.json.data.status, "no-settings");
        assert.equal(runCli(sandbox, ["current", "--claude"]).stdout.trim(), "No Claude Code settings.json found.");

        // A global boolean flag, so the name is a positional in every ordering. These two spellings
        // are the regression the parser work closed.
        const added = runOk(sandbox, ["add", "--claude", "copilot", "--from-file", copilotSettings, "--json"]);
        assert.equal(added.json.data.provider, "copilot");
        assert.equal(added.json.data.model, "claude-sonnet-5");

        const addedPrefixOrder = runOk(sandbox, ["--claude", "add", "zai", "--from-file", zaiSettings, "--json"]);
        assert.equal(addedPrefixOrder.json.data.provider, "zai");

        const registry = JSON.parse(fs.readFileSync(path.join(sandbox.home, "claude-providers.json"), "utf8"));
        assert.deepEqual(Object.keys(registry.providers).sort(), ["copilot", "zai"]);

        const list = runOk(sandbox, ["list", "--claude", "--json"]);
        assert.equal(list.json.data.count, 2);
        const copilot = list.json.data.providers.find((provider) => provider.name === "copilot");
        assert.equal(copilot.isActive, false);
        assert.equal(copilot.baseUrl, BASE_URL);

        const listHuman = runCli(sandbox, ["list", "--claude"]);
        assert.match(listHuman.stdout, /^Claude Code providers:$/m);
        assert.match(listHuman.stdout, new RegExp(`^  copilot model=claude-sonnet-5 base=${BASE_URL}$`, "m"));

        // Switch replaces settings.json wholesale, which is why the sandbox root is load-bearing.
        const switched = runOk(sandbox, ["switch", "copilot", "--claude", "--json"]);
        assert.equal(switched.json.data.provider, "copilot");
        assert.ok(switched.json.data.backupPath);

        const written = JSON.parse(fs.readFileSync(settingsPath(sandbox), "utf8"));
        assert.equal(written.model, "claude-sonnet-5");
        assert.equal(written.theme, "dark");
        assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, AUTH_TOKEN);

        const current = runOk(sandbox, ["current", "--claude", "--json"]);
        assert.equal(current.json.data.status, "managed");
        assert.equal(current.json.data.active, "copilot");
        assert.match(runCli(sandbox, ["current", "--claude"]).stdout, /^Active Claude provider: copilot$/m);

        const listAfter = runOk(sandbox, ["list", "--claude", "--json"]);
        assert.equal(listAfter.json.data.providers.find((p) => p.name === "copilot").isActive, true);

        const removed = runOk(sandbox, ["remove", "--claude", "zai", "--force", "--json"]);
        assert.equal(removed.json.data.provider, "zai");
        assert.equal(removed.json.data.removed, true);
        assert.match(runCli(sandbox, ["remove", "--claude", "copilot", "--force"]).stdout, /^Removed Claude provider "copilot"\.$/m);

        const finalList = runOk(sandbox, ["list", "--claude", "--json"]);
        assert.equal(finalList.json.data.count, 0);
      },
    },
    {
      name: "Claude show masks every secret value and reveals only under --reveal",
      run() {
        const sandbox = createSandbox();
        const file = writeSettingsFile(sandbox, "copilot");
        runOk(sandbox, ["add", "--claude", "copilot", "--from-file", file, "--note", "primary", "--tag", "daily", "--json"]);

        const masked = runOk(sandbox, ["show", "copilot", "--claude", "--json"]);
        assert.equal(masked.json.data.revealed, false);
        // The raw settings blob is withheld entirely rather than masked: it is opaque and nests
        // arbitrarily, so there is no reliable rule for which of its values are credentials.
        assert.equal(masked.json.data.settings, undefined, "the raw settings blob must not be returned");
        assert.notEqual(masked.json.data.env.ANTHROPIC_AUTH_TOKEN, AUTH_TOKEN);
        assert.match(masked.json.data.env.ANTHROPIC_AUTH_TOKEN, /^sk-\*+/);
        // A non-secret key is left alone, so the mask is targeted rather than blanket.
        assert.equal(masked.json.data.env.ANTHROPIC_BASE_URL, BASE_URL);
        assert.equal(masked.json.data.note, "primary");
        assert.deepEqual(masked.json.data.tags, ["daily"]);

        const maskedHuman = runCli(sandbox, ["show", "copilot", "--claude"]);
        assert.equal(maskedHuman.status, 0);
        assert.doesNotMatch(maskedHuman.stdout, new RegExp(AUTH_TOKEN), "the plaintext must not reach stdout");
        assert.match(maskedHuman.stdout, /^    ANTHROPIC_BASE_URL=https:\/\/claude-provider\.example$/m);
        assert.match(maskedHuman.stdout, /^  \(secret values masked; pass --reveal to print them\)$/m);

        const revealed = runOk(sandbox, ["show", "copilot", "--claude", "--reveal", "--json"]);
        assert.equal(revealed.json.data.revealed, true);
        assert.equal(revealed.json.data.env.ANTHROPIC_AUTH_TOKEN, AUTH_TOKEN);
        assert.equal(revealed.json.data.settings.model, "claude-sonnet-5");

        const revealedHuman = runCli(sandbox, ["show", "copilot", "--claude", "--reveal"]);
        assert.match(revealedHuman.stdout, new RegExp(`^    ANTHROPIC_AUTH_TOKEN=${AUTH_TOKEN}$`, "m"));
        assert.doesNotMatch(revealedHuman.stdout, /secret values masked/);
      },
    },
    {
      name: "Claude commands refuse the invocations that would write the wrong thing",
      run() {
        const sandbox = createSandbox();
        const file = writeSettingsFile(sandbox, "copilot");

        // No name and no --from-file, both non-interactive, so both are refusals rather than prompts.
        const noName = runFail(sandbox, ["add", "--claude", "--json"]);
        assert.equal(noName.json.error.code, "INVALID_ARGUMENT");
        assert.match(noName.json.error.message, /requires a provider name/);

        const noFile = runFail(sandbox, ["add", "--claude", "copilot", "--json"]);
        assert.equal(noFile.json.error.code, "INVALID_ARGUMENT");
        assert.match(noFile.json.error.message, /requires --from-file/);

        const missingFile = runFail(sandbox, ["add", "--claude", "copilot", "--from-file", path.join(sandbox.root, "nope.json"), "--json"]);
        assert.equal(missingFile.json.error.code, "INVALID_ARGUMENT");
        assert.match(missingFile.json.error.message, /Settings file not found/);

        const malformed = path.join(sandbox.root, "malformed.json");
        fs.writeFileSync(malformed, "{ not json", "utf8");
        const unparseable = runFail(sandbox, ["add", "--claude", "copilot", "--from-file", malformed, "--json"]);
        assert.equal(unparseable.json.error.code, "INVALID_ARGUMENT");
        assert.match(unparseable.json.error.message, /Failed to parse settings file/);

        const arrayDocument = path.join(sandbox.root, "array.json");
        fs.writeFileSync(arrayDocument, "[]", "utf8");
        const notAnObject = runFail(sandbox, ["add", "--claude", "copilot", "--from-file", arrayDocument, "--json"]);
        assert.equal(notAnObject.json.error.code, "INVALID_ARGUMENT");
        assert.match(notAnObject.json.error.message, /must contain a JSON object/);

        runOk(sandbox, ["add", "--claude", "copilot", "--from-file", file, "--json"]);
        const duplicate = runFail(sandbox, ["add", "--claude", "copilot", "--from-file", file, "--json"]);
        assert.equal(duplicate.json.error.code, "CLAUDE_PROVIDER_ALREADY_EXISTS");
        assert.match(duplicate.json.error.details.suggestion, /aps remove --claude/);
        // The refusal must not have written anything, so the registry still holds exactly one.
        const registry = JSON.parse(fs.readFileSync(path.join(sandbox.home, "claude-providers.json"), "utf8"));
        assert.deepEqual(Object.keys(registry.providers), ["copilot"]);

        // A removal that was not asked for is refused rather than prompted.
        const noForce = runFail(sandbox, ["remove", "--claude", "copilot", "--json"]);
        assert.equal(noForce.json.error.code, "INVALID_ARGUMENT");
        assert.match(noForce.json.error.message, /requires --force/);

        const absent = runFail(sandbox, ["remove", "--claude", "ghost", "--force", "--json"]);
        assert.equal(absent.json.error.code, "CLAUDE_PROVIDER_NOT_FOUND");
        assert.deepEqual(absent.json.error.details.availableProviders, ["copilot"]);

        const ghostSwitch = runFail(sandbox, ["switch", "ghost", "--claude", "--json"]);
        assert.equal(ghostSwitch.json.error.code, "CLAUDE_PROVIDER_NOT_FOUND");
        assert.deepEqual(ghostSwitch.json.error.details.availableProviders, ["copilot"]);

        const ghostShow = runFail(sandbox, ["show", "ghost", "--claude", "--json"]);
        assert.equal(ghostShow.json.error.code, "CLAUDE_PROVIDER_NOT_FOUND");

        // `--claude` is not a wildcard: a command outside the supported set rejects it rather than
        // silently running the Codex path, which would report Codex state under a Claude flag.
        const unsupported = runFail(sandbox, ["status", "--claude", "--json"]);
        assert.equal(unsupported.json.error.code, "INVALID_ARGUMENT");
        assert.equal(unsupported.json.error.details.command, "status");
        assert.deepEqual(unsupported.json.error.details.supportedCommands, [
          "add",
          "current",
          "list",
          "remove",
          "show",
          "switch",
        ]);

        // Nothing above may have reached the real settings.json — there is not one to reach.
        assert.equal(fs.existsSync(settingsPath(sandbox)), false);
      },
    },
  ],
};
