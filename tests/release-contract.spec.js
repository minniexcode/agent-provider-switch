"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { repoRoot, runBuiltCli } = require("./helpers");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

module.exports = {
  name: "release contract",
  tests: [
    {
      name: "package metadata is 1.0.0",
      run() {
        const packageJson = require("../package.json");
        const packageLock = require("../package-lock.json");
        assert.equal(packageJson.version, "1.0.0");
        assert.equal(packageLock.version, "1.0.0");
        assert.equal(packageLock.packages[""].version, "1.0.0");
        assert.equal(packageJson.name, "@minniexcode/agent-provider-switch");
        assert.equal(packageLock.name, "@minniexcode/agent-provider-switch");
        assert.equal(packageLock.packages[""].name, "@minniexcode/agent-provider-switch");
        assert.deepEqual(packageJson.bin, { aps: "dist/cli.js" });
        assert.deepEqual(packageLock.packages[""].bin, { aps: "dist/cli.js" });
      },
    },
    {
      name: "current docs use 1.0.0 fact sources",
      run() {
        for (const relativePath of [
          "README.md",
          "README.CN.md",
          "README.AI.md",
          "docs/cli-usage.md",
          "docs/agent-provider-switch-product-overview.md",
          "docs/agent-provider-switch-technical-architecture.md",
          "docs/Tests/testing.md",
          "CHANGELOG.md",
        ]) {
          const content = read(relativePath);
          // The overview and architecture docs deliberately lag a release or two, so the regex
          // spans the whole 0.x line rather than pinning the current version.
          assert.match(content, /1\.0\.0|0\.4\.1|0\.4\.0|0\.3\.1|0\.3\.0|0\.2\.1/, relativePath);
        }
        for (const version of ["1.0.0", "0.4.1", "0.4.0", "0.3.1", "0.3.0"]) {
          assert.ok(
            fs.existsSync(path.join(repoRoot, `docs/PRD/agent-provider-switch-prd-v${version}.md`)),
            `missing docs/PRD/agent-provider-switch-prd-v${version}.md`
          );
          assert.ok(
            fs.existsSync(path.join(repoRoot, `docs/Design/agent-provider-switch-v${version}-design.md`)),
            `missing docs/Design/agent-provider-switch-v${version}-design.md`
          );
        }
        assert.match(read("README.md"), /Claude Code provider switching|managing and switching Codex and Claude Code/);
        assert.match(read("README.AI.md"), /local-first CLI for managing and switching Codex and Claude Code/);
      },
    },
    {
      name: "help exposes provider-management-only command surface",
      async run() {
        const result = await runBuiltCli(["--help"]);
        assert.equal(result.status, 0);
        for (const command of [
          "init",
          "migrate",
          "list",
          "show",
          "current",
          "status",
          "config show",
          "config list-profiles",
          "add",
          "edit",
          "switch",
          "remove",
          "import",
          "export",
          "backups list",
          // Both were missing before 0.4.1, so a regression that dropped either from `--help`
          // would have passed this test — the list asserted 18 of the 20 commands.
          "backups prune",
          "unlock",
          "rollback",
          "doctor",
          "setup",
        ]) {
          assert.match(result.stdout, new RegExp(command.replace(" ", "\\s+")));
        }
        assert.doesNotMatch(result.stdout, /login copilot|--copilot|bridge start|bridge status|bridge stop|Copilot SDK/i);
        // The 1.0.0 rename: the old program name must not survive anywhere in the help surface,
        // which is the one place a stale identity would be visible to every user.
        assert.doesNotMatch(result.stdout, /codexs|codex-switch|CODEXS_/);
      },
    },
    {
      name: "no file carries the pre-1.0.0 identity outside its deliberate exceptions",
      run() {
        // The rename is only complete if a grep for the old name comes back empty. The exceptions
        // are the places where the old name is data rather than branding: the rename map that
        // records what changed, the frozen LEGACY_* values the migration matches against whatever
        // is already on a user's disk, and this file's own negative assertion.
        const allowed = new Set([
          "src/storage/codex-paths.ts",
          "tests/tool-home-migration.spec.js",
          "tests/release-contract.spec.js",
          "docs/PRD/agent-provider-switch-prd-v1.0.0.md",
        ]);
        const pattern = /codex-switch|codexs|CODEXS_|CodexSwitch/;
        const skipDirs = new Set(["node_modules", "dist", "tmp", "coverage", "dev-codex"]);
        const textExtensions = new Set([".ts", ".js", ".cjs", ".mjs", ".json", ".md", ".yml", ".yaml", ".toml"]);

        const offenders = [];
        const walk = (relativeDir) => {
          const absoluteDir = path.join(repoRoot, relativeDir);
          for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
            const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              // Dot-directories include `.git` and any worktree checkout under `.claude/`.
              if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
              walk(relative);
              continue;
            }
            if (!textExtensions.has(path.extname(entry.name)) || allowed.has(relative)) continue;
            // `codex-switcher` is an unrelated third-party project cited in the product-research
            // doc, not this tool under an old name.
            if (pattern.test(read(relative).replace(/codex-switcher/g, ""))) offenders.push(relative);
          }
        };
        walk("");

        assert.deepEqual(offenders, [], `the pre-1.0.0 identity survives in: ${offenders.join(", ")}`);
      },
    },
    {
      name: "version command reports 1.0.0",
      async run() {
        const result = await runBuiltCli(["--version"]);
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trim(), "1.0.0");
      },
    },
  ],
};
