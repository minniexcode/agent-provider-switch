import * as fs from "node:fs";
import * as path from "node:path";
import { ManagedProfileView, buildManagedProfileViews, collectConfigConsistencyIssues } from "../domain/config";
import { inspectLiveStateDrift, LiveStateDrift } from "../domain/runtime-state";
import { ProvidersFile } from "../domain/providers";
import { readStructuredConfig } from "../storage/config-repo";
import { readProvidersFile } from "../storage/providers-repo";
import { readAuthFileState } from "../storage/auth-repo";
import { Finding, Reading, TargetReport, absent, invalid, ok, unavailable } from "../domain/report";
import { normalizeError } from "../domain/errors";
import { ProviderMatch } from "../domain/claude-identity";
import { renderConfigIssueMessage } from "./finding-messages";

/**
 * The Codex section's own projection readings, beside the shared report contract.
 *
 * Codex state is spread over three files — the registry in the tool home, and `config.toml` plus
 * `auth.json` in the runtime directory — so "is Codex configured and is it working" is not one
 * reading. Each artifact gets its own, which is what keeps a missing `auth.json` from reading as an
 * unreadable `config.toml`.
 */
export type CodexArtifacts = {
  config: Reading<{ model: string | null; modelProvider: string | null }>;
  auth: Reading<{ valid: boolean }>;
};

/**
 * The Codex section.
 *
 * The projection-specific fields are *inside* the section rather than beside it: `doctor` and
 * `status` publish the same section for the same target, so a consumer switching between the two
 * commands reads one shape. A sibling block would also make the fields ambiguous as soon as both
 * targets are in scope — `currentModel` at the top level of a two-target report does not say whose.
 */
export type CodexReport = {
  section: TargetReport & CodexSectionDetail;
  issues: Finding[];
  warnings: string[];
  liveState: LiveStateDrift | null;
  configProfiles: ManagedProfileView[];
  currentModel: string | null;
  currentModelProvider: string | null;
};

/**
 * The Codex-specific readings and views the section carries besides the shared contract.
 */
type CodexSectionDetail = {
  artifacts: CodexArtifacts;
  liveState: LiveStateDrift | null;
  configProfiles: ManagedProfileView[];
  currentModel: string | null;
  currentModelProvider: string | null;
};

/**
 * Reports the current on-disk Codex runtime state and how it maps back to managed providers.
 *
 * Every failure is local. A `providers.json` this process cannot parse becomes an issue and leaves
 * the registry-dependent readings `unavailable`; `config.toml` is still read, because what it says
 * about the active route does not depend on the registry being well formed. That is the opposite of
 * the strict readers the mutation commands use, and deliberately so: `switch` must refuse to run on
 * a file it does not understand, while a report exists precisely to explain such a file.
 *
 * `codexDir` is nullable because there is a case where it is genuinely unknown: the shared config
 * could not be read, and nothing else — no `--codex-dir`, no `APS_CODEX_DIR` — named a directory.
 * Falling back to `~/.codex` there would be a guess presented as a finding, so the runtime-derived
 * readings become `unavailable` instead. The registry path is not affected: it comes from the tool
 * home, which is resolved without reading the shared config at all.
 */
