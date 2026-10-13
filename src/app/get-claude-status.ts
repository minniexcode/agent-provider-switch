import * as fs from "node:fs";
import { matchClaudeProviders, ProviderMatch } from "../domain/claude-identity";
import {
  ClaudeProvidersFile,
  collectClaudeRecordIssues,
  collectClaudeRecordNotes,
  resolveClaudeProvidersFile,
  summarizeClaudeSettings,
} from "../domain/claude-providers";
import { collectInheritedPaths } from "../domain/claude-settings-merge";
import {
  Finding,
  Reading,
  TargetReport,
  absent,
  invalid,
  ok,
  unavailable,
  valueOf,
} from "../domain/report";
import { normalizeError } from "../domain/errors";
import {
  readClaudeProvidersFile,
  readClaudeSettingsState,
} from "../storage/claude-providers-repo";

/**
 * The three answers a Claude settings path can give.
 *
 * `absent` and `invalid` stay separate all the way to the report: "never set up" and "set up and
 * broken" ask for different repairs, and a reader that collapsed them would send a user to create a
 * file that is already there.
 */
export type ClaudeSettingsStatus = "absent" | "invalid" | "ok";

/**
 * One Claude provider as a report row.
 *
 * `inherited` is a list of dotted paths rather than a count, because the count is trivially
 * derivable and the paths are what makes it explicable — they name which settings come from the
 * shared block. Values are never included, so this is safe to print next to a masked env.
 */
export type ClaudeStatusProvider = {
  name: string;
  model: string | null;
  baseUrl: string | null;
  inherited: string[];
  active: boolean;
  candidate: boolean;
  ambiguous: boolean;
  differencePaths: string[];
};

/**
 * Everything the Claude section of a `doctor` or `status` report carries.
 *
 * The section itself is a {@link TargetReport}; the rest is either the raw material its readings
 * were derived from (`settingsStatus`) or material that only the human renderer uses (`providers`).
 */
/**
 * The Claude-specific fields the section carries besides the shared contract.
 *
 * Inside the section rather than beside it, for the same reason the Codex ones are: `doctor` and
 * `status` publish one shape per target, and a sibling block at the top level of a two-target
 * report would not say whose rows it held.
 */
export type ClaudeSectionDetail = {
  settingsStatus: ClaudeSettingsStatus;
  settingsInvalidReason: string | null;
  providers: ClaudeStatusProvider[];
};

export type ClaudeReport = {
  section: TargetReport;
  issues: Finding[];
  notes: Finding[];
  settingsStatus: ClaudeSettingsStatus;
  settingsInvalidReason: string | null;
  providers: ClaudeStatusProvider[];
};

/**
 * The section as both report commands publish it: the shared contract plus Claude's own detail.
 */
export function claudeSection(report: ClaudeReport): TargetReport & ClaudeSectionDetail {
  return {
    ...report.section,
    settingsStatus: report.settingsStatus,
    settingsInvalidReason: report.settingsInvalidReason,
    providers: report.providers,
  };
}

/**
 * Builds the Claude section from the shared-config readings the caller already established.
 *
 * The whole function is shaped by one rule: **a fact about the installation is not a fault.** A
 * registry that is not there means no records are managed on this machine, which is exactly what a
 * user who has never run `aps add --claude` should see — not an issue, and not an unhealthy report.
 * The only Claude faults are content faults: a registry this process obtained and could not parse,
 * and a live settings file it obtained and could not use.
 *
 * `defaults` is a reading rather than a value because it comes from the shared tool config, which
 * can be unreadable in its own right. When it is not `ok`, the candidate set cannot be established
 * — a delta record's effective settings are a merge against those defaults — so `matching` and
 * `inheritance` are `unavailable` rather than an answer computed from a block that was never read.
 */
