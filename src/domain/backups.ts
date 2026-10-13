import * as path from "node:path";
import { BackupManifest } from "./backup";
import type { TargetId } from "./target";

/**
 * How a backup entry is labelled once its target has been worked out.
 *
 * `unknown` is a refusal to guess rather than a failure: a wrong label on a backup is worse than
 * a missing one, because `rollback` is the command the label informs.
 */
export type BackupTargetLabel = TargetId | "mixed" | "unknown";

export type BackupListItem = {
  backupId: string;
  createdAt: string;
  reason: string;
  files: string[];
  backupPath: string;
  target: BackupTargetLabel;
};

/**
 * The operation-name prefixes and exact names that identify a backup's target without reading any
 * path.
 *
 * Every Claude mutation names its operation `claude-*`, and every Codex one names it without a
 * prefix. That convention is third in this codebase's catalogue of target-carrying conventions
 * (`1.1.1` listed the other two), so it is read here as a fallback rather than trusted as the
 * primary source — `manifest.target` is.
 */
const CODEX_OPERATIONS = new Set(["add", "switch", "remove", "edit", "import", "migrate"]);

/**
 * Backup artifacts whose owner is fixed by their name, wherever they sit on disk.
 *
 * A name is needed as well as a root because the registries live in the *tool home*, which belongs
 * to neither target: `providers.json` is Codex's registry and `claude-providers.json` is Claude's,
 * and a classifier that only knew the two runtime roots would file both under "unknown" — or,
 * worse, file them under whichever root the tool home happened to be nested in, since `APS_HOME`
 * and `APS_CODEX_DIR` can overlap.
 *
 * The tool config is listed as `shared` rather than omitted. Omitting it would make a backup that
 * captured only the tool config classify as `unknown`, when what is actually known about it is that
 * it belongs to both targets — the same reason `restoreImpactOf()` reports a `shared` flag beside
 * its target list.
 */
const KNOWN_ARTIFACT_OWNERS: Record<string, TargetId | "shared"> = {
  "providers.json": "codex",
  "claude-providers.json": "claude",
  // `TOOL_CONFIG_FILENAME`. Repeated as a literal because this is a domain module and the storage
  // layer is where paths are resolved; the name is part of the on-disk contract either way.
  "agent-provider-switch.json": "shared",
};

/**
 * One backup entry's ownership, as far as names can tell.
 */
function artifactOwner(restorePath: string): TargetId | "shared" | null {
  return KNOWN_ARTIFACT_OWNERS[path.basename(restorePath)] ?? null;
}

/**
 * The targets whose roots contain `candidate`.
 *
 * A list rather than the first match: `APS_HOME` is commonly nested inside a directory also used
 * as `APS_CODEX_DIR`, and a first-match answer would report one target for a path that genuinely
 * belongs to both. Accumulating is the only answer that stays true as the roots move.
 */
function matchingRoots(candidate: string, roots: BackupRoots): TargetId[] {
  const matched: TargetId[] = [];
  if (isWithinRoot(candidate, roots.codexDir)) {
    matched.push("codex");
  }
  if (isWithinRoot(candidate, roots.claudeDir)) {
    matched.push("claude");
  }
  return matched;
}

/**
 * The targets a backup's artifact names and paths argue for, ignoring metadata.
 *
 * Shared artifacts are skipped rather than counted: this function answers "whose operation was
 * this", and a tool config is nobody's. A path matching no root contributes nothing here, because
 * an origin label has no `unknown` member to carry it — the absence of a label is the answer.
 */
function originFromPaths(manifest: BackupManifest, roots: BackupRoots): TargetId[] {
  const targets = new Set<TargetId>();
  for (const entry of manifest.files) {
    const owner = artifactOwner(entry.restorePath);
    if (owner === "shared") {
      continue;
    }
    if (owner !== null) {
      targets.add(owner);
      continue;
    }
    for (const target of matchingRoots(entry.restorePath, roots)) {
      targets.add(target);
    }
  }

  return (["codex", "claude"] as const).filter((target) => targets.has(target));
}

/**
 * Backups retained after a mutation and by `backups prune` when `--keep` is not given.
 *
 * The number is a retention policy, not a guarantee: a directory a surviving manifest still
 * references is kept regardless, so the count on disk can exceed this.
 */
export const DEFAULT_BACKUP_RETENTION = 20;

/**
 * Returns the explicit backup identifier derived from the backup directory name.
 */
export function getBackupId(backupDir: string): string {
  return path.basename(backupDir);
}

