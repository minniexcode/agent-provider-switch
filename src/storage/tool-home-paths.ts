import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeDefaults } from "../domain/claude-providers";

export const TOOL_HOME_ENV_NAME = "APS_HOME";

/**
 * Names of the artifacts this tool owns inside the tool home.
 *
 * These are constants rather than inline literals because the paths used to be rebuilt by hand in
 * `dispatch.ts` and `claude-handlers.ts` alongside the builders in this module. That duplication is
 * exactly how an identity rename leaves a stale literal behind in one spot but not the other.
 */
export const TOOL_HOME_DIRNAME = "agent-provider-switch";
export const TOOL_CONFIG_FILENAME = "agent-provider-switch.json";
export const LOCK_FILENAME = ".aps.lock";

/**
 * The names used before the 1.0.0 rename. Frozen: they describe a location that already exists on
 * a user's disk, so they are only ever read, never written.
 */
export const LEGACY_TOOL_HOME_DIRNAME = "codex-switch";
export const LEGACY_TOOL_CONFIG_FILENAME = "codex-switch.json";
export const LEGACY_LOCK_FILENAME = ".codex-switch.lock";

/**
 * Absolute paths into the tool home alone, independent of any target.
 *
 * The tool home holds what the targets share: the tool config, the lock, and the backups tree.
 * A target's own registry file is *not* here — a path this type required would be a path every
 * caller had to name a target to build, which is the coupling the target descriptors exist to
 * remove. Each target's paths add its own registry under its own name.
 */
export type ToolHomePaths = {
  toolHomeDir: string;
  toolConfigPath: string;
  backupsDir: string;
  latestBackupPath: string;
  lockPath: string;
};

/**
 * Stored tool-level configuration for agent-provider-switch.
 */
export type AgentProviderSwitchConfig = {
  version: string;
  defaultCodexDir?: string;
  claudeDefaults?: ClaudeDefaults;
};

/**
 * Resolves the tool home directory, defaulting to `~/.config/agent-provider-switch`.
 */
export function resolveToolHome(toolHomeDir?: string): string {
  if (toolHomeDir) {
    return path.resolve(toolHomeDir);
  }

  const envToolHome = process.env[TOOL_HOME_ENV_NAME];
  if (envToolHome) {
    return path.resolve(envToolHome);
  }

  return path.join(os.homedir(), ".config", TOOL_HOME_DIRNAME);
}

/**
 * Expands the tool home into the paths shared by every command, for either target.
 */
export function createToolHomePaths(input?: string | { toolHomeDir?: string }): ToolHomePaths {
  const toolHomeDir = resolveToolHome(typeof input === "string" ? input : input?.toolHomeDir);
  return {
    toolHomeDir,
    toolConfigPath: path.join(toolHomeDir, TOOL_CONFIG_FILENAME),
    backupsDir: path.join(toolHomeDir, "backups"),
    latestBackupPath: path.join(toolHomeDir, "backups", "latest.json"),
    lockPath: resolveLockPath(toolHomeDir),
  };
}

/**
 * Resolves the shared lock path from the tool home alone.
 *
 * Codex and Claude operations share one lock file, and it lives in the tool home rather than
 * in a target runtime. Commands that only touch tool-home state therefore need this
 * rather than a full `CodexPaths`, which cannot be built without a Codex directory.
 */
export function resolveLockPath(toolHomeDir?: string): string {
  return path.join(resolveToolHome(toolHomeDir), LOCK_FILENAME);
}
