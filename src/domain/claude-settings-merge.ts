import { isDeepStrictEqual } from "node:util";

type Settings = Record<string, unknown>;

/**
 * Pure helpers for layering a provider's stored settings over the shared Claude defaults.
 *
 * The stored record is a delta; `switch` expands it. Everything here is data in, data out: inputs
 * are never mutated, and every returned object is fresh, so a caller can hand the result to a
 * writer without aliasing the defaults it came from.
 *
 * The one merge rule: recursive for plain objects, the override wins, arrays and scalars are
 * replaced wholesale, and a `null` override deletes the inherited key. `env` needs no special
 * case — it is a map of scalar leaves, so the recursion merges it key by key.
 *
 * Paths reported by the `collect*` functions are dotted display strings. A key that itself
 * contains a dot makes a path ambiguous; nothing parses them back, so that is cosmetic.
 */

/**
 * Layers `overrides` over `defaults`.
 *
 * An empty object does not clear anything: `{ enabledPlugins: {} }` over a default with entries
 * inherits them, because the merge recurses into it and finds nothing to override. Clearing takes
 * an explicit `null`. The result never contains a `null` object member — a `null` override either
 * deletes a real key or is a no-op — though arrays are copied verbatim.
 */
export function mergeClaudeSettings(
  defaults: Settings | null | undefined,
  overrides: Settings | null | undefined
): Settings {
  const result: Settings = {};
  // Defaults go through the same layering as overrides rather than being cloned wholesale. A
  // `null` default is read as absent — `null` is the deletion marker, and a marker has no
  // business surviving into an effective settings file — and that has to hold for a `null`
  // nested inside a default object too, which a plain deep clone would copy straight through.
  applyLayer(result, defaults);
  applyLayer(result, overrides);
  return result;
}

function applyLayer(target: Settings, layer: Settings | null | undefined): void {
  for (const [key, value] of Object.entries(layer ?? {})) {
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value)) {
      // With nothing to merge into, the object is still recursed through rather than cloned,
      // because it may carry `null` deletions that must not leak out as literal nulls.
      target[key] = mergeClaudeSettings(isPlainObject(target[key]) ? (target[key] as Settings) : null, value);
    } else if (value !== undefined) {
      target[key] = deepClone(value);
    }
  }
}

/**
 * Returns the smallest delta `d` such that `mergeClaudeSettings(defaults, d)` deep-equals
 * `mergeClaudeSettings(defaults, full)`.
 *
 * Entries deep-equal to a default are dropped, which is also what makes a key the defaults set and
 * `full` omits *inherit* — slimming is inheritance-first, not a byte-preserving round trip. The
 * invariant is about what a switch writes, and slimming never changes that.
 *
 * Idempotent: a delta passed back through is returned unchanged. A `null` is kept only where it
 * deletes a real default; dropping that one would make the deleted value reappear.
 */
export function diffClaudeSettings(
  defaults: Settings | null | undefined,
  full: Settings
): Settings {
  const base = defaults ?? {};
  const delta: Settings = {};

  for (const [key, value] of Object.entries(full)) {
    const inherited = base[key];
    const hasDefault = inherited !== null && inherited !== undefined;

    if (value === null) {
      if (hasDefault) {
        delta[key] = null;
      }
    } else if (isPlainObject(value) && isPlainObject(inherited)) {
      const nested = diffClaudeSettings(inherited, value);
      if (Object.keys(nested).length > 0) {
        delta[key] = nested;
      }
    } else if (isPlainObject(value)) {
      // An empty object over an absent default still has to be stored: omitting it would drop
      // the key from the effective settings entirely.
      delta[key] = mergeClaudeSettings(null, value);
    } else if (value !== undefined && !(hasDefault && isDeepStrictEqual(inherited, value))) {
      delta[key] = deepClone(value);
    }
  }

  return delta;
}

/**
 * Lists the dotted paths whose effective value comes from the defaults rather than from the
 * record. Values are never returned, so the list is safe to print next to a masked env.
 *
 * Plain objects are reported by their leaves; an array or an empty object is reported as the path
 * itself. A key the record overrides, or deletes with `null`, is not inherited.
 */
export function collectInheritedPaths(
  defaults: Settings | null | undefined,
  overrides: Settings | null | undefined
): string[] {
  const paths: string[] = [];
  collectInherited(defaults ?? {}, overrides ?? {}, "", paths);
  return paths.sort();
}

function collectInherited(defaults: Settings, overrides: Settings, prefix: string, paths: string[]): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (value === null || value === undefined) {
      continue;
    }

    const path = prefix ? `${prefix}.${key}` : key;
    const override = overrides[key];

    if (override === undefined) {
      pushLeaves(value, path, paths);
    } else if (isPlainObject(value) && isPlainObject(override)) {
      collectInherited(value, override, path, paths);
    }
    // Anything else is an override or a `null` deletion: not inherited.
  }
}

/**
 * Lists the dotted paths in `full` that `diffClaudeSettings` drops because they equal a default.
 * Same shape as {@link collectInheritedPaths}: paths and no values. An empty object that sits over
 * a non-empty default object is reported as its own path, since it contributes no leaves but is
 * still dropped.
 */
export function collectDroppedPaths(
  defaults: Settings | null | undefined,
  full: Settings
): string[] {
  const paths: string[] = [];
  collectDropped(defaults ?? {}, full, "", paths);
  return paths.sort();
}

function collectDropped(defaults: Settings, full: Settings, prefix: string, paths: string[]): void {
  for (const [key, value] of Object.entries(full)) {
    const inherited = defaults[key];
    if (inherited === null || inherited === undefined || value === null || value === undefined) {
      continue;
    }

    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(value) && isPlainObject(inherited)) {
      if (Object.keys(value).length === 0 && Object.keys(inherited).length > 0) {
        paths.push(path);
      } else {
        collectDropped(inherited, value, path, paths);
      }
    } else if (isDeepStrictEqual(inherited, value)) {
      paths.push(path);
    }
  }
}

function pushLeaves(value: unknown, path: string, paths: string[]): void {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== null && nested !== undefined) {
        pushLeaves(nested, `${path}.${key}`, paths);
      }
    }
    return;
  }
  paths.push(path);
}

function isPlainObject(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const copy: Settings = {};
    for (const [key, nested] of Object.entries(value)) {
      copy[key] = deepClone(nested);
    }
    return copy as T;
  }
  return value;
}
