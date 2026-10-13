"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeToolHomeWithManagedState, runBuiltCli, runJsonCli, withClaudeEnv } = require("./helpers");

const {
  COMMAND_TARGET_POLICIES,
  acceptsTarget,
  routesToClaudeHandler,
  scopeOf,
  singleTarget,
} = require("../dist/domain/target.js");
const { assertFlagsApply } = require("../dist/commands/flag-guards.js");
const { getCommandDefinitions } = require("../dist/commands/registry.js");

/**
 * Every command's target scope, written out.
 *
 * Declared rather than derived from the policy table, because a derived table would agree with the
 * code by construction and would therefore assert nothing. This is the declaration a new command
 * has to be added to; the coverage test below is what makes forgetting it a failure rather than a
 * silent pass.
 *
 * The `both` and `shared` rows are the ones `1.1.3` introduced: `doctor`, `status`, and
 * `backups list` report both targets and narrow with a selection, while `backups prune`, `rollback`,
 * and `unlock` hold state that is not per-target, so no selection is a smaller answer.
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
 * Whether a scope accepts one target, one target at a time.
 *
 * The expectation, not a second implementation: `acceptsTarget()` is read for the code's answer and
 * this table for the declared one, so a change to the capability declaration has to be made twice
 * on purpose.
 */
const ACCEPTS = {
  switchable: { claude: true, codex: true },
  "codex-only": { claude: false, codex: true },
  "claude-only": { claude: true, codex: false },
  both: { claude: true, codex: true },
  shared: { claude: false, codex: false },
};

const TARGETS = ["codex", "claude"];

const IMPLICIT = { kind: "implicit" };

/**
 * The selection a `--target <id>` or the matching shorthand flag normalizes to.
 */
function selecting(target) {
  return { kind: "explicit", id: target, token: `--${target}` };
}

/**
 * Asks the real guard for one command and one selection, and reports what it decided.
 *
 * Goes through `assertFlagsApply()` rather than reading the declarations directly, so the matrix
 * below tests the decision the CLI actually makes rather than a restatement of the table.
 */
function decide(command, selection, globalOptions = {}, commandOptions = new Map()) {
  try {
    return { outcome: "accepted", targets: assertFlagsApply(command, selection, commandOptions, globalOptions) };
  } catch (error) {
    return { outcome: "refused", code: error.code, message: error.message, details: error.details };
  }
}

