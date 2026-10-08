"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  makeCodexFixture,
  makeTempDir,
  makeToolHomeWithManagedState,
  runJsonCli,
} = require("./helpers");

function backupsDirOf(toolHomeDir) {
  return path.join(toolHomeDir, "backups");
}

function latestPathOf(toolHomeDir) {
  return path.join(backupsDirOf(toolHomeDir), "latest.json");
}

/**
 * Lists the backup directories under a tool home, sorted by name.
 *
 * Backup names are `<timestamp>-<reason>` with a fixed-width timestamp, so lexical order is
 * chronological order — except for the `-N` collision suffix, which only ever appears next to
 * the name it extends and therefore still sorts immediately after it.
 */
function listBackupDirs(backupsDir) {
  if (!fs.existsSync(backupsDir)) {
    return [];
  }

  return fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Rewrites one backup's `createdAt`, so ordering is pinned to an explicit value instead of to
 * how many milliseconds apart the setup commands happened to run.
 */
function restampManifest(backupsDir, dirName, createdAt) {
  const manifestPath = path.join(backupsDir, dirName, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.createdAt = createdAt;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * Runs one `add`, which is the cheapest command that produces a real backup.
 */
function addProvider(toolHomeDir, codexDir, name) {
  return runJsonCli({
    toolHomeDir,
    args: [
      "add",
      name,
      "--profile",
      name,
      "--model",
      "gpt-5-mini",
      "--api-key",
      `sk-${name}`,
      "--base-url",
      "https://gamma.example/v1",
      "--json",
      "--codex-dir",
      codexDir,
    ],
  });
}

module.exports = {
  name: "backup retention",
  tests: [
    {
      name: "automatic retention bounds the backups directory at the default count",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        // Before retention existed nothing ever deleted a backup; the machine this was written
        // against held 97 directories of plaintext provider keys spanning four months.
        const mutations = 25;
        for (let index = 0; index < mutations; index += 1) {
          const result = await addProvider(toolHomeDir, codexDir, `provider-${index}`);
          assert.equal(result.status, 0, `mutation ${index} failed: ${result.stderr}`);
        }

        const dirs = listBackupDirs(backupsDirOf(toolHomeDir));
        assert.equal(
          dirs.length,
          20,
          `expected retention to leave 20 directories after ${mutations} mutations, found ${dirs.length}`
        );

        // The most recent backup is what a no-argument rollback resolves through, so it has to
        // be the one that survived.
        const latest = JSON.parse(fs.readFileSync(latestPathOf(toolHomeDir), "utf8"));
        assert.ok(
          fs.existsSync(latest.backupDir),
          "the backup latest.json names must never be pruned"
        );
      },
    },
    {
      name: "two backups created at the same instant get distinct directories",
      run() {
        const { createBackup } = require("../dist/storage/backup-repo.js");
        const root = makeTempDir("agent-provider-switch-retention-");
        const backupsDir = path.join(root, "backups");
        const sourceFile = path.join(root, "config.toml");
        fs.writeFileSync(sourceFile, 'model = "gpt-5"\n', "utf8");
        const files = [{ absolutePath: sourceFile, relativePath: "config.toml" }];

        // The timestamp is frozen so both calls land on the same millisecond. With one-second
        // resolution and a recursive `ensureDir`, the second call resolved to the same
        // directory as the first and silently overwrote its files and manifest.
        const RealDate = Date;
        const frozen = new RealDate("2026-01-01T00:00:00.000Z");
        class FrozenDate extends RealDate {
          constructor(...args) {
            super(...(args.length > 0 ? args : [frozen.getTime()]));
          }

          static now() {
            return frozen.getTime();
          }
        }

        let first;
        let second;
        global.Date = FrozenDate;
        try {
          first = createBackup(backupsDir, "switch", files);
          second = createBackup(backupsDir, "switch", files);
        } finally {
          global.Date = RealDate;
        }

        assert.notEqual(
          first.backupDir,
          second.backupDir,
          "two backups at the same timestamp must not share a directory"
        );
        assert.equal(listBackupDirs(backupsDir).length, 2);
        for (const manifest of [first, second]) {
          assert.ok(
            fs.existsSync(path.join(manifest.backupDir, "config.toml")),
            `backup ${manifest.backupDir} lost its file copy`
          );
          assert.ok(fs.existsSync(path.join(manifest.backupDir, "manifest.json")));
        }
      },
    },
    {
      name: "prune keeps a directory a surviving manifest still references",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        const backupsDir = backupsDirOf(toolHomeDir);
        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        for (const name of ["alpha", "beta", "gamma"]) {
          const result = await addProvider(toolHomeDir, codexDir, name);
          assert.equal(result.status, 0, result.stderr);
        }

        const dirs = listBackupDirs(backupsDir);
        assert.equal(dirs.length, 3, `expected three backups, found ${dirs.join(", ")}`);
        const [oldest, middle, newest] = dirs;

        // Pin the ordering explicitly. Retention orders by the manifest's createdAt, so leaving
        // that to how far apart the setup commands happened to run would make this test depend
        // on timing rather than on the rule it is checking.
        restampManifest(backupsDir, oldest, "2026-01-01T00:00:01.000Z");
        restampManifest(backupsDir, middle, "2026-01-01T00:00:02.000Z");
        restampManifest(backupsDir, newest, "2026-01-01T00:00:03.000Z");

        // Point the no-argument rollback at the oldest backup. It is beyond the retention
        // count, but a rollback still resolves through it, so it must not be deleted.
        fs.copyFileSync(
          path.join(backupsDir, oldest, "manifest.json"),
          latestPathOf(toolHomeDir)
        );

        const pruned = await runJsonCli({
          toolHomeDir,
          args: ["backups", "prune", "--keep", "1", "--json", "--codex-dir", codexDir],
        });
        assert.equal(pruned.status, 0, pruned.stderr);
        assert.deepEqual(pruned.payload.data.removed, [middle]);
        assert.equal(pruned.payload.data.removedCount, 1);
        assert.equal(pruned.payload.data.protectedCount, 1);
        assert.ok(
          pruned.payload.warnings.some((warning) => warning.includes("a surviving manifest still references it")),
          `expected a protected-directory warning, got ${JSON.stringify(pruned.payload.warnings)}`
        );

        assert.ok(fs.existsSync(path.join(backupsDir, newest)), "the retained backup must survive");
        assert.ok(
          fs.existsSync(path.join(backupsDir, oldest)),
          "the backup latest.json names must survive a prune"
        );
        assert.equal(fs.existsSync(path.join(backupsDir, middle)), false);

        const rolled = await runJsonCli({
          toolHomeDir,
          args: ["rollback", "--json", "--codex-dir", codexDir],
        });
        assert.equal(rolled.status, 0, `a no-argument rollback must still resolve: ${rolled.stderr}`);
        assert.equal(rolled.payload.data.backupPath, path.join(backupsDir, oldest));
      },
    },
    {
      name: "prune is a success when there is nothing to prune",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        // A machine with no backups at all must not exit non-zero for having nothing to do.
        if (fs.existsSync(backupsDirOf(toolHomeDir))) {
          fs.rmSync(backupsDirOf(toolHomeDir), { recursive: true, force: true });
        }
        let result = await runJsonCli({
          toolHomeDir,
          args: ["backups", "prune", "--json", "--codex-dir", codexDir],
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.data.removedCount, 0);

        fs.mkdirSync(backupsDirOf(toolHomeDir), { recursive: true });
        result = await runJsonCli({
          toolHomeDir,
          args: ["backups", "prune", "--json", "--codex-dir", codexDir],
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.data.removedCount, 0);
        assert.equal(result.payload.data.keep, 20, "the default retention count must be reported");
      },
    },
    {
      name: "--keep rejects anything that is not a positive integer",
      async run() {
        const toolHomeDir = makeToolHomeWithManagedState();
        const codexDir = makeCodexFixture();
        await runJsonCli({ toolHomeDir, args: ["init", "--json", "--codex-dir", codexDir] });

        const rejected = [
          ["--keep"], // a bare flag parses as the literal string "true"
          ["--keep", "true"],
          // Zero would leave nothing retained and is one step from an empty protected set.
          ["--keep", "0"],
          ["--keep", "-5"],
          // parseInt("2.5") is 2 and parseInt("5abc") is 5, so the raw string is matched
          // against an integer pattern before it is converted.
          ["--keep", "2.5"],
          ["--keep", "5abc"],
        ];

        for (const extra of rejected) {
          const result = await runJsonCli({
            toolHomeDir,
            args: ["backups", "prune", ...extra, "--json", "--codex-dir", codexDir],
          });
          assert.equal(
            result.status,
            1,
            `expected ${JSON.stringify(extra)} to be rejected, got exit 0`
          );
          assert.equal(result.payload.error.code, "INVALID_ARGUMENT", JSON.stringify(extra));
        }

        const accepted = await runJsonCli({
          toolHomeDir,
          args: ["backups", "prune", "--keep", "5", "--json", "--codex-dir", codexDir],
        });
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.equal(accepted.payload.data.keep, 5);
        assert.equal(accepted.payload.data.removedCount, 0, "nothing to remove when fewer backups exist than are kept");
      },
    },
    {
      name: "a rolled-back mutation leaves no backup directory and no backup path",
      run() {
        const { runMutation } = require("../dist/app/run-mutation.js");
        const root = makeTempDir("agent-provider-switch-mutation-");
        const codexDir = path.join(root, "codex");
        fs.mkdirSync(codexDir, { recursive: true });
        const configPath = path.join(codexDir, "config.toml");
        const original = 'model = "gpt-5"\n';
        fs.writeFileSync(configPath, original, "utf8");

        const backupsDir = path.join(root, "backups");
        const lockPath = path.join(root, ".aps.lock");

        let thrown = null;
        try {
          runMutation({
            lockPath,
            backupsDir,
            latestBackupPath: path.join(backupsDir, "latest.json"),
            operation: "switch",
            files: [{ absolutePath: configPath, relativePath: "config.toml" }],
            mutate: () => {
              throw new Error("boom");
            },
          });
        } catch (error) {
          thrown = error;
        }

        assert.ok(thrown, "the mutation must fail");
        assert.equal(thrown.details.rollbackApplied, true);
        assert.equal(
          Object.prototype.hasOwnProperty.call(thrown.details, "backupPath"),
          false,
          "a rolled-back mutation must not hand the caller a path that no longer exists"
        );
        assert.deepEqual(listBackupDirs(backupsDir), [], "failed attempts must not accumulate");
        assert.equal(fs.readFileSync(configPath, "utf8"), original, "the file must be restored");
        assert.equal(fs.existsSync(lockPath), false, "the lock must be released on failure");
      },
    },
    {
      name: "a failed rollback keeps the backup and reports where it is",
      run() {
        const { runMutation } = require("../dist/app/run-mutation.js");
        const root = makeTempDir("agent-provider-switch-mutation-");
        const codexDir = path.join(root, "codex");
        fs.mkdirSync(codexDir, { recursive: true });
        const configPath = path.join(codexDir, "config.toml");
        fs.writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");

        const backupsDir = path.join(root, "backups");

        let thrown = null;
        try {
          runMutation({
            lockPath: path.join(root, ".aps.lock"),
            backupsDir,
            latestBackupPath: path.join(backupsDir, "latest.json"),
            operation: "switch",
            files: [{ absolutePath: configPath, relativePath: "config.toml" }],
            mutate: (context) => {
              // Remove the backup copy, so the restore cannot complete. This is the one case
              // where the backup directory is the last manual recovery route and must survive.
              for (const entry of context.backup.files) {
                if (entry.backupFileName) {
                  fs.rmSync(path.join(context.backup.backupDir, entry.backupFileName), { force: true });
                }
              }
              throw new Error("boom");
            },
          });
        } catch (error) {
          thrown = error;
        }

        assert.ok(thrown, "the mutation must fail");
        assert.equal(thrown.code, "ROLLBACK_FAILED");
        assert.equal(typeof thrown.details.backupPath, "string");
        assert.ok(
          fs.existsSync(thrown.details.backupPath),
          "a failed rollback must keep the only manual recovery route"
        );
      },
    },
  ],
};
