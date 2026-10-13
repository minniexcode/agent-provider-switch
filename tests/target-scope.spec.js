"use strict";

const assert = require("node:assert/strict");
const { makeToolHomeWithManagedState, withClaudeEnv, runJsonCli } = require("./helpers");

const {
  TARGET_SCOPES,
  acceptsTargetFlag,
  resolveTarget,
  routesToClaudeHandler,
  scopeOf,
  selectedTargets,
  singleTarget,
} = require("../dist/domain/target.js");
const { assertFlagsApply } = require("../dist/commands/flag-guards.js");
const { getCommandDefinitions } = require("../dist/commands/registry.js");

/**
 * Every command's target scope, written out.
 *
 * Declared rather than derived from `TARGET_SCOPES`, because a derived table would agree with the
 * code by construction and would therefore assert nothing. This is the declaration a new command
 * has to be added to; the coverage test below is what makes forgetting it a failure rather than a
 * silent pass.
 *
 * The `both` and `shared` rows are the ones `1.1.3` introduced: `doctor`, `status`, and
 * `backups list` report both targets and narrow with a flag, while `backups prune`, `rollback`, and
 * `unlock` hold state that is not per-target, so neither flag is a smaller answer and both are
 * refused.
 */
const SCOPE = {
  "config-show": "codex-only",
  "config-list-profiles": "codex-only",
  "config-compact": "claude-only",
  init: "codex-only",
  migrate: "codex-only",
  setup: "codex-only",
  list: "switchable",
  show: "switchable",
  current: "switchable",
  status: "both",
  edit: "codex-only",
  add: "switchable",
  switch: "switchable",
  remove: "switchable",
  import: "codex-only",
  export: "codex-only",
  "backups-list": "both",
  "backups-prune": "shared",
  doctor: "both",
  unlock: "shared",
  rollback: "shared",
};

/**
 * Whether a scope accepts one flag, one flag at a time.
 *
 * The expectation, not a second implementation: `acceptsTargetFlag()` is read for the code's
 * answer and this table for the declared one, so a change to the scope table has to be made twice
 * on purpose.
 */
const ACCEPTS = {
  switchable: { claude: true, codex: true },
  "codex-only": { claude: false, codex: true },
  "claude-only": { claude: true, codex: false },
  both: { claude: true, codex: true },
  shared: { claude: false, codex: false },
};

/**
 * Reproduces the decision order `executeCommand` uses — the guard table first, then
 * `resolveTarget()` — so the matrix below tests the real ordering rather than one half of it.
 */
function decide(command, { claude = false, codex = false } = {}) {
  const options = new Map();
  if (claude) options.set("--claude", []);
  if (codex) options.set("--codex", []);

  try {
    assertFlagsApply(command, options);
  } catch (error) {
    return { outcome: "refused", code: error.code, message: error.message };
  }

  const resolution = resolveTarget({ command, claudeRequested: claude, codexRequested: codex });
  if ("refusal" in resolution) {
    return { outcome: "refused", code: resolution.refusal.code, message: resolution.refusal.message };
  }

  return { outcome: "accepted", targets: selectedTargets(command, options) };
}

