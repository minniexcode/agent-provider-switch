import { BackupRoots } from "../domain/backups";
import type { TargetId } from "../domain/target";
import { listBackups } from "../storage/backup-repo";
import { CommandResult } from "./types";

/**
 * Lists backup manifests available under the shared backups directory.
 *
 * `targets` filters the list rather than selecting it: the directory is one directory holding both
 * targets' backups, so an empty selection would mean "narrowed to nothing" and is not a case this
 * service has to answer — the scope table gives `backups list` one or two targets, never none.
 *
 * An entry classified `unknown` appears in the unfiltered list only. Matching it to either target
 * would be the guess `classifyBackupTargets()` refuses to make, and the list cannot show an entry
 * under a heading the filter did not ask for.
 *
 * `mixed` appears in **both** narrowed lists. It is not a third thing standing beside the two
 * targets: it is an entry that touched Codex and Claude, so a reader asking "show me the Codex
 * backups" is asking about a set that includes it. Omitting it would hide the one backup whose
 * restore is most likely to surprise them — the one that overwrites both targets at once.
 */
export function listBackupEntries(args: {
  backupsDir: string;
  roots: BackupRoots;
  targets: TargetId[];
}): CommandResult {
  const result = listBackups(args.backupsDir, args.roots);
  const backups = result.backups.filter((backup) => {
    if (args.targets.length !== 1) {
      return true;
    }
    return backup.target === args.targets[0] || backup.target === "mixed";
  });

  return {
    data: {
      backups,
      count: backups.length,
    },
    warnings: result.warnings,
  };
}
