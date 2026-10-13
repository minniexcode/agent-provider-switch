"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  makeCodexFixture,
  withClaudeEnv,
  runJsonCli,
} = require("./helpers");

const {
  classifyBackupTargets,
  labelBackupTargets,
  restoreImpactOf,
  targetsRestoredBy,
  validateBackupManifest,
} = require("../dist/domain/backups.js");

/**
 * Three sibling roots under a fake prefix, so containment answers are readable rather than
 * dependent on the machine. `aps-home` is deliberately a *sibling* of the two runtime roots: it is
 * not inside either, which is the fact the classification depends on.
 */
const ROOTS = {
  codexDir: path.join(os.tmpdir(), "aps-roots", "codex"),
  claudeDir: path.join(os.tmpdir(), "aps-roots", "claude"),
  toolHomeDir: path.join(os.tmpdir(), "aps-roots", "home"),
};

/**
 * A manifest with the fields the classification reads. `target` is omitted by default, which is
 * what a pre-`1.1.3` manifest looks like.
 */
function manifest({ reason, files = [], target }) {
  return {
    version: 1,
    createdAt: new Date(0).toISOString(),
    reason,
    backupDir: path.join(ROOTS.toolHomeDir, "backups", "20260101-000000000-000"),
    ...(target ? { target } : {}),
    files: files.map((restorePath) => ({
      relativePath: path.basename(restorePath),
      restorePath,
      existed: true,
      backupFileName: path.basename(restorePath),
    })),
  };
}

