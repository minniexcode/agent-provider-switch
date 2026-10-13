import { okValue, renderCountReading, renderReading, summarizeInheritedPaths } from "../cli/report-lines";
import { cliError } from "../domain/errors";
import { isSecretKey, maskSecret } from "../domain/secrets";
import { TARGET_METADATA, TargetId, TargetMetadata } from "../domain/target";

/**
 * What a `status` block needs from the report around it.
 *
 * `leading` is why this is a context rather than a second parameter: the report header and the
 * tool-home line belong to the report, not to a target, so exactly one block prints them — the
 * first one. The other blocks then say only what is theirs, which is what keeps a two-target report
 * from stating the tool home twice.
 *
 * The other two fields are facts that live at the report level and are *read* by one target's
 * summary: the envelope's warning count, and whether any issue says the live configuration still
 * carries a field this release no longer projects. Both are computed by the caller from data the
 * presenter is not handed, and neither is re-derived here — a presenter that recomputed them would
 * be a second reader of the report rather than a view of it.
 */
export type StatusSectionContext = {
  toolHomeRoot: string;
  leading: boolean;
  warningCount: number;
  hasLegacyFields: boolean;
};

/**
 * One target's half of the human payload view.
 *
 * Pure: data in, lines out. A presenter may not read a file, resolve a path, or probe a runtime —
 * the payload already carries everything the view needs, and a presenter that went looking would be
 * a second implementation of the command rather than a view of it.
 *
 * `renderCommand` answers `null` for every command this target does not own alone, which is the
 * contract that lets the renderer ask *any* single-target invocation about its presenter and fall
 * through to the shared view. In particular it is `null` for `status`, `doctor`, `backups list`,
 * `backups prune`, `rollback` and `unlock`: those answer about state the targets share, so no
 * single target's presenter can produce them.
 *
 * Takes a plain string because the execution context widens `command` to
 * `CommandId | "help" | "version"`, and the renderer holds that context. A token that names no
 * command this target owns is a definite `null`, the same contract `routesToClaudeHandler()` and
 * `scopeOfName()` have.
 */
export type TargetPresenter = {
  metadata: TargetMetadata;
  renderCommand: (command: string, data: Record<string, unknown>) => string[] | null;
  /** This target's `status` block, or `[]` when the report carries no section for it. */
  renderStatusSection: (section: Record<string, unknown>, context: StatusSectionContext) => string[];
};

