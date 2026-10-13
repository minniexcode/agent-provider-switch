import { CliErrorShape } from "../domain/errors";
import { isSecretKey, maskSecret } from "../domain/secrets";
import { scopeOfName, singleTarget, type TargetId } from "../domain/target";
import { printErrorDetails } from "../storage/fs-utils";
import { CommandResult } from "../app/types";
import { CommandExecutionContext } from "../commands/types";

export type JsonEnvelope = {
  ok: boolean;
  command: string;
  /**
   * The targets this invocation covers, or `[]` when no command resolved. **Authoritative.**
   *
   * A list because a command may cover two: `aps doctor --json` answers with both targets, and
   * `--claude` or `--codex` narrows it to one. Before `1.1.3` this was a single value, which was
   * accurate while every target-aware command was single-target.
   */
  targets: TargetId[];
  /**
   * The single target when exactly one is covered, otherwise `null`. A convenience alias for
   * `targets[0]`, derived from it rather than resolved separately, so the two cannot disagree.
   *
   * Written on both the success and the failure path, which is what makes it readable without
   * correlating `command` against an error code. That matters most for failures: before this
   * field existed, the only signal that a failed `switch --claude` asked about Claude was the
   * `CLAUDE_` prefix on its error code.
   *
   * This is the only place a payload states its target. `data.target` used to carry a second copy,
   * written by hand in each Claude service, and was removed in `1.1.2` — the envelope is written
   * once from the resolved targets, so a service cannot disagree with it.
   */
  target: TargetId | null;
  data: Record<string, unknown> | null;
  warnings: string[];
  error: CliErrorShape | null;
};

export type RenderedOutput = {
  stdout: string[];
  stderr: string[];
  exitCode: number;
};

/**
 * Renders a successful command result for either JSON or human-readable output.
 */
export function renderSuccess(ctx: CommandExecutionContext, result: CommandResult): RenderedOutput {
  const warnings = result.warnings ?? [];
  if (ctx.options.json) {
    const payload: JsonEnvelope = {
      ok: true,
      command: ctx.command,
      targets: ctx.targets,
      target: singleTarget(ctx.targets),
      data: result.data,
      warnings,
      error: null,
    };

    return {
      stdout: [JSON.stringify(payload, null, 2)],
      stderr: [],
      exitCode: 0,
    };
  }

  return {
    stdout: renderHumanSuccess(ctx, result.data, warnings),
    stderr: [],
    exitCode: 0,
  };
}

/**
 * Renders a failed command result for either JSON or human-readable output.
 */
export function renderFailure(ctx: CommandExecutionContext, error: CliErrorShape): RenderedOutput {
  if (ctx.options.json) {
    const payload: JsonEnvelope = {
      ok: false,
      command: ctx.command,
      targets: ctx.targets,
      target: singleTarget(ctx.targets),
      data: null,
      warnings: [],
      error,
    };

    return {
      stdout: [],
      stderr: [JSON.stringify(payload, null, 2)],
      exitCode: 1,
    };
  }

  return {
    stdout: [],
    stderr: [`${error.code}: ${error.message}`, ...printErrorDetails(error)],
    exitCode: 1,
  };
}

/**
 * Builds the plain-text success view for interactive terminal usage.
 *
 * The targets are the resolved ones rather than payload fields. The Claude services used to write
 * their own `target: "claude"` into `data`, and this renderer read that until `1.1.1`; switching to
 * the resolved targets is what made the payload's copy removable, because at the moment it was
 * deleted it had no reader left inside the repository. `data` is nullable here rather than because
 * of that change — a resolved Claude target no longer implies a non-null payload.
 *
 * The Claude view is reached from the routing question, not from the target list alone: a `both`
 * command narrowed with `--claude` covers only Claude and must still render its own view, because
 * `renderClaudeHumanSuccess` knows nothing about diagnostics.
 */
