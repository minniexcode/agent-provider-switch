"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./helpers");
const { writeTextFileAtomic } = require("../dist/storage/fs-utils");

/**
 * Replaces a property on the shared `node:fs` object for the duration of `body`, then restores it.
 *
 * This is the only interception point available: the built module calls `fs.renameSync(...)` as a
 * property access on the module object, so patching that object reaches it. Nothing else in the
 * process runs concurrently, since the harness is synchronous.
 *
 * The replacement is handed the original as `real`, because the property it is shadowing is how it
 * would otherwise reach it — calling `fs.renameSync` from inside the replacement recurses.
 */
function withPatchedFs(name, replacement, body) {
  const original = fs[name];
  fs[name] = replacement(original);
  try {
    return body();
  } finally {
    fs[name] = original;
  }
}

/**
 * Forces the Windows branch of the rename. `writeTextFileAtomic` also skips `chmod` on win32,
 * which the POSIX suite asserts elsewhere — those assertions are unaffected because this override
 * is scoped to one patched call.
 */
function withPlatform(platform, body) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

module.exports = {
  name: "atomic writes",
  tests: [
    {
      name: "a rename held open by another process is retried and succeeds",
      run() {
        const directory = makeTempDir("agent-provider-switch-atomic-");
        const target = path.join(directory, "config.toml");

        withPlatform("win32", () => {
          let attempts = 0;
          withPatchedFs(
            "renameSync",
            (real) =>
              (from, to) => {
                attempts += 1;
                // Two failures is the shape of the live incident: a scanner released the handle on
                // its own within a few milliseconds.
                if (attempts <= 2) {
                  const error = new Error("EPERM: operation not permitted, rename");
                  error.code = "EPERM";
                  throw error;
                }
                return real(from, to);
              },
            () => writeTextFileAtomic(target, 'model_provider = "gamma"\n')
          );

          assert.equal(attempts, 3, "the write must retry rather than fail on the first EPERM");
        });

        assert.equal(fs.readFileSync(target, "utf8"), 'model_provider = "gamma"\n');
      },
    },
    {
      name: "a permanent renaming failure is reported after the retries are exhausted",
      run() {
        const directory = makeTempDir("agent-provider-switch-atomic-");
        const target = path.join(directory, "config.toml");
        fs.writeFileSync(target, "original\n", "utf8");

        withPlatform("win32", () => {
          let attempts = 0;
          assert.throws(
            () =>
              withPatchedFs(
                "renameSync",
                () => () => {
                  attempts += 1;
                  const error = new Error("EPERM: operation not permitted, rename");
                  error.code = "EPERM";
                  throw error;
                },
                () => writeTextFileAtomic(target, "replaced\n")
              ),
            /EPERM/
          );

          // Bounded, not a loop that waits forever: five delays (0/20/40/80/160) and no more.
          assert.equal(attempts, 5, "the retry budget must be bounded");
        });

        // The destination is untouched, which is the property the atomic write exists to provide:
        // a failed write leaves the previous contents readable rather than truncated.
        assert.equal(fs.readFileSync(target, "utf8"), "original\n");
      },
    },
    {
      name: "an error that is not a transient rename failure is not retried",
      run() {
        const directory = makeTempDir("agent-provider-switch-atomic-");
        const target = path.join(directory, "config.toml");

        withPlatform("win32", () => {
          let attempts = 0;
          assert.throws(
            () =>
              withPatchedFs(
                "renameSync",
                () => () => {
                  attempts += 1;
                  const error = new Error("EXDEV: cross-device link not permitted, rename");
                  error.code = "EXDEV";
                  throw error;
                },
                () => writeTextFileAtomic(target, "contents\n")
              ),
            /EXDEV/
          );

          // A cross-device rename can never succeed on retry, so retrying it would only add delay
          // to a failure that is already certain.
          assert.equal(attempts, 1);
        });
      },
    },
    {
      name: "the happy path renames exactly once",
      run() {
        const directory = makeTempDir("agent-provider-switch-atomic-");
        const target = path.join(directory, "config.toml");

        let attempts = 0;
        withPlatform("win32", () =>
          withPatchedFs(
            "renameSync",
            (real) =>
              (from, to) => {
                attempts += 1;
                return real(from, to);
              },
            () => writeTextFileAtomic(target, "once\n")
          )
        );

        // The delay table starts at zero, so a healthy write pays nothing for the retry logic
        // rather than trading a millisecond of latency for the resilience.
        assert.equal(attempts, 1);
        assert.equal(fs.readFileSync(target, "utf8"), "once\n");
      },
    },
  ],
};
