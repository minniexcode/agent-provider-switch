import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cliError, normalizeError } from "../domain/errors";
import { ensureDir } from "./fs-utils";

/**
 * Metadata written into the lock file for diagnostics.
 *
 * `hostname` is absent from records written before it was introduced, so every reader
 * must tolerate its absence rather than treat it as a foreign machine.
 */
export type LockRecord = {
  pid: number;
  operation: string;
  createdAt: string;
  hostname?: string;
};

/**
 * How the current lock file reads. `live`, `dead`, `unreadable` and `malformed` are the
 * four states a present record can be in; `foreign` is a record another machine wrote.
 */
export type LockStatus = "absent" | "live" | "dead" | "unreadable" | "malformed" | "foreign";

/**
 * The observed lock state plus the record it was derived from, when one parsed.
 */
export type LockState = {
  status: LockStatus;
  record: LockRecord | null;
};

/**
 * Executes a mutation while holding an exclusive agent-provider-switch lock file.
 *
 * Returns the mutation's value alongside any warnings raised while taking the lock, so a
 * takeover is reported in the command's structured result rather than only on disk.
 */
export function withCodexLock<T>(
  lockPath: string,
  operation: string,
  run: () => T
): { value: T; warnings: string[] } {
  const { warnings } = acquireLock(lockPath, operation);
  try {
    return { value: run(), warnings };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Acquires the lock file, taking over a record whose owner is provably gone.
 */
export function acquireLock(lockPath: string, operation: string): { warnings: string[] } {
  try {
    writeLockRecord(lockPath, operation);
    return { warnings: [] };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      // Only EEXIST means another writer holds the lock. EACCES, EROFS, ENOSPC and ENOENT
      // are I/O failures, and reporting those as "another operation is already running"
      // sends the user to a remedy that cannot work.
      throw cliError("LOCK_IO_FAILED", "Could not create the agent-provider-switch lock file.", {
        file: lockPath,
        cause: normalizeError(error).message,
      });
    }
  }

  const observed = inspectLock(lockPath);
  if (!isRecoverableLock(observed)) {
    throw cliError("LOCK_CONFLICT", "Another agent-provider-switch write operation is already running.", {
      file: lockPath,
      activeOperation: observed.record?.operation ?? "unknown",
      activePid: observed.record?.pid ?? null,
      activeSince: observed.record?.createdAt ?? null,
      activeHost: observed.record?.hostname ?? os.hostname(),
      activeFor: formatLockAge(observed.record?.createdAt),
      requestedOperation: operation,
      // Both cases fail closed, and both have the same way out. A pid recycled onto an
      // unrelated live process resolves as alive forever, and a record from another host
      // cannot be probed here at all, so the user is told about the escape hatch rather
      // than left to read the source.
      note:
        observed.status === "foreign"
          ? "This lock was created on a different host, so its owner cannot be verified here."
          : "If the recorded process is a recycled pid, no agent-provider-switch operation is actually running.",
      remedy: "Run `aps unlock --force` to clear it.",
    });
  }

  claimLock(lockPath, operation, observed);
  return { warnings: [describeTakeover(observed)] };
}

/**
 * Takes over a recoverable lock using verify-then-claim.
 *
 * The record is re-read immediately before it is removed and compared against what was
 * verified. If either field moved, another process took over first and this one backs off,
 * so the loser of that race receives LOCK_CONFLICT instead of two writers proceeding.
 */
function claimLock(lockPath: string, operation: string, observed: LockState): void {
  const current = readLockRecord(lockPath);
  const verified = observed.record;
  if (verified && (current?.pid !== verified.pid || current?.createdAt !== verified.createdAt)) {
    throw cliError("LOCK_CONFLICT", "Another agent-provider-switch write operation took over the lock first.", {
      file: lockPath,
      activePid: current?.pid ?? null,
      requestedOperation: operation,
      remedy: "Retry the command.",
    });
  }

  try {
    fs.rmSync(lockPath, { force: true });
    writeLockRecord(lockPath, operation);
  } catch (error: unknown) {
    // A failed takeover is never followed by a mutation: the caller sees an error instead.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw cliError("LOCK_CONFLICT", "Another agent-provider-switch write operation is already running.", {
        file: lockPath,
        requestedOperation: operation,
        remedy: "Retry the command.",
      });
    }

    throw cliError("LOCK_IO_FAILED", "Could not take over the agent-provider-switch lock file.", {
      file: lockPath,
      cause: normalizeError(error).message,
    });
  }
}