function renderHumanSuccess(
  ctx: CommandExecutionContext,
  data: Record<string, unknown> | null,
  warnings: string[]
): string[] {
  const lines: string[] = [];
  const command = ctx.command;
  const scope = scopeOfName(command);

  if (ctx.targets.length === 1 && ctx.targets[0] === "claude" && (scope === "switchable" || scope === "claude-only")) {
    return renderClaudeHumanSuccess(command, data ?? {}, warnings);
  }

  switch (command) {
    case "list": {
      const providers = (data?.providers as Array<Record<string, unknown>>) ?? [];
      if (providers.length === 0) {
        lines.push("No providers configured.");
      } else {
        const currentModel = typeof data?.currentModel === "string" ? data.currentModel : null;
        const currentModelProvider = typeof data?.currentModelProvider === "string" ? data.currentModelProvider : null;
        const activeProviderResolvable = data?.activeProviderResolvable !== false;
        const activeCandidates = Array.isArray(data?.activeProviderCandidates) ? (data?.activeProviderCandidates as string[]) : [];
        if (currentModel) {
          lines.push(`Current model: ${currentModel}`);
        }
        if (currentModelProvider) {
          lines.push(`Current model provider: ${currentModelProvider}`);
          if (!activeProviderResolvable && activeCandidates.length > 1) {
            lines.push(`Current provider: ambiguous (${activeCandidates.join(", ")})`);
          } else if (!activeProviderResolvable) {
            lines.push("Current provider: unmanaged or unresolved");
          }
        }
        for (const provider of providers) {
          const tags = Array.isArray(provider.tags) && provider.tags.length > 0
            ? ` tags=${(provider.tags as string[]).join(",")}`
            : "";
          const note = provider.note ? ` note=${provider.note}` : "";
          const current = provider.isActive ? " current" : "";
          lines.push(`${provider.name}${current} -> ${provider.modelProvider}${provider.model ? ` model=${provider.model}` : ""}${tags}${note}`);
        }
      }
      break;
    }
    case "show": {
      const provider = (data?.provider as Record<string, unknown>) ?? {};
      lines.push(`Provider: ${String(data?.providerName ?? "")}`);
      lines.push(`profile: ${String(provider.profile ?? "")}`);
      lines.push(`apiKey: ${String(provider.apiKey ?? "")}`);
      if (provider.baseUrl) {
        lines.push(`baseUrl: ${String(provider.baseUrl)}`);
      }
      if (provider.note) {
        lines.push(`note: ${String(provider.note)}`);
      }
      if (Array.isArray(provider.tags) && provider.tags.length > 0) {
        lines.push(`tags: ${(provider.tags as string[]).join(", ")}`);
      }
      break;
    }
    case "current":
      lines.push(`Current model: ${String(data?.model ?? "")}`);
      lines.push(`Current model provider: ${String(data?.modelProvider ?? "")}`);
      if (data?.provider) {
        lines.push(`Managed provider: ${String(data.provider)}`);
      }
      break;
    case "status": {
      // A narrowed `status` omits the other target's block, which is what makes `targets` more
      // than decoration: the sections are composed by the handler from the selected targets.
      const codex = data?.codex as Record<string, unknown> | undefined;
      const claude = data?.claude as Record<string, unknown> | undefined;

      if (codex) {
        const paths = okValue<Record<string, string>>(codex.paths);
        lines.push("Status summary:");
        lines.push(`  target runtime: ${paths?.codexDir ?? "(unknown)"}`);
        lines.push(`  tool home: ${String(data?.toolHomeRoot ?? "")}`);
        lines.push(`  current model: ${String(codex.currentModel ?? "(none)")}`);
        lines.push(`  current model provider: ${String(codex.currentModelProvider ?? "(none)")}`);
        lines.push(`  mapped provider: ${renderStatusMappedProvider(codex)}`);
        lines.push(`  provider path: ${renderStatusProviderPath(codex)}`);
        lines.push(`  runtime health: ${renderStatusHealth(codex)}`);
        lines.push(`  warnings: ${warnings.length}`);
        lines.push(`  next step: ${renderStatusNextStep(data, warnings)}`);
      }
      if (claude) {
        // The tool home is the only field both blocks would print, so the narrowed Claude view
        // carries it and the combined view leaves it to the Codex block above.
        if (!codex) {
          lines.push("Status summary:");
          lines.push(`  tool home: ${String(data?.toolHomeRoot ?? "")}`);
        }
        lines.push("Claude summary:");
        lines.push(`  claude dir: ${okValue<Record<string, string>>(claude.paths)?.claudeDir ?? "(unknown)"}`);
        lines.push(`  providers registry: ${renderReading(claude.registry, (value) => `${(value as { providerCount: number }).providerCount} record(s)`)}`);
        lines.push(`  settings: ${renderReading(claude.live, () => "present")}`);
        lines.push(`  configured: ${renderReading(claude.configured, (value) => String(value))}`);
        lines.push(`  activation: ${renderReading(claude.activation, (value) => String(value))}`);
        lines.push(`  providers: ${renderCountReading(claude.providerCount)}`);
        lines.push(`  active provider: ${renderClaudeActiveProvider(claude.matching)}`);
      }

      // The summary lines are the same for either target and are printed once, under the blocks.
      lines.push(`  health: ${renderHealth(data?.healthy, data?.complete)}`);
      const statusIssues = (data?.issues as Array<Record<string, unknown>>) ?? [];
      const statusNotes = (data?.notes as Array<Record<string, unknown>>) ?? [];
      for (const issue of statusIssues) {
        lines.push(`  issue [${String(issue.target ?? "shared")}] ${String(issue.code)}: ${String(issue.message)}`);
      }
      for (const note of statusNotes) {
        lines.push(`  note [${String(note.target ?? "shared")}] ${String(note.code)}: ${String(note.message)}`);
      }
      break;
    }
    case "config-show": {
      lines.push(`currentModel: ${String(data?.currentModel ?? "")}`);
      lines.push(`currentModelProvider: ${String(data?.currentModelProvider ?? "")}`);
      lines.push(`legacyProfile: ${String(data?.legacyProfile ?? "")}`);
      const profiles = (data?.profiles as Array<Record<string, unknown>>) ?? [];
        for (const profile of profiles) {
          lines.push(
          `${String(profile.name)} managed=${String(profile.managed)} active=${String(profile.isActive)} source=${String(profile.source)} model=${String(profile.model ?? "")} modelProvider=${String(profile.modelProvider ?? "")} baseUrl=${String(profile.baseUrl ?? "")}`
          );
        }
      break;
    }
    case "config-list-profiles": {
      const profiles = (data?.profiles as Array<Record<string, unknown>>) ?? [];
      for (const profile of profiles) {
        lines.push(
          `${String(profile.name)} managed=${String(profile.managed)} active=${String(profile.isActive)} source=${String(profile.source)}`
        );
      }
      break;
    }
    case "switch":
      lines.push(`Switched to provider ${String(data?.provider ?? "")} using model provider ${String(data?.modelProvider ?? data?.profile ?? "")}.`);
      lines.push(`Model: ${String(data?.model ?? "")}`);
      lines.push(`Backup: ${String(data?.backupPath ?? "")}`);
      break;
    case "import":
      lines.push(`Imported providers from file using mode ${String(data?.mode ?? "replace")}. Backup: ${String(data?.backupPath ?? "")}`);
      break;
    case "export":
      lines.push(`Exported providers to ${String(data?.exportedTo ?? "")}.`);
      break;
    case "init":
      lines.push("Initialized agent-provider-switch tool home.");
      lines.push(`tool home: ${String(data?.toolHomeDir ?? "")}`);
      lines.push(`tool config: ${String(data?.toolConfigPath ?? "")}`);
      lines.push(`providers registry: ${String(data?.providersPath ?? "")}`);
      lines.push(`tool home created: ${String(data?.createdToolHomeDir ?? false)}`);
      lines.push(`tool config created: ${String(data?.createdToolConfigFile ?? false)}`);
      lines.push(`providers registry created: ${String(data?.createdProvidersFile ?? false)}`);
      lines.push("next step: run `aps add <provider> --profile <model-provider-id> --model <model> --api-key <key> --base-url <url>`.");
      break;
    case "migrate":
      lines.push(`Migrated providers in ${String(data?.codexDir ?? "")} using ${String(data?.strategy ?? "")}.`);
      lines.push(`Providers initialized: ${String(data?.providersInitialized ?? 0)}`);
      lines.push(`Doctor healthy: ${String((data?.doctor as Record<string, unknown> | undefined)?.healthy ?? false)}`);
      lines.push(`Backup: ${String(data?.backupPath ?? "")}`);
      break;
    case "setup":
      lines.push("setup is deprecated. Use `aps init` or `aps migrate`.");
      break;
    case "edit":
      lines.push(`Updated provider ${String(data?.provider ?? "")}. Backup: ${String(data?.backupPath ?? "")}`);
      lines.push(`Updated fields: ${Array.isArray(data?.updatedFields) ? (data?.updatedFields as string[]).join(", ") : ""}`);
      break;
    case "add":
      lines.push(`Added provider ${String(data?.provider ?? "")}. Backup: ${String(data?.backupPath ?? "")}`);
      if (Array.isArray(data?.createdProfileSections) && (data?.createdProfileSections as string[]).length > 0) {
        lines.push(`Created profiles: ${(data?.createdProfileSections as string[]).join(", ")}`);
      }
      break;
    case "remove":
      lines.push(`Removed provider ${String(data?.provider ?? "")}. Backup: ${String(data?.backupPath ?? "")}`);
      if (Array.isArray(data?.deletedProfileSections) && (data?.deletedProfileSections as string[]).length > 0) {
        lines.push(`Deleted profiles: ${(data?.deletedProfileSections as string[]).join(", ")}`);
      }
      break;
    case "doctor": {
      const issues = (data?.issues as Array<Record<string, unknown>>) ?? [];
      // `healthy` is three-valued, and the third value must not read as either of the other two:
      // "unknown" is what a run says when it could not complete its checks, and printing it as
      // "healthy" would be the claim the field exists to avoid making.
      const healthy = data?.healthy;
      const summary =
        healthy === false
          ? `${issues.length} issue(s) need attention`
          : healthy === true
            ? "healthy. No action required"
            : "incomplete: some checks could not be performed, and none that ran found a fault";
      lines.push(`Doctor summary: ${summary}.`);
      lines.push(`  complete: ${String(data?.complete ?? false)}`);
      lines.push(`  shared lock: ${renderReading((data?.shared as Record<string, unknown> | undefined)?.lock, (value) => String(value))}`);
      const codex = data?.codex as Record<string, unknown> | undefined;
      if (codex) {
        lines.push(`target runtime: ${okValue<Record<string, string>>(codex.paths)?.codexDir ?? "(unknown)"}`);
      }
      // The target is named only when more than one is in scope. A narrowed run has nothing to
      // disambiguate, and its lines stay exactly as `1.1.2` rendered them.
      const labelTargets = ctx.targets.length > 1;
      for (const issue of issues) {
        const label = labelTargets ? `[${String(issue.target ?? "shared")}] ` : "";
        lines.push(`- ${label}${String(issue.code)}: ${String(issue.message)}`);
        lines.push(`  next step: ${renderDoctorIssueNextStep(issue)}`);
      }
      // Printed after the issues, and under their own heading, because they are not something to
      // act on and must not read as part of the count above them.
      const notes = (data?.notes as Array<Record<string, unknown>>) ?? [];
      if (notes.length > 0) {
        lines.push(`${notes.length} note(s), nothing to fix:`);
        for (const note of notes) {
          const label = labelTargets ? `[${String(note.target ?? "shared")}] ` : "";
          lines.push(`- ${label}${String(note.code)}: ${String(note.message)}`);
        }
      }
      break;
    }
    case "backups-list": {
      const backups = (data?.backups as Array<Record<string, unknown>>) ?? [];
      for (const backup of backups) {
        lines.push(`${backup.backupId} ${backup.reason} ${String(backup.target)} ${backup.createdAt}`);
      }
      break;
    }
    case "backups-prune": {
      const removed = Array.isArray(data?.removed) ? (data?.removed as string[]) : [];
      lines.push(`Retention kept ${String(data?.keep ?? "")} backup(s) and removed ${removed.length}.`);
      for (const backupId of removed) {
        lines.push(`- removed ${backupId}`);
      }
      // Counts of what was deliberately left alone are surfaced here rather than only in the
      // warnings, so the retained total is explicable instead of looking like a bug.
      const protectedCount = Number(data?.protectedCount ?? 0);
      const unreadableCount = Number(data?.unreadableCount ?? 0);
      if (protectedCount > 0) {
        lines.push(`Kept ${protectedCount} backup(s) that a surviving manifest still references.`);
      }
      if (unreadableCount > 0) {
        lines.push(`Kept ${unreadableCount} backup(s) whose manifest is missing or unreadable.`);
      }
      break;
    }
    case "unlock": {
      const removed = Boolean(data?.removed);
      lines.push(
        removed
          ? `Cleared the agent-provider-switch lock (${String(data?.reason ?? "removed")}).`
          : `No agent-provider-switch lock to clear (${String(data?.reason ?? "absent")}).`
      );
      const owner = data?.owner as Record<string, unknown> | null | undefined;
      if (owner) {
        lines.push(
          `  previous owner: pid ${String(owner.pid ?? "unknown")}, operation "${String(owner.operation ?? "unknown")}", started ${String(owner.createdAt ?? "unknown")}`
        );
      }
      break;
    }
    case "rollback": {
      lines.push(`Rollback restored files from ${String(data?.backupPath ?? "")}.`);
      // Which targets the backup touched, which is not the same question as which target this
      // invocation named: `rollback` is a shared command and names none. `targets` alone cannot say
      // "only shared state" and "nothing classifiable" apart — both are the empty list — so the
      // impact flags are printed beside it rather than left to the JSON.
      const restored = Array.isArray(data?.targets) ? (data.targets as string[]) : [];
      const impact = (data?.impact as { shared?: boolean; unknown?: boolean } | undefined) ?? {};
      lines.push(`  restored targets: ${restored.length > 0 ? restored.join(", ") : "none"}`);
      if (impact.shared) {
        lines.push("  shared state was restored; neither target's runtime files were overwritten.");
      }
      if (impact.unknown) {
        lines.push("  some restored paths could not be attributed to a target.");
      }
      break;
    }
    default:
      lines.push(JSON.stringify(data, null, 2));
      break;
  }

  // Emit warnings after the primary payload so the main outcome remains easy to scan.
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines;
}

