import { resolveClaudeProviderRecord, summarizeClaudeSettings } from "../domain/claude-providers";
import { collectInheritedPaths } from "../domain/claude-settings-merge";
import { maskSecretValues } from "../domain/secrets";
import { readClaudeProviderRecord } from "../storage/claude-providers-repo";
import { CommandResult } from "./types";

/**
 * Shows details of a single Claude provider profile.
 *
 * What it shows is the resolved settings — what `switch` would write — so a delta-stored record
 * reads as the provider it actually is. `inherited` lists the dotted paths that came from the
 * shared defaults rather than the record; it carries paths and never values, so it is safe in
 * every mode.
 *
 * Secrets are masked unless the caller passes `reveal`. The raw `settings` blob is
 * withheld entirely in the default case rather than masked: it is opaque and can nest
 * arbitrarily, so there is no reliable rule for which of its values are credentials. That includes
 * the inherited half — a shared credential in the defaults block is masked in `env` like any other.
 */
export async function claudeShowProvider(args: {
  claudeProvidersPath: string;
  providerName: string;
  reveal: boolean;
  defaults: Record<string, unknown> | null;
}): Promise<CommandResult> {
  const record = readClaudeProviderRecord(args.claudeProvidersPath, args.providerName);
  const { effective } = resolveClaudeProviderRecord(record, args.defaults);
  const summary = summarizeClaudeSettings(effective);
  const env = (effective.env as Record<string, string> | undefined) ?? {};

  const data: Record<string, unknown> = {
    target: "claude",
    provider: args.providerName,
    model: summary.model,
    baseUrl: summary.baseUrl,
    theme: summary.theme,
    note: record.note ?? null,
    tags: record.tags ?? [],
    env: args.reveal ? env : maskSecretValues(env),
    inherited: args.defaults === null ? [] : collectInheritedPaths(args.defaults, record.settings),
    revealed: args.reveal,
  };

  if (args.reveal) {
    // `settings` is what gets written; `overrides` is what is stored. Revealing only the stored
    // delta would show a file that is not the one Claude Code ends up with.
    data.settings = effective;
    data.overrides = record.settings;
  }

  return { data };
}