const CODEX_PRESENTER: TargetPresenter = {
  metadata: TARGET_METADATA.codex,

  renderCommand(command, data) {
    const lines: string[] = [];
    switch (command) {
      case "list": {
        const providers = (data.providers as Array<Record<string, unknown>>) ?? [];
        if (providers.length === 0) {
          lines.push("No providers configured.");
        } else {
          const currentModel = typeof data.currentModel === "string" ? data.currentModel : null;
          const currentModelProvider = typeof data.currentModelProvider === "string" ? data.currentModelProvider : null;
          const activeProviderResolvable = data.activeProviderResolvable !== false;
          const activeCandidates = Array.isArray(data.activeProviderCandidates) ? (data.activeProviderCandidates as string[]) : [];
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
        const provider = (data.provider as Record<string, unknown>) ?? {};
        lines.push(`Provider: ${String(data.providerName ?? "")}`);
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
        lines.push(`Current model: ${String(data.model ?? "")}`);
        lines.push(`Current model provider: ${String(data.modelProvider ?? "")}`);
        if (data.provider) {
          lines.push(`Managed provider: ${String(data.provider)}`);
        }
        break;
      case "config-show": {
        lines.push(`currentModel: ${String(data.currentModel ?? "")}`);
        lines.push(`currentModelProvider: ${String(data.currentModelProvider ?? "")}`);
        lines.push(`legacyProfile: ${String(data.legacyProfile ?? "")}`);
        const profiles = (data.profiles as Array<Record<string, unknown>>) ?? [];
        for (const profile of profiles) {
          lines.push(
            `${String(profile.name)} managed=${String(profile.managed)} active=${String(profile.isActive)} source=${String(profile.source)} model=${String(profile.model ?? "")} modelProvider=${String(profile.modelProvider ?? "")} baseUrl=${String(profile.baseUrl ?? "")}`
          );
        }
        break;
      }
      case "config-list-profiles": {
        const profiles = (data.profiles as Array<Record<string, unknown>>) ?? [];
        for (const profile of profiles) {
          lines.push(
            `${String(profile.name)} managed=${String(profile.managed)} active=${String(profile.isActive)} source=${String(profile.source)}`
          );
        }
        break;
      }
      case "switch":
        lines.push(`Switched to provider ${String(data.provider ?? "")} using model provider ${String(data.modelProvider ?? data.profile ?? "")}.`);
        lines.push(`Model: ${String(data.model ?? "")}`);
        lines.push(`Backup: ${String(data.backupPath ?? "")}`);
        break;
      case "import":
        lines.push(`Imported providers from file using mode ${String(data.mode ?? "replace")}. Backup: ${String(data.backupPath ?? "")}`);
        break;
      case "export":
        lines.push(`Exported providers to ${String(data.exportedTo ?? "")}.`);
        break;
      case "init":
        lines.push("Initialized agent-provider-switch tool home.");
        lines.push(`tool home: ${String(data.toolHomeDir ?? "")}`);
        lines.push(`tool config: ${String(data.toolConfigPath ?? "")}`);
        lines.push(`providers registry: ${String(data.providersPath ?? "")}`);
        lines.push(`tool home created: ${String(data.createdToolHomeDir ?? false)}`);
        lines.push(`tool config created: ${String(data.createdToolConfigFile ?? false)}`);
        lines.push(`providers registry created: ${String(data.createdProvidersFile ?? false)}`);
        lines.push("next step: run `aps add <provider> --profile <model-provider-id> --model <model> --api-key <key> --base-url <url>`.");
        break;
      case "migrate":
        lines.push(`Migrated providers in ${String(data.codexDir ?? "")} using ${String(data.strategy ?? "")}.`);
        lines.push(`Providers initialized: ${String(data.providersInitialized ?? 0)}`);
        lines.push(`Doctor healthy: ${String((data.doctor as Record<string, unknown> | undefined)?.healthy ?? false)}`);
        lines.push(`Backup: ${String(data.backupPath ?? "")}`);
        break;
      case "setup":
        lines.push("setup is deprecated. Use `aps init` or `aps migrate`.");
        break;
      case "edit":
        lines.push(`Updated provider ${String(data.provider ?? "")}. Backup: ${String(data.backupPath ?? "")}`);
        lines.push(`Updated fields: ${Array.isArray(data.updatedFields) ? (data.updatedFields as string[]).join(", ") : ""}`);
        break;
      case "add":
        lines.push(`Added provider ${String(data.provider ?? "")}. Backup: ${String(data.backupPath ?? "")}`);
        if (Array.isArray(data.createdProfileSections) && (data.createdProfileSections as string[]).length > 0) {
          lines.push(`Created profiles: ${(data.createdProfileSections as string[]).join(", ")}`);
        }
        break;
      case "remove":
        lines.push(`Removed provider ${String(data.provider ?? "")}. Backup: ${String(data.backupPath ?? "")}`);
        if (Array.isArray(data.deletedProfileSections) && (data.deletedProfileSections as string[]).length > 0) {
          lines.push(`Deleted profiles: ${(data.deletedProfileSections as string[]).join(", ")}`);
        }
        break;
      default:
        // Every remaining command answers about state both targets share, or belongs to the other
        // target. Neither is this presenter's to render.
        return null;
    }

    return lines;
  },

  renderStatusSection(section, context) {
    const lines: string[] = [];
    const paths = okValue<Record<string, string>>(section.paths);

    lines.push("Status summary:");
    lines.push(`  target runtime: ${paths?.codexDir ?? "(unknown)"}`);
    lines.push(`  tool home: ${context.toolHomeRoot}`);
    lines.push(`  current model: ${String(section.currentModel ?? "(none)")}`);
    lines.push(`  current model provider: ${String(section.currentModelProvider ?? "(none)")}`);
    lines.push(`  mapped provider: ${renderStatusMappedProvider(section)}`);
    lines.push(`  provider path: ${renderStatusProviderPath(section)}`);
    lines.push(`  runtime health: ${renderStatusHealth(section)}`);
    // The warning *count* rather than the sentences: the count is what tells a reader the run has
    // something to look at, and `next step` below already points at the command that prints them.
    // The rendered warnings themselves are appended by the caller.
    lines.push(`  warnings: ${context.warningCount}`);
    lines.push(`  next step: ${renderStatusNextStep(section, context)}`);
    return lines;
  },
};

const CLAUDE_PRESENTER: TargetPresenter = {
  metadata: TARGET_METADATA.claude,

  renderCommand(command, data) {
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
        return null;
    }

    return lines;
  },

  renderStatusSection(section, context) {
    const lines: string[] = [];
    // A Claude-only report has no Codex block above it to carry the header, so it prints one. With
    // both in scope the Codex block already did, and the tool home is stated once.
    if (context.leading) {
      lines.push("Status summary:");
      lines.push(`  tool home: ${context.toolHomeRoot}`);
    }
    lines.push("Claude summary:");
    lines.push(`  claude dir: ${okValue<Record<string, string>>(section.paths)?.claudeDir ?? "(unknown)"}`);
    lines.push(`  providers registry: ${renderReading(section.registry, (value) => `${(value as { providerCount: number }).providerCount} record(s)`)}`);
    lines.push(`  settings: ${renderReading(section.live, () => "present")}`);
    lines.push(`  configured: ${renderReading(section.configured, (value) => String(value))}`);
    lines.push(`  activation: ${renderReading(section.activation, (value) => String(value))}`);
    lines.push(`  providers: ${renderCountReading(section.providerCount)}`);
    lines.push(`  active provider: ${renderClaudeActiveProvider(section.matching)}`);
    return lines;
  },
};

/**
 * The presenters, keyed by the target each describes.
 *
 * A map rather than a chain of comparisons, so adding a target is an entry here and a declaration
 * in `domain/target.ts` — not another branch in the renderer.
 */
const PRESENTERS: ReadonlyMap<TargetId, TargetPresenter> = new Map<TargetId, TargetPresenter>([
  ["codex", CODEX_PRESENTER],
  ["claude", CLAUDE_PRESENTER],
]);

/**
 * Returns the presenter for one target.
 *
 * A missing entry is an *internal* error, reported as one. Falling back to another target's view
 * would print Codex field names over a Claude payload, which reads as a working command producing
 * nonsense rather than as the wiring fault it is.
 */
export function presenterFor(target: TargetId): TargetPresenter {
  const presenter = PRESENTERS.get(target);
  if (!presenter) {
    throw cliError("UNKNOWN_COMMAND", `No human presenter is registered for "${target}".`);
  }
  return presenter;
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
function renderStatusNextStep(codex: Record<string, unknown>, context: StatusSectionContext): string {
  if (context.warningCount > 0) {
    return "run `aps doctor` to inspect warnings before the next write command";
  }
  const managed = okValue<{ state: string }>(codex.matching)?.state === "managed";
  if (!managed) {
    return "run `aps switch <provider>` after adding or adopting a managed provider";
  }
  return context.hasLegacyFields
    ? "run `aps switch <provider>` to reproject the active route and clean legacy fields"
    : "run `aps doctor` if you need a deeper diagnostic pass";
}