/**
 * The value inside an `ok` reading, or `null` for any of the three other states.
 *
 * The renderer's counterpart to `valueOf()` in the domain: it collapses the tag because a human
 * line has room for one answer, and the callers below are the places where that is the right
 * trade. Anything that has to explain *why* a reading did not resolve uses {@link renderReading}.
 */
function okValue<T>(reading: unknown): T | null {
  const tagged = reading as { status?: string; value?: T } | undefined;
  return tagged?.status === "ok" ? (tagged.value as T) : null;
}

/**
 * Prints one reading the way a human reads it: the value, or the state and its reason.
 *
 * `absent` prints as the word rather than as an empty value, which is the whole point of the
 * vocabulary reaching the terminal: a missing `settings.json` and an unreadable one are different
 * repairs, and both differ from a file that is there and says nothing.
 */
function renderReading(reading: unknown, render: (value: unknown) => string): string {
  const tagged = reading as { status?: string; value?: unknown; reason?: string } | undefined;
  switch (tagged?.status) {
    case "ok":
      return render(tagged.value);
    case "absent":
      return "absent";
    case "invalid":
      return `invalid (${tagged.reason ?? "unusable"})`;
    case "unavailable":
      return `unavailable (${tagged.reason ?? "could not be read"})`;
    default:
      return "not reported";
  }
}

