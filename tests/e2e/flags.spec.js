"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, repoRoot, runCli, runFail, runOk, seedCodex } = require("./sandbox");

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
  name: "documented flags",
  tests: [
    {
      name: "--version and -v print the packaged version and exit 0",
      run() {
        const sandbox = createSandbox();
        const version = require(path.join(repoRoot, "package.json")).version;

        for (const flag of ["--version", "-v"]) {
          const result = runCli(sandbox, [flag]);
          assert.equal(result.status, 0, `${flag} must exit 0`);
          assert.equal(result.stdout.trim(), version, `${flag} must print the packaged version`);
        }
      },
    },
    {
      name: "-h prints help for the command it follows",
      run() {
        const sandbox = createSandbox();

        const top = runCli(sandbox, ["-h"]);
        assert.equal(top.status, 0);
        assert.match(top.stdout, /^agent-provider-switch$/m);

        // Symmetric with the `help <topic>` subcommand, which is what makes the short form a
        // usable alias rather than a second, thinner help surface.
        const topic = runCli(sandbox, ["add", "-h"]);
        assert.equal(topic.status, 0);
        assert.match(topic.stdout, /^aps add$/m);
        assert.match(topic.stdout, /^Usage:$/m);
      },
    },
    {
      name: "--note and --tag are stored, editable, and rendered",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        addProvider(sandbox, "gamma", ["--note", "primary", "--tag", "daily", "--tag", "paid"]);

        const stored = runOk(sandbox, ["show", "gamma", "--json"]);
        assert.equal(stored.json.data.provider.note, "primary");
        assert.deepEqual(stored.json.data.provider.tags, ["daily", "paid"]);

        const humanStored = runCli(sandbox, ["show", "gamma"]);
        assert.match(humanStored.stdout, /^note: primary$/m);
        assert.match(humanStored.stdout, /^tags: daily, paid$/m);

        // A second --tag on edit appends rather than replacing; --note replaces.
        const edited = runOk(sandbox, ["edit", "gamma", "--note", "revised", "--tag", "extra", "--json"]);
        assert.ok(edited.json.data.updatedFields.includes("note"));
        assert.ok(edited.json.data.updatedFields.includes("tags"));

        const after = runOk(sandbox, ["show", "gamma", "--json"]);
        assert.equal(after.json.data.provider.note, "revised");
        assert.ok(after.json.data.provider.tags.includes("extra"));

        // `list` renders both, which is the only place they appear together.
        const list = runCli(sandbox, ["list"]);
        assert.match(list.stdout, /note=revised/);
        assert.match(list.stdout, /tags=/);
      },
    },
    {
      name: "--create-profile creates a legacy profiles section on add",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        // Without the flag the command projects only model_providers sections.
        const plain = addProvider(sandbox, "plain");
        assert.deepEqual(plain.json.data.createdProfileSections, []);

        const withProfile = addProvider(sandbox, "legacy", ["--create-profile"]);
        assert.deepEqual(withProfile.json.data.createdProfileSections, ["legacy"]);

        const config = fs.readFileSync(path.join(sandbox.codex, "config.toml"), "utf8");
        assert.match(config, /^\[profiles\.legacy\]$/m);
        assert.doesNotMatch(config, /^\[profiles\.plain\]$/m);

        // And the reverse: a profile section can be created for an existing provider on edit.
        const edited = runOk(sandbox, ["edit", "plain", "--create-profile", "--json"]);
        assert.deepEqual(edited.json.data.createdProfileSections, ["plain"]);
      },
    },
    {
      name: "--switch-to lets the active provider be removed",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");
        addProvider(sandbox, "spare");
        runOk(sandbox, ["switch", "gamma", "--json"]);

        // Removing the active route is refused without a replacement...
        const refused = runFail(sandbox, ["remove", "gamma", "--force", "--json"]);
        assert.equal(refused.json.error.code, "PROFILE_IN_USE");
        assert.deepEqual(refused.json.error.details.linkedProviders, ["gamma"]);

        // ...and accepted when one is named, which is the flag's whole purpose.
        const removed = runOk(sandbox, ["remove", "gamma", "--force", "--switch-to", "spare", "--json"]);
        assert.equal(removed.json.data.provider, "gamma");

        const current = runOk(sandbox, ["current", "--json"]);
        assert.equal(current.json.data.modelProvider, "spare");
      },
    },
    {
      name: "--reveal affects Claude output only, as the help text states",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        addProvider(sandbox, "gamma");

        // The global help scopes --reveal to Claude provider show, so on the Codex path it must
        // change nothing. Accepting the flag and quietly honouring it would be the bug.
        const masked = runCli(sandbox, ["show", "gamma"]);
        const revealed = runCli(sandbox, ["show", "gamma", "--reveal"]);
        assert.equal(revealed.status, 0);
        assert.equal(revealed.stdout, masked.stdout, "--reveal must not alter Codex human output");
        assert.doesNotMatch(revealed.stdout, /sk-gamma/);
      },
    },
    {
      name: "--keep bounds what a prune removes and is validated",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });
        for (const name of ["alpha", "beta", "gamma", "delta"]) {
          addProvider(sandbox, name);
        }

        const pruned = runOk(sandbox, ["backups", "prune", "--keep", "2", "--json"]);
        assert.equal(pruned.json.data.keep, 2);
        assert.equal(pruned.json.data.removedCount, 2);
        assert.equal(pruned.json.data.removed.length, 2);

        // A bare `--keep` parses as the literal "true", which must not reach the retention math.
        const bare = runFail(sandbox, ["backups", "prune", "--keep", "--json"]);
        assert.equal(bare.json.error.code, "INVALID_ARGUMENT");
      },
    },
    {
      name: "migrate rejects --merge together with --overwrite",
      run() {
        const sandbox = createSandbox();
        seedCodex(sandbox, { modelProvider: "freemodel" });

        const both = runFail(sandbox, [
          "migrate",
          "--codex-dir",
          sandbox.codex,
          "--merge",
          "--overwrite",
          "--json",
        ]);
        assert.equal(both.json.error.code, "INVALID_ARGUMENT");
      },
    },
  ],
};