export async function buildCodexReport(args: {
  toolHomeRoot: string;
  providersPath: string;
  codexDir: string | null;
  codexDirUnavailableReason: string | null;
  defaultsPresent: boolean;
}): Promise<CodexReport> {
  const issues: Finding[] = [];
  const warnings: string[] = [];

  const configPath = args.codexDir === null ? null : path.join(args.codexDir, "config.toml");
  const authPath = args.codexDir === null ? null : path.join(args.codexDir, "auth.json");

  // Registry. Broken content here is a fault; absence is a fact.
  let providers: ProvidersFile | null = null;
  let registry: Reading<{ providerCount: number }>;
  if (!fs.existsSync(args.providersPath)) {
    registry = absent();
  } else {
    try {
      providers = readProvidersFile(args.providersPath);
      registry = ok({ providerCount: Object.keys(providers.providers).length });
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      registry = invalid(normalized.message);
      issues.push({
        target: "codex",
        code: normalized.code,
        message: normalized.message,
        path: args.providersPath,
        ...(normalized.details ?? {}),
      });
    }
  }

  const providerCount: Reading<number> =
    registry.status === "ok"
      ? ok(registry.value.providerCount)
      : registry.status === "absent"
        ? ok(0)
        : unavailable<number>(`providers.json could not be read: ${registry.reason}`);

  if (args.codexDir === null) {
    const reason = args.codexDirUnavailableReason ?? "No Codex directory could be determined.";
    return {
      section: {
        // The registry is one of the evidence sources and it is known, so a registry file present
        // is enough to answer `true`; only a total absence of evidence needs the directory.
        configured: ok(fs.existsSync(args.providersPath) || args.defaultsPresent),
        paths: unavailable<Record<string, string>>(reason),
        registry,
        live: unavailable<{ present: true }>(reason),
        activation: unavailable<"not-activated" | "activated">(reason),
        defaults: ok({ present: args.defaultsPresent }),
        providerCount,
        // Inapplicable rather than unobtainable: Codex records carry no inherited-delta concept,
        // and an empty map is the true answer rather than a placeholder for a failed read.
        inheritance: ok({}),
        matching: unavailable<ProviderMatch>(reason),
        artifacts: {
          config: unavailable<{ model: string | null; modelProvider: string | null }>(reason),
          auth: unavailable<{ valid: boolean }>(reason),
        },
        liveState: null,
        configProfiles: [],
        currentModel: null,
        currentModelProvider: null,
      },
      issues,
      warnings,
      liveState: null,
      configProfiles: [],
      currentModel: null,
      currentModelProvider: null,
    };
  }

  const configExists = fs.existsSync(configPath as string);
  let currentModel: string | null = null;
  let currentModelProvider: string | null = null;
  let configViews: ManagedProfileView[] = [];
  let consistencyIssues: ReturnType<typeof collectConfigConsistencyIssues> = [];

  let configReading: Reading<{ model: string | null; modelProvider: string | null }>;
  if (!configExists) {
    configReading = absent();
  } else {
    try {
      const document = readStructuredConfig(configPath as string);
      currentModel = document.currentModel;
      currentModelProvider = document.currentModelProvider;
      configViews = buildManagedProfileViews(document, providers);
      // Projection checks are prerequisites of an *activated* target, not of a readable file. A
      // `config.toml` with no top-level selector is a prepared or untouched Codex side, and
      // reporting its absent model, legacy sections, or unlinked profile as faults would invent
      // problems for a target the user has not started using — the same mistake as demanding a
      // `config.toml` from a machine that only has a registry.
      if (currentModelProvider) {
        consistencyIssues = collectConfigConsistencyIssues(document, providers);
      }
      configReading = ok({ model: currentModel, modelProvider: currentModelProvider });
      if (!currentModelProvider) {
        warnings.push("config.toml exists but has no top-level model_provider.");
      }
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      configReading = invalid(normalized.message);
      issues.push({
        target: "codex",
        code: normalized.code === "PROVIDERS_PARSE_ERROR" ? "CONFIG_PARSE_ERROR" : normalized.code,
        message: normalized.message,
        path: configPath as string,
        ...(normalized.details ?? {}),
      });
    }
  }

  for (const issue of consistencyIssues) {
    issues.push({ target: "codex", ...issue, message: renderConfigIssueMessage(issue) });
  }

  const authState = readAuthFileState(authPath as string);
  const authReading: Reading<{ valid: boolean }> = !authState.exists
    ? absent()
    : authState.valid
      ? ok({ valid: true })
      : invalid(authState.parseError ?? "auth.json is invalid.");
  if (authState.exists && !authState.valid) {
    issues.push({
      target: "codex",
      code: "AUTH_JSON_INVALID",
      message: authState.parseError ?? "auth.json is invalid.",
      path: authPath as string,
    });
  }

  const liveState = inspectLiveStateDrift(currentModelProvider, providers);
  const matching = buildCodexMatch({
    configReading,
    registry,
    liveState,
    consistencyIssues,
  });

  if (liveState.canBackfillActiveProvider) {
    warnings.push(
      "Current config profile is not mapped in providers.json. Backfill would be required before treating live state as managed."
    );
  }
  if (liveState.reason === "shared-profile") {
    warnings.push(
      `Current model provider "${currentModelProvider}" is shared by multiple providers in providers.json, so the active provider cannot be resolved uniquely.`
    );
  }

  const evidencePresent = configExists || fs.existsSync(args.providersPath) || args.defaultsPresent;

  return {
    section: {
      configured: ok(evidencePresent),
      paths: ok({
        codexDir: args.codexDir,
        configPath: configPath as string,
        providersPath: args.providersPath,
        authPath: authPath as string,
      }),
      registry,
      live: configExists ? ok({ present: true }) : absent(),
      activation:
        configReading.status === "ok"
          ? ok(currentModelProvider ? ("activated" as const) : ("not-activated" as const))
          : configReading.status === "absent"
            ? ok("not-activated" as const)
            : unavailable<"not-activated" | "activated">(
                `config.toml could not be read: ${configReading.reason}`
              ),
      defaults: ok({ present: args.defaultsPresent }),
      providerCount,
      inheritance: ok({}),
      matching,
      artifacts: { config: configReading, auth: authReading },
      liveState,
      configProfiles: configViews,
      currentModel,
      currentModelProvider,
    },
    issues,
    warnings,
    liveState,
    configProfiles: configViews,
    currentModel,
    currentModelProvider,
  };
}