/**
 * A count reading, where the distinction between a real zero and an unobtainable count matters.
 */
function renderCountReading(reading: unknown): string {
  return renderReading(reading, (value) => `${String(value)}`);
}

/**
 * The health line, which has three outcomes and prints all three apart.
 */
function renderHealth(healthy: unknown, complete: unknown): string {
  if (healthy === false) {
    return "unhealthy";
  }
  if (healthy === true) {
    return "healthy";
  }
  return `unknown (report ${complete === false ? "incomplete" : "complete"})`;
}

/**
 * Names the active Claude provider, or the state that stands in for one.
 *
 * Ambiguous is spelled out with its candidates rather than resolved to the first of them: the
 * match found several, and picking one here would be the renderer inventing a fact the report
 * deliberately withheld.
 */
function renderClaudeActiveProvider(matching: unknown): string {
  const match = okValue<{ state: string; activeProvider: string | null; candidates: Array<{ name: string }> }>(matching);
  if (!match) {
    return renderReading(matching, () => "(none)");
  }
  switch (match.state) {
    case "managed":
      return match.activeProvider ?? "(none)";
    case "ambiguous":
      return `(ambiguous: ${match.candidates.map((candidate) => candidate.name).join(", ")})`;
    case "not-activated":
      return "(not activated)";
    default:
      return "(unmanaged or unresolved)";
  }
}

