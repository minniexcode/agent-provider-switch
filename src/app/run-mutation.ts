import * as fs from "node:fs";
import * as path from "node:path";
import { BackupManifest, FileBackupEntry } from "../domain/backup";
import { DEFAULT_BACKUP_RETENTION } from "../domain/backups";
import { cliError, normalizeError } from "../domain/errors";
import { createBackup, pruneBackups, restoreManifest, saveLatestManifest } from "../storage/backup-repo";
import { withToolLock } from "../storage/lock-repo";

type ManagedFile = {
  absolutePath: string;
  relativePath: string;
};

type MutationContext = {
  backup: BackupManifest;
};

/**
 * The payload every successful mutation reports.
 */
export type MutationData = {
  backupPath: string;
  retentionRemoved: number;
  managedState: Record<string, unknown>;
};

/**
 * Runs a write operation under a lock with automatic backup and rollback handling.
 *
 * `lockPath` is required rather than defaulted. The whole recovery model rests on there
 * being exactly one shared lock file, and a caller that omitted the argument would silently
 * create a second one that no other command contends for.
 */
export function runMutation<TData extends Record<string, unknown>>(args: {
  lockPath: string;
  backupsDir: string;
  latestBackupPath: string;
  operation: string;
  files: ManagedFile[];
  mutate: (context: MutationContext) => TData;
}): { data: TData & MutationData; warnings: string[] } {
  // Retention and takeover notices are raised inside the critical section but reported
  // through the command's result, which is the structured channel both output modes read.
  const retentionWarnings: string[] = [];

  const lock = withToolLock(args.lockPath, args.operation, () => {
    const backup = createBackup(args.backupsDir, args.operation, args.files);
    try {
      const data = args.mutate({ backup });
      // Record the successful backup only after the mutation completes.
      saveLatestManifest(args.latestBackupPath, backup);

      // Retention runs here, inside this mutation's lock and after the new backup is
      // recorded, so the directory just created is already the newest one and cannot be a
      // candidate for removal. Calling the locking wrapper instead would always receive
      // EEXIST from the non-reentrant lock, and automatic retention would never run.
      const retentionRemoved = pruneBestEffort(args.backupsDir, args.latestBackupPath, retentionWarnings);

      return {
        ...data,
        backupPath: backup.backupDir,
        retentionRemoved,
        managedState: {
          transaction: "single-process-file-lock",
          backupFiles: listBackedUpFiles(backup.files),
        },
      } as TData & MutationData;
    } catch (error: unknown) {
      try {
        // Roll back the managed files to their pre-mutation state on any failure.
        restoreManifest(backup, buildAllowedRoots(args));
      } catch (rollbackError: unknown) {
        // The directory is kept and its path reported: with rollback failed, the backup is
        // the only manual recovery route left, so it must not be deleted.
        throw cliError("ROLLBACK_FAILED", `${capitalize(args.operation)} failed and rollback was not successful.`, {
          cause: normalizeError(error).message,
          rollbackReason: normalizeError(rollbackError).message,
          backupPath: backup.backupDir,
        });
      }

      // `restoreManifest()` restores only the files the manifest lists, so "rolled back
      // successfully" is not provably "the state is pre-mutation". Removing the directory
      // is a judgement call rather than a given: it is taken because failed attempts
      // otherwise accumulate without bound, and `backupPath` is dropped from the payload in
      // the same breath so no caller is handed a path that no longer exists.
      try {
        fs.rmSync(backup.backupDir, { recursive: true, force: true });
      } catch {
        // Best effort. A directory that cannot be removed must not replace the mutation's
        // own error with a filesystem one.
      }

      const baseError = normalizeError(error);
      throw cliError(baseError.code, baseError.message, {
        ...(baseError.details ?? {}),
        rollbackApplied: true,
      });
    }
  });

  return { data: lock.value, warnings: [...lock.warnings, ...retentionWarnings] };
}

/**
 * Runs retention without allowing it to change the mutation's outcome.
 *
 * A prune that fails must never fail a mutation that already succeeded, so this is the one
 * call in the wrapper that swallows. The count is returned for the result payload and the
 * warnings are collected for the caller to report.
 */
function pruneBestEffort(backupsDir: string, latestBackupPath: string, warnings: string[]): number {
  try {
    const retention = pruneBackups({ backupsDir, latestBackupPath, keep: DEFAULT_BACKUP_RETENTION });
    warnings.push(...retention.warnings);
    if (retention.removed.length > 0) {
      const noun = retention.removed.length === 1 ? "backup directory" : "backup directories";
      warnings.push(`Retention removed ${retention.removed.length} ${noun}.`);
    }
    return retention.removed.length;
  } catch (error: unknown) {
    warnings.push(`Backup retention could not run: ${normalizeError(error).message}`);
    return 0;
  }
}

/**
 * Builds the directories a rollback for this mutation may write into.
 *
 * Sourced from the caller's file list and the backup directory's parent, never from the
 * backup manifest, so a tampered manifest cannot redirect a restore outside the files
 * this operation actually owns.
 */
function buildAllowedRoots(args: { backupsDir: string; files: ManagedFile[] }): string[] {
  const roots = new Set<string>([path.dirname(args.backupsDir)]);
  for (const file of args.files) {
    roots.add(path.dirname(file.absolutePath));
  }
  return [...roots];
}

/**
 * Lists the files that existed before the mutation and were captured in the backup.
 */
function listBackedUpFiles(files: FileBackupEntry[]): string[] {
  return files.filter((entry) => entry.existed).map((entry) => entry.relativePath);
}

/**
 * Uppercases the first character for human-readable operation names.
 */
function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
