import * as fs from "node:fs";
import * as path from "node:path";
import { BackupManifest, FileBackupEntry } from "../domain/backup";
import { BackupOwnership, sortBackupList, toBackupListItem, validateBackupManifest } from "../domain/backups";
import type { TargetId } from "../domain/target";
import { cliError, normalizeError } from "../domain/errors";
import { SECURE_DIR_MODE, ensureDir, writeTextFileAtomic } from "./fs-utils";

/**
 * How many suffixed names to try before giving up on finding a free backup directory.
 */
const MAX_BACKUP_DIR_ATTEMPTS = 100;

/**
 * Creates a point-in-time backup for the managed files involved in a mutation.
 *
 * `target` is written into the manifest so that a later `backups list` or `rollback` can name it
 * without inferring it from an operation name or a file path.
 */
export function createBackup(
  backupsDir: string,
  reason: string,
  files: Array<{ absolutePath: string; relativePath: string }>,
  target: TargetId
): BackupManifest {
  try {
    ensureDir(backupsDir);
    const backupDir = createExclusiveBackupDir(backupsDir, reason);

    const entries: FileBackupEntry[] = [];
    for (const file of files) {
      const exists = fs.existsSync(file.absolutePath);
      const backupFileName = exists ? file.relativePath.replace(/[\\/]/g, "__") : null;
      if (exists && backupFileName) {
        // Flatten relative paths into a single filename inside the backup directory.
        fs.copyFileSync(file.absolutePath, path.join(backupDir, backupFileName));
      }

      entries.push({
        relativePath: file.relativePath,
        restorePath: file.absolutePath,
        existed: exists,
        backupFileName,
      });
    }

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      backupDir,
      target,
      files: entries,
    };

    writeTextFileAtomic(path.join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error: unknown) {
    throw cliError("BACKUP_FAILED", "Failed to create backup.", {
      cause: normalizeError(error).message,
    });
  }
}

/**
 * Returns true when `targetPath` resolves inside one of the allowed roots.
 */
