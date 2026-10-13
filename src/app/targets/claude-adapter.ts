import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanClaudeProviderRecord,
  ClaudeProviderRecord,
  ResolvedClaudeProviderRecord,
  resolveClaudeProviderRecord,
  sortClaudeProviders,
  summarizeClaudeSettings,
  validateClaudeProvidersShape,
} from "../../domain/claude-providers";
import { matchClaudeProviders, ProviderMatch } from "../../domain/claude-identity";
import { collectDroppedPaths, collectInheritedPaths, diffClaudeSettings } from "../../domain/claude-settings-merge";
import { cliError } from "../../domain/errors";
import { maskSecretValues } from "../../domain/secrets";
import { TARGET_METADATA } from "../../domain/target";
import type { CliPromptRuntime } from "../../interaction/prompt";
import { readClaudeSettings, writeClaudeSettings } from "../../storage/claude-providers-repo";
import { ProviderAdapter } from "./types";

/**
 * What `list`, `show` and the chooser need to know about the live Claude state.
 *
 * The settings *document*, not a summary of it: the identity match compares whole paths and the
 * row markers report differences, so anything less than the file itself would make `list` and
 * `current` answer from different evidence than the switch that wrote it.
 *
 * `null` means "nothing to compare against" — an absent file, or one that could not be read as
 * settings. Reporting on the difference between those two is `status`'s job, not this state's.
 */
export type ClaudeLiveState = {
  settings: Record<string, unknown> | null;
};

/**
 * The values one Claude `add` settled on.
 *
 * `fromFile` rather than parsed settings: the file is read once, inside `prepareAdd()`, so a
 * relative path is resolved against the working directory the command ran in rather than against
 * whatever directory a prompt happened to leave behind.
 */
type ClaudeAddInput = {
  fromFile: string;
  full: boolean;
  note: string | null;
  tags: string[];
};

const SELECTION_MESSAGES: Record<string, string> = {
  show: "Choose a Claude provider to show",
  switch: "Choose a Claude provider to switch to",
  remove: "Choose a Claude provider to remove",
};

/**
 * Claude's contribution to the shared provider workflows.
 *
 * The one thing this adapter must never do is hand a resolved record back as if it were stored.
 * `settings` is a delta, and the shared workflows pass the *effective* view to the read hooks and
 * the stored registry to `write()`; the two are different types here (`ResolvedClaudeProviderRecord`
 * against `ClaudeProviderRecord`) so that confusing them is a compile error rather than a silent
 * expansion of the defaults into every record the next write saves.
 */
export function createClaudeAdapter(paths: {
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  defaults: Record<string, unknown> | null;
}): ProviderAdapter<
  ClaudeProviderRecord,
  ResolvedClaudeProviderRecord,
  ClaudeLiveState,
  ProviderMatch,
  ClaudeAddInput
