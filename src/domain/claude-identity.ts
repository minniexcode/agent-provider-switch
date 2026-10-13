/**
 * Provider identity for Claude settings: which registered provider, if any, the live
 * `settings.json` is currently pointed at.
 *
 * One pure module, because this question has five askers — `current`, `list`, `show`, `doctor`,
 * `status` — plus the interactive active markers, and before `1.1.3` each of them either re-derived
 * the answer or read the same partial one. `claudeSettingsMatch()` was that partial answer: it
 * compared the address and the model routing and nothing else, so two providers that differ only in
 * the credential they authenticate with were indistinguishable, and every caller picked the first
 * match it found.
 *
 * Two questions, deliberately separate:
 *
 * - **Identity** — `matchClaudeProviders()`. "Which provider is this?" Answered from the paths in
 *   {@link IDENTITY_PATHS}: the address, the model routing, and the configured authentication.
 * - **Full consistency** — {@link compareSettings}. "Is the live file exactly what `switch` would
 *   write for that provider?" Answered over the whole document.
 *
 * A unique identity with differences is still *managed*: drift in a permission or a plugin list is
 * not a different provider. Several identities stay *ambiguous* even when one of them matches
 * completely, because the credential is what tells two routes apart and nothing here may silently
 * collapse them.
 */

/**
 * The settings paths that make up provider identity, as dotted paths into the settings document.
 *
 * Three dimensions, and the authentication one is what `1.1.3` adds: a user with two API keys for
 * the same gateway and the same models switches between two providers, and an identity that
 * ignored the key would report whichever record sorted first.
 *
 * `apiKeyHelper` is a top-level path rather than an `env` member, which is why the table is a list
 * of paths rather than three separate field lists.
 */
export const IDENTITY_PATHS: readonly string[] = [
  "model",
  "env.ANTHROPIC_BASE_URL",
  "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
  "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
  "env.ANTHROPIC_AUTH_TOKEN",
  "env.ANTHROPIC_API_KEY",
  "apiKeyHelper",
];

/**
 * The answer to "what is at this identity path", with absence distinguishable from a stored null.
 *
 * A sentinel rather than `null`, because `{"ANTHROPIC_API_KEY": null}` and an absent
 * `ANTHROPIC_API_KEY` are different settings: with no defaults block a null is ordinary data that
 * `switch` writes verbatim, and a comparison that folded the two together would call a provider
 * managed when the live file says something else about that key.
 */
export type IdentityValue =
  | { present: false }
  | { present: true; value: unknown };

const ABSENT: IdentityValue = { present: false };

/**
 * Reads one dotted path, or reports that the path is not there.
 *
 * A null member on the way counts as absent rather than as a value: `{"env": null}` has no
 * `env.ANTHROPIC_BASE_URL` to read, whatever the intent behind the null was. Every segment must be
 * a plain object; a string or an array on the way is a malformed document, and this function's
 * answer for it is absence, not a value — the field-level fault belongs to the validation that runs
 * before matching, which reports it as an issue rather than as a silent non-match.
 */
export function readIdentityValue(settings: Record<string, unknown>, settingsPath: string): IdentityValue {
  let current: unknown = settings;
  for (const segment of settingsPath.split(".")) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return ABSENT;
    }
    current = current[segment];
    if (current === null) {
      return ABSENT;
    }
  }
  return { present: true, value: current };
}

/**
 * Reports whether two settings documents describe the same provider.
 *
 * Presence is compared as strictly as the value is: a provider that declares
 * `ANTHROPIC_AUTH_TOKEN` does not match a live file that omits it, and neither matches one that
 * carries a different token. Values are compared exactly — no trailing-slash folding, no model
 * alias resolution, no `apiKeyHelper` execution — because every normalisation here would be a
 * guess about a service this tool does not call.
 *
 * Secrets are compared in memory and never leave this function: the caller receives a boolean.
 */
export function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const settingsPath of IDENTITY_PATHS) {
    const left = readIdentityValue(a, settingsPath);
    const right = readIdentityValue(b, settingsPath);
    if (left.present !== right.present) {
      return false;
    }
    if (left.present && right.present && left.value !== right.value) {
      return false;
    }
  }
  return true;
}

/**
 * The result of comparing a live settings document with one provider's effective settings.
 */
export type SettingsComparison = {
  consistent: boolean;
  /** Dotted paths where the two differ, with array indices; ordered, and never carrying values. */
  differencePaths: string[];
};

