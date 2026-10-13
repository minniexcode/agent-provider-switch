import { cliError } from "../domain/errors";
import { Finding, TargetReport } from "../domain/report";
import type { TargetId } from "../domain/target";
import { CommandResult } from "./types";
import { ToolConfigInspection } from "./inspect-tool-config";
import { containsUnavailable, inspectSharedLock } from "./report-support";
import { ReportMode, TargetReportPort } from "./targets/types";

/**
 * The one place a `doctor` or `status` report is assembled.
 *
 * Both commands publish the same sections in the same payload — the only difference is which
 * checks each target ran to produce them — so they were already one shape described twice. This is
 * that shape once: read the shared state, ask each selected target for its contribution, and
 * combine them.
 *
 * Two rules it exists to keep:
 *
 * - **Only the selected targets are read.** A target out of scope contributes nothing and its files
 *   are not touched, which is what lets a Claude-only machine come back healthy rather than
 *   reporting a `config.toml` it was never meant to have.
 * - **The shared state is read once.** The tool config and the lock are facts about the installation
 *   rather than about a target; reading them per target would inspect one file twice and let the two
 *   readings disagree.
 *
 * A target in the selection with no port is an *internal* error: there is no default section to fall
 * back to, and answering with another target's would be worse than refusing.
 */
export async function collectReport(args: {
  mode: ReportMode;
  targets: readonly TargetId[];
  toolHomeRoot: string;
  toolConfig: ToolConfigInspection;
  lockPath: string;
  /** The report adapters, keyed by the target they describe. */
  ports: ReadonlyMap<TargetId, TargetReportPort>;
}): Promise<CommandResult> {
  const issues: Finding[] = [];
  const notes: Finding[] = [];
  const warnings: string[] = [];
  const sections: Partial<Record<TargetId, TargetReport>> = {};

  for (const target of args.targets) {
    const port = args.ports.get(target);
    if (!port) {
      throw cliError("UNKNOWN_COMMAND", `No report adapter is registered for "${target}".`);
    }

    const contribution = await port.collect({
      mode: args.mode,
      toolHomeRoot: args.toolHomeRoot,
      toolConfig: args.toolConfig,
    });

    sections[target] = contribution.section;
    issues.push(...contribution.issues);
    notes.push(...contribution.notes);
    warnings.push(...contribution.warnings);
  }

  // The shared config's own findings, which name no target. Raised after the sections so a reader
  // reaches the target-specific ones first; a malformed `claudeDefaults` block arrives through the
  // Claude contribution instead, because that is whose fault it is.
  issues.push(...args.toolConfig.sharedIssues);

  const lock = inspectSharedLock(args.lockPath);
  if (lock.finding) {
    issues.push(lock.finding);
  }

  // `complete` tracks only `unavailable` readings: content that was obtained and judged — however
  // bad — is a check that ran, while a target that could not be read at all is a check that did not.
  const complete = ![
    args.toolConfig.reading,
    args.toolConfig.defaults,
    args.toolConfig.defaultCodexDir,
    lock.reading,
    ...Object.values(sections),
  ].some(containsUnavailable);

  const data: Record<string, unknown> = {
    toolHomeRoot: args.toolHomeRoot,
    // Three-valued, and the third value carries real information: `null` means the checks could not
    // be completed *and* nothing that was found is a fault. `true` there would certify a target this
    // run never managed to inspect.
    complete,
    healthy: issues.length > 0 ? false : complete ? true : null,
    issues,
    notes,
    shared: { toolConfig: args.toolConfig.reading, lock: lock.reading },
    ...sections,
  };

  return { data, warnings };
}
