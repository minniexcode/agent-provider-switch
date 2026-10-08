import * as fs from "node:fs";
import { ClaudeDefaults } from "../domain/claude-providers";
import { cliError } from "../domain/errors";
import { AgentProviderSwitchConfig } from "./codex-paths";
import { ensureDir, writeTextFileAtomic } from "./fs-utils";

/**
 * Reads the optional tool-level agent-provider-switch config file when present.
 */
export function readToolConfigIfExists(toolConfigPath: string): AgentProviderSwitchConfig | null {
  if (!fs.existsSync(toolConfigPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(toolConfigPath, "utf8")) as AgentProviderSwitchConfig;
    return validateToolConfig(parsed, toolConfigPath);
  } catch (error: unknown) {
    throw cliError("INVALID_CONFIG", "agent-provider-switch.json is invalid.", {
      file: toolConfigPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Ensures the tool-level config file exists with the minimum stable fields.
 */
export function ensureToolConfig(toolConfigPath: string, version: string, defaultCodexDir: string): {
  created: boolean;
  config: AgentProviderSwitchConfig;
} {
  const current = readToolConfigIfExists(toolConfigPath);
  if (current) {
    return {
      created: false,
      config: current,
    };
  }

  const next: AgentProviderSwitchConfig = {
    version,
  };
  if (defaultCodexDir) {
    next.defaultCodexDir = defaultCodexDir;
  }
  ensureDir(require("node:path").dirname(toolConfigPath));
  writeTextFileAtomic(toolConfigPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    created: true,
    config: next,
  };
}

/**
 * Writes the tool-level config file with a normalized shape.
 */
export function writeToolConfig(toolConfigPath: string, config: AgentProviderSwitchConfig): void {
  const normalized = validateToolConfig(config, toolConfigPath);
  writeTextFileAtomic(toolConfigPath, `${JSON.stringify(normalized, null, 2)}\n`);
}

function validateToolConfig(config: AgentProviderSwitchConfig, toolConfigPath: string): AgentProviderSwitchConfig {
  if (!config || typeof config !== "object") {
    throw cliError("INVALID_CONFIG", "agent-provider-switch.json must contain a JSON object.", {
      file: toolConfigPath,
    });
  }
  if (typeof config.version !== "string" || config.version.trim() === "") {
    throw cliError("INVALID_CONFIG", "agent-provider-switch.json requires a non-empty version field.", {
      file: toolConfigPath,
    });
  }
  if (config.defaultCodexDir !== undefined && typeof config.defaultCodexDir !== "string") {
    throw cliError("INVALID_CONFIG", "agent-provider-switch.json.defaultCodexDir must be a string when provided.", {
      file: toolConfigPath,
    });
  }

  const normalized: AgentProviderSwitchConfig = {
    version: config.version,
    defaultCodexDir: config.defaultCodexDir,
  };
  // Added only when present: this function rebuilds the object rather than preserving it, so a
  // field it does not copy is erased on the next read. That is the reason `claudeDefaults` is
  // handled here at all — and the reason an absent block must stay absent instead of becoming
  // an explicit `undefined` that a deep-equality check would see as a difference.
  if (config.claudeDefaults !== undefined) {
    normalized.claudeDefaults = validateClaudeDefaults(config.claudeDefaults, toolConfigPath);
  }
  return normalized;
}

/**
 * Validates the shared Claude settings block.
 *
 * Unknown keys are refused rather than dropped. The likeliest hand-written mistake is putting
 * `env` directly under `claudeDefaults` and forgetting the `settings` wrapper; silently ignoring
 * it would leave every provider with no inherited env and no message saying why.
 */
function validateClaudeDefaults(value: unknown, toolConfigPath: string): ClaudeDefaults {
  if (!isPlainObject(value)) {
    throw cliError("INVALID_CONFIG", "agent-provider-switch.json.claudeDefaults must be an object when provided.", {
      file: toolConfigPath,
    });
  }

  const unknownKeys = Object.keys(value).filter((key) => key !== "settings");
  if (unknownKeys.length > 0) {
    throw cliError(
      "INVALID_CONFIG",
      `agent-provider-switch.json.claudeDefaults only supports "settings"; found ${unknownKeys.map((key) => `"${key}"`).join(", ")}. ` +
        "Nest those keys under claudeDefaults.settings.",
      { file: toolConfigPath }
    );
  }

  if (!isPlainObject(value.settings)) {
    throw cliError("INVALID_CONFIG", "agent-provider-switch.json.claudeDefaults.settings must be an object.", {
      file: toolConfigPath,
    });
  }

  return { settings: value.settings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
