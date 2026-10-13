import type { ConfigConsistencyIssue } from "../domain/config";

/**
 * Turns a config-consistency finding into the sentence a report carries.
 *
 * In `src/app/` rather than in either caller because `status` and `doctor` both publish these
 * findings and they must read identically: the same drift reported two ways would be a bug the
 * user experiences as two different problems.
 *
 * The default arm returns the raw code rather than a generic sentence. A code with no message is a
 * code somebody added without one, and printing it verbatim is what makes that visible instead of
 * hiding it behind "unknown issue".
 */
export function renderConfigIssueMessage(issue: ConfigConsistencyIssue | Record<string, unknown>): string {
  switch (issue.code) {
    case "MODEL_MISSING":
      return "Top-level model is missing from config.toml.";
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
