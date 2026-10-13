import { TARGET_METADATA, TargetId } from "../../domain/target";
import { Finding, Reading, valueOf } from "../../domain/report";
import { buildClaudeReport, claudeSection } from "../get-claude-status";
import { buildCodexReport } from "../get-status";
import { MIN_SUPPORTED_CODEX_VERSION } from "../../runtime/codex-version";
import { probeCodexRuntime } from "../../runtime/codex-probe";
import { ReportContext, TargetReportContribution, TargetReportPort } from "./types";

/**
 * Both report adapters, keyed by the target each describes.
 *
 * The ports close over paths and read nothing, so building one for a target the report will not
 * include costs nothing. Callers that report on a single target build only that target's port
 * instead, which is a statement about the command rather than an optimisation.
 */
export function createReportPorts(paths: {
  codex: { providersPath: string; codexDir: string | null; codexDirUnavailableReason: string | null };
  claude: { claudeDir: string; claudeProvidersPath: string; claudeSettingsPath: string };
}): Map<TargetId, TargetReportPort> {
  return new Map<TargetId, TargetReportPort>([
    ["codex", createCodexReportPort(paths.codex)],
    ["claude", createClaudeReportPort(paths.claude)],
  ]);
}

/**
 * The Codex report adapter.
 *
 * The runtime probe lives here rather than in the composer because it is a Codex check about Codex
 * state: it shells out to the CLI and reads `config.toml`, and a composer that ran it would have to
 * know which target the probe was for — the branch this port exists to remove.
 */
export function createCodexReportPort(paths: {
  providersPath: string;
  codexDir: string | null;
  codexDirUnavailableReason: string | null;
}): TargetReportPort {
  return {
    metadata: TARGET_METADATA.codex,

    async collect(context: ReportContext): Promise<TargetReportContribution> {
      const report = await buildCodexReport({
        toolHomeRoot: context.toolHomeRoot,
        providersPath: paths.providersPath,
        codexDir: paths.codexDir,
        codexDirUnavailableReason: paths.codexDirUnavailableReason,
        defaultsPresent: context.toolConfig.reading.status === "ok" && context.toolConfig.reading.value.defaultsPresent,
      });

      const issues = [...report.issues];
      // Doctor-only, and gated on activation inside the check itself. `status` reports the same
      // section without them: the probe is a statement about a live CLI installation, and a plain
      // status read is not asking about one.
      if (context.mode === "doctor") {
        issues.push(...(await collectCodexRuntimeIssues(report.section)));
      }

      return {
        section: report.section,
        issues,
        notes: [],
        warnings: report.warnings,
        readings: [report.section],
      };
    },
  };
}

/**
 * The Claude report adapter.
 *
 * The malformed-defaults finding is folded in here rather than by the composer: the shared tool
 * config is read for both targets, but a broken `claudeDefaults` block is a Claude fault — Codex
 * never reads it — so it must not be raised when Claude is out of scope, and it must not stop a
 * Codex check. Owning it here is what makes that a property of the collector rather than a rule the
 * composer would have to remember.
 *
 * No runtime probe is held here. Claude has no CLI to probe, and reaching for Codex state from this
 * adapter would be exactly the cross-target coupling these ports replace.
 */
export function createClaudeReportPort(paths: {
  claudeDir: string;
  claudeProvidersPath: string;
  claudeSettingsPath: string;
}): TargetReportPort {
  return {
    metadata: TARGET_METADATA.claude,

    async collect(context: ReportContext): Promise<TargetReportContribution> {
      const report = buildClaudeReport({
        ...paths,
        defaults: context.toolConfig.defaults,
      });
      const section = claudeSection(report);

      return {
        section,
        issues: [...context.toolConfig.claudeIssues, ...report.issues],
        notes: report.notes,
        warnings: [],
        readings: [section],
      };
    },
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
async function collectCodexRuntimeIssues(section: {
  activation: Reading<"not-activated" | "activated">;
}): Promise<Finding[]> {
  const issues: Finding[] = [];

  // The runtime probe is skipped whenever activation is not positively `activated`, which also
  // covers the unknown-directory case: `unavailable` is not a licence to probe a guessed path.
  //
  // Nothing else is reported on the way out, and a `config.toml` with no top-level selector is the
  // case that makes the difference: it is a *not-activated* target, which the health table calls a
  // state rather than a fault. A missing selector was raised here as `MODEL_PROVIDER_MISSING`
  // before this release, which told a user who had never switched anything that their Codex setup
  // was broken.
  if (valueOf(section.activation) !== "activated") {
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
