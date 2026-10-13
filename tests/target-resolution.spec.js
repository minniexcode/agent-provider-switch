"use strict";

const assert = require("node:assert/strict");
const { makeToolHomeWithManagedState, runJsonCli } = require("./helpers");

const { TARGET_IDS, resolveTarget } = require("../dist/domain/target.js");
const { assertFlagsApply } = require("../dist/commands/flag-guards.js");
const { getCommandDefinitions } = require("../dist/commands/registry.js");

/**
 * Which target flags each command accepts, one flag at a time.
 *
 * Written out rather than derived from `CLAUDE_COMMANDS`, because a derived table would agree with
 * the code by construction and would therefore assert nothing. This is the declaration a new
 * command has to be added to; `the scope table covers every command the registry defines` is what
 * makes forgetting it a failure rather than a silent pass.
 */
const SCOPE = {
  "config-show": { claude: false, codex: true },
  "config-list-profiles": { claude: false, codex: true },
  "config-compact": { claude: true, codex: false },
  init: { claude: false, codex: true },
  migrate: { claude: false, codex: true },
  setup: { claude: false, codex: true },
  list: { claude: true, codex: true },
  show: { claude: true, codex: true },
  current: { claude: true, codex: true },
  status: { claude: false, codex: true },
  edit: { claude: false, codex: true },
  add: { claude: true, codex: true },
  switch: { claude: true, codex: true },
  remove: { claude: true, codex: true },
  import: { claude: false, codex: true },
  export: { claude: false, codex: true },
  "backups-list": { claude: false, codex: true },
  "backups-prune": { claude: false, codex: true },
  doctor: { claude: false, codex: true },
  unlock: { claude: false, codex: true },
  rollback: { claude: false, codex: true },
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

  return { outcome: "accepted", target: resolution.target };
}

