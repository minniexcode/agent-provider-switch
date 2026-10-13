import { Finding, Reading, ok } from "../domain/report";
import { describeLockOwner, inspectLock, isRecoverableLock, LockState } from "../storage/lock-repo";

/**
 * The shared lock, as a state rather than a verdict.
 *
 * A lock is a fact about the tool home instead of about a target, so it is inspected once outside
 * the target collectors under every scope: reporting it per target would make the issue count
 * depend on how many targets happened to be selected.
 *
 * Busy is a *state*. A live owner means an operation is running, which is normal, and turning that
 * into a fault would mean a background `aps` invocation could make `doctor` report a broken
 * install. Only a lock that cannot be attributed to a running operation is abnormal — that one
 * blocks every write command on both targets, which is why it is reported with its repair.
 *
 * `foreign` counts as busy rather than abnormal: a record naming another host is a legitimate live
 * owner seen from here, and this process has no standing to call it stale.
 */
export function inspectSharedLock(lockPath: string): {
  reading: Reading<"free" | "busy" | "abnormal">;
  finding: Finding | null;
} {
  const state: LockState = inspectLock(lockPath);
  if (state.status === "absent") {
    return { reading: ok("free"), finding: null };
  }
  if (state.status === "live" || state.status === "foreign") {
    return { reading: ok("busy"), finding: null };
  }

  const recoverable = isRecoverableLock(state);
  return {
    reading: ok("abnormal"),
    finding: {
      target: null,
      code: recoverable ? "LOCK_STALE" : "LOCK_ABNORMAL",
      message: recoverable
        ? `A lock is present but its owner is gone: ${describeLockOwner(state)}.`
        : `A lock is present and cannot be attributed to a process: ${describeLockOwner(state)}.`,
      path: lockPath,
      lockStatus: state.status,
      activePid: state.record?.pid ?? null,
      activeOperation: state.record?.operation ?? "unknown",
      activeSince: state.record?.createdAt ?? null,
      activeHost: state.record?.hostname ?? null,
      remedy: recoverable
        ? "The next write command clears it automatically, or run `aps unlock`."
        : "Run `aps unlock --force` only if no agent-provider-switch operation is actually running.",
    },
  };
}

/**
 * Whether anything inside a report value is an `unavailable` reading.
 *
 * Structural rather than per-field, so a reading added to a section is counted without this
 * function being told about it — the alternative is a health field that quietly stops being right
 * the next time the report grows a field.
 */
export function containsUnavailable(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsUnavailable);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.status === "unavailable") {
      return true;
    }
    return Object.values(record).some(containsUnavailable);
  }
  return false;
}
