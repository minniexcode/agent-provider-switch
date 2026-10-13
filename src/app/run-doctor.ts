import { Finding, Report, TargetReport, valueOf } from "../domain/report";
import type { TargetId } from "../domain/target";
import { CommandResult } from "./types";
import { probeCodexRuntime } from "../runtime/codex-probe";
import { MIN_SUPPORTED_CODEX_VERSION } from "../runtime/codex-version";
import { containsUnavailable, inspectSharedLock } from "./report-support";
import { buildClaudeReport, claudeSection, ClaudeReport } from "./get-claude-status";
import { buildCodexReport, CodexReport } from "./get-status";
import type { ToolConfigInspection } from "./inspect-tool-config";

/**
 * The health-relevant checks, and what they reported.
 *
 * `healthy` is three-valued and the third value carries real information: `null` means the checks
 * could not be completed *and* nothing that was found is a fault. Reporting `true` there would
 * certify a target this run never managed to inspect, which is the failure mode the whole
 * `Reading` vocabulary exists to prevent — a collector that could not look is not a collector that
 * found nothing.
 */
type Health = {
  complete: boolean;
  healthy: boolean | null;
};

/**
 * Performs consistency checks across both targets and reports them together.
 *
 * Everything is composed from the selected targets. A target the user has never pointed at this
 * tool is *skipped*, not found wanting: there is no issue to raise about a `config.toml` that was
 * never meant to exist, and that is also what lets a Claude-only machine come back healthy.
 *
 * Three kinds of answer, kept apart on purpose:
 *
 * - **issues** are diagnosed faults and are what `healthy` reads.
 * - **notes** are worth printing and are not faults; `healthy` never reads them.
 * - **states** — activation, management, ambiguity, lock ownership — describe the installation
 *   without judging it. Valid but unmanaged settings and a lock held by a running operation are
 *   both states. Folding either into `issues` would fail a run over a machine that is working,
 *   which is how a user learns to ignore the report.
 */
export async function runDoctor(args: {
  targets: TargetId[];
  toolHomeRoot: string;
  codex: {
    codexDir: string | null;
    codexDirUnavailableReason: string | null;
    providersPath: string;
    defaultsPresent: boolean;
  };
  claude: { claudeDir: string; claudeProvidersPath: string; claudeSettingsPath: string };
  toolConfig: ToolConfigInspection;
  lockPath: string;
}): Promise<CommandResult> {
  const codexInScope = args.targets.includes("codex");
  const claudeInScope = args.targets.includes("claude");

  const codex: CodexReport | null = codexInScope
    ? await buildCodexReport({
        toolHomeRoot: args.toolHomeRoot,
        providersPath: args.codex.providersPath,
        codexDir: args.codex.codexDir,
        codexDirUnavailableReason: args.codex.codexDirUnavailableReason,
        defaultsPresent: args.codex.defaultsPresent,
      })
    : null;

  const claude: ClaudeReport | null = claudeInScope
    ? buildClaudeReport({
        ...args.claude,
        defaults: args.toolConfig.defaults,
      })
    : null;

  const issues: Finding[] = [
    ...(codex?.issues ?? []),
    // The malformed-defaults finding comes from the shared file but names Claude: the file is
    // readable and its Codex-relevant fields are sound, so this is a Claude fault and must not
    // stop a Codex check.
    ...(claudeInScope ? args.toolConfig.claudeIssues : []),
    ...(claude?.issues ?? []),
    ...args.toolConfig.sharedIssues,
  ];
  const notes: Finding[] = [...(claude?.notes ?? [])];

  // Doctor-only Codex checks. Everything here is gated on the target actually being activated: a
  // registry with no runtime configuration is a prepared target, and a prepared target does not owe
  // a `config.toml` any more than an empty directory does.
  if (codex) {
    issues.push(...(await collectCodexRuntimeIssues(codex)));
  }

  const lock = inspectSharedLock(args.lockPath);
  if (lock.finding) {
    issues.push(lock.finding);
  }

  const health = assessHealth({
    issues,
    // The shared readings the sections are derived from, plus the sections themselves. Both, and
    // not just the sections: an `unavailable` shared config has already been folded into the
    // readings it produced, and either side alone would miss a case.
    readings: [
      args.toolConfig.reading,
      args.toolConfig.defaults,
      args.toolConfig.defaultCodexDir,
      lock.reading,
      ...(codex ? [codex.section] : []),
      ...(claude ? [claude.section] : []),
    ],
  });

  const report: Report = {
    toolHomeRoot: args.toolHomeRoot,
    complete: health.complete,
    healthy: health.healthy,
    issues,
    notes,
    shared: {
      toolConfig: args.toolConfig.reading,
      lock: lock.reading,
    },
    ...(codex ? { codex: codex.section } : {}),
    ...(claude ? { claude: claudeSection(claude) } : {}),
  };

  return {
    data: { ...report },
    warnings: codex?.warnings ?? [],
  };
}

/**
 * The checks that need a Codex runtime on disk, not just a registry.
 *
 * Gated on activation, and the gate is the point: the CLI probe shells out and the projection
 * checks read `config.toml`, so on a machine whose Codex side is a registry and nothing else they
 * would report a missing CLI and a missing config for a target the user has not started using —
 * two findings that say nothing and make every other finding harder to see.
 */
async function collectCodexRuntimeIssues(report: CodexReport): Promise<Finding[]> {
  const issues: Finding[] = [];
  const activation = report.section.activation;

  // The runtime probe is skipped whenever activation is not positively `activated`, which also
  // covers the unknown-directory case: `unavailable` is not a licence to probe a guessed path.
  //
  // Nothing else is reported on the way out, and a `config.toml` with no top-level selector is the
  // case that makes the difference: it is a *not-activated* target, which the health table calls a
  // state rather than a fault. A missing selector was raised here as `MODEL_PROVIDER_MISSING`
  // before this release, which told a user who had never switched anything that their Codex setup
  // was broken.
  if (valueOf(activation) !== "activated") {
    return issues;
  }

  const codexCheck = probeCodexRuntime(MIN_SUPPORTED_CODEX_VERSION);
  if (!codexCheck.ok) {
    const message =
      codexCheck.reason === "missing"
        ? "codex CLI is not available on PATH."
        : codexCheck.reason === "unsupported"
          ? "codex CLI version is below the supported minimum."
          : "codex CLI probe failed.";
    issues.push({
      target: "codex",
      code:
        codexCheck.reason === "unsupported"
          ? "CODEX_VERSION_UNSUPPORTED"
          : codexCheck.reason === "missing"
            ? "CODEX_NOT_INSTALLED"
            : "CODEX_LOGIN_FAILED",
      message,
      ...(codexCheck.cause ? { cause: codexCheck.cause } : {}),
    });
  }

  return issues;
}

/**
 * Decides the report's two health fields from what was found and what could be looked at.
 *
 * `complete` tracks only `unavailable` readings: content that was obtained and judged — however
 * bad — is a check that ran. A target that could not be read at all is a check that did not.
 */
function assessHealth(args: { issues: Finding[]; readings: unknown[] }): Health {
  const complete = !args.readings.some(containsUnavailable);

  if (args.issues.length > 0) {
    return { complete, healthy: false };
  }
  return { complete, healthy: complete ? true : null };
}