module.exports = {
  name: "target scope",
  tests: [
    {
      name: "the scope table covers every command the registry defines",
      run() {
        const defined = getCommandDefinitions()
          .map((command) => command.id)
          .sort();
        assert.deepEqual(
          Object.keys(TARGET_SCOPES).sort(),
          defined,
          "every command needs a scope, and the table may not name a command that does not exist"
        );
        assert.deepEqual(
          Object.keys(SCOPE).sort(),
          defined,
          "every command needs a target-scope decision, and only real commands may appear here"
        );
      },
    },
    {
      name: "the declared scope of every command is the one the table holds",
      run() {
        for (const [command, scope] of Object.entries(SCOPE)) {
          assert.equal(scopeOf(command), scope, command);
        }
      },
    },
    {
      name: "the accept/refuse matrix holds for every command, one flag at a time",
      run() {
        for (const [command, scope] of Object.entries(SCOPE)) {
          for (const [flag, accepted] of [
            ["--claude", ACCEPTS[scope].claude],
            ["--codex", ACCEPTS[scope].codex],
          ]) {
            assert.equal(acceptsTargetFlag(command, flag), accepted, `${command} ${flag}`);

            const result = decide(command, { [flag.slice(2)]: true });
            if (accepted) {
              assert.equal(
                result.outcome,
                "accepted",
                `${command} ${flag} must be accepted, got: ${result.message}`
              );
            } else {
              assert.equal(result.outcome, "refused", `${command} ${flag} must be refused`);
              assert.equal(result.code, "INVALID_ARGUMENT", `${command} ${flag}`);
            }
          }
        }
      },
    },
    {
      name: "a shared command refuses both flags and says why narrowing does not exist",
      run() {
        // The three commands that hold state the targets share. Refused by the guard before any
        // handler runs, and refused with a reason: "does not support" would read as a missing
        // capability, and the capability is not missing — the question has no answer.
        for (const command of ["backups-prune", "rollback", "unlock"]) {
          for (const flag of ["--claude", "--codex"]) {
            const result = decide(command, { [flag.slice(2)]: true });
            assert.equal(result.outcome, "refused", `${command} ${flag}`);
            assert.equal(result.code, "INVALID_ARGUMENT");
            assert.match(result.message, /operates on state every target shares/, `${command} ${flag}`);
            assert.match(result.message, new RegExp(`cannot be narrowed with ${flag}`));
          }
        }
      },
    },
    {
      name: "a command that refuses one flag still refuses the pair, and one that takes both refuses the pair",
      run() {
        // The pair never resolves. Every command falls into one of four buckets, and each bucket is
        // refused for a different reason — which is why this asserts the message, not just the
        // outcome. A precedence rule would make the last bucket succeed with a target.
        for (const [command, scope] of Object.entries(SCOPE)) {
          const result = decide(command, { claude: true, codex: true });
          assert.equal(result.outcome, "refused", `${command} --claude --codex must be refused`);
          assert.equal(result.code, "INVALID_ARGUMENT", command);

          if (scope === "shared") {
            assert.match(result.message, /operates on state every target shares/, command);
          } else if (!ACCEPTS[scope].claude) {
            assert.match(result.message, /does not support --claude/, command);
          } else if (!ACCEPTS[scope].codex) {
            assert.match(result.message, /has no Codex form/, command);
          } else {
            assert.match(result.message, /cannot be combined/, command);
          }
        }
      },
    },
    {
      name: "routing is a different question from scope, and only the both scope separates them",
      run() {
        // The distinction this release exists to get right. A `both` command accepts `--claude`
        // and must not be routed to a Claude handler: `doctor` and `status` report on both
        // targets, and no Claude service could produce the whole answer.
        const separate = Object.entries(SCOPE)
          .filter(([command]) => acceptsTargetFlag(command, "--claude") !== routesToClaudeHandler(command))
          .map(([command]) => command)
          .sort();

        assert.deepEqual(separate, ["backups-list", "doctor", "status"]);

        // And the two predicates agree everywhere else, which is what makes the exception a
        // decision rather than a drift.
        for (const [command, scope] of Object.entries(SCOPE)) {
          if (scope === "both") {
            assert.equal(routesToClaudeHandler(command), false, command);
          } else {
            assert.equal(
              routesToClaudeHandler(command),
              acceptsTargetFlag(command, "--claude"),
              command
            );
          }
        }
      },
    },
    {
      name: "selectedTargets is the whole answer for a both command, and a constant elsewhere",
      run() {
        const flags = (...names) => new Map(names.map((name) => [name, []]));

        assert.deepEqual(selectedTargets("doctor", flags()), ["codex", "claude"]);
        assert.deepEqual(selectedTargets("doctor", flags("--codex")), ["codex"]);
        assert.deepEqual(selectedTargets("doctor", flags("--claude")), ["claude"]);
        assert.deepEqual(selectedTargets("status", flags()), ["codex", "claude"]);
        assert.deepEqual(selectedTargets("backups-list", flags()), ["codex", "claude"]);

        // A `switchable` command covers one target, and the flag picks it; the default is Codex.
        assert.deepEqual(selectedTargets("list", flags()), ["codex"]);
        assert.deepEqual(selectedTargets("list", flags("--claude")), ["claude"]);
        assert.deepEqual(selectedTargets("list", flags("--codex")), ["codex"]);

        // `--codex` on a `codex-only` command changes nothing rather than narrowing twice.
        assert.deepEqual(selectedTargets("init", flags("--codex")), ["codex"]);
        assert.deepEqual(selectedTargets("config-compact", flags("--claude")), ["claude"]);

        // A `shared` command names no target at all, and that is not the same answer as "Codex".
        assert.deepEqual(selectedTargets("rollback", flags()), []);
      },
    },
    {
      name: "singleTarget answers only when exactly one target is in scope",
      run() {
        assert.equal(singleTarget(["claude"]), "claude");
        assert.equal(singleTarget(["codex"]), "codex");
        assert.equal(singleTarget(["codex", "claude"]), null);
        assert.equal(singleTarget([]), null);
      },
    },
    {
      name: "--codex-dir is refused when --claude narrows a both command, and only there",
      run() {
        const options = new Map([["--claude", []]]);

        for (const command of ["doctor", "status", "backups-list"]) {
          assert.throws(
            () => assertFlagsApply(command, options, { codexDirExplicit: true }),
            (error) => {
              assert.equal(error.code, "INVALID_ARGUMENT");
              assert.match(error.message, /--codex-dir does not apply when --claude narrows it to Claude/);
              return true;
            },
            `${command} --claude --codex-dir must be refused`
          );

          // Without the narrowing there is nothing to contradict.
          assert.doesNotThrow(() => assertFlagsApply(command, new Map(), { codexDirExplicit: true }));
        }

        // A `switchable` command keeps the long-standing accepted form: the pair was never
        // meaningful there either, but changing it is not this release's business.
        assert.doesNotThrow(() =>
          assertFlagsApply("list", options, { codexDirExplicit: true })
        );
      },
    },
    {
      name: "the envelope's targets is authoritative and target is its single-target alias",
      async run() {
        const bare = await runJsonCli({ args: ["doctor", "--json", "--codex", "--claude"] });
        assert.equal(bare.status, 1, "the pair is a refusal, not a two-target report");

        const both = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["status", "--json"],
        });
        assert.equal(both.status, 0, both.stderr);
        assert.deepEqual(both.payload.targets, ["codex", "claude"]);
        assert.equal(both.payload.target, null);

        const narrowed = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["status", "--codex", "--json"],
        });
        assert.equal(narrowed.status, 0, narrowed.stderr);
        assert.deepEqual(narrowed.payload.targets, ["codex"]);
        assert.equal(narrowed.payload.target, "codex");

        await withClaudeEnv({ model: "sonnet" }, async ({ toolHomeDir }) => {
          const claude = await runJsonCli({ toolHomeDir, args: ["status", "--claude", "--json"] });
          assert.equal(claude.status, 0, claude.stderr);
          assert.deepEqual(claude.payload.targets, ["claude"]);
          assert.equal(claude.payload.target, "claude");
        });
      },
    },
  ],
};