module.exports = {
  name: "target resolution",
  tests: [
    {
      name: "the target ids are the two the CLI can act on",
      run() {
        assert.deepEqual([...TARGET_IDS], ["codex", "claude"]);
      },
    },
    {
      name: "resolveTarget names the default, honours an explicit flag, and refuses the pair",
      run() {
        // The command is not consulted for the no-flag case: Codex is the default whatever the
        // command is, which is the property that keeps the flag optional.
        assert.deepEqual(resolveTarget({ command: "list", claudeRequested: false, codexRequested: false }), {
          target: "codex",
        });
        assert.deepEqual(resolveTarget({ command: "list", claudeRequested: true, codexRequested: false }), {
          target: "claude",
        });
        assert.deepEqual(resolveTarget({ command: "list", claudeRequested: false, codexRequested: true }), {
          target: "codex",
        });

        // `null` is "no command resolved", which is a success rather than a refusal: the help,
        // version, and pre-dispatch failure paths legitimately have no command to describe.
        assert.deepEqual(resolveTarget({ command: null, claudeRequested: false, codexRequested: false }), {
          target: null,
        });
        assert.deepEqual(resolveTarget({ command: null, claudeRequested: true, codexRequested: false }), {
          target: null,
        });

        // A pair is a refusal rather than a precedence rule. `--claude` winning as the "more
        // specific" flag would silently ignore a `--codex` the user typed.
        const pair = resolveTarget({ command: "list", claudeRequested: true, codexRequested: true });
        assert.ok("refusal" in pair);
        assert.equal(pair.refusal.code, "INVALID_ARGUMENT");
        assert.match(pair.refusal.message, /cannot be combined/);
      },
    },
    {
      name: "the scope table covers every command the registry defines",
      run() {
        const defined = getCommandDefinitions()
          .map((command) => command.id)
          .sort();
        assert.deepEqual(
          Object.keys(SCOPE).sort(),
          defined,
          "every command needs a target-scope decision, and only real commands may appear here"
        );
      },
    },
    {
      name: "the accept/refuse matrix holds for every command, one flag at a time",
      run() {
        for (const [command, scope] of Object.entries(SCOPE)) {
          for (const [flag, accepted] of [
            ["--claude", scope.claude],
            ["--codex", scope.codex],
          ]) {
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
      name: "a command that refuses one flag still refuses the pair, and one that takes both refuses the pair",
      run() {
        // The pair never resolves. Every command falls into one of three buckets, and each bucket
        // is refused for a different reason — which is why this asserts the message, not just the
        // outcome. A precedence rule would make the third bucket succeed with a target.
        for (const [command, scope] of Object.entries(SCOPE)) {
          const result = decide(command, { claude: true, codex: true });
          assert.equal(result.outcome, "refused", `${command} --claude --codex must be refused`);
          assert.equal(result.code, "INVALID_ARGUMENT", command);

          if (!scope.claude) {
            assert.match(result.message, /does not support --claude/, command);
          } else if (!scope.codex) {
            assert.match(result.message, /has no Codex form/, command);
          } else {
            assert.match(result.message, /cannot be combined/, command);
          }
        }
      },
    },
    {
      name: "a named flag reaches the resolved target, and the default does not need to be named",
      run() {
        const explicit = decide("list", { codex: true });
        assert.equal(explicit.target, "codex");

        const implicit = decide("list");
        assert.equal(implicit.target, "codex");

        const claude = decide("list", { claude: true });
        assert.equal(claude.target, "claude");
      },
    },
    {
      name: "the envelope carries the resolved target on success and on failure",
      async run() {
        // Success: `list --claude` against an empty tool home. The Claude root is arranged by
        // `runBuiltCli`, so this cannot reach the developer's real ~/.claude.
        const success = await runJsonCli({
          args: ["list", "--claude", "--json"],
        });
        assert.equal(success.status, 0, success.stderr);
        assert.equal(success.payload.target, "claude");
        assert.equal(success.payload.command, "list");

        // The default, stated without a flag, is Codex.
        const defaulted = await runJsonCli({ args: ["status", "--json"] });
        assert.equal(defaulted.payload.target, "codex");

        // Failure: the refusal is raised before the handler runs, so the envelope has to describe
        // the requested target rather than the one that would have applied. `null` is asserted
        // with `in` as well as by value, because a dropped key and an explicit null read the same
        // through `JSON.stringify` unless the key's presence is checked.
        const refused = await runJsonCli({ args: ["status", "--claude", "--json"] });
        assert.equal(refused.status, 1);
        assert.equal(refused.payload.error.code, "INVALID_ARGUMENT");
        assert.ok("target" in refused.payload, "the failure envelope must state a target");
        assert.equal(refused.payload.target, null);
      },
    },
    {
      name: "a failure raised after resolution reports the resolved target, not null",
      async run() {
        // The same error code as the refusals above, arriving from the handler instead of from the
        // resolution. `target` is the field that tells the two apart, which is the reason it is
        // written on the failure path at all: before this release the only signal that a failed
        // `--claude` invocation had anything to do with Claude was the error code's name.
        const result = await runJsonCli({ args: ["show", "--claude", "--json"] });
        assert.equal(result.status, 1);
        assert.equal(result.payload.error.code, "INVALID_ARGUMENT");
        assert.match(result.payload.error.message, /Missing provider name for show --claude/);
        assert.equal(result.payload.target, "claude");

        // And the Codex form of the same mistake, which resolves to the other target.
        const codex = await runJsonCli({ args: ["show", "--json"] });
        assert.equal(codex.status, 1);
        assert.equal(codex.payload.error.code, "INVALID_ARGUMENT");
        assert.equal(codex.payload.target, "codex");
      },
    },
    {
      name: "the Claude payload target and the envelope target agree",
      async run() {
        // `data.target` is written by the Claude services and the envelope's `target` by the
        // renderer, so the two are set in different places. 1.1.2 deletes the former; until then
        // this is the assertion that makes that removal provably behaviour-preserving.
        const result = await runJsonCli({ args: ["list", "--claude", "--json"] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.data.target, result.payload.target);

        // And the Codex path sets no payload target at all, so the envelope field is the only
        // place a consumer can read it from.
        const codex = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["list", "--json"],
        });
        assert.equal(codex.status, 0, codex.stderr);
        assert.equal(codex.payload.data.target, undefined);
        assert.equal(codex.payload.target, "codex");
      },
    },
    {
      name: "--codex is stripped position-independently, so it never swallows the next token",
      async run() {
        // The defect the boolean-flag set exists to prevent: `--codex` reaching the greedy option
        // pass would record `list` as its value and leave no command to resolve.
        const leading = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["--codex", "list", "--json"],
        });
        assert.equal(leading.status, 0, leading.stderr);
        assert.equal(leading.payload.command, "list");
        assert.equal(leading.payload.target, "codex");
      },
    },
  ],
};
