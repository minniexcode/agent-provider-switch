import type { TargetId } from "./target";

/**
 * Describes one managed file captured in a backup manifest.
 */
export type FileBackupEntry = {
  relativePath: string;
  restorePath: string;
  existed: boolean;
  backupFileName: string | null;
};

/**
 * Describes the files and metadata needed to restore a previous runtime state.
 */
export type BackupManifest = {
  version: 1;
  createdAt: string;
  reason: string;
  backupDir: string;
  files: FileBackupEntry[];
  /**
   * The target the mutation acted on.
   *
   * Optional because a manifest written before `1.1.3` simply lacks it, and because
   * `validateBackupManifest()` checks required fields and passes unknown ones through — an added
   * optional field cannot make an existing manifest invalid. A reader that needs an answer for an
   * older manifest classifies it; see `classifyBackupTargets()`.
   */
  target?: TargetId;
};