/**
 * Validates the minimal manifest shape needed for listing and restoring backups.
 */
export function validateBackupManifest(input: unknown): BackupManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Backup manifest must be an object.");
  }

  const manifest = input as Partial<BackupManifest>;
  if (manifest.version !== 1) {
    throw new Error("Unsupported backup manifest version.");
  }
  if (typeof manifest.createdAt !== "string" || manifest.createdAt.trim() === "") {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (typeof manifest.reason !== "string" || manifest.reason.trim() === "") {
    throw new Error("Backup manifest is missing reason.");
  }
  if (typeof manifest.backupDir !== "string" || manifest.backupDir.trim() === "") {
    throw new Error("Backup manifest is missing backupDir.");
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Backup manifest is missing files.");
  }

  // `target` is optional — manifests written before `1.1.3` do not carry it — but it is a *known*
  // field now, so when it is present it must be one of the two ids. Passing arbitrary extension
  // fields through is a policy about fields this build does not know; it is not a reason for a
  // known field to skip validation. A `target: "bogus"` that reached the output would break the
  // label enum `backups list` promises, and `mixed`/`unknown` are labels the list *derives* rather
  // than values a manifest may declare.
  if (manifest.target !== undefined && manifest.target !== "codex" && manifest.target !== "claude") {
    throw new Error('Backup manifest target must be "codex" or "claude" when present.');
  }

  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Backup manifest contains an invalid file entry.");
    }

    if (
      typeof entry.relativePath !== "string" ||
      typeof entry.restorePath !== "string" ||
      entry.restorePath.trim() === "" ||
      typeof entry.existed !== "boolean"
    ) {
      throw new Error("Backup manifest contains an invalid file entry.");
    }

    if (entry.backupFileName !== null && typeof entry.backupFileName !== "string") {
      throw new Error("Backup manifest contains an invalid backup file name.");
    }
  }

  return manifest as BackupManifest;
}

/**
 * Sorts backup list items from newest to oldest based on createdAt.
 */