/**
 * Compares two settings documents structurally.
 *
 * Object key order is irrelevant — `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same settings — and
 * array order is not, because an array is a value the user wrote rather than a set. Only the paths
 * are returned: a difference path can name `env.ANTHROPIC_AUTH_TOKEN`, and a diff that carried the
 * two values would print a credential into a diagnostic report.
 *
 * A missing key is reported at the parent's path plus the key, and a length difference is reported
 * at the array's own path rather than one entry per surplus element — the count is what changed,
 * and enumerating indices `[3]`, `[4]`, `[5]` says it three times.
 */
export function compareSettings(
  live: Record<string, unknown>,
  effective: Record<string, unknown>
): SettingsComparison {
  const differencePaths: string[] = [];
  diffValue(live, effective, "", differencePaths);
  return { consistent: differencePaths.length === 0, differencePaths };
}

function diffValue(left: unknown, right: unknown, at: string, out: string[]): void {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      out.push(at);
      return;
    }
    if (left.length !== right.length) {
      out.push(at);
      return;
    }
    for (let index = 0; index < left.length; index += 1) {
      diffValue(left[index], right[index], `${at}[${index}]`, out);
    }
    return;
  }

  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      out.push(at);
      return;
    }
    // Sorted, so the reported paths do not depend on the order the two documents happened to be
    // written in — the same reason key order does not affect equality.
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const childPath = at === "" ? key : `${at}.${key}`;
      const leftHas = Object.prototype.hasOwnProperty.call(left, key);
      const rightHas = Object.prototype.hasOwnProperty.call(right, key);
      if (!leftHas || !rightHas) {
        out.push(childPath);
        continue;
      }
      diffValue(left[key], right[key], childPath, out);
    }
    return;
  }

  if (!Object.is(left, right)) {
    out.push(at);
  }
}

/**
 * One provider that matches the live settings on identity.
 */
export type ProviderMatchCandidate = {
  name: string;
  /** Whether the whole document matches, not just the identity paths. */
  consistent: boolean;
  differencePaths: string[];
};

/**
 * The shared answer to "what is the live settings file pointed at".
 *
 * `not-activated` is the absent-file case and is a state rather than a finding: a target that has
 * never been switched to has no active provider to name. The other three are the three answers the
 * identity comparison can give, and `activeProvider` is non-null for exactly one of them — which is
 * what lets a caller branch on the state instead of on a name that may be a guess.
 */
export type ProviderMatch = {
  state: "not-activated" | "unmanaged" | "managed" | "ambiguous";
  activeProvider: string | null;
  candidates: ProviderMatchCandidate[];
};

/**
 * Matches live settings against every registered provider's effective settings.
 *
 * The candidate set is built by filtering, never by `.find()`: a first-match winner would report
 * one of two identical-identity providers as *the* active one, and the user reading `list` would
 * believe the other one is not in play. Several candidates stay ambiguous and every one of them is
 * reported with its own full-consistency answer.
 *
 * `live` is `null` only when there is no live settings document to compare — an absent file. A file
 * that exists but could not be read is not this function's input: its reader reports `invalid`, and
 * a caller that passed the unreadable document on would be asserting an identity it never
 * established.
 */
export function matchClaudeProviders(args: {
  live: Record<string, unknown> | null;
  providers: Record<string, Record<string, unknown>>;
}): ProviderMatch {
  if (args.live === null) {
    return { state: "not-activated", activeProvider: null, candidates: [] };
  }

  const candidates: ProviderMatchCandidate[] = [];
  // Sorted, so the candidate list is stable across runs and across the key order on disk.
  for (const name of Object.keys(args.providers).sort()) {
    const effective = args.providers[name];
    if (!sameIdentity(effective, args.live)) {
      continue;
    }
    const comparison = compareSettings(args.live, effective);
    candidates.push({
      name,
      consistent: comparison.consistent,
      differencePaths: comparison.differencePaths,
    });
  }

  if (candidates.length === 0) {
    return { state: "unmanaged", activeProvider: null, candidates };
  }
  if (candidates.length === 1) {
    return { state: "managed", activeProvider: candidates[0].name, candidates };
  }
  // More than one, and full consistency is not a tie-breaker: a candidate that matches the whole
  // document still proves nothing about which credential the live file is meant to carry.
  return { state: "ambiguous", activeProvider: null, candidates };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
