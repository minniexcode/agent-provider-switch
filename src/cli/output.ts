import { CliErrorShape } from "../domain/errors";
import { isSecretKey, maskSecret } from "../domain/secrets";
import { printErrorDetails } from "../storage/fs-utils";
import { CommandResult } from "../app/types";
import { CommandExecutionContext } from "../commands/types";

export type JsonEnvelope = {
  ok: boolean;
  command: string;
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
    stdout: renderHumanSuccess(ctx.command, result.data, warnings),
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
 */
function renderHumanSuccess(command: string, data: Record<string, unknown> | null, warnings: string[]): string[] {
  const lines: string[] = [];

  if (data?.target === "claude") {
    return renderClaudeHumanSuccess(command, data, warnings);
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
    case "status":
      lines.push("Status summary:");
      lines.push(`  target runtime: ${String(data?.codexDir ?? "")}`);
      lines.push(`  tool home: ${String(data?.toolHomeRoot ?? "")}`);
      lines.push(`  current model: ${String(data?.currentModel ?? "(none)")}`);
      lines.push(`  current model provider: ${String(data?.currentModelProvider ?? "(none)")}`);
      lines.push(`  mapped provider: ${renderStatusMappedProvider(data)}`);
      lines.push(`  provider path: ${renderStatusProviderPath(data)}`);
      lines.push(`  runtime health: ${renderStatusHealth(data)}`);
      lines.push(`  warnings: ${warnings.length}`);
      lines.push(`  next step: ${renderStatusNextStep(data, warnings)}`);
      break;
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
      const healthy = Boolean(data?.healthy);
      const issues = (data?.issues as Array<Record<string, unknown>>) ?? [];
      lines.push(healthy ? "Doctor summary: healthy. No action required." : `Doctor summary: ${issues.length} issue(s) need attention.`);
      lines.push(`target runtime: ${String(data?.codexDir ?? "")}`);
      for (const issue of issues) {
        lines.push(`- ${String(issue.code)}: ${String(issue.message)}`);
        lines.push(`  next step: ${renderDoctorIssueNextStep(issue)}`);
      }
      break;
    }
    case "backups-list": {
      const backups = (data?.backups as Array<Record<string, unknown>>) ?? [];
      for (const backup of backups) {
        lines.push(`${backup.backupId} ${backup.reason} ${backup.createdAt}`);
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
    case "rollback":
      lines.push(`Rollback restored files from ${String(data?.backupPath ?? "")}.`);
      break;
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
 * Summarizes runtime health for the human-readable status output.
 */
function renderStatusHealth(data: Record<string, unknown> | null): string {
  const configExists = Boolean(data?.configExists);
  const providersExists = Boolean(data?.providersExists);
  const auth = (data?.auth as Record<string, unknown> | undefined) ?? {};
  const issues = Array.isArray(data?.issues) ? (data?.issues as Array<Record<string, unknown>>) : [];
  const activeProviderResolvable = data?.activeProviderResolvable !== false;
  const liveState = (data?.liveState as Record<string, unknown> | undefined) ?? {};
  if (!configExists || !providersExists) {
    return "incomplete local state";
  }
  if (!activeProviderResolvable || liveState.reason === "shared-profile") {
    return "active provider ambiguous";
  }
  if (issues.some((issue) => issue.code === "PROVIDER_BASE_URL_MISMATCH")) {
    return "provider projection drift";
  }
  if (auth.exists === false) {
    return "auth projection missing";
  }
  if (auth.valid === false) {
    return "auth projection invalid";
  }
  return "ok";
}

/**
 * Renders the mapped provider line without claiming a unique winner for shared profiles.
 */
function renderStatusMappedProvider(data: Record<string, unknown> | null): string {
  if (typeof data?.provider === "string" && data.provider.length > 0) {
    return data.provider;
  }
  const candidates = Array.isArray(data?.activeProviderCandidates) ? (data?.activeProviderCandidates as string[]) : [];
  if (candidates.length > 1) {
    return `(ambiguous: ${candidates.join(", ")})`;
  }
  return "(unmanaged or unresolved)";
}

/**
 * Renders the active workflow path in status output.
 */
function renderStatusProviderPath(data: Record<string, unknown> | null): string {
  return data?.provider ? "managed provider" : "unmanaged route";
}

/**
 * Suggests the next operator action for the human-readable status output.
 */
function renderStatusNextStep(data: Record<string, unknown> | null, warnings: string[]): string {
  if (warnings.length > 0) {
    return "run `aps doctor` to inspect warnings before the next write command";
  }
  if (!data?.provider) {
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
    case "CONFIG_NOT_FOUND":
      return "restore or create config.toml before switching providers";
    case "PROVIDERS_NOT_FOUND":
      return "run `aps init` and then add or migrate providers";
    case "UNMANAGED_ACTIVE_PROFILE":
      return "switch to a managed provider or adopt the active route with `aps migrate`";
    case "LEGACY_PROFILE_SELECTOR":
    case "LEGACY_PROFILE_SECTION":
    case "LEGACY_MODEL_PROVIDER_ENV_KEY":
      return "rerun `aps switch <provider>` to project top-level model/model_provider and remove legacy fields";
    case "PROVIDER_BASE_URL_MISMATCH":
      return "rerun `aps edit <provider> --base-url <url>` or `aps switch <provider>` to repair the runtime projection";
    case "LOCK_STALE":
      return "the next write command clears it automatically, or run `aps unlock`";
    case "LOCK_OCCUPIED":
      return "wait for the running operation, or run `aps unlock --force` if it is a recycled pid";
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