module.exports = {
  name: "target scope",
  tests: [
    {
      name: "the policy table covers every command the registry defines",
      run() {
        const defined = getCommandDefinitions()
          .map((command) => command.id)
          .sort();
        assert.deepEqual(
          Object.keys(COMMAND_TARGET_POLICIES).sort(),
          defined,
          "every command needs a target policy, and the table may not name a command that does not exist"
        );
        assert.deepEqual(
          Object.keys(SCOPE).sort(),
          defined,
          "every command needs a target-scope decision, and only real commands may appear here"
        );
      },
    },
    {
      name: "the declared scope of every command is the one the policy derives",
      run() {
        for (const [command, scope] of Object.entries(SCOPE)) {
          assert.equal(scopeOf(command), scope, command);
        }
      },
    },
    {
      name: "capability is a property of the target declaration, and the matrix holds",
      run() {
        for (const [command, scope] of Object.entries(SCOPE)) {
          for (const target of TARGETS) {
            assert.equal(acceptsTarget(command, target), ACCEPTS[scope][target], `${command} ${target}`);
          }
        }
      },
    },
    {
      name: "the accept/refuse matrix holds for every command, one target at a time",
      run() {
        for (const [command, scope] of Object.entries(SCOPE)) {
          for (const target of TARGETS) {
            const result = decide(command, selecting(target));
            if (ACCEPTS[scope][target]) {
              assert.equal(
                result.outcome,
                "accepted",
                `${command} --${target} must be accepted, got: ${result.message}`
              );
              assert.deepEqual(result.targets, [target], command);
            } else {
              assert.equal(result.outcome, "refused", `${command} --${target} must be refused`);
              assert.equal(result.code, "INVALID_ARGUMENT", `${command} --${target}`);
            }
          }
        }
      },
    },
    {
      name: "a bare invocation resolves to the default, to both, or to nothing at all",
      run() {
        // The three answers a bare line can have, and the fourth case where it has none.
        assert.deepEqual(decide("list", IMPLICIT).targets, ["codex"]);
        assert.deepEqual(decide("init", IMPLICIT).targets, ["codex"]);
        assert.deepEqual(decide("doctor", IMPLICIT).targets, ["codex", "claude"]);
        assert.deepEqual(decide("status", IMPLICIT).targets, ["codex", "claude"]);
        assert.deepEqual(decide("backups-list", IMPLICIT).targets, ["codex", "claude"]);

        // A `shared` command names no target at all, and that is not the same answer as "Codex".
        assert.deepEqual(decide("rollback", IMPLICIT).targets, []);

        // `config compact` has one target and will not run on it by default: its policy declares no
        // default, so the requirement and the help text are generated from the same fact.
        const compact = decide("config-compact", IMPLICIT);
        assert.equal(compact.outcome, "refused");
        assert.equal(compact.code, "INVALID_ARGUMENT");
        assert.match(compact.message, /requires --claude/);
        assert.match(compact.message, /--target claude/);

        // The same command with the target named is accepted, which is what makes the requirement a
        // requirement rather than a refusal to work.
        assert.deepEqual(decide("config-compact", selecting("claude")).targets, ["claude"]);

        // And its one target is the only one it has.
        const wrongTarget = decide("config-compact", selecting("codex"));
        assert.equal(wrongTarget.outcome, "refused");
        assert.match(wrongTarget.message, /has no Codex form/);
      },
    },
    {
      name: "a shared command refuses any selection and says why narrowing does not exist",
      run() {
        // The three commands that hold state the targets share. Refused before any file is read, and
        // refused with a reason: "does not support" would read as a missing capability, and the
        // capability is not missing — the question has no answer.
        for (const command of ["backups-prune", "rollback", "unlock"]) {
          for (const target of TARGETS) {
            const result = decide(command, selecting(target));
            assert.equal(result.outcome, "refused", `${command} ${target}`);
            assert.equal(result.code, "INVALID_ARGUMENT");
            assert.match(result.message, /operates on state every target shares/, `${command} ${target}`);
            assert.match(result.message, new RegExp(`cannot be narrowed with --${target}`));
          }
        }

        // The `--target` spelling is refused by the same rule and quoted back as it was typed.
        const targeted = decide("rollback", { kind: "explicit", id: "claude", token: "--target claude" });
        assert.equal(targeted.outcome, "refused");
        assert.match(targeted.message, /cannot be narrowed with --target claude/);
      },
    },
    {
      name: "an unsupported selection names the commands it does apply to",
      run() {
        // `--claude` is not a wildcard: a command with no Claude form rejects it rather than
        // silently running the Codex path, and the refusal lists where the selection does apply so
        // the caller does not have to guess which half of the line was wrong.
        const result = decide("init", selecting("claude"));
        assert.equal(result.outcome, "refused");
        assert.match(result.message, /does not support --claude/);
        assert.equal(result.details.command, "init");
        assert.deepEqual(result.details.supportedCommands, [
          "add",
          "backups-list",
          "config-compact",
          "current",
          "doctor",
          "list",
          "remove",
          "show",
          "status",
          "switch",
        ]);

        // The `--target` spelling produces the same refusal with the spelling the caller used.
        const targeted = decide("init", { kind: "explicit", id: "claude", token: "--target claude" });
        assert.match(targeted.message, /does not support --target claude/);
      },
    },
    {
      name: "routing is a different question from capability, and only the both scope separates them",
      run() {
        // The distinction this release exists to get right. A `both` command accepts a Claude
        // selection and must not be routed to a Claude handler: `doctor` and `status` report on both
        // targets, and no Claude service could produce the whole answer.
        const separate = Object.entries(SCOPE)
          .filter(([command]) => acceptsTarget(command, "claude") !== routesToClaudeHandler(command))
          .map(([command]) => command)
          .sort();

        assert.deepEqual(separate, ["backups-list", "doctor", "status"]);

        // And the two predicates agree everywhere else, which is what makes the exception a
        // decision rather than a drift.
        for (const [command, scope] of Object.entries(SCOPE)) {
          if (scope === "both") {
            assert.equal(routesToClaudeHandler(command), false, command);
          } else {
            assert.equal(routesToClaudeHandler(command), acceptsTarget(command, "claude"), command);
          }
        }

        // A token that names no command is a definite "no" rather than a mistake: the pre-dispatch
        // render paths hold "help" and "version" in the same field.
        assert.equal(routesToClaudeHandler("help"), false);
        assert.equal(routesToClaudeHandler("lst"), false);
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
      name: "--codex-dir is refused when a Claude selection narrows a both command, and only there",
      run() {
        for (const command of ["doctor", "status", "backups-list"]) {
          const refused = decide(command, selecting("claude"), { codexDirExplicit: true });
          assert.equal(refused.outcome, "refused", `${command} --claude --codex-dir must be refused`);
          assert.equal(refused.code, "INVALID_ARGUMENT");
          assert.match(refused.message, /--codex-dir does not apply when --claude narrows it to Claude/);

          // Without the narrowing there is nothing to contradict.
          assert.equal(decide(command, IMPLICIT, { codexDirExplicit: true }).outcome, "accepted");
        }

        // A `switchable` command keeps the long-standing accepted form: the pair was never
        // meaningful there either, but changing it is not this release's business.
        assert.equal(decide("list", selecting("claude"), { codexDirExplicit: true }).outcome, "accepted");
      },
    },
    {
      name: "--full and --dry-run are declared per command and per target, not read where they are used",
      run() {
        const flag = (name) => new Map([[name, ["true"]]]);

        // `--full` applies to Claude `add`, and only when the target was named.
        assert.equal(decide("add", selecting("claude"), {}, flag("--full")).outcome, "accepted");
        assert.equal(decide("add", IMPLICIT, {}, flag("--full")).outcome, "refused");
        assert.equal(decide("add", selecting("codex"), {}, flag("--full")).outcome, "refused");
        assert.deepEqual(decide("add", IMPLICIT, {}, flag("--full")).details.supportedCommands, ["add"]);

        // A Claude-capable command that has no use for it: the early-return must not let it through.
        const onSwitch = decide("switch", selecting("claude"), {}, flag("--full"));
        assert.equal(onSwitch.outcome, "refused");
        assert.match(onSwitch.message, /only applies to Claude/);

        // The motivating case for the whole table: `backups prune --dry-run` would delete real
        // backups under a flag that promised a preview.
        const onPrune = decide("backups-prune", IMPLICIT, {}, flag("--dry-run"));
        assert.equal(onPrune.outcome, "refused");
        assert.deepEqual(onPrune.details.supportedCommands, ["config-compact"]);
        assert.equal(decide("config-compact", selecting("claude"), {}, flag("--dry-run")).outcome, "accepted");
      },
    },
    {
      name: "a refused scope is settled before the shared config is read",
      async run() {
        // An unparseable `agent-provider-switch.json` is the probe: the strict reader throws
        // INVALID_CONFIG on it, so a refusal that reports INVALID_ARGUMENT instead proves no config
        // I/O happened. This is the ordering the guard, the migration and the config read depend on.
        const toolHomeDir = makeToolHomeWithManagedState();
        fs.writeFileSync(
          path.join(toolHomeDir, "agent-provider-switch.json"),
          "{ this is not json\n",
          "utf8"
        );

        const shared = await runJsonCli({ toolHomeDir, args: ["backups", "prune", "--claude", "--json"] });
        assert.equal(shared.status, 1);
        assert.equal(shared.payload.error.code, "INVALID_ARGUMENT");
        assert.match(shared.payload.error.message, /operates on state every target shares/);

        // The one that used to be checked in the handler, after the config had been read.
        const compact = await runJsonCli({ toolHomeDir, args: ["config", "compact", "--json"] });
        assert.equal(compact.status, 1);
        assert.equal(compact.payload.error.code, "INVALID_ARGUMENT");
        assert.match(compact.payload.error.message, /requires --claude/);

        const unsupported = await runJsonCli({ toolHomeDir, args: ["init", "--target", "claude", "--json"] });
        assert.equal(unsupported.status, 1);
        assert.equal(unsupported.payload.error.code, "INVALID_ARGUMENT");

        // The control: an accepted scope does read it, and reports the file rather than the flags.
        const accepted = await runJsonCli({ toolHomeDir, args: ["list", "--json"] });
        assert.equal(accepted.status, 1);
        assert.equal(accepted.payload.error.code, "INVALID_CONFIG");
      },
    },
    {
      name: "help derives each command's target sentence from the same declaration",
      async run() {
        const list = await runBuiltCli(["help", "list"]);
        assert.equal(list.status, 0, list.stderr);
        assert.match(list.stdout, /^Targets: Codex by default; --claude or --target claude selects Claude\.$/m);

        const init = await runBuiltCli(["help", "init"]);
        assert.match(init.stdout, /^Targets: Codex only\.$/m);

        const compact = await runBuiltCli(["help", "config compact"]);
        assert.match(compact.stdout, /^Targets: Claude only, and it must be named \(--claude or --target claude\)\.$/m);

        const prune = await runBuiltCli(["help", "backups prune"]);
        assert.match(prune.stdout, /^Targets: state both targets share; neither --claude nor --codex applies\.$/m);

        const top = await runBuiltCli(["--help"]);
        assert.match(top.stdout, /--target <id>\s+Act on one target: codex or claude\./);
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

          // The `--target` spelling produces the same envelope, which is what makes it an alias
          // rather than a second selector with its own rules.
          const targeted = await runJsonCli({ toolHomeDir, args: ["status", "--target", "claude", "--json"] });
          assert.equal(targeted.status, 0, targeted.stderr);
          assert.deepEqual(targeted.payload.targets, ["claude"]);
          assert.equal(targeted.payload.target, "claude");
        });
      },
    },
  ],
};
