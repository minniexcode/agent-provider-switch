import * as os from "node:os";
import * as path from "node:path";
import { TARGET_METADATA } from "../domain/target";
import { AgentProviderSwitchConfig, ToolHomePaths, createToolHomePaths } from "./tool-home-paths";

export const CODEX_DIR_ENV_NAME = "APS_CODEX_DIR";

const DEVELOPMENT_DEFAULT_CODEX_DIR = path.resolve(process.cwd(), "dev-codex", "local-sandbox");

/**
 * Absolute paths used by agent-provider-switch across its tool home and the target Codex directory.
 */
export type CodexPaths = ToolHomePaths & {
  providersPath: string;
  codexDir: string;
  configPath: string;
  authPath: string;
};

/**
 * Resolves the working Codex directory using the documented precedence order.
 */
export function resolveCodexDir(codexDir?: string, toolConfig?: AgentProviderSwitchConfig | null): string {
  if (codexDir) {
    return path.resolve(codexDir);
  }

  const envCodexDir = process.env[CODEX_DIR_ENV_NAME];
  if (envCodexDir) {
    return path.resolve(envCodexDir);
  }

  if (toolConfig?.defaultCodexDir) {
    return path.resolve(toolConfig.defaultCodexDir);
  }

  if (process.env.NODE_ENV === "development") {
    return DEVELOPMENT_DEFAULT_CODEX_DIR;
  }

  return path.join(os.homedir(), ".codex");
}

/**
 * Expands the tool home and Codex runtime into the file paths used by the CLI.
 */
export function createCodexPaths(args: { codexDir: string; toolHomeDir?: string } | string): CodexPaths {
  const input = typeof args === "string" ? { codexDir: args } : args;
  const codexDir = path.resolve(input.codexDir);
  const toolHome = createToolHomePaths({ toolHomeDir: input.toolHomeDir });
  return {
    ...toolHome,
    // Read off the target declaration rather than written as a literal here: the registry file name
    // is part of what a target is, and a second copy of it is how a rename leaves one path behind.
    providersPath: path.join(toolHome.toolHomeDir, TARGET_METADATA.codex.registryFile),
    codexDir,
    configPath: path.join(codexDir, "config.toml"),
    authPath: path.join(codexDir, "auth.json"),
  };
}