/**
 * Removes the lock file, but only when this process owns the record.
 *
 * Deleting whatever is at the path is harmless only while the holder is the sole process
 * able to reach this function. Once takeover exists it is a correctness bug: a process that
 * read a stale record would delete the lock a different process had just claimed, and both
 * would then mutate.
 */
export function releaseLock(lockPath: string): void {
  const record = readLockRecord(lockPath);
  if (!record || record.pid !== process.pid) {
    // An unreadable or foreign record cannot be proven to be ours. Leaving it behind is
    // safe: the next mutation reads it as recoverable and takes it over.
    return;
  }

  fs.rmSync(lockPath, { force: true });
}

/**
 * Reads the lock file's record, or null when it is missing or does not parse.
 */
export function readLockRecord(lockPath: string): LockRecord | null {
  if (!fs.existsSync(lockPath)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Classifies the current lock file into one of the states the recovery paths act on.
 */
export function inspectLock(lockPath: string): LockState {
  if (!fs.existsSync(lockPath)) {
    return { status: "absent", record: null };
  }

  const record = readLockRecord(lockPath);
  if (!record) {
    // A record that exists but does not parse is the residue of a hard kill, not an
    // unknown owner. Treating it as unrecoverable would leave the permanent lockout this
    // feature exists to remove, in exactly the situation most likely to produce it.
    return { status: "unreadable", record: null };
  }

  if (typeof record.hostname === "string" && record.hostname !== "" && record.hostname !== os.hostname()) {
    return { status: "foreign", record };
  }

  if (!isValidPid(record.pid)) {
    // Never probed. process.kill(0, 0) does not throw, so a zero pid would read as alive,
    // and non-integer pids throw ERR_INVALID_ARG_TYPE rather than an errno we can classify.
    return { status: "malformed", record };
  }

  return { status: isProcessAlive(record.pid) ? "live" : "dead", record };
}

/**
 * Reports whether a present lock may be taken over without `--force`.
 */
export function isRecoverableLock(state: LockState): boolean {
  return state.status === "dead" || state.status === "unreadable" || state.status === "malformed";
}

/**
 * Formats how long ago a lock was created, for human-facing reports.
 */
export function formatLockAge(createdAt: string | undefined): string {
  if (!createdAt) {
    return "unknown";
  }

  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) {
    return "unknown";
  }

  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

/**
 * Describes the owner of a present lock as a single human-readable line.
 */
export function describeLockOwner(state: LockState): string {
  if (state.status === "unreadable") {
    return "an unreadable record";
  }

  const record = state.record;
  if (!record) {
    return "an unknown owner";
  }

  const parts = [
    `pid ${String(record.pid)}`,
    `operation "${String(record.operation)}"`,
    `started ${String(record.createdAt)}`,
    `age ${formatLockAge(record.createdAt)}`,
  ];
  if (record.hostname) {
    parts.push(`host ${record.hostname}`);
  }
  return parts.join(", ");
}

/**
 * Writes a fresh lock record with exclusive-create semantics.
 */
function writeLockRecord(lockPath: string, operation: string): void {
  ensureDir(path.dirname(lockPath));

  const payload: LockRecord = {
    pid: process.pid,
    operation,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
  };

  fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

/**
 * Probes whether a pid belongs to a running process.
 *
 * EPERM means the pid exists but belongs to another user. That is not distinguishable from
 * a live operation of ours, so it reads as alive: a false "alive" is a recoverable
 * annoyance, while a false "dead" puts two writers on the same files.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reports whether a recorded pid could have been written by a running agent-provider-switch process.
 */
function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/**
 * Describes a takeover for the command's warning channel.
 */
function describeTakeover(state: LockState): string {
  if (state.status === "unreadable") {
    return "Cleared an unreadable agent-provider-switch lock left behind by a process that was killed mid-write.";
  }

  if (state.status === "malformed") {
    return `Cleared a malformed agent-provider-switch lock (recorded pid ${JSON.stringify(state.record?.pid ?? null)}).`;
  }

  return `Took over a stale agent-provider-switch lock: ${describeLockOwner(state)}.`;
}
