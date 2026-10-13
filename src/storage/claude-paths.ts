import * as os from "node:os";
import * as path from "node:path";
import { TARGET_METADATA } from "../domain/target";

export const CLAUDE_DIR_ENV_NAME = "APS_CLAUDE_DIR";

/**
 * Absolute paths used by agent-provider-switch for Claude Code provider management.
 */
export type ClaudePaths = {
  claudeDir: string;
  claudeSettingsPath: string;
  claudeProvidersPath: string;
};

/**
 * Resolves the Claude Code configuration directory, defaulting to `~/.claude`.
 */
export function resolveClaudeDir(claudeDir?: string): string {
  if (claudeDir) {
    return path.resolve(claudeDir);
  }

  const envClaudeDir = process.env[CLAUDE_DIR_ENV_NAME];
  if (envClaudeDir) {
    return path.resolve(envClaudeDir);
  }

  return path.join(os.homedir(), ".claude");
}

/**
 * Creates the Claude-related paths from tool home and Claude dir.
 */
export function createClaudePaths(toolHomeDir: string, claudeDir?: string): ClaudePaths {
  const resolvedClaudeDir = resolveClaudeDir(claudeDir);
  return {
    claudeDir: resolvedClaudeDir,
    claudeSettingsPath: path.join(resolvedClaudeDir, "settings.json"),
    // From the target declaration, for the same reason Codex reads its own from there.
    claudeProvidersPath: path.join(toolHomeDir, TARGET_METADATA.claude.registryFile),
  };
}
