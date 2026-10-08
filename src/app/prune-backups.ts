import { DEFAULT_BACKUP_RETENTION } from "../domain/backups";
import { cliError } from "../domain/errors";
import { pruneBackups } from "../storage/backup-repo";
import { withToolLock } from "../storage/lock-repo";
import { CommandResult } from "./types";

/**
 * Resolves the retention count from the raw `--keep` value.
 *
 * A valued option, so `--keep` with no following token parses as the literal string "true".
 * `parseInt("5abc")` is 5, so the raw string is matched against an integer pattern before it
 * is converted rather than after — otherwise trailing junk would be accepted silently.
 */
export function resolveBackupRetention(rawValue: string | null): number {
  if (rawValue === null) {
    return DEFAULT_BACKUP_RETENTION;
  }

  if (!/^\d+$/.test(rawValue) || Number(rawValue) < 1) {
    throw cliError("INVALID_ARGUMENT", `--keep requires a positive integer, received "${rawValue}".`, {
      option: "--keep",
      received: rawValue,
    });
  }

  return Number(rawValue);
}

/**
 * Deletes backups beyond the retention count, holding the shared lock.
 *
 * The lock matters here even though the core does not take it: without it, a manual prune in
 * one terminal can delete another terminal's in-flight backup, whose rollback then fails on
 * a missing backup file after a partial restore.
 */
export function pruneBackupEntries(args: {
  lockPath: string;
  backupsDir: string;
  latestBackupPath: string;
  keep: number;
}): CommandResult {
  const retentionWarnings: string[] = [];

  const lock = withToolLock(args.lockPath, "backups-prune", () => {
    const result = pruneBackups({
      backupsDir: args.backupsDir,
      latestBackupPath: args.latestBackupPath,
      keep: args.keep,
    });
    retentionWarnings.push(...result.warnings);

    return {
      backupsDir: args.backupsDir,
      keep: args.keep,
      removed: result.removed,
      removedCount: result.removed.length,
      protectedCount: result.protectedDirs.length,
      unreadableCount: result.unreadable.length,
    };
  });

  return { data: lock.value, warnings: [...lock.warnings, ...retentionWarnings] };
}