> {
  const resolve = (record: ClaudeProviderRecord): ResolvedClaudeProviderRecord =>
    resolveClaudeProviderRecord(record, paths.defaults);

  /** Identity is compared over the effective settings: that is what a switch actually wrote. */
  const matchProviders = (
    live: ClaudeLiveState,
    providers: Record<string, ResolvedClaudeProviderRecord>
  ): ProviderMatch =>
    matchClaudeProviders({
      live: live.settings,
      providers: Object.fromEntries(
        Object.entries(providers).map(([name, record]) => [name, record.effective])
      ),
    });

  return {
    metadata: TARGET_METADATA.claude,

    codec: { decode: validateClaudeProvidersShape, encode: sortClaudeProviders },

    registryErrors: {
      // Unlike Codex, a missing Claude registry has a remedy the user has not been told yet.
      missingMessage: "claude-providers.json not found. Run `aps add --claude` first.",
      notFoundSubject: "Claude provider",
      // A near-miss name is the common case here, so the alternative is named.
      notFoundDetails: (file) => ({ availableProviders: Object.keys(file.providers).sort() }),
    },

    // The three verbs that answer about a registry which may not exist yet: a user who has written
    // their first `settings.json` but registered nothing still gets an honest `list` and `current`,
    // and `add` is what starts the registry. The rest are lookups, and a lookup into nothing is an
    // error rather than an empty answer.
    readMode: (verb) =>
      verb === "list" || verb === "current" || verb === "add" ? "empty-if-missing" : "required",

    readLive: () => ({ settings: readClaudeSettings(paths.claudeSettingsPath) }),

    resolve,

    match: (live, providers) => matchProviders(live, providers.providers),

    // The registry's own order. Claude's writer keeps the file sorted, so this is stable without
    // the reader imposing an order on a file a user may have edited by hand.
    listOrder: (file) => Object.keys(file.providers),

    listRow: (name, raw, effective, match) => {
      const summary = summarizeClaudeSettings(effective.effective);
      const candidate = match.candidates.find((entry) => entry.name === name);
      return {
        name,
        model: summary.model,
        baseUrl: summary.baseUrl,
        theme: summary.theme,
        note: raw.note ?? null,
        tags: raw.tags ?? [],
        // `isActive` requires a unique match. Several matching providers are all candidates and none
        // of them is claimed to be the active route: marking them active would read as "all of these
        // are in use", which is the opposite of what the comparison found.
        isActive: match.state === "managed" && match.activeProvider === name,
        isCandidate: candidate !== undefined,
        ambiguous: match.state === "ambiguous" && candidate !== undefined,
        // Paths only, and empty for a non-candidate row, so the list stays safe to print next to a
        // masked env: a difference path can name a credential but never carries one.
        differencePaths: candidate?.differencePaths ?? [],
      };
    },

    listData: (rows, _live, match) => ({
      providers: rows,
      count: rows.length,
      matchState: match.state,
      activeProvider: match.activeProvider,
    }),

    showData: (name, raw, effective, view) => {
      const summary = summarizeClaudeSettings(effective.effective);
      const env = (effective.effective.env as Record<string, string> | undefined) ?? {};
      const data: Record<string, unknown> = {
        provider: name,
        model: summary.model,
        baseUrl: summary.baseUrl,
        theme: summary.theme,
        note: raw.note ?? null,
        tags: raw.tags ?? [],
        env: view.reveal ? env : maskSecretValues(env),
        inherited:
          paths.defaults === null ? [] : collectInheritedPaths(paths.defaults, raw.settings),
        revealed: view.reveal,
      };

      if (view.reveal) {
        // `settings` is what gets written; `overrides` is what is stored. Revealing only the stored
        // delta would show a file that is not the one Claude Code ends up with.
        data.settings = effective.effective;
        data.overrides = raw.settings;
      }

      return data;
    },

    // A machine that has never run `switch` has no settings.json, and saying so is a complete
    // answer: reading the registry to then report "unmanaged" would describe a file that is not
    // there as one that matches nothing.
    currentWithoutRegistry: (live) =>
      live.settings === null
        ? { active: null, status: "no-settings", message: "No Claude Code settings.json found." }
        : null,

    currentData: (live, match) => {
      const summary = summarizeClaudeSettings(live.settings ?? {});
      const detail = { model: summary.model, baseUrl: summary.baseUrl };

      if (match.state === "managed") {
        return { active: match.activeProvider, ...detail, status: "managed" };
      }

      if (match.state === "ambiguous") {
        return {
          active: null,
          ...detail,
          status: "ambiguous",
          // Names only: which candidates matched on identity, without claiming one of them is active.
          candidates: match.candidates.map((candidate) => candidate.name),
          message: "Current settings match more than one registered Claude provider.",
        };
      }

      return {
        active: null,
        ...detail,
        status: "unmanaged",
        message: "Current settings do not match any registered Claude provider.",
      };
    },

    selection: (file, live, match) => {
      // Sorted here rather than read off the file: a chooser's order is a usability decision, and
      // the file's order is the writer's.
      const names = Object.keys(file.providers).sort();
      const choices = names.map((name) => {
        const record = file.providers[name];
        const effective = resolve(record).effective;
        // "(current)" requires a unique match. On an ambiguous one the marker would be a claim the
        // comparison did not make; the row says "(candidate)" instead, which is what is actually known.
        const suffix =
          match.state === "managed" && match.activeProvider === name
            ? " (current)"
            : match.state === "ambiguous" && match.candidates.some((candidate) => candidate.name === name)
              ? " (candidate)"
              : "";
        const env = effective.env as Record<string, string> | undefined;
        const model = (effective.model as string) ?? "";
        const baseUrl = env?.ANTHROPIC_BASE_URL ?? "";
        return {
          value: name,
          label: `${name}${suffix} [model=${model}, base=${baseUrl}]`,
        };
      });

      return {
        choices,
        emptyMessage: "No Claude providers registered. Run `aps add --claude` first.",
      };
    },

    selectionMessage: (verb) => SELECTION_MESSAGES[verb] ?? `Choose a Claude provider to ${verb}`,

    missingName: (verb) =>
      verb === "show"
        ? { cliErrorCode: "INVALID_ARGUMENT", message: "Missing provider name for show --claude command." }
        : { cliErrorCode: "PROVIDER_NOT_FOUND", message: `Missing provider name for ${verb} --claude command.` },

    // The prefix is what keeps a Claude operation distinguishable in a backup manifest's history,
    // including for the manifests written before the operation name carried a target.
    mutationOperation: (verb) => `claude-${verb}`,

    async collectAddInput(request) {
      // Both prompts go through the injected runtime rather than `inquirer` directly, so a caller
      // that supplies a runtime gets a non-interactive run of the same flow instead of a hang.
      let name = request.name;
      if (!name) {
        if (!request.canPrompt) {
          throw cliError(
            "INVALID_ARGUMENT",
            "Claude add requires a provider name. Usage: aps add --claude <name> --from-file <path>"
          );
        }
        name = await promptRequired(request.runtime, "Claude provider name:");
      }

      let fromFile = request.options.value("--from-file");
      if (!fromFile) {
        if (!request.canPrompt) {
          throw cliError("INVALID_ARGUMENT", "Claude add requires --from-file <path> in non-interactive mode.");
        }
        fromFile = await promptRequired(request.runtime, "Path to Claude settings JSON file:", (value) =>
          fs.existsSync(value.trim()) ? null : `File not found: ${value.trim()}`
        );
      }

      return {
        name,
        input: {
          fromFile,
          full: request.options.has("--full"),
          note: request.options.value("--note"),
          tags: request.options.values("--tag"),
        },
      };
    },

    duplicateProvider: (name) => ({
      cliErrorCode: "PROVIDER_ALREADY_EXISTS",
      message: `Claude provider "${name}" already exists.`,
      details: {
        provider: name,
        suggestion: "Use a different name or run `aps remove --claude <name>` first.",
      },
    }),

    prepareAdd: (name, input) => {
      if (!fs.existsSync(input.fromFile)) {
        throw cliError("INVALID_ARGUMENT", `Settings file not found: ${input.fromFile}`);
      }

      let settings: Record<string, unknown>;
      try {
        settings = JSON.parse(fs.readFileSync(input.fromFile, "utf8")) as Record<string, unknown>;
      } catch {
        throw cliError("INVALID_ARGUMENT", `Failed to parse settings file: ${input.fromFile}`);
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw cliError("INVALID_ARGUMENT", "Settings file must contain a JSON object.");
      }

      // No defaults block means nothing to slim against, so the file is stored as it came. With one,
      // the record becomes the delta unless `--full` opts out — which pins the values it spells out,
      // where a slimmed record would follow a later change to the defaults.
      const defaults = paths.defaults;
      const slim = defaults !== null && !input.full;
      const stored = slim && defaults !== null ? diffClaudeSettings(defaults, settings) : settings;
      const droppedPaths = slim && defaults !== null ? collectDroppedPaths(defaults, settings) : [];

      const record = cleanClaudeProviderRecord({
        settings: stored,
        note: input.note ?? undefined,
        tags: input.tags,
      });

      return {
        record,
        native: {
          // Nothing native is written: an `add` only registers a record, and the settings file is
          // what `switch` replaces. The payload is still the plan's to produce, so the shared
          // boundary stays one shape for both targets.
          files: [],
          applyNative: () => {
            const { effective } = resolveClaudeProviderRecord(record, paths.defaults);
            return {
              provider: name,
              // The model reported is the one a switch would write, not whatever the stored delta
              // holds.
              model: (effective.model as string) ?? null,
              // Paths only. A non-empty list is what lets the renderer say the record was slimmed.
              droppedPaths,
            };
          },
        },
      };
    },

    planSwitch: (name, raw, effective) => {
      const claudeDir = path.dirname(paths.claudeSettingsPath);
      return {
        files: [{ absolutePath: paths.claudeSettingsPath, relativePath: "claude-settings.json" }],
        applyNative: () => {
          if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
          }
          // The stored record stayed a delta; only the file written to Claude Code is expanded.
          writeClaudeSettings(paths.claudeSettingsPath, effective.effective);
          const env = effective.effective.env as Record<string, string> | undefined;
          return {
            provider: name,
            model: (effective.effective.model as string) ?? null,
            baseUrl: env?.ANTHROPIC_BASE_URL ?? null,
          };
        },
      };
    },

    planRemove: (name) => ({
      // A Claude removal drops a registry key and nothing else: removing a provider is not a
      // request to change which one is live, so no settings.json is touched here.
      files: [],
      applyNative: () => ({ provider: name, removed: true }),
    }),

    removePolicy: { requiresForce: true, forceRequiredMessage: "remove --claude requires --force in non-interactive mode." },
  };
}

/**
 * Prompts until the answer satisfies the check, echoing the reason it did not.
 *
 * The same loop the Codex collector uses, on the same injected runtime, so an interactive `add`
 * behaves alike on both targets even though what it asks for differs.
 */
async function promptRequired(
  runtime: CliPromptRuntime,
  message: string,
  validate?: (value: string) => string | null
): Promise<string> {
  while (true) {
    const answer = (await runtime.inputText(message)).trim();
    if (answer.length === 0) {
      runtime.writeLine(`${message} is required.`);
      continue;
    }
    const failure = validate?.(answer);
    if (failure) {
      runtime.writeLine(failure);
      continue;
    }
    return answer;
  }
}