/**
 * Summarizes runtime health for the human-readable status output.
 *
 * Read from the section's readings, not from the raw files: the same answers the JSON carries are
 * what decides the sentence, so the human and machine views cannot describe different states.
 *
 * Absence and unreadability are separate sentences here for the same reason they are separate
 * readings underneath. A machine that has never activated Codex has an absent `config.toml`, and
 * calling that "unreadable" would print a repair for a target the user has not started using —
 * this line is where "a missing file is a fact, not a fault" has to reach the terminal. Only
 * content this process obtained and could not use is "unreadable".
 */
function renderStatusHealth(codex: Record<string, unknown>): string {
  const artifacts = (codex.artifacts as Record<string, unknown> | undefined) ?? {};
  const config = artifacts.config as { status?: string } | undefined;
  const authStatus = (artifacts.auth as { status?: string } | undefined)?.status;
  const match = okValue<{ state: string; candidates: Array<{ consistent: boolean }> }>(codex.matching);
  const registry = (codex.registry as { status?: string } | undefined)?.status;

  if (registry === "invalid" || registry === "unavailable") {
    return "providers.json unreadable";
  }
  if (config?.status === "invalid" || config?.status === "unavailable") {
    return "config.toml unreadable";
  }
  // No active route is a state, and it is reached by both an absent `config.toml` and one without a
  // top-level selector. Neither owes the reader a repair, and the auth projection is not checked
  // for either: a target that was never activated has no projection to be missing.
  if (match?.state === "not-activated") {
    return "not activated";
  }
  if (!match) {
    return "provider identity unresolved";
  }
  if (match.state === "ambiguous") {
    return "active provider ambiguous";
  }
  // The drift sentence comes from the matching candidates rather than from the issue list, because
  // the section is what this renderer is handed. A candidate that disagrees with its stored record
  // is the same fact the `PROVIDER_BASE_URL_MISMATCH` issue carries, read from the same place it is
  // computed, so the two views cannot drift apart.
  if (match.candidates.some((candidate) => !candidate.consistent)) {
    return "provider projection drift";
  }
  if (authStatus === "absent") {
    return "auth projection missing";
  }
  if (authStatus === "invalid") {
    return "auth projection invalid";
  }
  return "ok";
}

