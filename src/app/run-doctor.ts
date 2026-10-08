import * as fs from "node:fs";
import { collectConfigConsistencyIssues, ConfigConsistencyIssue, ParsedConfigDocument } from "../domain/config";
import { inspectLiveStateDrift } from "../domain/runtime-state";
import { readStructuredConfig } from "../storage/config-repo";
import { readProvidersFile } from "../storage/providers-repo";
import { normalizeError } from "../domain/errors";
import { CommandResult } from "./types";
import { probeCodexRuntime } from "../runtime/codex-probe";
import { readAuthFileState } from "../storage/auth-repo";
import { describeLockOwner, inspectLock, isRecoverableLock } from "../storage/lock-repo";
import { MIN_SUPPORTED_CODEX_VERSION } from "../runtime/codex-version";

/**
 * Performs consistency checks across config.toml, providers.json, and the local Codex CLI.
 */
export async function runDoctor(args: {
  codexDir: string;
  configPath: string;
  providersPath: string;
  authPath: string;
  lockPath: string;
}): Promise<CommandResult> {
  const issues: Array<Record<string, unknown>> = [];
  let currentModelProvider: string | null = null;
  let providers = null;
  let document: ParsedConfigDocument | null = null;

  if (!fs.existsSync(args.configPath)) {
    issues.push({
      code: "CONFIG_NOT_FOUND",
      message: "config.toml does not exist.",
      file: args.configPath,
    });
  } else {
    document = readStructuredConfig(args.configPath);
    currentModelProvider = document.currentModelProvider;
    if (!currentModelProvider) {
      issues.push({
        code: "MODEL_PROVIDER_MISSING",
        message: "config.toml has no top-level model_provider.",
        file: args.configPath,
      });
    }
  }

  if (!fs.existsSync(args.providersPath)) {
    issues.push({
      code: "PROVIDERS_NOT_FOUND",
      message: "providers.json does not exist.",
      file: args.providersPath,
    });
  } else {
    try {
      providers = readProvidersFile(args.providersPath);
      if (document) {
        for (const issue of collectConfigConsistencyIssues(document, providers)) {
          issues.push({
            ...issue,
            message: renderConfigIssueMessage(issue),
          });
        }
      }
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      issues.push({
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details ?? {}),
      });
    }
  }

  const authState = readAuthFileState(args.authPath);
  if (authState.exists && !authState.valid) {
    issues.push({
      code: "AUTH_JSON_INVALID",
      message: authState.parseError ?? "auth.json is invalid.",
      file: args.authPath,
    });
  }

  const drift = inspectLiveStateDrift(currentModelProvider, providers);

  // A stuck lock is reported only when a record is actually present. Reporting "absent" as a
  // finding would make every healthy run look like it had something to fix, and would drown
  // the issues that do need attention.
  const lockState = inspectLock(args.lockPath);
  if (lockState.status !== "absent") {
    const recoverable = isRecoverableLock(lockState);
    issues.push({
      code: recoverable ? "LOCK_STALE" : "LOCK_OCCUPIED",
      message: recoverable
        ? `A lock is present but its owner is gone: ${describeLockOwner(lockState)}.`
        : `A lock is held by a running operation: ${describeLockOwner(lockState)}.`,
      file: args.lockPath,
      lockStatus: lockState.status,
      activePid: lockState.record?.pid ?? null,
      activeOperation: lockState.record?.operation ?? "unknown",
      activeSince: lockState.record?.createdAt ?? null,
      activeHost: lockState.record?.hostname ?? null,
      // Every write command fails while this is present, which is why it belongs in doctor
      // rather than only in the lock error the user would otherwise hit by surprise.
      remedy: recoverable
        ? "The next write command clears it automatically, or run `aps unlock`."
        : "Run `aps unlock --force` only if no agent-provider-switch operation is actually running.",
    });
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
      code:
        codexCheck.reason === "unsupported"
          ? "CODEX_VERSION_UNSUPPORTED"
          : codexCheck.reason === "missing"
            ? "CODEX_NOT_INSTALLED"
            : "CODEX_LOGIN_FAILED",
      message,
      cause: codexCheck.cause,
    });
  }

  return {
    data: {
      healthy: issues.length === 0,
      issues,
      codexDir: args.codexDir,
      liveState: drift,
      auth: authState,
    },
    warnings: issues.length === 0 ? [] : [`doctor found ${issues.length} issue(s)`],
  };
}

function renderConfigIssueMessage(issue: ConfigConsistencyIssue | Record<string, unknown>): string {
  switch (issue.code) {
    case "MODEL_MISSING":
      return "Top-level model is missing from config.toml.";
    case "MODEL_PROVIDER_MISSING":
      return "Top-level model_provider is missing from config.toml.";
    case "MODEL_PROVIDER_SECTION_MISSING":
      return `Model provider section "${issue.modelProvider}" is missing from config.toml.`;
    case "MODEL_PROVIDER_BASE_URL_MISSING":
      return `Model provider section "${issue.modelProvider}" is missing base_url.`;
    case "LEGACY_PROFILE_SELECTOR":
      return `Legacy top-level profile selector "${issue.profile}" is still present.`;
    case "LEGACY_PROFILE_SECTION":
      return `Legacy profile section "${issue.profile}" is still present.`;
    case "LEGACY_MODEL_PROVIDER_ENV_KEY":
      return `Model provider "${issue.modelProvider}" still contains legacy env_key wiring.`;
    case "PROVIDER_BASE_URL_MISMATCH":
      return `Provider "${issue.provider}" baseUrl does not match config.toml model provider "${issue.modelProvider}" base_url.`;
    case "AUTH_JSON_INVALID":
      return String((issue as { message?: string }).message ?? "auth.json is invalid.");
    case "DESTRUCTIVE_REMOVE_BLOCKED":
      return `Provider "${issue.provider}" cannot be removed while "${issue.activeModelProvider}" remains active.`;
    default:
      return String((issue as { code?: string }).code ?? "UNKNOWN_ISSUE");
  }
}
