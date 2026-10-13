"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  makeCodexFixture,
  makeToolHomeWithManagedState,
  repoRoot,
  runJsonCli,
  withClaudeEnv,
} = require("./helpers");

const SOURCE_ROOT = path.join(repoRoot, "src");

/**
 * Codes the union declares and no producer throws.
 *
 * Recorded by name rather than allowed by pattern, so the list is a ratchet: declaring another
 * unproduced code fails the suite, and producing one of these also fails until it is deleted from
 * the list. Each is left in the union because removing it is a separate break with its own
 * migration, and this release's break is deliberately one table wide.
 *
 * - `LIVE_STATE_DRIFT`, `AUTH_JSON_SYNC_FAILED`, `ACTIVE_PROVIDER_UNRESOLVED` — declared and never
 *   thrown anywhere. Dead vocabulary predating this release.
 * - `UNMANAGED_ACTIVE_PROFILE`, `PROVIDER_BASE_URL_MISMATCH` — rendered as *config issues* by the
 *   doctor, which is a different space: an issue is a finding on a successful run, and the two are
 *   not type-checked against each other. They sit in the error union as well, where nothing throws
 *   them.
 */
const UNPRODUCED_CODES = [
  "ACTIVE_PROVIDER_UNRESOLVED",
  "AUTH_JSON_SYNC_FAILED",
  "LIVE_STATE_DRIFT",
  "PROVIDER_BASE_URL_MISMATCH",
  "UNMANAGED_ACTIVE_PROFILE",
];

/**
 * Every `.ts` file under `src/`, so a producer in the dead tree still counts as one.
 */
function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(absolute));
    } else if (entry.name.endsWith(".ts")) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * A quoted `CLAUDE_`-prefixed string literal. See the test that uses it for why the quotes matter.
 */