export function buildClaudeReport(args: {
  claudeDir: string;
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  defaults: Reading<Record<string, unknown> | null>;
}): ClaudeReport {
  const issues: Finding[] = [];
  const notes: Finding[] = [];
  const defaultsValue = valueOf(args.defaults);

  // Registry. `absent` and `invalid` are both facts the reader established; only the second is a
  // fault, and it is reported before anything is derived from the file.
  let file: ClaudeProvidersFile | null = null;
  let registry: Reading<{ providerCount: number }>;
  if (!fs.existsSync(args.claudeProvidersPath)) {
    registry = absent();
  } else {
    try {
      file = readClaudeProvidersFile(args.claudeProvidersPath);
      registry = ok({ providerCount: Object.keys(file.providers).length });
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      registry = invalid(normalized.message);
      issues.push({
        target: "claude",
        code: "PROVIDERS_PARSE_ERROR",
        message: normalized.message,
        path: args.claudeProvidersPath,
        ...(normalized.details ?? {}),
      });
    }
  }

  // Live settings. The file's existence and its usability are separate answers, which is what lets
  // "there is a settings.json and it is corrupt" stay distinguishable from "there is none".
  const settingsState = readClaudeSettingsState(args.claudeSettingsPath);
  const currentSettings = settingsState.status === "ok" ? settingsState.settings : null;
  const live: Reading<{ present: true }> =
    settingsState.status === "absent"
      ? absent()
      : settingsState.status === "ok"
        ? ok({ present: true })
        : invalid(settingsState.reason);
  if (settingsState.status === "invalid") {
    issues.push({
      target: "claude",
      code: "CLAUDE_SETTINGS_INVALID",
      message: settingsState.reason,
      path: args.claudeSettingsPath,
    });
  }

  const providerCount: Reading<number> =
    registry.status === "ok"
      ? ok(registry.value.providerCount)
      : registry.status === "absent"
        ? // A missing registry is a known absence, and zero is a legitimate count derived from it.
          // This is the difference the `Reading` vocabulary exists for: `absent` and `ok(0)` say
          // different things, and both say something different from `unavailable`.
          ok(0)
        : unavailable<number>(`the Claude registry could not be read: ${registry.reason}`);

  const defaultsPresent = args.defaults.status === "ok" ? args.defaults.value !== null : false;
  const activation: Reading<"not-activated" | "activated"> =
    settingsState.status === "absent"
      ? ok("not-activated")
      : settingsState.status === "ok"
        ? ok("activated")
        : unavailable<"not-activated" | "activated">(
            `settings.json could not be read: ${settingsState.reason}`
          );

  // A *missing* registry does not make the candidate set unknown — it makes it empty, which is a
  // determinate answer: nothing is managed, so live settings are `unmanaged` and no settings at all
  // is `not-activated`. Only damage does: an unparseable registry, or unusable defaults, leaves the
  // candidate set unestablished, and a merged comparison is the only correct one because a stored
  // record is a delta — comparing it unmerged would report a switched-to provider as unmanaged.
  const candidateSet =
    args.defaults.status === "ok"
      ? resolveClaudeProvidersFile(file ?? { providers: {} }, defaultsValue)
      : null;
  const defaultsReason =
    args.defaults.status === "invalid" || args.defaults.status === "unavailable" ? args.defaults.reason : "";

  let matching: Reading<ProviderMatch>;
  if (registry.status === "invalid") {
    matching = unavailable<ProviderMatch>(`the Claude registry could not be read: ${registry.reason}`);
  } else if (candidateSet === null) {
    matching = unavailable<ProviderMatch>(
      args.defaults.status === "absent"
        ? "the shared Claude defaults are not available, so no provider can be compared."
        : `the shared Claude defaults could not be read: ${defaultsReason}`
    );
  } else if (settingsState.status === "invalid") {
    matching = unavailable<ProviderMatch>(
      `settings.json could not be read: ${settingsState.reason}`
    );
  } else {
    matching = ok(
      matchClaudeProviders({
        live: currentSettings,
        providers: Object.fromEntries(
          Object.entries(candidateSet.providers).map(([name, record]) => [name, record.effective])
        ),
      })
    );
  }

  const match = valueOf(matching);
  const candidateNames = new Set((match?.candidates ?? []).map((candidate) => candidate.name));

  // The rows and the inheritance counts need the resolved records and nothing else, so a live
  // settings file that could not be read costs the reader the active marker and not the list.
  const providers: ClaudeStatusProvider[] = [];
  let inheritance: Reading<Record<string, number>>;
  if (candidateSet === null) {
    inheritance = unavailable<Record<string, number>>(
      args.defaults.status === "absent"
        ? "the shared Claude defaults are not available, so no record could be resolved."
        : "the shared Claude defaults could not be read."
    );
  } else {
    const counts: Record<string, number> = {};
    for (const name of Object.keys(candidateSet.providers).sort()) {
      const record = candidateSet.providers[name];
      const inherited = collectInheritedPaths(defaultsValue, record.settings);
      counts[name] = inherited.length;
      const summary = summarizeClaudeSettings(record.effective);
      providers.push({
        name,
        model: summary.model,
        baseUrl: summary.baseUrl,
        inherited,
        active: match?.state === "managed" && match.activeProvider === name,
        candidate: candidateNames.has(name),
        ambiguous: match?.state === "ambiguous" && candidateNames.has(name),
        differencePaths:
          match?.candidates.find((candidate) => candidate.name === name)?.differencePaths ?? [],
      });
    }
    inheritance = ok(counts);
  }

  // Content faults in the stored records. Read from the raw file, not from `providers` above: this
  // check is about what `switch` would *write*, so it runs against the effective view even when the
  // row list could not be built.
  if (file !== null && args.defaults.status === "ok") {
    for (const recordIssue of collectClaudeRecordIssues(file, defaultsValue)) {
      issues.push({
        target: "claude",
        code: recordIssue.code,
        message: recordIssue.message,
        ...(recordIssue.paths ? { paths: recordIssue.paths } : {}),
      });
    }
    for (const note of collectClaudeRecordNotes(file, defaultsValue)) {
      notes.push({ target: "claude", code: note.code, message: note.message, paths: note.paths });
    }
  }

  // Drift is a note and never an issue: a permission or a plugin list that differs from the stored
  // record is still the provider the user configured, and failing the run over it would train them
  // to ignore the one signal that means something is actually broken.
  for (const candidate of match?.candidates ?? []) {
    if (candidate.consistent || candidate.differencePaths.length === 0) {
      continue;
    }
    notes.push({
      target: "claude",
      code: "CONFIGURATION_DRIFT",
      message: `Claude provider "${candidate.name}" matches the live settings on identity but differs at ${candidate.differencePaths.join(", ")}.`,
      paths: candidate.differencePaths,
    });
  }

  // Evidence, not a previous-installation heuristic. A registry file, a live settings file, or a
  // shared defaults block each prove this target has been used here; an empty directory proves
  // nothing, and a malformed file proves exactly as much as a well-formed one — it exists.
  const evidencePresent =
    registry.status !== "absent" || live.status !== "absent" || defaultsPresent;
  const configured: Reading<boolean> =
    registry.status === "unavailable"
      ? unavailable<boolean>("the Claude registry could not be read, so no conclusion is available.")
      : ok(evidencePresent);

  return {
    section: {
      configured,
      paths: ok({
        claudeDir: args.claudeDir,
        claudeProvidersPath: args.claudeProvidersPath,
        claudeSettingsPath: args.claudeSettingsPath,
      }),
      registry,
      live,
      activation,
      defaults: args.defaults.status === "ok" ? ok({ present: args.defaults.value !== null }) : args.defaults,
      providerCount,
      inheritance,
      matching,
    },
    issues,
    notes,
    settingsStatus: settingsState.status,
    settingsInvalidReason: settingsState.status === "invalid" ? settingsState.reason : null,
    providers,
  };
}