export function sortBackupList(items: BackupListItem[]): BackupListItem[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Converts a manifest into the stable list payload returned by `backups list`.
 */
export function toBackupListItem(manifest: BackupManifest, roots: BackupRoots): BackupListItem {
  return {
    backupId: getBackupId(manifest.backupDir),
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    files: manifest.files.map((file) => file.relativePath),
    backupPath: manifest.backupDir,
    target: labelBackupTargets(classifyBackupTargets(manifest, roots)),
  };
}

/**
 * The roots a backup's `restorePath` entries are tested against.
 *
 * Supplied by the caller rather than taken from the manifest, for the reason `restoreManifest()`
 * requires the same: the manifest is a file on disk, so a root recorded inside it would be
 * editable by whatever wrote the path the classification is trying to judge.
 */
export type BackupRoots = {
  codexDir: string;
  claudeDir: string;
  toolHomeDir: string;
};

/**
 * Works out which targets a backup touched, for manifests written before the target was recorded.
 *
 * Applied in order, first answer wins:
 *
 * 1. `manifest.target`, present on everything `1.1.3` and later writes.
 * 2. The operation name: a `claude-` prefix means Claude, the known Codex operation names mean
 *    Codex. Every Claude mutation already uses that prefix, so this answers for every manifest
 *    written before this release.
 * 3. Artifact names first, then containment: a recognised registry name decides on its own, and
 *    every other path is tested against both trusted roots — see {@link originFromPaths}. This is
 *    the legacy arm, reached only by manifests older than the operation-name table.
 * 4. Otherwise `[]` — unclassifiable, never a guess.
 *
 * Steps 1 and 2 answer from metadata, which is what makes this the *provenance* question: which
 * target's operation produced the backup. What a restore will actually overwrite is a different
 * question with a different answer, and it is asked by `restoreImpactOf()`.
 *
 * **Step 3 decides nothing from bare tool-home containment, and that is deliberate rather than an
 * ordering rule.** `claude-providers.json` lives in the tool home and `settings.json` lives in the
 * Claude directory, so a `claude-switch` backup holds one of each and a classification that treated
 * the tool home as "the Codex side" would file it as Codex. What step 3 does read from the tool
 * home is the *name* of each artifact, which is fixed per target; containment itself answers only
 * for the two runtime directories, and a path in neither leaves the set untouched. Both arms build
 * a set rather than short-circuiting, which is why a manifest holding files under both trees is
 * reported as `mixed` instead of being assigned to whichever arm ran first.
 */
export function classifyBackupTargets(manifest: BackupManifest, roots: BackupRoots): TargetId[] {
  if (manifest.target) {
    return [manifest.target];
  }

  // An explicit table, not a prefix test on any string. `reason` is written by this tool, so the
  // recognised names are a closed set that can be listed; treating every `claude-`-prefixed value
  // as Claude would leave the door open for a future unrelated operation to be filed by spelling.
  if (manifest.reason.startsWith("claude-")) {
    return ["claude"];
  }
  if (CODEX_OPERATIONS.has(manifest.reason)) {
    return ["codex"];
  }

  return originFromPaths(manifest, roots);
}

/**
 * What a restore of one manifest would affect, on both axes that can be named.
 *
 * Two axes because one is not enough. `targets` alone cannot say "this restored only the shared
 * tool config" — that answer is the same empty list as "nothing here could be classified" — so
 * `shared` and `unknown` are carried beside it. Several of the outcomes below collapse to
 * `targets: []` and mean entirely different things; a report that could not distinguish them would
 * present a completed tool-config restore as recovery of nothing.
 *
 * Ordering and de-duplication are fixed (`codex` then `claude`) so a caller can compare two results
 * without sorting them first.
 */
export type RestoreImpact = {
  targets: TargetId[];
  impact: { shared: boolean; unknown: boolean };
};

/**
 * Works out which targets a restore would actually write to, by reading the manifest's file paths.
 *
 * **A different question from {@link classifyBackupTargets}, and deliberately a different
 * function.** That one answers "which target's operation produced this backup", and it is right to
 * answer from metadata: the operation is what names the backup, and `backups list` is a list of
 * operations. This one answers "which target's runtime state is about to be overwritten", and
 * metadata cannot answer that at all — a manifest may declare one target and hold another's files,
 * which is exactly the disagreement a reader would be misled by. So `manifest.target` and
 * `manifest.reason` are not consulted.
 *
 * Applied in three steps per restored destination, including a destination restored to *absence*
 * (a file that did not exist before the mutation is deleted to undo it — that is still a
 * restoration, and it still affects the target that owns the path):
 *
 * 1. A recognised artifact name decides on its own: `providers.json` is Codex's registry and
 *    `claude-providers.json` is Claude's *even when both sit inside one overlapping root*, which
 *    is what makes name recognition necessary rather than a shortcut. A known shared artifact —
 *    the tool config — is recorded on the `shared` axis instead of being attributed to a target.
 * 2. Every other path is tested against each trusted root independently, and **every** match is
 *    added. There is no Claude-first `if/else` winner here: with overlapping roots a path can
 *    legitimately be under both, and picking one would understate what the restore touched.
 * 3. A path with neither owner nor root match is recorded as `unknown`. Generic tool-home
 *    containment is deliberately *not* an answer: the tool home holds both registries, so
 *    "inside the tool home" would misattribute every registry-only backup it did not recognise.
 *
 * A manifest holding only tool-home artifacts the table does not know returns `targets: []` with
 * `unknown: true` — which is a statement, not a gap.
 */
export function restoreImpactOf(manifest: BackupManifest, roots: BackupRoots): RestoreImpact {
  const targets = new Set<TargetId>();
  let shared = false;
  let unknown = false;

  for (const entry of manifest.files) {
    const owner = artifactOwner(entry.restorePath);
    if (owner === "shared") {
      shared = true;
      continue;
    }
    if (owner !== null) {
      targets.add(owner);
      continue;
    }

    const matched = matchingRoots(entry.restorePath, roots);
    if (matched.length === 0) {
      unknown = true;
      continue;
    }
    for (const target of matched) {
      targets.add(target);
    }
  }

  return {
    targets: (["codex", "claude"] as const).filter((target) => targets.has(target)),
    impact: { shared, unknown },
  };
}

/**
 * The target list alone, for callers that need only that axis.
 */
export function targetsRestoredBy(manifest: BackupManifest, roots: BackupRoots): TargetId[] {
  return restoreImpactOf(manifest, roots).targets;
}

/**
 * Collapses a target list into the label a backup entry carries.
 */
export function labelBackupTargets(targets: TargetId[]): BackupTargetLabel {
  if (targets.length === 0) {
    return "unknown";
  }
  if (targets.length === 1) {
    return targets[0];
  }
  return "mixed";
}

/**
 * Reports whether `candidate` resolves strictly inside `root`.
 *
 * Strictly: a path equal to the root itself is not inside it. A directory is never a backup entry,
 * so the distinction only matters as a guard against a root being accepted on its own.
 */
function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
