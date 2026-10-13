import { BackupOwnership, restoreImpactOf } from "../domain/backups";
import { cliError, normalizeError } from "../domain/errors";
import { loadLatestManifest, loadManifestById, restoreManifest } from "../storage/backup-repo";
import { CommandResult } from "./types";

/**
 * Restores either the latest backup or a specific historical backup by id.
 *
 * `ownership` is read only to report which targets the restore touched. The roots a restore may
 * write into stay in `allowedRoots`, which the caller builds: this function's answer about a
 * manifest is a label, and the containment check that decides whether the manifest is honoured at
 * all must not be derived from that same manifest.
 *
 * The reported set is derived from the file paths, not from the manifest's recorded target. The
 * field's whole job is to tell the user what just changed on disk, and a recorded target answers a
 * different question — which operation produced the backup. When the two disagree the manifest is
 * what is wrong, so believing it would report a Claude settings file as untouched Codex state.
 */
export function rollbackBackup(args: {
  latestBackupPath: string;
  backupsDir: string;
  allowedRoots: string[];
  ownership: BackupOwnership;
  backupId?: string | null;
}): CommandResult {
  const manifest = args.backupId
    ? loadManifestById(args.backupsDir, args.backupId)
    : loadLatestManifest(args.latestBackupPath);

  try {
    restoreManifest(manifest, args.allowedRoots);
    // Computed after the restore, not before: the impact is a statement about what was written,
    // and a restore that was refused by containment must not publish one. The throw below is what
    // keeps the two in step.
    const impact = restoreImpactOf(manifest, args.ownership);
    return {
      data: {
        restoredFiles: manifest.files.map((file) => file.relativePath),
        backupId: args.backupId ?? null,
        backupPath: manifest.backupDir,
        // Which target's runtime state this restore overwrote, not which target this invocation
        // named: `rollback` is a shared command and names none. The announcement is the point of
        // the field — the command restores the newest backup whatever wrote it.
        //
        // Derived from the file paths, so an origin that disagrees with them loses. A manifest may
        // declare Codex and hold a Claude settings file; the user's next question is what just
        // changed on disk, and only the paths answer it.
        targets: impact.targets,
        // `targets` alone cannot express every outcome: restoring only the shared tool config and
        // restoring a path nobody can classify both report `[]`. These two flags are what tells
        // them apart, and telling them apart is the difference between "nothing to worry about"
        // and "something changed that this build cannot describe".
        impact: impact.impact,
      },
    };
  } catch (error: unknown) {
    const normalized = normalizeError(error);
    if (normalized.code === "ROLLBACK_PATH_REJECTED") {
      // Surface the specific cause: a rejected manifest is not a transient failure.
      throw error;
    }

    throw cliError("ROLLBACK_FAILED", "Rollback failed.", {
      cause: normalized.message,
      backupPath: manifest.backupDir,
      backupId: args.backupId ?? null,
    });
  }
}
