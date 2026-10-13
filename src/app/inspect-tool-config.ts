import * as fs from "node:fs";
import { Finding, Reading, invalid, ok, unavailable } from "../domain/report";
import { AgentProviderSwitchConfig } from "../storage/codex-paths";

/**
 * What a report can establish about the shared tool config, field by field.
 *
 * `readToolConfigIfExists()` is the strict reader and stays that way: a mutation that ran with a
 * half-understood defaults block would silently store every Claude record in full instead of as a
 * delta, and the user would not find out until they edited the defaults. But a *report* has the
 * opposite obligation — it has to keep going and say what it could not establish — so it needs an
 * inspection that separates the failure modes instead of collapsing them into one throw.
 *
 * Three, and they are genuinely different:
 *
 * - The file is not there. Nothing is configured, which is a fact, not a failure.
 * - The file is there and unusable as a whole — unreadable, not JSON, or a root that is not an
 *   object. Nothing can be read from it, so every value that lives in it is `unavailable`.
 * - The file parses and the *root* is sound, but one field is malformed. That is contained: the
 *   fields that do not live in the broken one are still readable, and Codex keeps working on a
 *   machine whose Claude defaults are wrong. The design's rule is that this must not mark a
 *   Codex-only report incomplete, because Codex never reads that block.
 */
export type ToolConfigInspection = {
  /** The file-level answer, for `Report.shared.toolConfig`. */
  reading: Reading<{ defaultsPresent: boolean }>;
  /** The validated Claude defaults block, `ok(null)` when the file carries none. */
  defaults: Reading<Record<string, unknown> | null>;
  /** The configured Codex directory, `ok(null)` when the file names none. */
  defaultCodexDir: Reading<string | null>;
  /** Whole-file problems, which belong to neither target. */
  sharedIssues: Finding[];
  /** The malformed-defaults problem, which belongs to Claude alone. */
  claudeIssues: Finding[];
};

/**
 * Inspects the shared tool config without letting any of it become a hard failure.
 *
 * The path is a parameter rather than resolved here so this module stays free of the environment
 * lookups `resolveToolHome()` performs — the caller already has one.
 */
export function inspectToolConfig(toolConfigPath: string): ToolConfigInspection {
  if (!fs.existsSync(toolConfigPath)) {
    return {
      reading: ok({ defaultsPresent: false }),
      defaults: ok(null),
      defaultCodexDir: ok(null),
      sharedIssues: [],
      claudeIssues: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(toolConfigPath, "utf8"));
  } catch (error: unknown) {
    const reason = `agent-provider-switch.json could not be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return wholeFileUnusable(toolConfigPath, reason);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return wholeFileUnusable(toolConfigPath, "agent-provider-switch.json must contain a JSON object.");
  }

  const config = parsed as AgentProviderSwitchConfig;

  // The Codex directory override, on its own axis: a malformed Claude block must not take it away,
  // and a malformed override must not take the Claude block away.
  const defaultCodexDir: Reading<string | null> =
    config.defaultCodexDir === undefined
      ? ok(null)
      : typeof config.defaultCodexDir === "string"
        ? ok(config.defaultCodexDir)
        : invalid<string | null>(
            "agent-provider-switch.json.defaultCodexDir must be a string when provided."
          );

  const defaultsResult = inspectClaudeDefaults(config.claudeDefaults, toolConfigPath);

  return {
    reading: ok({ defaultsPresent: config.claudeDefaults !== undefined }),
    defaults: defaultsResult.reading,
    defaultCodexDir,
    sharedIssues: [],
    claudeIssues: defaultsResult.finding ? [defaultsResult.finding] : [],
  };
}

function wholeFileUnusable(toolConfigPath: string, reason: string): ToolConfigInspection {
  return {
    reading: invalid(reason),
    // Both of these live in the file that could not be read, so neither is guessed — not even to
    // "no override configured", which is the guess that would silently fall back to `~/.codex`.
    defaults: unavailable(reason),
    defaultCodexDir: unavailable(reason),
    sharedIssues: [
      {
        code: "SHARED_CONFIG_INVALID",
        target: null,
        message: reason,
        path: toolConfigPath,
      },
    ],
    claudeIssues: [],
  };
}

/**
 * Validates just the `claudeDefaults` block, in the reporting rather than the enforcing style.
 *
 * The rules are `validateClaudeDefaults()`'s, restated here because the strict one throws: an
 * unknown key is refused there to catch the likely mis-nesting (`env` written where
 * `claudeDefaults.settings` belongs), and the report has to say the same thing without giving up
 * on the rest of the file.
 */
function inspectClaudeDefaults(
  value: unknown,
  toolConfigPath: string
): { reading: Reading<Record<string, unknown> | null>; finding: Finding | null } {
  if (value === undefined) {
    return { reading: ok(null), finding: null };
  }

  const refuse = (reason: string) => ({
    reading: unavailable<Record<string, unknown> | null>(reason),
    finding: {
      code: "CLAUDE_DEFAULTS_INVALID",
      target: "claude" as const,
      message: reason,
      path: toolConfigPath,
    },
  });

  if (!isPlainObject(value)) {
    return refuse("agent-provider-switch.json.claudeDefaults must be an object when provided.");
  }

  const unknownKeys = Object.keys(value).filter((key) => key !== "settings");
  if (unknownKeys.length > 0) {
    return refuse(
      `agent-provider-switch.json.claudeDefaults only supports "settings"; found ${unknownKeys
        .map((key) => `"${key}"`)
        .join(", ")}. Nest those keys under claudeDefaults.settings.`
    );
  }

  if (!isPlainObject(value.settings)) {
    return refuse("agent-provider-switch.json.claudeDefaults.settings must be an object.");
  }

  return { reading: ok(value.settings), finding: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
