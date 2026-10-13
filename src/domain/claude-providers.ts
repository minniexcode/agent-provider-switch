import { collectOrphanedDeletions, mergeClaudeSettings } from "./claude-settings-merge";
/**
 * Claude Code provider definition stored in claude-providers.json.
 */
export type ClaudeProviderRecord = {
  settings: Record<string, unknown>;
  note?: string;
  tags?: string[];
};

/**
 * The shared default settings every Claude provider inherits, stored in the tool config.
 *
 * The inner shape mirrors a provider record on purpose, so resolving a record is the symmetric
 * `merge(defaults.settings, record.settings)` and a future target-level field (a note, tags) has
 * somewhere to live without reshaping the block.
 */
export type ClaudeDefaults = {
  settings: Record<string, unknown>;
};

/**
 * Root claude-providers.json document shape.
 */
export type ClaudeProvidersFile = {
  providers: Record<string, ClaudeProviderRecord>;
};

/**
 * A provider record together with the settings `switch` would write for it.
 *
 * `effective` is a separate field, never a replacement for `settings`, and that is load-bearing.
 * The stored record is a delta, and `remove` reads the whole file, deletes one key, and writes it
 * back: if the reader overwrote `settings` with the merged result, removing one provider would
 * silently expand the defaults into every survivor. A reader that serves a write must stay raw;
 * only read-only services take this type.
 */
export type ResolvedClaudeProviderRecord = ClaudeProviderRecord & {
  effective: Record<string, unknown>;
};

/**
 * Resolves one stored record against the shared defaults.
 *
 * With no defaults block nothing is merged and the record is copied verbatim. That is stricter than
 * merging over an empty object, which would also strip explicit `null` members — a deletion marker
 * once a block exists, but plain data in a record imported before one did. Without this rule,
 * upgrading would change what `switch` writes for a user who never opted in.
 */
export function resolveClaudeProviderRecord(
  record: ClaudeProviderRecord,
  defaults: Record<string, unknown> | null
): ResolvedClaudeProviderRecord {
  return {
    ...record,
    effective: defaults === null ? JSON.parse(JSON.stringify(record.settings)) : mergeClaudeSettings(defaults, record.settings),
  };
}

/**
 * Resolves every record in a providers file, for the read-only list and current services.
 */
export function resolveClaudeProvidersFile(
  file: ClaudeProvidersFile,
  defaults: Record<string, unknown> | null
): { providers: Record<string, ResolvedClaudeProviderRecord> } {
  const providers: Record<string, ResolvedClaudeProviderRecord> = {};
  for (const [name, record] of Object.entries(file.providers)) {
    providers[name] = resolveClaudeProviderRecord(record, defaults);
  }
  return { providers };
}

/**
 * Validates and normalizes unknown JSON into the claude-providers.json domain model.
 */