/**
 * The Codex identity answer, in the same vocabulary as the Claude one.
 *
 * Codex identity is the model_provider wiring: the live `config.toml` names a profile, and the
 * providers whose stored `profile` matches are the candidates. Consistency is the projection
 * check — a record whose `baseUrl` disagrees with the live `base_url` for that model provider is a
 * candidate with a difference, not a different provider.
 */
function buildCodexMatch(args: {
  configReading: Reading<{ model: string | null; modelProvider: string | null }>;
  registry: Reading<{ providerCount: number }>;
  liveState: LiveStateDrift;
  consistencyIssues: ReturnType<typeof collectConfigConsistencyIssues>;
}): Reading<ProviderMatch> {
  if (args.configReading.status === "absent") {
    return ok({ state: "not-activated" as const, activeProvider: null, candidates: [] });
  }
  if (args.configReading.status !== "ok") {
    return unavailable<ProviderMatch>(`config.toml could not be read: ${args.configReading.reason}`);
  }
  // A missing registry leaves the candidate set *empty*, which is a determinate answer rather than
  // an unknown one: nothing is managed, so a live route that maps to no stored record is
  // `unmanaged`. Only damage makes the answer unknowable.
  if (args.registry.status !== "ok" && args.registry.status !== "absent") {
    return unavailable<ProviderMatch>(`providers.json could not be read: ${args.registry.reason}`);
  }
  if (!args.configReading.value.modelProvider) {
    return ok({ state: "not-activated" as const, activeProvider: null, candidates: [] });
  }

  const mismatched = new Set(
    args.consistencyIssues
      .filter((issue) => issue.code === "PROVIDER_BASE_URL_MISMATCH")
      .map((issue) => String((issue as { provider?: string }).provider ?? ""))
  );
  const candidates = args.liveState.mappedProviders.map((name) => ({
    name,
    consistent: !mismatched.has(name),
    differencePaths: mismatched.has(name) ? ["baseUrl"] : [],
  }));

  if (candidates.length === 0) {
    return ok({ state: "unmanaged" as const, activeProvider: null, candidates });
  }
  if (candidates.length === 1) {
    return ok({ state: "managed" as const, activeProvider: candidates[0].name, candidates });
  }
  return ok({ state: "ambiguous" as const, activeProvider: null, candidates });
}