const QUOTED_CLAUDE_CODE = /["']CLAUDE_[A-Z_]+["']/;

module.exports = {
  name: "error vocabulary",
  tests: [
    {
      name: "no error code names a target",
      run() {
        // The design sketches this as a bare `/CLAUDE_[A-Z_]+/` over `src/`. That regex does not
        // hold in this tree and should not: `APS_CLAUDE_DIR`, `CLAUDE_COMMANDS`, and
        // `CLAUDE_DIR_ENV_NAME` all legitimately contain the substring, so a bare match would need
        // an allowlist of identifiers — the exact kind of exception that hides a real offender.
        // Requiring the quotes narrows it to what the invariant is actually about, a code string,
        // and `"APS_CLAUDE_DIR"` does not start with `CLAUDE_`, so the environment variable needs
        // no exception at all.
        const offenders = [];
        for (const file of sourceFiles(SOURCE_ROOT)) {
          const source = fs.readFileSync(file, "utf8");
          const match = source.match(QUOTED_CLAUDE_CODE);
          if (match) {
            offenders.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
          }
        }

        assert.deepEqual(
          offenders,
          [],
          `an error code must name a condition, not a target: ${offenders.join(", ")}`
        );
      },
    },
    {
      name: "every declared error code has a producer, apart from the recorded exceptions",
      run() {
        const errorsSource = fs.readFileSync(path.join(SOURCE_ROOT, "domain", "errors.ts"), "utf8");
        const unionStart = errorsSource.indexOf("export type ErrorCode =");
        assert.ok(unionStart >= 0, "the ErrorCode union must be declared in src/domain/errors.ts");
        const union = errorsSource.slice(unionStart, errorsSource.indexOf(";", unionStart));
        const declared = [...union.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
        assert.ok(declared.length > 20, "the union parse must have found the members, not a fragment");

        // The two ways a code reaches a caller. `readRequiredFile()` takes the code as its second
        // argument so it can throw a file-specific error, which is why a census that looked only at
        // `cliError()` would call `CONFIG_NOT_FOUND` and `PROVIDERS_NOT_FOUND` unproduced.
        const produced = new Set();
        for (const file of sourceFiles(SOURCE_ROOT)) {
          const source = fs.readFileSync(file, "utf8");
          for (const match of source.matchAll(/cliError\(\s*"([A-Z0-9_]+)"/g)) produced.add(match[1]);
          for (const match of source.matchAll(/readRequiredFile\([^)]*?"([A-Z0-9_]+)"/g)) produced.add(match[1]);
        }

        const unproduced = declared.filter((code) => !produced.has(code)).sort();
        assert.deepEqual(
          unproduced,
          UNPRODUCED_CODES,
          "the set of declared-but-unproduced codes changed: producing one means deleting it here, " +
            "and declaring a new one means giving it a producer"
        );

        // And the other direction, which catches a rename that missed the union.
        const undeclared = [...produced].filter((code) => !declared.includes(code)).sort();
        assert.deepEqual(undeclared, [], `these codes are thrown but not declared: ${undeclared.join(", ")}`);
      },
    },
    {
      name: "a duplicate provider record and an existing registry are different conditions",
      async run() {
        // The one-character pair this release leaves in place on purpose. `PROVIDER_ALREADY_EXISTS`
        // means a record with that name is taken; `PROVIDERS_ALREADY_EXISTS` means the registry
        // file already exists and holds something migrate would have to overwrite. Merging them
        // would have made one code mean both, and a consumer could not tell which had happened —
        // so this test exists to catch the next reader who notices the resemblance and "cleans it
        // up".
        //
        // The plural's reachable producer is `migrate`, not `init`: `init` is idempotent over an
        // existing registry and returns success. `import` does not raise it either; it replaces
        // the file. Naming the real call site here is the point of asserting this end to end.
        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir, importFile }) => {
          const first = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "duplicate", "--from-file", importFile, "--json"],
          });
          assert.equal(first.status, 0, first.stderr);

          const second = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "duplicate", "--from-file", importFile, "--json"],
          });
          assert.equal(second.status, 1);
          assert.equal(second.payload.error.code, "PROVIDER_ALREADY_EXISTS");
          assert.equal(second.payload.target, "claude");
        });

        const toolHomeDir = makeToolHomeWithManagedState();
        fs.writeFileSync(
          path.join(toolHomeDir, "providers.json"),
          `${JSON.stringify(
            {
              providers: {
                existing: {
                  profile: "existing",
                  apiKey: "sk-fixture",
                  model: "gpt-5",
                  baseUrl: "https://relay.example.com/v1",
                },
              },
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        const migrate = await runJsonCli({
          toolHomeDir,
          args: ["migrate", "--json", "--codex-dir", makeCodexFixture({ modelProvider: "packycode" })],
        });
        assert.equal(migrate.status, 1);
        assert.equal(migrate.payload.error.code, "PROVIDERS_ALREADY_EXISTS");
        assert.equal(migrate.payload.target, "codex");
      },
    },
    {
      name: "the merged codes keep the message that describes the state",
      async run() {
        // The point of merging the codes without merging the sentences: a Claude failure must not
        // start reading as a Codex one. `PROVIDER_NOT_FOUND` now names the condition for both
        // targets; the sentence still says which target, and the envelope's `target` says so
        // structurally.
        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir, importFile }) => {
          const added = await runJsonCli({
            toolHomeDir,
            args: ["add", "--claude", "present", "--from-file", importFile, "--json"],
          });
          assert.equal(added.status, 0, added.stderr);

          const missing = await runJsonCli({
            toolHomeDir,
            args: ["show", "--claude", "ghost", "--json"],
          });
          assert.equal(missing.status, 1);
          assert.equal(missing.payload.error.code, "PROVIDER_NOT_FOUND");
          assert.match(missing.payload.error.message, /Claude provider "ghost" was not found\./);
          assert.equal(missing.payload.target, "claude");

          // The Codex twin: same code, same exit code, same shape, and a sentence that names the
          // other target. `target` is the field a consumer reads to tell the two apart, which is
          // what let the two vocabularies collapse without the two lines becoming indistinguishable.
          const codex = await runJsonCli({
            toolHomeDir: makeToolHomeWithManagedState(),
            args: ["show", "ghost", "--json"],
          });
          assert.equal(codex.status, missing.status);
          assert.equal(codex.payload.error.code, missing.payload.error.code);
          assert.match(codex.payload.error.message, /Provider "ghost" was not found\./);
          assert.equal(codex.payload.target, "codex");
        });
      },
    },
    {
      name: "a Claude success payload carries no target of its own",
      async run() {
        // The acceptance criterion for the one deliberate `--json` break: after this release the
        // envelope's `target` is the only place the answer is written down.
        const result = await runJsonCli({ args: ["list", "--claude", "--json"] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.target, "claude");
        assert.equal(result.payload.data.target, undefined);
        assert.deepEqual(Object.keys(result.payload.data), ["providers", "count"]);
      },
    },
  ],
};