export function validateClaudeProvidersShape(input: unknown): ClaudeProvidersFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Root value must be an object.");
  }

  const providersValue = (input as { providers?: unknown }).providers;
  if (!providersValue || typeof providersValue !== "object" || Array.isArray(providersValue)) {
    throw new Error('Missing or invalid "providers" object.');
  }

  const providers: Record<string, ClaudeProviderRecord> = {};
  for (const [name, value] of Object.entries(providersValue)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Claude provider "${name}" must be an object.`);
    }

    const provider = value as Record<string, unknown>;
    if (!provider.settings || typeof provider.settings !== "object" || Array.isArray(provider.settings)) {
      throw new Error(`Claude provider "${name}" is missing a valid settings object.`);
    }
    if (provider.note !== undefined && typeof provider.note !== "string") {
      throw new Error(`Claude provider "${name}" has an invalid note.`);
    }
    if (
      provider.tags !== undefined &&
      (!Array.isArray(provider.tags) || provider.tags.some((tag) => typeof tag !== "string"))
    ) {
      throw new Error(`Claude provider "${name}" has invalid tags.`);
    }

    providers[name] = cleanClaudeProviderRecord({
      settings: provider.settings as Record<string, unknown>,
      note: provider.note as string | undefined,
      tags: provider.tags as string[] | undefined,
    });
  }

  return { providers };
}

/**
 * Trims optional fields and removes empty values from a Claude provider record.
 */
export function cleanClaudeProviderRecord(record: ClaudeProviderRecord): ClaudeProviderRecord {
  const next: ClaudeProviderRecord = {
    settings: record.settings,
  };

  if (record.note && record.note.trim() !== "") {
    next.note = record.note.trim();
  }
  if (record.tags && record.tags.length > 0) {
    next.tags = record.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  }

  return next;
}

/**
 * Returns a copy of the Claude providers file with provider names sorted deterministically.
 */
export function sortClaudeProviders(providers: ClaudeProvidersFile): ClaudeProvidersFile {
  const orderedProviders = Object.keys(providers.providers)
    .sort()
    .reduce<Record<string, ClaudeProviderRecord>>((accumulator, key) => {
      accumulator[key] = providers.providers[key];
      return accumulator;
    }, {});

  return { providers: orderedProviders };
}

/**
 * Extracts a human-readable summary from Claude settings for display.
 */
export function summarizeClaudeSettings(settings: Record<string, unknown>): {
  model: string | null;
  baseUrl: string | null;
  theme: string | null;
} {
  const env = settings.env as Record<string, string> | undefined;
  return {
    model: (settings.model as string) ?? null,
    baseUrl: env?.ANTHROPIC_BASE_URL ?? null,
    theme: (settings.theme as string) ?? null,
  };
}

/**
 * A finding about one stored Claude provider record.
 *
 * An *issue*, not an error: it describes a record that was read successfully and shapes a finding
 * inside a successful `doctor` run. It carries no exit code and is not part of the `ErrorCode`
 * vocabulary.
 */
export type ClaudeRecordIssue = {
  code: "INVALID_CONFIG";
  provider: string;
  message: string;
  paths?: string[];
};

/**
 * Finds the stored records that would write a settings file Claude Code cannot use.
 *
 * One class, and only this one: **a field the tool itself reads has the wrong type.**
 * `validateClaudeProvidersShape()` accepts any object as `settings`, so `env` or `model` can be a
 * string or an array. The merge is total and would copy it verbatim, so `switch` would write it
 * into `settings.json` and Claude Code would then read a shape it cannot use. These two are checked
 * because they are the two the tool reads and writes; an unknown key is the user's business.
 *
 * **Checked against the effective settings, not the stored delta.** What `switch` writes is
 * `resolveClaudeProviderRecord()`, so a stored member the merge deletes — `{"env": null}` over a
 * defaults block that sets `env` — cannot be a bad type in the file the user ends up with. A
 * `null` member is skipped outright: with a defaults block it is the deletion marker, and with no
 * block it is plain data the record-writes-verbatim rule preserves on purpose.
 *
 * A record that merely overrides an inherited value is not reported: that is the normal case and
 * the reason the record is a delta at all.
 *
 * A deletion marker that deletes nothing is *not* here. It is a note, not an issue — see
 * {@link collectClaudeRecordNotes}.
 */
export function collectClaudeRecordIssues(
  file: ClaudeProvidersFile,
  defaults: Record<string, unknown> | null
): ClaudeRecordIssue[] {
  const issues: ClaudeRecordIssue[] = [];

  for (const name of Object.keys(file.providers).sort()) {
    const effective = resolveClaudeProviderRecord(file.providers[name], defaults).effective;

    if (effective.env !== undefined && effective.env !== null && !isPlainObject(effective.env)) {
      issues.push({
        code: "INVALID_CONFIG",
        provider: name,
        paths: ["env"],
        message: `Claude provider "${name}" has a non-object env; switching to it would write that value verbatim.`,
      });
    }
    if (effective.model !== undefined && effective.model !== null && typeof effective.model !== "string") {
      issues.push({
        code: "INVALID_CONFIG",
        provider: name,
        paths: ["model"],
        message: `Claude provider "${name}" has a non-string model; switching to it would write that value verbatim.`,
      });
    }
  }

  return issues;
}

/**
 * A finding about a stored Claude provider record that is worth telling the user and is not a fault.
 *
 * A *note*, not an issue: it does not make `doctor` report the run as unhealthy, and it carries no
 * `INVALID_CONFIG`. The condition is real — the stored record carries something that does nothing —
 * but nothing is broken, so failing the run over it would be a false alarm.
 */
export type ClaudeRecordNote = {
  code: "REDUNDANT_DELETION_MARKER";
  provider: string;
  paths: string[];
  message: string;
};

/**
 * Finds the stored records carrying a deletion marker that deletes nothing.
 *
 * A record's `null` is an instruction about the defaults block, so it goes stale when the block
 * changes. The user's intent is still satisfied — the key is absent from the effective settings
 * either way, which is what they asked for — so this is not a fault and must not fail the run.
 * What it is worth saying is that the marker now does nothing where it is read, and that
 * `config compact --claude` will drop it: compacting keeps a `null` only where it deletes a real
 * default.
 *
 * Reported only when a defaults block exists. With none, a `null` in a record is not a deletion
 * marker at all — it is plain data preserved verbatim, and reporting it would be a finding about
 * the record's storage rather than about anything that changed.
 */
export function collectClaudeRecordNotes(
  file: ClaudeProvidersFile,
  defaults: Record<string, unknown> | null
): ClaudeRecordNote[] {
  if (defaults === null) {
    return [];
  }

  const notes: ClaudeRecordNote[] = [];
  for (const name of Object.keys(file.providers).sort()) {
    const orphaned = collectOrphanedDeletions(defaults, file.providers[name].settings);
    if (orphaned.length === 0) {
      continue;
    }

    notes.push({
      code: "REDUNDANT_DELETION_MARKER",
      provider: name,
      paths: orphaned,
      message:
        `Claude provider "${name}" deletes ${orphaned.join(", ")}, which the shared defaults no longer set. ` +
        `The key stays absent either way, so nothing is wrong; run \`config compact --claude\` to drop the marker.`,
    });
  }

  return notes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares two Claude settings objects for identity (based on env + model fields).
 */
export function claudeSettingsMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const envA = a.env as Record<string, string> | undefined;
  const envB = b.env as Record<string, string> | undefined;
  if ((a.model ?? null) !== (b.model ?? null)) {
    return false;
  }
  const baseUrlA = envA?.ANTHROPIC_BASE_URL ?? null;
  const baseUrlB = envB?.ANTHROPIC_BASE_URL ?? null;
  if (baseUrlA !== baseUrlB) {
    return false;
  }
  const haikuA = envA?.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null;
  const haikuB = envB?.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null;
  if (haikuA !== haikuB) {
    return false;
  }
  const sonnetA = envA?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null;
  const sonnetB = envB?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null;
  if (sonnetA !== sonnetB) {
    return false;
  }
  const opusA = envA?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null;
  const opusB = envB?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null;
  if (opusA !== opusB) {
    return false;
  }
  return true;
}