function isWithinAllowedRoots(targetPath: string, allowedRoots: string[]): boolean {
  const resolvedTarget = path.resolve(targetPath);
  return allowedRoots.some((root) => {
    const relative = path.relative(path.resolve(root), resolvedTarget);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

/**
 * Restores all files described by a backup manifest back into their original paths.
 *
 * `allowedRoots` must come from the caller rather than from the manifest: the manifest
 * is a file on disk, so a root recorded inside it would be editable by the same change
 * that redirects a restore path. Every entry must resolve inside one of the roots.
 */
export function restoreManifest(manifest: BackupManifest, allowedRoots: string[]): void {
  for (const entry of manifest.files) {
    const targetPath = entry.restorePath;
    if (!isWithinAllowedRoots(targetPath, allowedRoots)) {
      throw cliError("ROLLBACK_PATH_REJECTED", `Backup entry for "${entry.relativePath}" resolves outside the managed roots.`, {
        relativePath: entry.relativePath,
        restorePath: targetPath,
      });
    }

    if (!entry.existed) {
      if (fs.existsSync(targetPath)) {
        // Remove files that were created by the failed mutation but were absent before it.
        fs.rmSync(targetPath, { force: true });
      }
      continue;
    }

    if (!entry.backupFileName) {
      throw new Error(`Backup file for ${entry.relativePath} is missing from manifest.`);
    }

    const sourcePath = path.join(manifest.backupDir, entry.backupFileName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Backup file not found: ${sourcePath}`);
    }

    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

/**
 * Persists the latest successful backup manifest for manual rollback.
 */
export function saveLatestManifest(latestBackupPath: string, manifest: BackupManifest): void {
  writeTextFileAtomic(latestBackupPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Loads and validates the latest rollback manifest file.
 */
export function loadLatestManifest(latestBackupPath: string): BackupManifest {
  if (!fs.existsSync(latestBackupPath)) {
    throw cliError("BACKUP_NOT_FOUND", "No rollback backup is available.", {
      file: latestBackupPath,
    });
  }

  try {
    return validateBackupManifest(JSON.parse(fs.readFileSync(latestBackupPath, "utf8")));
  } catch (error: unknown) {
    throw cliError("ROLLBACK_FAILED", "Failed to read latest backup manifest.", {
      file: latestBackupPath,
      cause: normalizeError(error).message,
    });
  }
}

/**
 * Loads a backup manifest by its explicit backup id.
 */
export function loadManifestById(backupsDir: string, backupId: string): BackupManifest {
  const manifestPath = path.join(backupsDir, backupId, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw cliError("BACKUP_NOT_FOUND", `Backup "${backupId}" was not found.`, {
      backupId,
      file: manifestPath,
    });
  }

  try {
    return validateBackupManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch (error: unknown) {
    throw cliError("ROLLBACK_FAILED", `Failed to read backup manifest "${backupId}".`, {
      backupId,
      file: manifestPath,
      cause: normalizeError(error).message,
    });
  }
}

/**
 * Lists valid backup manifests under backups/, newest first, while skipping corrupt entries with warnings.
 *
 * `ownership` is what lets every entry be labelled with the target it belongs to; the directory
 * itself is shared, so nothing about an entry's position on disk says which target wrote it.
 */
export function listBackups(
  backupsDir: string,
  ownership: BackupOwnership
): {
  backups: Array<ReturnType<typeof toBackupListItem>>;
  warnings: string[];
} {
  if (!fs.existsSync(backupsDir)) {
    throw cliError("BACKUP_NOT_FOUND", "No backups directory exists.", {
      directory: backupsDir,
    });
  }

  const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  const backups: Array<ReturnType<typeof toBackupListItem>> = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "latest.json") {
      continue;
    }

    const manifestPath = path.join(backupsDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      warnings.push(`Skipped backup "${entry.name}" because manifest.json is missing.`);
      continue;
    }

    try {
      backups.push(
        toBackupListItem(validateBackupManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8"))), ownership)
      );
    } catch (error: unknown) {
      warnings.push(`Skipped backup "${entry.name}" because manifest.json is invalid: ${normalizeError(error).message}`);
    }
  }

  if (backups.length === 0) {
    throw cliError("BACKUP_NOT_FOUND", "No valid backups were found.", {
      directory: backupsDir,
    });
  }

  return {
    backups: sortBackupList(backups),
    warnings,
  };
}

/**
 * What one retention pass did, for reporting through the command result.
 */
export type PruneResult = {
  removed: string[];
  protectedDirs: string[];
  unreadable: string[];
  warnings: string[];
};

/**
 * Deletes backup directories beyond the retention count, newest first.
 *
 * Lock-free by design. The command wrapper takes the shared lock, but the automatic call
 * inside a mutation already holds it — and that lock is a non-reentrant exclusive create,
 * so a wrapper here would always receive EEXIST. The caller would then swallow it as
 * best-effort and automatic retention would silently never run.
 *
 * This deliberately does not reuse `listBackups()`: that throws when the directory holds no
 * valid manifest, so a clean machine would exit non-zero for having nothing to do, and it
 * skips unreadable entries — exactly the crash residue worth reporting.
 */
export function pruneBackups(args: {
  backupsDir: string;
  latestBackupPath: string;
  keep: number;
}): PruneResult {
  const result: PruneResult = { removed: [], protectedDirs: [], unreadable: [], warnings: [] };
  if (!fs.existsSync(args.backupsDir)) {
    return result;
  }

  const candidates: Array<{ dirPath: string; manifest: BackupManifest }> = [];
  for (const entry of fs.readdirSync(args.backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dirPath = path.join(args.backupsDir, entry.name);
    const manifestPath = path.join(dirPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      result.unreadable.push(entry.name);
      result.warnings.push(`Kept backup "${entry.name}" because manifest.json is missing.`);
      continue;
    }

    try {
      candidates.push({
        dirPath,
        manifest: validateBackupManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8"))),
      });
    } catch (error: unknown) {
      // Reported rather than deleted: an unvalidatable directory cannot be shown to be
      // expendable, and skipping it would leave the unbounded growth in place for the one
      // case a crash produces most often.
      result.unreadable.push(entry.name);
      result.warnings.push(`Kept backup "${entry.name}" because manifest.json is invalid: ${normalizeError(error).message}`);
    }
  }

  // Ordering is by the manifest's createdAt, never by directory name: with suffixed
  // retries in play, "…-switch-10" sorts before "…-switch-9" lexically.
  const ordered = candidates
    .map((candidate) => ({ ...candidate, createdAt: candidate.manifest.createdAt }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const retained = ordered.slice(0, args.keep);
  const deletable = ordered.slice(args.keep);

  // The protected set is derived from the manifests that SURVIVE this prune. A manifest
  // lives inside its own backup directory, so it is removed together with that directory;
  // what survives is the retained directories plus latest.json, which is a top-level file.
  // Deriving the set from every manifest instead would protect every directory and leave
  // nothing deletable at all.
  const protectedPaths = new Set<string>();
  for (const candidate of retained) {
    protectedPaths.add(path.resolve(candidate.dirPath));
    // rollback <id> resolves through loadManifestById() and then reads manifest.backupDir,
    // so a retained manifest naming some other directory keeps that directory alive too.
    protectedPaths.add(path.resolve(candidate.manifest.backupDir));
  }

  const latest = readLatestManifestQuietly(args.latestBackupPath);
  if (latest) {
    // latest.json is what a no-argument rollback resolves through, and it is not recreated
    // by a prune, so whatever it names must stay resolvable.
    protectedPaths.add(path.resolve(latest.backupDir));
  }

  for (const candidate of deletable) {
    const name = path.basename(candidate.dirPath);
    if (protectedPaths.has(path.resolve(candidate.dirPath))) {
      result.protectedDirs.push(name);
      result.warnings.push(`Kept backup "${name}" because a surviving manifest still references it.`);
      continue;
    }

    try {
      fs.rmSync(candidate.dirPath, { recursive: true, force: true });
      result.removed.push(name);
    } catch (error: unknown) {
      // One directory that cannot be removed (Windows EBUSY, an antivirus hold) must not
      // fail the whole prune, but it is reported rather than swallowed.
      result.warnings.push(`Could not remove backup "${name}": ${normalizeError(error).message}`);
    }
  }

  return result;
}

/**
 * Reads the latest-rollback manifest, or null when it is missing or unusable.
 */
function readLatestManifestQuietly(latestBackupPath: string): BackupManifest | null {
  if (!fs.existsSync(latestBackupPath)) {
    return null;
  }

  try {
    return validateBackupManifest(JSON.parse(fs.readFileSync(latestBackupPath, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Formats a filesystem-safe timestamp for backup directory names.
 *
 * Milliseconds are included so two mutations in the same second cannot resolve to the
 * same name. Uniqueness is still enforced by the exclusive create below rather than by
 * the timestamp: a clock that steps backwards must not be able to lose a backup.
 */
function createTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  return [
    now.getFullYear().toString(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join("");
}

/**
 * Creates a backup directory no other mutation can share.
 *
 * `ensureDir` is recursive and therefore silent when the directory already exists, which is
 * how two mutations in the same second used to overwrite each other's files and manifest.
 * A non-recursive create is exclusive on its own property rather than on the shared lock's,
 * so it stays correct while the lock's failure modes are being loosened.
 */
function createExclusiveBackupDir(backupsDir: string, reason: string): string {
  const baseName = `${createTimestamp()}-${reason}`;

  for (let attempt = 0; attempt < MAX_BACKUP_DIR_ATTEMPTS; attempt += 1) {
    const candidate = path.join(backupsDir, attempt === 0 ? baseName : `${baseName}-${attempt}`);
    try {
      fs.mkdirSync(candidate, { mode: SECURE_DIR_MODE });
      return candidate;
    } catch (error: unknown) {
      // Only a name already in use is retried; anything else is a real failure.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error(`Could not find an unused backup directory name for "${baseName}".`);
}
