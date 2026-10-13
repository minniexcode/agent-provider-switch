import { CliErrorShape } from "../domain/errors";
import { TARGET_IDS, singleTarget, type TargetId } from "../domain/target";
import { printErrorDetails } from "../storage/fs-utils";
import { CommandResult } from "../app/types";
import { CommandExecutionContext } from "../commands/types";
import { presenterFor } from "../commands/target-presenters";
import { okValue, renderDoctorIssueNextStep, renderHealth, renderReading } from "./report-lines";

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
 * A command covering exactly one target is offered to that target's presenter first, and the
 * presenter answers `null` for anything it does not own — so `doctor --claude` and `backups list
 * --claude` reach the shared view below rather than a target view that could not produce them. The
 * selection is a registry lookup, not a comparison: adding a target is an entry in the presenter
 * map, never another branch here.
 *
 * The targets are the resolved ones rather than payload fields. The Claude services used to write
 * their own `target: "claude"` into `data`, and this renderer read that until `1.1.1`; switching to
 * the resolved targets is what made the payload's copy removable, because at the moment it was
 * deleted it had no reader left inside the repository. `data` is nullable here rather than because
 * of that change — a resolved Claude target no longer implies a non-null payload.
 */
function renderHumanSuccess(
  ctx: CommandExecutionContext,
  data: Record<string, unknown> | null,
  warnings: string[]
): string[] {
  const command = ctx.command;
  const presenter = ctx.targets.length === 1 ? presenterFor(ctx.targets[0]) : null;
  const lines = presenter?.renderCommand(command, data ?? {}) ?? null;

  const rendered = lines ?? renderSharedCommand(ctx, data, warnings);

  // Emit warnings after the primary payload so the main outcome remains easy to scan.
  for (const warning of warnings) {
    rendered.push(`Warning: ${warning}`);
  }

  return rendered;
}

/**
 * The view for a command no single target owns: a report over both, or shared state.
 *
 * Everything here answers a question that is not one target's — `status` and `doctor` compose both
 * sections, and `backups`, `rollback` and `unlock` act on the one tree, pointer and lock the targets
 * share. The provider commands and the Codex-exclusive flows are rendered by their target's
 * presenter instead, which is why none of them appears below.
 */
function renderSharedCommand(
  ctx: CommandExecutionContext,
  data: Record<string, unknown> | null,
  warnings: string[]
): string[] {
  const lines: string[] = [];
  const command = ctx.command;

  switch (command) {
    case "status": {
      // A narrowed `status` omits the other target's block, which is what makes `targets` more
      // than decoration: the sections are composed by the handler from the selected targets. The
      // blocks themselves are the presenters' — each target states its own summary, and the first
      // one carries the header.
      const sections = TARGET_IDS.filter((target) => data?.[target] !== undefined);
      const context = {
        toolHomeRoot: String(data?.toolHomeRoot ?? ""),
        leading: true,
        warningCount: warnings.length,
        hasLegacyFields: hasLegacyProjection(data),
      };
      for (const target of sections) {
        const section = data?.[target] as Record<string, unknown>;
        lines.push(...presenterFor(target).renderStatusSection(section, context));
        context.leading = false;
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

  return lines;
}

/**
 * Whether the report carries an issue about a field this release no longer projects.
 *
 * Read from the issue list rather than from the declarations, because the issue is what the command
 * already decided: the same three codes are what `renderDoctorIssueNextStep` offers a repair for, and
 * the list is the one place both the human and JSON views read that fact from.
 */
function hasLegacyProjection(data: Record<string, unknown> | null): boolean {
  const issues = (data?.issues as Array<Record<string, unknown>>) ?? [];
  return issues.some(
    (issue) =>
      issue.code === "LEGACY_PROFILE_SELECTOR" ||
      issue.code === "LEGACY_PROFILE_SECTION" ||
      issue.code === "LEGACY_MODEL_PROVIDER_ENV_KEY"
  );}
