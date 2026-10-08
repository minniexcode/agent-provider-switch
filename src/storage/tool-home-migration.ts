import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeError } from "../domain/errors";
import {
  LEGACY_LOCK_FILENAME,
  LEGACY_TOOL_CONFIG_FILENAME,
  LEGACY_TOOL_HOME_DIRNAME,
  LOCK_FILENAME,
  TOOL_CONFIG_FILENAME,
  TOOL_HOME_DIRNAME,
  TOOL_HOME_ENV_NAME,
} from "./codex-paths";
import { renameWithRetryOnWindows } from "./fs-utils";
import { describeLockOwner, inspectLock } from "./lock-repo";

/**
 * Result of one migration attempt.
 *
 * `migrated` means the legacy home was moved. Every no-op — including the ones that are the
 * correct outcome — reports `false` with no warnings, so a warning always means something the
 * user may have to act on.
 */
export type ToolHomeMigration = {
  migrated: boolean;
  warnings: string[];
};

function noMigration(): ToolHomeMigration {
  return { migrated: false, warnings: [] };
}

/**
 * Moves a pre-1.0.0 tool home to the location the 1.0.0 paths resolve to.
 *
 * Takes both directories as arguments rather than deriving them, so a test can drive it against
 * temp paths and never against the developer's real home. `ensureLegacyToolHomeMigrated` is the
 * production wiring.
 *
 * The move is a same-filesystem directory rename: the legacy data is never copied, and the legacy
 * home is never deleted. A failure leaves it exactly where it was, which is what makes retrying on
 * the next command safe.
 */
export function migrateLegacyToolHome(input: {
  newHomeDir: string;
  legacyHomeDir: string;
}): ToolHomeMigration {
  const newHomeDir = path.resolve(input.newHomeDir);
  const legacyHomeDir = path.resolve(input.legacyHomeDir);

  // Renaming a tree onto itself is a no-op that reads as an error. Nothing in the production
  // wiring can produce this, and it costs one comparison to be sure of it here rather than
  // inferring it from the call sites.
  if (newHomeDir === legacyHomeDir) {
    return noMigration();
  }

  // Guard 2: a new home that already exists wins, whether it holds migrated data or is empty.
  if (fs.existsSync(newHomeDir)) {
    return noMigration();
  }

  // Guard 3: nothing to move. This is also the check that makes the path comparison above safe —
  // without it a typo'd directory would be renamed into existence.
  if (!isDirectory(legacyHomeDir)) {
    return noMigration();
  }

  // Guard 4: a legacy lock whose owner may still be running means a pre-rename `codexs` process
  // is live against this home. Moving it out from under that process would leave two writers on
  // two different files. `dead`, `unreadable` and `malformed` are all residue, so they move.
  const legacyLock = inspectLock(path.join(legacyHomeDir, LEGACY_LOCK_FILENAME));
  if (legacyLock.status === "live" || legacyLock.status === "foreign") {
    const source = legacyLock.status === "foreign" ? "another host" : "another operation";
    return {
      migrated: false,
      warnings: [
        `Left the legacy tool home at ${legacyHomeDir} in place: it holds a lock from ${source} ` +
          `(${describeLockOwner(legacyLock)}). Re-run the command once that operation has finished.`,
      ],
    };
  }

  // Ordering is load-bearing. The files move first and the directory last, because the directory
  // rename is the only step that cannot be retried: once it lands, guard 2 sees the new home and
  // every later run is a no-op. Both file renames are idempotent, so a run interrupted after them
  // is picked up cleanly next time. Renaming the directory first would be a genuine bug — a
  // failure on the inner files would leave `codex-switch.json` inside a home whose existence
  // permanently satisfies guard 2, and the tool would read the migrated data as a fresh install.
  renameWithin(legacyHomeDir, LEGACY_TOOL_CONFIG_FILENAME, TOOL_CONFIG_FILENAME);
  renameWithin(legacyHomeDir, LEGACY_LOCK_FILENAME, LOCK_FILENAME);

  try {
    renameWithRetryOnWindows(legacyHomeDir, newHomeDir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? "";

    // The source is gone, so another process completed the move between the check above and here.
    // Its files are already in place; there is nothing left for this one to do.
    if (code === "ENOENT") {
      return { migrated: true, warnings: [] };
    }

    // The destination appeared mid-flight. Both homes now exist, and the rule for that state is
    // to leave both alone: merging them is how one home's providers silently overwrite the
    // other's, and there is no way to tell after the fact which copy was newer.
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      return noMigration();
    }

    return {
      migrated: false,
      warnings: [
        `Could not move the legacy tool home ${legacyHomeDir} to ${newHomeDir}: ` +
          `${normalizeError(error).message}. Your providers and backups are still under ` +
          `${legacyHomeDir}. Move that directory to ${newHomeDir} by hand before running another ` +
          `write command, or the tool will start writing to an empty home.`,
      ],
    };
  }

  return { migrated: true, warnings: [] };
}

/**
 * Runs the legacy-home migration for the default tool home, when it applies.
 */
export function ensureLegacyToolHomeMigrated(): ToolHomeMigration {
  // An explicit `APS_HOME` always wins, and this check deliberately precedes every filesystem
  // call: it is the one thing standing between a bug in this module and the developer's real
  // `~/.config`. Tests depend on it too — `runBuiltCli` sets the variable for every invocation,
  // so a spec that never mentions migration cannot reach the real home through this path.
  if (process.env[TOOL_HOME_ENV_NAME]) {
    return noMigration();
  }

  const configDir = path.join(os.homedir(), ".config");
  return migrateLegacyToolHome({
    newHomeDir: path.join(configDir, TOOL_HOME_DIRNAME),
    legacyHomeDir: path.join(configDir, LEGACY_TOOL_HOME_DIRNAME),
  });
}

/**
 * Renames one artifact inside the legacy home, tolerating a re-run.
 *
 * Skipping when the destination already exists is what makes a partially completed migration
 * safe: the file renames are idempotent, so only the directory rename has to succeed.
 */
function renameWithin(directory: string, fromName: string, toName: string): void {
  const fromPath = path.join(directory, fromName);
  const toPath = path.join(directory, toName);
  if (fs.existsSync(fromPath) && !fs.existsSync(toPath)) {
    renameWithRetryOnWindows(fromPath, toPath);
  }
}

/**
 * Reports whether the path names an existing directory.
 */
function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