/**
 * Renders the mapped provider line without claiming a unique winner for shared profiles.
 */
function renderStatusMappedProvider(codex: Record<string, unknown>): string {
  const match = okValue<{ state: string; activeProvider: string | null; candidates: Array<{ name: string }> }>(codex.matching);
  if (!match) {
    return "(unresolved)";
  }
  if (match.state === "managed" && match.activeProvider) {
    return match.activeProvider;
  }
  if (match.state === "ambiguous") {
    return `(ambiguous: ${match.candidates.map((candidate) => candidate.name).join(", ")})`;
  }
  return match.state === "not-activated" ? "(not activated)" : "(unmanaged or unresolved)";
}

/**
 * Renders the active workflow path in status output.
 */
function renderStatusProviderPath(codex: Record<string, unknown>): string {
  return okValue<{ state: string }>(codex.matching)?.state === "managed"
    ? "managed provider"
    : "unmanaged route";
}

/**
 * Suggests the next operator action for the human-readable status output.
 */
function renderStatusNextStep(data: Record<string, unknown> | null, warnings: string[]): string {
  if (warnings.length > 0) {
    return "run `aps doctor` to inspect warnings before the next write command";
  }
  const codex = data?.codex as Record<string, unknown> | undefined;
  const managed = okValue<{ state: string }>(codex?.matching)?.state === "managed";
  if (!managed) {
    return "run `aps switch <provider>` after adding or adopting a managed provider";
  }
  if (Array.isArray(data?.issues) && (data?.issues as Array<Record<string, unknown>>).some((issue) => issue.code === "LEGACY_PROFILE_SELECTOR" || issue.code === "LEGACY_PROFILE_SECTION" || issue.code === "LEGACY_MODEL_PROVIDER_ENV_KEY")) {
    return "run `aps switch <provider>` to reproject the active route and clean legacy fields";
  }
  return "run `aps doctor` if you need a deeper diagnostic pass";
}

/**
 * Turns structured doctor issue codes into repair-oriented next steps.
 */
