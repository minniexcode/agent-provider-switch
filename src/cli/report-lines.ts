/**
 * Turning report fields into the lines a human reads.
 *
 * Pure text helpers, shared by the shared renderer in `cli/output.ts` and by the per-target
 * presenters in `commands/target-presenters.ts`. They live here rather than in either of those two
 * because the alternative is a cycle: the renderer selects a presenter, and a presenter that had to
 * import the renderer back would be a module that cannot be loaded first.
 *
 * Nothing here knows which target it is describing. That is the point — these functions take a
 * reading or an issue and return a sentence, so a target's own view is free to be about its own
 * fields while the vocabulary of `Reading` is stated once.
 */

/**
 * The value inside an `ok` reading, or `null` for any of the three other states.
 *
 * The renderer's counterpart to `valueOf()` in the domain: it collapses the tag because a human
 * line has room for one answer. Anything that has to explain *why* a reading did not resolve uses
 * {@link renderReading}.
 */
export function okValue<T>(reading: unknown): T | null {
  const tagged = reading as { status?: string; value?: T } | undefined;
  return tagged?.status === "ok" ? (tagged.value as T) : null;
}

/**
 * Prints one reading the way a human reads it: the value, or the state and its reason.
 *
 * `absent` prints as the word rather than as an empty value, which is the whole point of the
 * vocabulary reaching the terminal: a missing `settings.json` and an unreadable one are different
 * repairs, and both differ from a file that is there and says nothing.
 */
export function renderReading(reading: unknown, render: (value: unknown) => string): string {
  const tagged = reading as { status?: string; value?: unknown; reason?: string } | undefined;
  switch (tagged?.status) {
    case "ok":
      return render(tagged.value);
    case "absent":
      return "absent";
    case "invalid":
      return `invalid (${tagged.reason ?? "unusable"})`;
    case "unavailable":
      return `unavailable (${tagged.reason ?? "could not be read"})`;
    default:
      return "not reported";
  }
}

/**
 * A count reading, where the distinction between a real zero and an unobtainable count matters.
 */
export function renderCountReading(reading: unknown): string {
  return renderReading(reading, (value) => `${String(value)}`);
}

/**
 * The health line, which has three outcomes and prints all three apart.
 */
export function renderHealth(healthy: unknown, complete: unknown): string {
  if (healthy === false) {
    return "unhealthy";
  }
  if (healthy === true) {
    return "healthy";
  }
  return `unknown (report ${complete === false ? "incomplete" : "complete"})`;
}

/**
 * Turns structured doctor issue codes into repair-oriented next steps.
 *
 * Shared rather than per target, because the codes are: `PROVIDERS_PARSE_ERROR` is raised by both
 * targets, and the sentence has to be the same for the same condition whichever section raised it.
 */
export function renderDoctorIssueNextStep(issue: Record<string, unknown>): string {
  switch (issue.code) {
    // Absence is not one of the branches here. A missing registry, a missing `config.toml`, and a
    // missing `settings.json` are states the report carries in its readings, so no issue is raised
    // for them and a case for one would be unreachable — the "create the file" advice belongs to
    // the reading, not to an issue that never fires.
    case "CLAUDE_SETTINGS_INVALID":
      return "repair settings.json by hand, or repair the record it matches with `aps edit --claude <name>`";
    case "CLAUDE_DEFAULTS_INVALID":
      return "fix or remove `claudeDefaults` in agent-provider-switch.json";
    case "SHARED_CONFIG_INVALID":
      return "repair agent-provider-switch.json, or restore it with `aps rollback`";
    case "PROVIDERS_PARSE_ERROR":
    case "CONFIG_PARSE_ERROR":
      return "repair the file the issue names, or restore it with `aps rollback`";
    case "AUTH_JSON_INVALID":
      return "repair auth.json, or run `aps switch <provider>` to rewrite it from the registry";
    case "INVALID_CONFIG":
      return "fix the stored record the issue names; `aps show --claude <name>` prints its resolved settings";
    case "LEGACY_PROFILE_SELECTOR":
    case "LEGACY_PROFILE_SECTION":
    case "LEGACY_MODEL_PROVIDER_ENV_KEY":
      return "rerun `aps switch <provider>` to project top-level model/model_provider and remove legacy fields";
    case "PROVIDER_BASE_URL_MISMATCH":
      return "rerun `aps edit <provider> --base-url <url>` or `aps switch <provider>` to repair the runtime projection";
    case "LOCK_STALE":
      return "the next write command clears it automatically, or run `aps unlock`";
    case "LOCK_ABNORMAL":
      return "inspect the lock file the issue names, then run `aps unlock --force`";
    default:
      return "inspect the issue details and rerun `aps doctor` after fixing the state";
  }
}

/**
 * Collapses dotted settings paths into a one-line summary: `env.A` and `env.B` become `env(2)`,
 * and a top-level key that is itself the path stays a bare name.
 */
export function summarizeInheritedPaths(paths: string[]): string {
  const groups = new Map<string, number>();
  const bare = new Set<string>();
  for (const settingsPath of [...paths].sort()) {
    const [head, ...rest] = settingsPath.split(".");
    if (rest.length === 0) {
      bare.add(head);
    }
    groups.set(head, (groups.get(head) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([head, count]) => (bare.has(head) && count === 1 ? head : `${head}(${count})`))
    .join(", ");
}
