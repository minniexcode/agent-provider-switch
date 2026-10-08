import * as os from "node:os";
import * as path from "node:path";

export const CODEX_DIR_ENV_NAME = "CODEXS_CODEX_DIR";
export const TOOL_HOME_ENV_NAME = "CODEXS_HOME";

/**
 * Names of the artifacts this tool owns inside the tool home.
 *
 * These are constants rather than inline literals because the paths used to be rebuilt by hand in
 * `dispatch.ts` and `claude-handlers.ts` alongside the builders in this module. That duplication is
 * exactly how an identity rename leaves a stale literal behind in one spot but not the other.
 */
export const TOOL_HOME_DIRNAME = "codex-switch";
export const TOOL_CONFIG_FILENAME = "codex-switch.json";
export const LOCK_FILENAME = ".codex-switch.lock";

/**
 * The names used before the 1.0.0 rename. Frozen: they describe a location that already exists on
 * a user's disk, so they are only ever read, never written.
 */
export const LEGACY_TOOL_HOME_DIRNAME = "codex-switch";
export const LEGACY_TOOL_CONFIG_FILENAME = "codex-switch.json";
export const LEGACY_LOCK_FILENAME = ".codex-switch.lock";

const DEVELOPMENT_DEFAULT_CODEX_DIR = path.resolve(process.cwd(), "dev-codex", "local-sandbox");

/**
 * Absolute paths into the tool home alone, independent of any target.
 *
 * Split out from `CodexPaths` because Claude commands need the tool home — the lock and the
 * backups tree are shared between both targets — but cannot build a `CodexPaths`, which cannot be
 * constructed without a Codex directory.
 */
export type ToolHomePaths = {
  toolHomeDir: string;
  toolConfigPath: string;
  providersPath: string;
  backupsDir: string;
  latestBackupPath: string;
  lockPath: string;
};

/**
 * Absolute paths used by codex-switch across its tool home and the target Codex directory.
 */
export type CodexPaths = ToolHomePaths & {
  codexDir: string;
  configPath: string;
  authPath: string;
};

/**
 * Stored tool-level configuration for codex-switch.
 */
export type CodexSwitchConfig = {
  version: string;
  defaultCodexDir?: string;
};

/**
 * Resolves the tool home directory, defaulting to `~/.config/codex-switch`.
 */
export function resolveCodexSwitchHome(toolHomeDir?: string): string {
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
 * Resolves the working Codex directory using the documented precedence order.
 */
export function resolveCodexDir(codexDir?: string, toolConfig?: CodexSwitchConfig | null): string {
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
 * Expands the tool home into the paths shared by every command, for either target.
 */
export function createToolHomePaths(input?: string | { toolHomeDir?: string }): ToolHomePaths {
  const toolHomeDir = resolveCodexSwitchHome(typeof input === "string" ? input : input?.toolHomeDir);
  return {
    toolHomeDir,
    toolConfigPath: path.join(toolHomeDir, TOOL_CONFIG_FILENAME),
    providersPath: path.join(toolHomeDir, "providers.json"),
    backupsDir: path.join(toolHomeDir, "backups"),
    latestBackupPath: path.join(toolHomeDir, "backups", "latest.json"),
    lockPath: resolveLockPath(toolHomeDir),
  };
}

/**
 * Expands the tool home and Codex runtime into the file paths used by the CLI.
 */
export function createCodexPaths(args: { codexDir: string; toolHomeDir?: string } | string): CodexPaths {
  const input = typeof args === "string" ? { codexDir: args } : args;
  const codexDir = path.resolve(input.codexDir);
  return {
    ...createToolHomePaths({ toolHomeDir: input.toolHomeDir }),
    codexDir,
    configPath: path.join(codexDir, "config.toml"),
    authPath: path.join(codexDir, "auth.json"),
  };
}

/**
 * Resolves the shared lock path from the tool home alone.
 *
 * Codex and Claude operations share one lock file, and it lives in the tool home rather than
 * in a target runtime. Commands that only touch tool-home state therefore need this rather
 * than a full `CodexPaths`, which cannot be built without a Codex directory.
 */
export function resolveLockPath(toolHomeDir?: string): string {
  return path.join(resolveCodexSwitchHome(toolHomeDir), LOCK_FILENAME);
}