function renderDoctorIssueNextStep(issue: Record<string, unknown>): string {
  switch (issue.code) {
    // Absence is not one of the branches here. A missing registry, a missing `config.toml`, and a
    // missing `settings.json` are states the report carries in its readings, so no issue is raised
    // for them and a case for one would be unreachable — the "create the file" advice belongs to
    // the reading, not to an issue that never fires.
    case "CLAUDE_SETTINGS_INVALID":
      return "repair settings.json by hand, or repair the record it matches with `aps edit --claude <name>`";
    case "CLAUDE_DEFAULTS_INVALID":
      return "fix or remove `claudeDefaults` in agent-provider-switch.json";
    case "SHARED_CONFIG_INVALID":
      return "repair agent-provider-switch.json, or restore it with `aps rollback`";
    case "PROVIDERS_PARSE_ERROR":
    case "CONFIG_PARSE_ERROR":
      return "repair the file the issue names, or restore it with `aps rollback`";
    case "AUTH_JSON_INVALID":
      return "repair auth.json, or run `aps switch <provider>` to rewrite it from the registry";
    case "INVALID_CONFIG":
      return "fix the stored record the issue names; `aps show --claude <name>` prints its resolved settings";
    case "LEGACY_PROFILE_SELECTOR":
    case "LEGACY_PROFILE_SECTION":
    case "LEGACY_MODEL_PROVIDER_ENV_KEY":
      return "rerun `aps switch <provider>` to project top-level model/model_provider and remove legacy fields";
    case "PROVIDER_BASE_URL_MISMATCH":
      return "rerun `aps edit <provider> --base-url <url>` or `aps switch <provider>` to repair the runtime projection";
    case "LOCK_STALE":
      return "the next write command clears it automatically, or run `aps unlock`";
    case "LOCK_ABNORMAL":
      return "inspect the lock file the issue names, then run `aps unlock --force`";
    default:
      return "inspect the issue details and rerun `aps doctor` after fixing the state";
  }
}

/**
 * Collapses dotted settings paths into a one-line summary: `env.A` and `env.B` become `env(2)`,
 * and a top-level key that is itself the path stays a bare name.
 */