module.exports = {
  name: "backup targets",
  tests: [
    {
      name: "a recorded target is the answer, whatever the manifest also looks like",
      run() {
        // The order that matters as soon as the first manifest written by this release is read: a
        // record left by a hand-edited `reason` must not be able to move the label.
        assert.deepEqual(
          classifyBackupTargets(
            manifest({ reason: "claude-switch", target: "codex", files: [path.join(ROOTS.claudeDir, "settings.json")] }),
            ROOTS
          ),
          ["codex"]
        );
      },
    },
    {
      name: "the operation name answers for every manifest written before this release",
      run() {
        // The fallback that makes the change backward compatible: every Claude mutation already
        // names its operation `claude-*`, and every Codex one uses an unprefixed name.
        for (const reason of ["claude-add", "claude-switch", "claude-remove", "claude-config-compact"]) {
          assert.deepEqual(classifyBackupTargets(manifest({ reason }), ROOTS), ["claude"], reason);
        }

        for (const reason of ["add", "switch", "remove", "edit", "import", "migrate"]) {
          assert.deepEqual(classifyBackupTargets(manifest({ reason }), ROOTS), ["codex"], reason);
        }
      },
    },
    {
      name: "the artifact name answers inside the tool home, and containment decides only outside it",
      run() {
        // The case the classification exists for. A Claude backup holds `claude-providers.json` in
        // the tool home *and* `settings.json` in the Claude directory, so a rule that read the tool
        // home as the Codex side would file a Claude backup as Codex — the label `rollback` reads.
        const mixedHome = manifest({
          reason: "backfill",
          files: [
            path.join(ROOTS.toolHomeDir, "claude-providers.json"),
            path.join(ROOTS.claudeDir, "settings.json"),
          ],
        });
        assert.deepEqual(classifyBackupTargets(mixedHome, ROOTS), ["claude"]);

        // A registry in the tool home on its own is classified, and by its *name* rather than by
        // where it sits: `providers.json` is Codex's registry and `claude-providers.json` is
        // Claude's, and the tool home belongs to neither target. Containment alone would have to
        // pick a side for a directory that is on both, which is why the name is read here.
        const codexRegistry = manifest({ reason: "backfill", files: [path.join(ROOTS.toolHomeDir, "providers.json")] });
        assert.deepEqual(classifyBackupTargets(codexRegistry, ROOTS), ["codex"]);
        const claudeRegistry = manifest({
          reason: "backfill",
          files: [path.join(ROOTS.toolHomeDir, "claude-providers.json")],
        });
        assert.deepEqual(classifyBackupTargets(claudeRegistry, ROOTS), ["claude"]);

        // The two registries in one manifest is `mixed`, which is reachable from names alone — no
        // operation writes both today, but the answer follows the files rather than the operation.
        const bothRegistries = manifest({
          reason: "backfill",
          files: [
            path.join(ROOTS.toolHomeDir, "providers.json"),
            path.join(ROOTS.toolHomeDir, "claude-providers.json"),
          ],
        });
        assert.deepEqual(classifyBackupTargets(bothRegistries, ROOTS), ["codex", "claude"]);

        // An unrecognised name in the tool home classifies nothing, and `unknown` is the honest
        // answer: containment there would have to guess whose directory it is.
        const unknownHome = manifest({ reason: "backfill", files: [path.join(ROOTS.toolHomeDir, "notes.txt")] });
        assert.deepEqual(classifyBackupTargets(unknownHome, ROOTS), []);
        assert.equal(labelBackupTargets(classifyBackupTargets(unknownHome, ROOTS)), "unknown");

        // Outside the tool home, containment is what answers: a runtime file the name table does
        // not know is attributed to the root it sits in.
        assert.deepEqual(
          classifyBackupTargets(manifest({ reason: "backfill", files: [path.join(ROOTS.codexDir, "config.toml")] }), ROOTS),
          ["codex"]
        );
      },
    },
    {
      name: "both trees at once is mixed, and a sibling directory is not a containment",
      run() {
        // `mixed` is reachable rather than theoretical once both arms are asked and the two answers
        // are unioned. No single operation writes both trees today, so this is the defensive read
        // of a manifest this tool cannot produce — which is why it is a label and not a guess.
        const both = manifest({
          reason: "backfill",
          files: [
            path.join(ROOTS.claudeDir, "settings.json"),
            path.join(ROOTS.codexDir, "auth.json"),
          ],
        });
        assert.deepEqual(classifyBackupTargets(both, ROOTS), ["codex", "claude"]);
        assert.equal(labelBackupTargets(classifyBackupTargets(both, ROOTS)), "mixed");

        // A prefix match would call this inside `.../claude`. It is a different directory, and it is
        // exactly the check that keeps a backup for one root from being attributed to another.
        const sibling = manifest({
          reason: "backfill",
          files: [path.join(path.dirname(ROOTS.claudeDir), "claude-old", "settings.json")],
        });
        assert.deepEqual(classifyBackupTargets(sibling, ROOTS), []);

        // A root is not inside itself: a directory is never a backup entry, so an entry that names
        // one is not a containment claim about the tree under it.
        const rootItself = manifest({ reason: "backfill", files: [ROOTS.claudeDir] });
        assert.deepEqual(classifyBackupTargets(rootItself, ROOTS), []);
      },
    },
    {
      name: "the label collapses a target list, and unknown is not a third target",
      run() {
        assert.equal(labelBackupTargets([]), "unknown");
        assert.equal(labelBackupTargets(["codex"]), "codex");
        assert.equal(labelBackupTargets(["claude"]), "claude");
        assert.equal(labelBackupTargets(["codex", "claude"]), "mixed");
      },
    },
    {
      name: "what a backup belongs to and what a restore overwrites are answered separately",
      run() {
        // The disagreement the two functions exist to keep apart. A manifest that records one
        // target and holds another's files is what a hand-edited or mislabelled manifest looks
        // like, and the two questions have to give different answers to it: `backups list` labels
        // the *operation* and reports what the metadata says, while `rollback` reports what its
        // file paths will actually overwrite. Believing the metadata for both would tell a user
        // their Claude settings file was untouched Codex state.
        const conflicted = manifest({
          reason: "claude-switch",
          target: "codex",
          files: [path.join(ROOTS.claudeDir, "settings.json")],
        });
        assert.deepEqual(classifyBackupTargets(conflicted, ROOTS), ["codex"], "the recorded target labels the entry");
        assert.deepEqual(targetsRestoredBy(conflicted, ROOTS), ["claude"], "the paths decide what a restore touches");

        // Metadata is not consulted at all, in either direction: an operation name that says Codex
        // over a Claude path is the same conflict as an explicit `target` saying it.
        const byReason = manifest({ reason: "switch", files: [path.join(ROOTS.claudeDir, "settings.json")] });
        assert.deepEqual(classifyBackupTargets(byReason, ROOTS), ["codex"]);
        assert.deepEqual(targetsRestoredBy(byReason, ROOTS), ["claude"]);

        // Both trees accumulate, so a restore that writes both reports both.
        const bothTrees = manifest({
          reason: "backfill",
          files: [path.join(ROOTS.claudeDir, "settings.json"), path.join(ROOTS.codexDir, "config.toml")],
        });
        assert.deepEqual(targetsRestoredBy(bothTrees, ROOTS), ["codex", "claude"]);

        // Registry-only, which is what an `add` snapshot looks like: nothing under either runtime
        // root, and the registry itself in the tool home. The restore still overwrites Claude's
        // stored records — `claude-providers.json` is Claude state, and `rollback` rewrites it — so
        // the impact is Claude's. Answering `[]` here would report a completed registry restore as
        // recovery of nothing, and the operation name would then be the only thing left to read.
        const registryOnly = manifest({
          reason: "claude-add",
          files: [path.join(ROOTS.toolHomeDir, "claude-providers.json")],
        });
        assert.deepEqual(targetsRestoredBy(registryOnly, ROOTS), ["claude"]);
        assert.deepEqual(classifyBackupTargets(registryOnly, ROOTS), ["claude"]);
      },
    },
    {
      name: "a restore impact names both axes, including the ones that are not a target",
      run() {
        // `targets: []` is three different statements, and the axes are what tell them apart. This
        // is a restore of the shared tool config and nothing else — a real recovery, of state both
        // targets own, that a target list alone would render as "nothing happened".
        assert.deepEqual(
          restoreImpactOf(
            manifest({ reason: "init", files: [path.join(ROOTS.toolHomeDir, "agent-provider-switch.json")] }),
            ROOTS
          ),
          { targets: [], impact: { shared: true, unknown: false } }
        );

        // A path with neither a recognised name nor a root is `unknown`: the restore will write
        // somewhere, and where is not known. Reported rather than dropped, because a caller that
        // saw only `targets: []` would conclude the opposite.
        assert.deepEqual(
          restoreImpactOf(manifest({ reason: "backfill", files: [path.join(os.tmpdir(), "elsewhere", "config.toml")] }), ROOTS),
          { targets: [], impact: { shared: false, unknown: true } }
        );

        // Both axes at once, and a target beside them: the three answers are independent.
        assert.deepEqual(
          restoreImpactOf(
            manifest({
              reason: "backfill",
              files: [
                path.join(ROOTS.toolHomeDir, "agent-provider-switch.json"),
                path.join(ROOTS.codexDir, "config.toml"),
                path.join(os.tmpdir(), "elsewhere", "settings.json"),
              ],
            }),
            ROOTS
          ),
          { targets: ["codex"], impact: { shared: true, unknown: true } }
        );

        // Overlapping roots accumulate instead of picking a winner. `codexDir` nested inside
        // `claudeDir` is a layout `APS_HOME` and `APS_CODEX_DIR` can genuinely produce, and the
        // path is inside both — so a restore from it touches both, and a first-match answer would
        // understate what it overwrote.
        const nested = {
          codexDir: path.join(ROOTS.claudeDir, "codex"),
          claudeDir: ROOTS.claudeDir,
          toolHomeDir: ROOTS.toolHomeDir,
        };
        assert.deepEqual(
          restoreImpactOf(manifest({ reason: "backfill", files: [path.join(nested.codexDir, "config.toml")] }), nested),
          { targets: ["codex", "claude"], impact: { shared: false, unknown: false } }
        );

        // The registry does not absorb the overlap: the name decides on its own, so a nested
        // `providers.json` is Codex's and is not also credited to the root it happens to sit in.
        assert.deepEqual(
          restoreImpactOf(
            manifest({ reason: "backfill", files: [path.join(nested.codexDir, "providers.json")] }),
            nested
          ),
          { targets: ["codex"], impact: { shared: false, unknown: false } }
        );
      },
    },
    {
      name: "a manifest may not declare a target the label enum does not have",
      run() {
        // `target` is a known field now, so a known field does not get to skip validation just
        // because older manifests lack it. `mixed` and `unknown` are labels `backups list`
        // *derives*; a manifest that declared one would be labelling itself.
        //
        // Built by assignment rather than through the `manifest()` helper: that helper omits the
        // key for a falsy value, which would quietly turn an empty-string case into the
        // absent-field case and make this loop assert nothing.
        const declaredTarget = (declared) => ({ ...manifest({ reason: "switch" }), target: declared });
        for (const declared of ["mixed", "unknown", "CODEX", ""]) {
          assert.throws(
            () => validateBackupManifest(declaredTarget(declared)),
            /target must be "codex" or "claude"/,
            `a declared target of ${JSON.stringify(declared)} must be refused`
          );
        }

        // The two legal values, and the absent field, all pass: this release reads manifests it
        // did not write.
        for (const declared of ["codex", "claude"]) {
          assert.equal(validateBackupManifest(declaredTarget(declared)).target, declared);
        }
        assert.equal(validateBackupManifest(manifest({ reason: "switch" })).target, undefined);
      },
    },
    {
      name: "backups list labels each entry, and a flag narrows the listing to that target",
      async run() {
        await withClaudeEnv({ env: { ANTHROPIC_AUTH_TOKEN: "sk-test-token" } }, async ({ toolHomeDir, importFile }) => {
          // Both targets in one tool home, which is the point: they share one backups tree and one
          // pointer, so a listing that does not label its entries cannot tell a caller what a
          // rollback would restore.
          fs.writeFileSync(
            path.join(toolHomeDir, "providers.json"),
            `${JSON.stringify(
              {
                providers: {
                  alpha: {
                    profile: "packycode",
                    apiKey: "sk-fixture",
                    model: "gpt-5",
                    baseUrl: "https://relay.example.com/v1",
                  },
                },
              },
              null,
              2
            )}\n`,
            "utf8"
          );
          const codexDir = makeCodexFixture({ modelProvider: "packycode" });

          const codexSwitch = await runJsonCli({
            toolHomeDir,
            args: ["switch", "alpha", "--codex-dir", codexDir, "--json"],
          });
          assert.equal(codexSwitch.status, 0, codexSwitch.stderr);

          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "beta", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);
          const claudeSwitch = await runJsonCli({
            toolHomeDir,
            args: ["switch", "--claude", "beta", "--json"],
          });
          assert.equal(claudeSwitch.status, 0, claudeSwitch.stderr);

          const listed = await runJsonCli({ toolHomeDir, args: ["backups", "list", "--json"] });
          assert.equal(listed.status, 0, listed.stderr);
          assert.equal(listed.payload.targets.length, 2, "a bare list covers both targets");
          assert.equal(listed.payload.target, null);

          // Three snapshots, because every mutation takes one: `add --claude` and `switch --claude`
          // are two writes, and each of them backs the files up before it writes. Every label is
          // still a single target — this release has no operation that produces `mixed`.
          const labels = listed.payload.data.backups.map((backup) => backup.target).sort();
          assert.deepEqual(labels, ["claude", "claude", "codex"]);
          assert.equal(listed.payload.data.count, 3);

          // The label is a summary field, and the manifest the entry came from still carries the
          // recorded target — the fallbacks above are for manifests that predate it.
          const claudeEntry = listed.payload.data.backups.find((backup) => backup.target === "claude");
          const manifestOnDisk = JSON.parse(
            fs.readFileSync(path.join(claudeEntry.backupPath, "manifest.json"), "utf8")
          );
          assert.equal(manifestOnDisk.target, "claude");

          const onlyCodex = await runJsonCli({ toolHomeDir, args: ["backups", "list", "--codex", "--json"] });
          assert.equal(onlyCodex.status, 0, onlyCodex.stderr);
          assert.deepEqual(onlyCodex.payload.targets, ["codex"]);
          assert.deepEqual(onlyCodex.payload.data.backups.map((backup) => backup.target), ["codex"]);

          const onlyClaude = await runJsonCli({ toolHomeDir, args: ["backups", "list", "--claude", "--json"] });
          assert.equal(onlyClaude.status, 0, onlyClaude.stderr);
          assert.deepEqual(onlyClaude.payload.targets, ["claude"]);
          assert.deepEqual(onlyClaude.payload.data.backups.map((backup) => backup.target), ["claude", "claude"]);
          assert.equal(onlyClaude.payload.data.count, 2);
        });
      },
    },
    {
      name: "a narrowed listing keeps every entry that touched the target, and drops the one nothing can",
      async run() {
        // Written by hand, because `mixed` and `unknown` are reads of manifests this tool never
        // writes: no operation today touches both trees, and the classifier refuses to invent a
        // label for a path it cannot place. Both are exactly the entries a filter has to have an
        // opinion about, so they are the ones a filter test needs.
        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir }) => {
          const backupsDir = path.join(toolHomeDir, "backups");
          const write = (id, reason, files) => {
            const dir = path.join(backupsDir, id);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
              path.join(dir, "manifest.json"),
              `${JSON.stringify(
                {
                  version: 1,
                  createdAt: new Date(Number(id.slice(-3)) * 1000).toISOString(),
                  reason,
                  backupDir: dir,
                  files: files.map((restorePath) => ({
                    relativePath: path.basename(restorePath),
                    restorePath,
                    existed: true,
                    backupFileName: path.basename(restorePath),
                  })),
                },
                null,
                2
              )}\n`,
              "utf8"
            );
          };

          write("20260101-000000000-001", "backfill", [
            path.join(toolHomeDir, "providers.json"),
            path.join(toolHomeDir, "claude-providers.json"),
          ]);
          write("20260101-000000000-002", "backfill", [
            path.join(path.dirname(toolHomeDir), "elsewhere", "settings.json"),
          ]);

          const all = await runJsonCli({ toolHomeDir, args: ["backups", "list", "--json"] });
          assert.equal(all.status, 0, all.stderr);
          assert.deepEqual(
            all.payload.data.backups.map((backup) => backup.target).sort(),
            ["mixed", "unknown"],
            "the unfiltered list is the only place an unplaceable entry appears"
          );

          // The rule this test exists for, in one assertion pair: `mixed` is in *both* narrowed
          // lists, because it is an entry that touched each of them, and omitting it would hide the
          // backup whose restore overwrites both targets. `unknown` is in neither: showing it under
          // a target heading would assert a membership nothing established.
          for (const flag of ["--codex", "--claude"]) {
            const narrowed = await runJsonCli({ toolHomeDir, args: ["backups", "list", flag, "--json"] });
            assert.equal(narrowed.status, 0, narrowed.stderr);
            assert.deepEqual(narrowed.payload.targets, [flag.slice(2)]);
            assert.deepEqual(
              narrowed.payload.data.backups.map((backup) => backup.target),
              ["mixed"],
              `backups list ${flag} must keep the mixed entry and drop the unknown one`
            );
          }
        });
      },
    },
    {
      name: "rollback is shared state: it restores the newest backup and says which target wrote it",
      async run() {
        await withClaudeEnv({ env: { ANTHROPIC_AUTH_TOKEN: "sk-test-token" } }, async ({ toolHomeDir, importFile }) => {
          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "beta", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);

          // One backup, written by a Claude mutation. `rollback` takes no target flag, so the
          // question is not which target to restore but which snapshot is newest — and today that
          // is a Claude one, in a run the caller did not qualify.
          const switched = await runJsonCli({
            toolHomeDir,
            args: ["switch", "--claude", "beta", "--json"],
          });
          assert.equal(switched.status, 0, switched.stderr);

          for (const flag of ["--claude", "--codex"]) {
            const refused = await runJsonCli({ toolHomeDir, args: ["rollback", flag, "--json"] });
            assert.equal(refused.status, 1, `rollback ${flag} must be refused`);
            assert.equal(refused.payload.error.code, "INVALID_ARGUMENT");
            assert.match(refused.payload.error.message, /operates on state every target shares/);
            assert.match(refused.payload.error.message, new RegExp(`cannot be narrowed with ${flag}`));
          }

          const rolled = await runJsonCli({ toolHomeDir, args: ["rollback", "--json"] });
          assert.equal(rolled.status, 0, rolled.stderr);
          assert.deepEqual(
            rolled.payload.data.targets,
            ["claude"],
            "the payload must say which target the restored snapshot came from"
          );
          // The second axis, and the reason it is carried: a `switch` snapshot holds settings.json
          // and nothing shared, so both flags are false — which is a different report from a
          // registry-only restore that names a target and touches no runtime file.
          assert.deepEqual(rolled.payload.data.impact, { shared: false, unknown: false });
        });
      },
    },
    {
      name: "rollback reports what it overwrote, not what the manifest claims",
      async run() {
        // End to end, because the two questions being separate is only worth anything if the CLI
        // asks the right one. The manifest is written by hand: nothing this tool produces records a
        // target that disagrees with its own files, so a hand-edited manifest is the only way to
        // state the conflict, and it is exactly the case where a metadata-first answer lies.
        await withClaudeEnv({}, async ({ toolHomeDir, claudeDir }) => {
          const backupId = "20260101-000000000-000";
          const backupPath = path.join(toolHomeDir, "backups", backupId);
          fs.mkdirSync(backupPath, { recursive: true });

          const settingsPath = path.join(claudeDir, "settings.json");
          fs.mkdirSync(claudeDir, { recursive: true });
          fs.writeFileSync(settingsPath, `${JSON.stringify({ model: "sonnet" })}\n`, "utf8");

          fs.writeFileSync(
            path.join(backupPath, "manifest.json"),
            `${JSON.stringify(
              {
                version: 1,
                createdAt: new Date(0).toISOString(),
                reason: "switch",
                backupDir: backupPath,
                target: "codex",
                files: [
                  {
                    relativePath: "settings.json",
                    restorePath: settingsPath,
                    // The pre-mutation state: the file was not there, so the restore removes it.
                    existed: false,
                    backupFileName: null,
                  },
                ],
              },
              null,
              2
            )}\n`,
            "utf8"
          );

          // The listing answers the other question, and answers it from the metadata: this entry is
          // labelled `codex` because that is the target its manifest records. Both answers are
          // correct; they are answers to different questions.
          const listed = await runJsonCli({ toolHomeDir, args: ["backups", "list", "--codex", "--json"] });
          assert.equal(listed.status, 0, listed.stderr);
          assert.deepEqual(
            listed.payload.data.backups.map((backup) => backup.target),
            ["codex"],
            "the label follows the recorded target"
          );

          const rolled = await runJsonCli({ toolHomeDir, args: ["rollback", backupId, "--json"] });
          assert.equal(rolled.status, 0, rolled.stderr);
          assert.deepEqual(
            rolled.payload.data.targets,
            ["claude"],
            "the restore overwrote Claude runtime state, whatever the manifest records"
          );
          assert.equal(fs.existsSync(settingsPath), false, "the restore must actually have run");
        });
      },
    },
  ],
};
