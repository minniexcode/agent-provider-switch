import * as fs from "node:fs";
import { cliError } from "../../domain/errors";
import {
  buildModelProviderProjection,
  cleanProviderRecord,
  ProviderRecord,
  sortProviders,
  validateProvidersShape,
} from "../../domain/providers";
import { withoutProvider } from "../../domain/provider-registry";
import { inspectLiveStateDrift, LiveStateDrift } from "../../domain/runtime-state";
import { maskSecret } from "../../domain/secrets";
import { TARGET_METADATA } from "../../domain/target";
import { writeOpenAiApiKeyAuth } from "../../storage/auth-repo";
import {
  applyConfigMutation,
  createConfigMutationPlan,
  readStructuredConfig,
} from "../../storage/config-repo";
import { ensureDir } from "../../storage/fs-utils";
import { collectAddInput, createNonInteractiveAddError } from "../../interaction/add-interactive";
import { ProviderAdapter } from "./types";

/**
 * What `list`, `show` and the chooser need to know about the live Codex state.
 *
 * The config document is read once and reduced to the three fields anything asks about, so the
 * shared workflow never holds a TOML document — or a byte range into one — it could not use.
 */
export type CodexLiveState = {
  /** The route the live config points at, or `null` when it names none. */
  currentModelProvider: string | null;
  /** The model named beside it, reported by `list` and `current` alike. */
  currentModel: string | null;
  /** The pre-`model_provider` key, still honoured by the chooser's "current" marker. */
  legacyProfile: string | null;
};

const NO_LIVE_STATE: CodexLiveState = {
  currentModelProvider: null,
  currentModel: null,
  legacyProfile: null,
};

/** The prompt sentences, which are the caller's words rather than the target's data. */
const SELECTION_MESSAGES: Record<string, string> = {
  show: "Choose a provider to show",
  switch: "Choose a provider to switch to",
  remove: "Choose a provider to remove",
};

/**
 * The values one Codex `add` settled on, once the flags that can be defaulted or inherited are.
 *
 * `model` and `baseUrl` stay nullable here because their fallback is a property of the live config
 * rather than of the invocation, and `prepareAdd()` is what reads it.
 */
type CodexAddInput = {
  profile: string;
  apiKey: string;
  model: string | null;
  baseUrl: string | null;
  note: string | null;
  tags: string[];
  createProfile: boolean;
};

/**
 * Codex's contribution to the shared provider workflows.
 *
 * Codex resolves nothing: a stored record *is* what it shows, because there is no defaults block on
 * this side and therefore no delta. That is why `R` and `E` are both `ProviderRecord` here while its
 * Claude twin has two distinct types — the shared adapter is parameterized over the difference
 * rather than flattening it.
 */