function summarizeInheritedPaths(paths: string[]): string {
  const groups = new Map<string, number>();
  const bare = new Set<string>();
  for (const settingsPath of [...paths].sort()) {
    const [head, ...rest] = settingsPath.split(".");
    if (rest.length === 0) {
      bare.add(head);
    }
    groups.set(head, (groups.get(head) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([head, count]) => (bare.has(head) && count === 1 ? head : `${head}(${count})`))
    .join(", ");
}

/**
 * Builds the plain-text success view for Claude Code provider commands.
 */
function renderClaudeHumanSuccess(command: string, data: Record<string, unknown>, warnings: string[]): string[] {
  const lines: string[] = [];
  switch (command) {
    case "list": {
      const providers = (data.providers as Array<Record<string, unknown>>) ?? [];
      if (providers.length === 0) {
        lines.push("No Claude providers configured. Run `aps add --claude <name> --from-file <path>` to add one.");
      } else {
        lines.push("Claude Code providers:");
        for (const provider of providers) {
          const active = provider.isActive ? " (current)" : "";
          const model = provider.model ? ` model=${provider.model}` : "";
          const baseUrl = provider.baseUrl ? ` base=${provider.baseUrl}` : "";
          const note = provider.note ? ` note=${provider.note}` : "";
          lines.push(`  ${provider.name}${active}${model}${baseUrl}${note}`);
        }
      }
      break;
    }
    case "show": {
      // Paths only: `inherited` never carries a value, so marking entries cannot leak anything.
      const inherited = new Set(Array.isArray(data.inherited) ? (data.inherited as string[]) : []);
      const mark = (settingsPath: string): string => (inherited.has(settingsPath) ? " (inherited)" : "");

      lines.push(`Claude provider: ${String(data.provider ?? "")}`);
      if (data.model) lines.push(`  model: ${String(data.model)}${mark("model")}`);
      if (data.baseUrl) lines.push(`  base URL: ${String(data.baseUrl)}${mark("env.ANTHROPIC_BASE_URL")}`);
      if (data.theme) lines.push(`  theme: ${String(data.theme)}${mark("theme")}`);
      if (data.note) lines.push(`  note: ${String(data.note)}`);
      if (Array.isArray(data.tags) && data.tags.length > 0) {
        lines.push(`  tags: ${(data.tags as string[]).join(", ")}`);
      }
      // `revealed` comes from the payload instead of being re-derived, so this pass
      // stays a genuine second line of defence if the service layer ever stops masking.
      const revealed = data.revealed === true;
      const env = data.env as Record<string, string> | undefined;
      if (env && Object.keys(env).length > 0) {
        lines.push("  env:");
        for (const [key, value] of Object.entries(env)) {
          const display = revealed || !isSecretKey(key) ? value : maskSecret(value);
          lines.push(`    ${key}=${display}${mark(`env.${key}`)}`);
        }
        if (!revealed) {
          lines.push("  (secret values masked; pass --reveal to print them)");
        }
      }
      if (inherited.size > 0) {
        lines.push(`  inherited: ${summarizeInheritedPaths([...inherited])}`);
      }
      break;
    }
    case "current": {
      if (data.status === "no-settings") {
        lines.push(String(data.message));
      } else if (data.status === "managed" && data.active) {
        lines.push(`Active Claude provider: ${String(data.active)}`);
        if (data.model) lines.push(`  model: ${String(data.model)}`);
        if (data.baseUrl) lines.push(`  base URL: ${String(data.baseUrl)}`);
      } else if (data.status === "ambiguous") {
        // Named with its candidates and without a winner. Saying "does not match any registered
        // provider" here would be false, and naming one of them would be a guess.
        const candidates = Array.isArray(data.candidates) ? (data.candidates as string[]) : [];
        lines.push(`Current Claude settings match more than one registered provider: ${candidates.join(", ")}.`);
        if (data.model) lines.push(`  model: ${String(data.model)}`);
        if (data.baseUrl) lines.push(`  base URL: ${String(data.baseUrl)}`);
      } else {
        lines.push("Current Claude settings do not match any registered provider.");
        if (data.model) lines.push(`  model: ${String(data.model)}`);
        if (data.baseUrl) lines.push(`  base URL: ${String(data.baseUrl)}`);
      }
      break;
    }
    case "switch":
      lines.push(`Switched Claude Code to provider "${String(data.provider ?? "")}".`);
      if (data.model) lines.push(`  model: ${String(data.model)}`);
      if (data.baseUrl) lines.push(`  base URL: ${String(data.baseUrl)}`);
      if (data.backupPath) lines.push(`  backup: ${String(data.backupPath)}`);
      break;
    case "config-compact": {
      const providers = (data.providers as Array<Record<string, unknown>>) ?? [];
      const changed = providers.filter((provider) => provider.changed === true);
      const dryRun = data.dryRun === true;

      if (providers.length === 0) {
        lines.push("No Claude providers configured; nothing to compact.");
      } else if (changed.length === 0) {
        lines.push(`All ${providers.length} Claude provider${providers.length === 1 ? "" : "s"} already store only what differs from the defaults; nothing to compact.`);
      } else {
        const noun = `of ${providers.length} Claude provider${providers.length === 1 ? "" : "s"}`;
        lines.push(
          dryRun
            ? `Dry run: ${changed.length} ${noun} would be compacted. Nothing was written.`
            : `Compacted ${changed.length} ${noun} to hold only what differs from the defaults.`
        );
        // Counts, not paths: the JSON envelope carries the paths, and a human reading this wants
        // to see which providers move and by how much.
        for (const provider of changed) {
          const dropped = Array.isArray(provider.droppedPaths) ? provider.droppedPaths.length : 0;
          lines.push(`  ${provider.provider}: ${dropped} entr${dropped === 1 ? "y" : "ies"} match the defaults`);
        }
        if (dryRun) {
          lines.push("Run without --dry-run to apply. What a switch writes does not change.");
        } else if (data.backupPath) {
          lines.push(`  backup: ${String(data.backupPath)}`);
        }
      }
      break;
    }
    case "add": {
      lines.push(`Added Claude provider "${String(data.provider ?? "")}".`);
      if (data.model) lines.push(`  model: ${String(data.model)}`);
      const dropped = Array.isArray(data.droppedPaths) ? data.droppedPaths.length : 0;
      if (dropped > 0) {
        lines.push(`  stored as a delta: ${dropped} entr${dropped === 1 ? "y" : "ies"} matched the claude defaults and were not stored (pass --full to keep them)`);
      }
      if (data.backupPath) lines.push(`  backup: ${String(data.backupPath)}`);
      break;
    }
    case "remove":
      lines.push(`Removed Claude provider "${String(data.provider ?? "")}".`);
      if (data.backupPath) lines.push(`  backup: ${String(data.backupPath)}`);
      break;
    default:
      lines.push(JSON.stringify(data, null, 2));
      break;
  }

  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines;
}
