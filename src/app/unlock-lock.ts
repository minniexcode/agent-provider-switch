import * as fs from "node:fs";
import { cliError } from "../domain/errors";
import { describeLockOwner, formatLockAge, inspectLock, isRecoverableLock } from "../storage/lock-repo";
import { CommandResult } from "./types";

/**
 * Clears a lock left behind by a process that no longer exists.
 *
 * Deliberately does not take the lock to do its job. Acquiring is the thing this command
 * exists to fix, so taking it would make the command unusable in exactly the situation that
 * needs it — and, since the lock is a non-reentrant exclusive create, it would fail against
 * the very file it was asked to clear.
 */
export function unlockLock(args: { lockPath: string; force: boolean }): CommandResult {
  const state = inspectLock(args.lockPath);

  if (state.status === "absent") {
    // Idempotent: nothing to clear is success, not an error. A script that always unlocks
    // before a batch must not fail because the lock was already gone.
    return {
      data: {
        lockPath: args.lockPath,
        removed: false,
        forced: args.force,
        owner: null,
        reason: "no lock file was present",
      },
    };
  }

  if (!args.force && !isRecoverableLock(state)) {
    throw cliError("LOCK_CONFLICT", "The agent-provider-switch lock is held by a process that is still running.", {
      file: args.lockPath,
      owner: describeLockOwner(state),
      activePid: state.record?.pid ?? null,
      activeOperation: state.record?.operation ?? "unknown",
      activeSince: state.record?.createdAt ?? null,
      activeHost: state.record?.hostname ?? null,
      activeFor: formatLockAge(state.record?.createdAt),
      // Both refusals fail closed, and neither is recoverable by waiting, so the escape
      // hatch is named rather than left to be discovered.
      note:
        state.status === "foreign"
          ? "This lock was created on a different host, so its owner cannot be verified here."
          : "If the recorded process is a recycled pid, no agent-provider-switch operation is actually running.",
      remedy: "Run `aps unlock --force` to clear it anyway.",
    });
  }

  fs.rmSync(args.lockPath, { force: true });

  return {
    data: {
      lockPath: args.lockPath,
      removed: true,
      forced: args.force,
      owner: {
        pid: state.record?.pid ?? null,
        operation: state.record?.operation ?? null,
        createdAt: state.record?.createdAt ?? null,
        hostname: state.record?.hostname ?? null,
      },
      reason: args.force
        ? "cleared because --force was given"
        : `cleared because the recorded owner is ${state.status}`,
    },
  };
}
