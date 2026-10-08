import { isDeepStrictEqual } from "node:util";
import { ClaudeProvidersFile } from "../domain/claude-providers";
import { collectDroppedPaths, diffClaudeSettings } from "../domain/claude-settings-merge";
import { readClaudeProvidersFileIfExists, writeClaudeProvidersFile } from "../storage/claude-providers-repo";
import { runMutation } from "./run-mutation";
import { CommandResult } from "./types";

type CompactPlan = {
  provider: string;
  changed: boolean;
  /** Dotted paths dropped because they equal a default. Paths only — never values. */
  droppedPaths: string[];
  delta: Record<string, unknown>;
};

/**
 * Rewrites every stored Claude provider to the entries that differ from the shared defaults.
 *
 * Nothing observable changes. A record is resolved over the defaults whenever it is read, full or
 * delta alike, so `merge(defaults, diff(defaults, x))` equals `merge(defaults, x)` and a switch
 * writes the same file before and after. Only how the provider is stored changes.
 *
 * `--dry-run` is a separate branch that returns before `runMutation` is reached, not a mutation that
 * skips its write: it must not take the lock, create a backup, or touch the file, and a preview that
 * acquired the lock could block on — or collide with — a real operation in another terminal. A run
 * with nothing to change takes the same early exit, for the same reason: a backup of an unchanged
 * file is noise that pushes a useful one toward retention.
 */
export async function claudeConfigCompact(args: {
  lockPath: string;
  backupsDir: string;
  latestBackupPath: string;
  claudeProvidersPath: string;
  defaults: Record<string, unknown>;
  dryRun: boolean;
}): Promise<CommandResult> {
  const preview = planCompaction(readClaudeProvidersFileIfExists(args.claudeProvidersPath), args.defaults);

  if (args.dryRun || preview.every((plan) => !plan.changed)) {
    return { data: buildPayload(preview, args.dryRun) };
  }

  return runMutation({
    lockPath: args.lockPath,
    backupsDir: args.backupsDir,
    latestBackupPath: args.latestBackupPath,
    operation: "claude-config-compact",
    files: [{ absolutePath: args.claudeProvidersPath, relativePath: "claude-providers.json" }],
    mutate: () => {
      // Re-read under the lock. The preview above ran without it, so another writer may have added
      // or removed a provider since, and compacting from a stale read would write it back.
      const file = readClaudeProvidersFileIfExists(args.claudeProvidersPath);
      const plans = planCompaction(file, args.defaults);

      const next: ClaudeProvidersFile = { providers: {} };
      for (const plan of plans) {
        // Everything but `settings` — note, tags — is carried over untouched.
        next.providers[plan.provider] = { ...file.providers[plan.provider], settings: plan.delta };
      }
      writeClaudeProvidersFile(args.claudeProvidersPath, next);

      return buildPayload(plans, false);
    },
  });
}

/**
 * Works out what compaction would do to each provider, without writing anything.
 *
 * "Changed" is decided by deep equality, never by comparing serialized text: `diffClaudeSettings`
 * builds new objects, so key order can shift while no value does, and a text comparison would call
 * an already-compact file changed on every run.
 */
function planCompaction(file: ClaudeProvidersFile, defaults: Record<string, unknown>): CompactPlan[] {
  return Object.keys(file.providers)
    .sort()
    .map((provider) => {
      const { settings } = file.providers[provider];
      const delta = diffClaudeSettings(defaults, settings);
      return {
        provider,
        changed: !isDeepStrictEqual(delta, settings),
        droppedPaths: collectDroppedPaths(defaults, settings),
        delta,
      };
    });
}

function buildPayload(plans: CompactPlan[], dryRun: boolean): Record<string, unknown> {
  const changedCount = plans.filter((plan) => plan.changed).length;
  return {
    target: "claude",
    dryRun,
    changedCount,
    unchangedCount: plans.length - changedCount,
    providers: plans.map((plan) => ({
      provider: plan.provider,
      changed: plan.changed,
      droppedPaths: plan.droppedPaths,
    })),
  };
}
