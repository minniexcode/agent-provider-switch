import type { ProviderMatch } from "./claude-identity";
import type { TargetId } from "./target";

/**
 * The reporting vocabulary `doctor` and `status` publish.
 *
 * The problem this solves is that a report has to say four different things about one field and
 * only had two words to say them with. A Codex `providers.json` that is not there, one that is
 * there and empty, one whose JSON cannot be parsed, and one this process was not allowed to read
 * all used to arrive as some combination of `null`, `0`, and `false` — and a consumer could not
 * tell "no providers" from "could not ask". `null` is not a substitute for any of them.
 *
 * - `ok` — a value was obtained. A successful zero is `ok` with `value: 0`.
 * - `absent` — confirmed nonexistence. The reader established the file is not there, which is a
 *   fact about the installation rather than a failure to read it.
 * - `invalid` — content was obtained and failed validation. The file exists; what is in it cannot
 *   be used. A damaged file's *existence* can still be known while its content is invalid.
 * - `unavailable` — the answer cannot be reliably derived: a read failed, or something the reading
 *   depends on is itself invalid. Nothing is guessed to fill it in.
 */
export type Reading<T> =
  | { status: "ok"; value: T }
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * A finding inside a successful report.
 *
 * Every finding names a target, or `null` for state both targets share — the lock, or the tool
 * config. It is not type-checked against `ErrorCode`: a finding is not an error, it carries no exit
 * code, and `ok: true` with a non-empty `issues` is a normal outcome.
 *
 * The four fields are the contract; the open shape is where each check's own detail goes — the
 * provider names a removal would have matched, the pid and operation a lock was taken under, the
 * dotted paths a record is wrong at. Those are the difference between a report a user can act on
 * and one that names a code, and a closed type would push them into `message` strings.
 */
export type Finding = Record<string, unknown> & {
  code: string;
  target: TargetId | null;
  message: string;
  path?: string;
};

export function ok<T>(value: T): Reading<T> {
  return { status: "ok", value };
}

export function absent<T>(): Reading<T> {
  return { status: "absent" };
}

export function invalid<T>(reason: string): Reading<T> {
  return { status: "invalid", reason };
}

export function unavailable<T>(reason: string): Reading<T> {
  return { status: "unavailable", reason };
}

/**
 * The value inside a reading, or `null` for the three non-`ok` states.
 *
 * For the callers that only need the value and have already dealt with the states. A caller that
 * has to explain *why* a reading is not `ok` should match on the tag instead of collapsing it here.
 */
export function valueOf<T>(reading: Reading<T>): T | null {
  return reading.status === "ok" ? reading.value : null;
}

/**
 * Replaces a reading with `unavailable` when it depends on another one that did not resolve.
 *
 * The dependency rule in one place: a derived reading cannot be more certain than its input, and
 * `unavailable` is the honest answer — never a zero, never an empty object, never a guessed
 * default. `absent` is deliberately *not* propagated: a missing registry is a fact, and a count
 * derived from it is legitimately zero.
 */
export function dependsOn<T, D>(
  dependency: Reading<D>,
  reading: Reading<T>,
  what: string
): Reading<T> {
  if (reading.status !== "ok") {
    return reading;
  }
  if (dependency.status === "invalid") {
    return unavailable<T>(`${what} could not be read: ${dependency.reason}`);
  }
  if (dependency.status === "unavailable") {
    return unavailable<T>(`${what} could not be read: ${dependency.reason}`);
  }
  return reading;
}

/**
 * One target's section of a report.
 *
 * Every field is a reading, so a consumer asks the same question of each one and gets one of the
 * same four answers. `matching` is the shared identity result from `claude-identity.ts`; for Codex
 * it carries the same meanings, and a Codex-specific projection reading is added beside it rather
 * than folded into it.
 */
export type TargetReport = {
  configured: Reading<boolean>;
  paths: Reading<Record<string, string>>;
  registry: Reading<{ providerCount: number }>;
  live: Reading<{ present: true }>;
  activation: Reading<"not-activated" | "activated">;
  defaults: Reading<{ present: boolean }>;
  providerCount: Reading<number>;
  inheritance: Reading<Record<string, number>>;
  matching: Reading<ProviderMatch>;
};

/**
 * A complete `doctor` or `status` report.
 *
 * `healthy` is three-valued, and the third value is the point: `null` means the health-relevant
 * checks could not be completed *and* nothing known is wrong. A report that answered `true` there
 * would be certifying a target it never managed to inspect.
 */
export type Report = {
  toolHomeRoot: string;
  complete: boolean;
  healthy: boolean | null;
  issues: Finding[];
  notes: Finding[];
  shared: {
    toolConfig: Reading<{ defaultsPresent: boolean }>;
    lock: Reading<"free" | "busy" | "abnormal">;
  };
  codex?: TargetReport;
  claude?: TargetReport;
};
