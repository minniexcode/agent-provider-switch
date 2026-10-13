"use strict";

const assert = require("node:assert/strict");
const { makeToolHomeWithManagedState, runJsonCli } = require("./helpers");

const { TARGET_IDS, resolveTarget } = require("../dist/domain/target.js");

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
      name: "a named flag reaches the resolved target, and the default does not need to be named",
      async run() {
        // Asked of a `switchable` command, which is the scope `resolveTarget()`'s `target` arm
        // still answers for: a bare `status` now covers two targets and answers `null` instead,
        // which is where the scope spec takes over.
        const explicit = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["list", "--codex", "--json"],
        });
        assert.equal(explicit.payload.target, "codex");

        const implicit = await runJsonCli({
          toolHomeDir: makeToolHomeWithManagedState(),
          args: ["list", "--json"],
        });
        assert.equal(implicit.payload.target, "codex");
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
        assert.deepEqual(success.payload.targets, ["claude"]);
        assert.equal(success.payload.command, "list");

        // Failure: the refusal is raised before the handler runs, so the envelope has to describe
        // the requested target rather than the one that would have applied. `null` is asserted
        // with `in` as well as by value, because a dropped key and an explicit null read the same
        // through `JSON.stringify` unless the key's presence is checked.
        //
        // The pair is the example because it is the refusal that survives `1.1.3`: the narrowed
        // `status --claude` this used to assert against is a supported invocation now.
        const refused = await runJsonCli({ args: ["doctor", "--claude", "--codex", "--json"] });
        assert.equal(refused.status, 1);
        assert.equal(refused.payload.error.code, "INVALID_ARGUMENT");
        assert.match(refused.payload.error.message, /cannot be combined/);
        assert.ok("target" in refused.payload, "the failure envelope must state a target");
        assert.equal(refused.payload.target, null);
        // `[]` rather than the two targets the flags disagree about: nothing was resolved, and a
        // list here would claim the command had a target when it did not.
        assert.deepEqual(refused.payload.targets, []);
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
        // A failure after the scope was accepted keeps it: the scope was decided from the command
        // line before any file was read, so nothing the handler does afterwards can un-resolve it.
        assert.deepEqual(result.payload.targets, ["claude"]);

        // And the Codex form of the same mistake, which resolves to the other target.
        const codex = await runJsonCli({ args: ["show", "--json"] });
        assert.equal(codex.status, 1);
        assert.equal(codex.payload.error.code, "INVALID_ARGUMENT");
        assert.equal(codex.payload.target, "codex");
      },
    },
    {
      name: "the target lives on the envelope and nowhere in the payload",
      async run() {
        // `data.target` was a second copy, written by hand in each Claude service. 1.1.1 moved the
        // human renderer off it, which is what made it removable, and 1.1.2 removed it; the
        // envelope is written once from the resolved target, so a payload cannot disagree with it.
        const result = await runJsonCli({ args: ["list", "--claude", "--json"] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.payload.target, "claude");
        assert.equal(result.payload.data.target, undefined);

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