export function createCodexAdapter(paths: {
  providersPath: string;
  configPath: string;
  codexDir: string;
  authPath: string;
}): ProviderAdapter<ProviderRecord, ProviderRecord, CodexLiveState, LiveStateDrift, CodexAddInput> {
  const toLiveState = (document: {
    currentModelProvider: string | null;
    currentModel: string | null;
    legacyProfile: string | null;
  }): CodexLiveState => ({
    currentModelProvider: document.currentModelProvider,
    currentModel: document.currentModel,
    legacyProfile: document.legacyProfile,
  });

  /** The config as the read paths see it: absent is an answer, not a failure. */
  const lenientLiveState = (): CodexLiveState => {
    if (!fs.existsSync(paths.configPath)) {
      return NO_LIVE_STATE;
    }
    return toLiveState(readStructuredConfig(paths.configPath));
  };

  return {
    metadata: TARGET_METADATA.codex,

    codec: { decode: validateProvidersShape, encode: sortProviders },

    // No `missingMessage`: a missing providers.json is reported by its name, and the remedy —
    // `aps init` — is the command that creates it. No `notFoundDetails` either, since a Codex
    // name is a key in a file the user just edited and the near-miss list would be noise.
    registryErrors: { notFoundSubject: "Provider" },

    // The two exceptions are the verbs that answer about a registry which may not exist yet:
    // `current` reports the live route and says `null` for the provider, and `add` starts one.
    // Everything else is a lookup into a registry, and a lookup into nothing is an error.
    readMode: (verb) => (verb === "current" || verb === "add" ? "empty-if-missing" : "required"),

    readLive: (verb) =>
      // `current` reports on the live config, so a missing one is the failure it reports rather than
      // an absence it papers over; `list` answers about the registry and must not fail with it.
      verb === "current" ? toLiveState(readStructuredConfig(paths.configPath)) : lenientLiveState(),

    resolve: (record) => record,

    match: (live, providers) => inspectLiveStateDrift(live.currentModelProvider, providers),

    listOrder: (file) => Object.keys(file.providers).sort(),

    listRow: (name, raw, _effective, match) => ({
      name,
      profile: raw.profile,
      modelProvider: raw.profile,
      model: raw.model ?? null,
      isActive: match.providerResolvable && match.mappedProvider === name,
      note: raw.note ?? null,
      tags: raw.tags ?? [],
    }),

    listData: (rows, live, match) => ({
      providers: rows,
      count: rows.length,
      currentModel: live.currentModel,
      currentModelProvider: live.currentModelProvider,
      activeProvider: match.mappedProvider,
      activeProviderResolvable: match.providerResolvable,
      activeProviderCandidates: match.mappedProviders,
    }),

    /**
     * Two different contracts on one command, and both are documented.
     *
     * `--json` returns the real `apiKey` — that is the automation contract, and inverting it would
     * break every script that reads a key back. The human rendering masks it, because a terminal is
     * the one place it is likely to be read by someone else.
     */
    showData: (name, raw, _effective, view) => ({
      providerName: name,
      provider: view.json ? raw : { ...raw, apiKey: maskSecret(raw.apiKey) },
    }),

    // Nothing to short-circuit: a Codex `current` that found no live route still has to say which
    // registered provider, if any, owns the profile the config names.
    currentWithoutRegistry: () => null,

    currentData: (live, match) => ({
      model: live.currentModel,
      modelProvider: live.currentModelProvider,
      // The name only when exactly one record claims the profile. Two providers sharing it is a
      // real configuration, and `current` must not pick one of them to call active.
      provider: match.mappedProviders.length === 1 ? match.mappedProviders[0] : null,
      profile: live.currentModelProvider,
    }),

    selection: (file, live, match) => {
      // A pre-`model_provider` config still names its provider the old way, and the record it names
      // is the one in use. Only consulted when the current route is not resolvable, so the two
      // markers can never both appear.
      const legacyCurrentProvider =
        !match.providerResolvable && live.legacyProfile && file.providers[live.legacyProfile]
          ? live.legacyProfile
          : null;

      const choices = Object.keys(file.providers)
        .sort()
        .map((name) => {
          const provider = file.providers[name];
          const currentMarker = match.providerResolvable && match.mappedProvider === name ? " | current" : "";
          const legacyMarker = !currentMarker && legacyCurrentProvider === name ? " | current" : "";
          const ambiguousMarker =
            !match.providerResolvable && match.mappedProviders.includes(name) ? " | current=ambiguous" : "";
          return {
            value: name,
            label: name,
            hint: `profile=${provider.profile}${currentMarker}${legacyMarker}${ambiguousMarker}`,
          };
        });

      // The plural code, raised by `selectProvider()` when there is nobody to choose from, which is
      // a different finding from a named provider that could not be found.
      return { choices, emptyMessage: "No providers are configured." };
    },

    selectionMessage: (verb) => SELECTION_MESSAGES[verb] ?? `Choose a provider to ${verb}`,

    missingName: (verb) =>
      verb === "show"
        ? { cliErrorCode: "INVALID_ARGUMENT", message: "Missing provider name for show command." }
        : { cliErrorCode: "PROVIDER_NOT_FOUND", message: `Missing provider name for ${verb} command.` },

    // Codex names its operations without a prefix; Claude's carry one, which is why this is a hook
    // and not a template here.
    mutationOperation: (verb) => verb,

    async collectAddInput(request, registry) {
      // `canPrompt`, not the JSON flag alone: this collector is only reached when prompting is
      // allowed, and the caller has already decided that from the runtime and the output mode.
      const name = request.name;
      const profile = request.options.value("--profile");
      const apiKey = request.options.value("--api-key");
      const model = request.options.value("--model");
      const baseUrl = request.options.value("--base-url");
      const note = request.options.value("--note");
      const tags = request.options.values("--tag");
      const createProfile = request.options.has("--create-profile");

      if (name && profile && apiKey) {
        return { name, input: { profile, apiKey, model, baseUrl, note, tags, createProfile } };
      }

      if (!request.canPrompt) {
        throw createNonInteractiveAddError();
      }

      // The two validators read what the prompt has to reject as it is typed: a name already in the
      // registry, and a profile already in the live config. Reading them here rather than after the
      // prompt is what turns "already exists" into a re-prompt instead of a failure at the end.
      const prompted = await collectAddInput(
        request.runtime,
        { providerName: name, profile, apiKey, model, baseUrl, note, tags },
        (candidate) => Boolean(registry.providers[candidate]),
        (candidate) => Boolean(readStructuredConfig(paths.configPath).profiles.find((entry) => entry.name === candidate))
      );

      return {
        name: prompted.providerName,
        input: {
          profile: prompted.profile,
          apiKey: prompted.apiKey,
          model: prompted.model ?? null,
          baseUrl: prompted.baseUrl ?? null,
          note: prompted.note ?? null,
          tags: prompted.tags,
          // Either source says yes: the flag was given, or the collector decided a missing profile
          // section needs creating.
          createProfile: createProfile || prompted.createProfile,
        },
      };
    },

    duplicateProvider: (name) => ({
      // `PROVIDER_ALREADY_EXISTS`, not `INVALID_IMPORT_FILE`: the condition is "a record with this
      // name is taken", which is the same condition the Claude path reports under that code. The
      // import code named the shape of the file rather than what was actually wrong.
      cliErrorCode: "PROVIDER_ALREADY_EXISTS",
      message: `Provider "${name}" already exists.`,
    }),

    prepareAdd: (name, input) => {
      ensureDir(paths.codexDir);
      const document = readStructuredConfig(paths.configPath);
      const existingModelProvider = document.modelProviders.find((entry) => entry.name === input.profile);
      const inheritedModel = document.currentModel ?? undefined;
      const providerModel = input.model ?? inheritedModel;
      if (!providerModel) {
        throw cliError("MANAGED_PROFILE_FIELDS_MISSING", `Provider "${name}" requires a model.`, {
          provider: name,
          modelProvider: input.profile,
          missingFields: ["model"],
          suggestion: "Pass `--model <name>` or set a top-level model in config.toml first.",
        });
      }

      const directBaseUrl = input.baseUrl;
      if ((!directBaseUrl || directBaseUrl.trim() === "") && !existingModelProvider) {
        throw cliError("MANAGED_PROFILE_FIELDS_MISSING", `Model provider "${input.profile}" requires base_url.`, {
          profile: input.profile,
          modelProvider: input.profile,
          missingFields: ["base_url"],
        });
      }

      const record = cleanProviderRecord({
        profile: input.profile,
        apiKey: input.apiKey,
        model: providerModel,
        baseUrl: input.baseUrl ?? undefined,
        note: input.note ?? undefined,
        tags: input.tags,
      });

      // The default projection writes only `[model_providers.<id>]`; `--create-profile` additionally
      // writes the matching `[profiles.<id>]` section that older Codex builds route through. Without
      // this the flag was parsed, threaded this far, and dropped — and the interactive collector,
      // which asks for a model and base_url precisely because it believes it is creating that
      // section, was silently writing nothing.
      const upsertProfiles = input.createProfile
        ? { [input.profile]: { model: providerModel, modelProvider: input.profile } }
        : undefined;

      return {
        record,
        native: {
          files: [{ absolutePath: paths.configPath, relativePath: "config.toml" }],
          applyNative: () => {
            const configPlan = createConfigMutationPlan(document, {
              upsertProfiles,
              upsertModelProviders: {
                [input.profile]: buildModelProviderProjection(
                  input.profile,
                  (directBaseUrl ?? existingModelProvider?.baseUrl ?? "").trim()
                ),
              },
              scrubModelProviderEnvKeys: [input.profile],
            });
            applyConfigMutation(paths.configPath, document, configPlan);
            return {
              provider: name,
              model: providerModel,
              modelProvider: input.profile,
              profile: input.profile,
              createdProfileSections: configPlan.createdProfileSections,
              createdModelProviderSections: configPlan.createdModelProviderSections,
              deletedProfileSections: configPlan.deletedProfileSections,
              keptSharedProfiles: [],
              switchedActiveProfile: configPlan.switchedActiveProfile,
              adoptedProfiles: [],
              repairedProfiles: [],
            };
          },
        },
      };
    },

    planSwitch: (name, raw, _effective) => {
      const document = readStructuredConfig(paths.configPath);
      const providerProfileSection = document.profiles.find((entry) => entry.name === raw.profile) ?? null;
      const providerModelProviderSection =
        document.modelProviders.find((entry) => entry.name === raw.profile) ?? null;
      const resolvedModel = raw.model ?? providerProfileSection?.model ?? document.currentModel;
      if (!resolvedModel) {
        throw cliError("MANAGED_PROFILE_FIELDS_MISSING", `Provider "${name}" has no model to switch with.`, {
          provider: name,
          modelProvider: raw.profile,
          suggestion: "Run `aps edit <provider> --model <name>` or `aps add <provider> --model <name>`.",
        });
      }

      return {
        files: [
          { absolutePath: paths.authPath, relativePath: "auth.json" },
          { absolutePath: paths.configPath, relativePath: "config.toml" },
        ],
        applyNative: () => {
          // The base URL check stays inside the apply rather than moving up into the plan, because
          // that is where it has always been: it is a refusal that happens after the backup, and
          // moving it would change which errors report a rollback.
          const directBaseUrl = raw.baseUrl?.trim() ?? "";
          const resolvedBaseUrl = directBaseUrl || providerModelProviderSection?.baseUrl?.trim() || "";
          if (!resolvedBaseUrl) {
            throw cliError("MANAGED_PROFILE_FIELDS_MISSING", `Provider "${name}" requires base_url before switching.`, {
              provider: name,
              modelProvider: raw.profile,
              suggestion: "Run `aps edit <provider> --base-url <url>`.",
            });
          }
          const configPlan = createConfigMutationPlan(document, {
            setCurrentModel: resolvedModel,
            setCurrentModelProvider: raw.profile,
            upsertModelProviders: {
              [raw.profile]: buildModelProviderProjection(raw.profile, resolvedBaseUrl),
            },
            deleteLegacyProfile: true,
            deleteLegacyProfilesByName: [raw.profile],
            scrubModelProviderEnvKeys: [raw.profile],
          });
          applyConfigMutation(paths.configPath, document, configPlan);
          writeOpenAiApiKeyAuth(paths.authPath, raw.apiKey);
          return {
            provider: name,
            model: resolvedModel,
            modelProvider: raw.profile,
            profile: raw.profile,
          };
        },
      };
    },

    planRemove: (name, raw, registry, options) => {
      const document = readStructuredConfig(paths.configPath);
      const activeModelProvider = document.currentModelProvider;
      // Counted over the registry as it was read, not as it will be: whether the provider being
      // removed is the *only* one on the active route is a fact about the configuration the user
      // has, and dropping the record first would always make the answer "one".
      const linkedProviders = Object.entries(registry.providers)
        .filter(([, provider]) => provider.profile === activeModelProvider)
        .map(([providerName]) => providerName)
        .sort();
      const removingActiveProvider = activeModelProvider === raw.profile && linkedProviders.length === 1;
      const remaining = withoutProvider(registry, name);
      const switchTargetName = options.switchTo;
      const switchTarget = switchTargetName ? remaining.providers[switchTargetName] ?? null : null;

      if (removingActiveProvider && !switchTargetName) {
        throw cliError(
          "PROFILE_IN_USE",
          `Provider "${name}" is the active route and requires --switch-to <provider-name>.`,
          { provider: name, activeModelProvider, linkedProviders }
        );
      }
      if (switchTargetName && !switchTarget) {
        throw cliError("PROVIDER_NOT_FOUND", `Provider "${switchTargetName}" was not found.`, {
          provider: switchTargetName,
          availableProviders: Object.keys(remaining.providers).sort(),
        });
      }
      const switchTargetModel = switchTarget?.model ?? document.currentModel ?? null;
      if (switchTargetName && !switchTargetModel) {
        throw cliError("MANAGED_PROFILE_FIELDS_MISSING", `Provider "${switchTargetName}" has no model to switch with.`, {
          provider: switchTargetName,
          suggestion: "Run `aps edit <provider> --model <name>` first.",
        });
      }
      const switchTargetProjection = switchTarget
        ? switchTarget.baseUrl
          ? buildModelProviderProjection(switchTarget.profile, switchTarget.baseUrl)
          : null
        : null;
      if (switchTargetName && !switchTargetProjection) {
        throw cliError(
          "MANAGED_PROFILE_FIELDS_MISSING",
          `Provider "${switchTargetName}" requires base_url before it can become active.`,
          { provider: switchTargetName, suggestion: "Run `aps edit <provider> --base-url <url>` first." }
        );
      }

      return {
        files: [{ absolutePath: paths.configPath, relativePath: "config.toml" }],
        applyNative: () => {
          const configPlan = createConfigMutationPlan(document, {
            setCurrentModel: switchTarget ? switchTargetModel : undefined,
            setCurrentModelProvider: switchTarget ? switchTarget.profile : undefined,
            upsertModelProviders:
              switchTarget && switchTargetProjection
                ? { [switchTarget.profile]: switchTargetProjection }
                : undefined,
            deleteLegacyProfile: Boolean(switchTarget),
            deleteLegacyProfilesByName: switchTarget ? [switchTarget.profile] : [],
            scrubModelProviderEnvKeys: switchTarget ? [switchTarget.profile] : [],
          });
          applyConfigMutation(paths.configPath, document, configPlan);
          return {
            provider: name,
            switchedTo: switchTargetName,
            createdProfileSections: configPlan.createdProfileSections,
            deletedProfileSections: configPlan.deletedProfileSections,
            keptSharedProfiles: [],
            switchedActiveProfile: Boolean(switchTarget),
            adoptedProfiles: [],
            repairedProfiles: [],
          };
        },
      };
    },

    // Codex refuses a non-interactive removal without `--force`, the same as Claude does; only the
    // sentence differs, and each target supplies its own.
    removePolicy: { requiresForce: true, forceRequiredMessage: "remove requires --force." },
  };
}
