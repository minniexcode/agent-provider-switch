"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir, repoRoot } = require("./helpers");

const SOURCE_ROOT = path.join(repoRoot, "src");
const TARGETS_DIR = path.join(SOURCE_ROOT, "app", "targets");

/**
 * The claim this suite makes is structural, so it reads the source rather than a payload.
 *
 * A behaviour test can show that `add` writes the right bytes for both targets; it cannot show
 * that there is one implementation doing it, and "there are two implementations, and both happen
 * to agree today" is exactly the state `1.2.0` exists to end. So these tests read the call graph an
 * author would: which module declares the transaction, which modules are allowed to enter it, and
 * whether a target's adapter is a declaration or a second copy of the orchestration.
 */

/** Every `.ts` file under a directory, recursively. */
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
 * Resolves the specifiers a file imports to absolute paths, so a check can name a module rather
 * than a spelling of its path.
 *
 * Comments are deliberately not stripped and not matched against: an earlier draft of this suite
 * looked for `selectProvider(` and found it inside a sentence explaining the code it raises. A
 * comment cannot import anything, so reading only `import`/`require` specifiers is both stricter
 * and quieter.
 */
function importedModules(file) {
  const source = fs.readFileSync(file, "utf8");
  const specifiers = [];
  for (const match of source.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) {
      specifiers.push(path.resolve(path.dirname(file), specifier));
    } else {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** The absolute path a relative import of a `.ts` module resolves to, without the extension. */
function modulePath(...segments) {
  return path.join(SOURCE_ROOT, ...segments);
}

/**
 * Modules an adapter must not reach: the shared transaction, the shared workflow module, the
 * generic registry repo, the shared provider chooser, and the target bindings.
 *
 * Named as a list rather than as "anything under app/", because an adapter legitimately imports
 * `app/types.ts` and its own report port — the claim is about orchestration, not about a directory.
 */
const ORCHESTRATION_MODULES = [
  modulePath("app", "run-mutation.ts"),
  modulePath("app", "provider-workflows.ts"),
  modulePath("storage", "provider-registry-repo.ts"),
  modulePath("interaction", "provider-selection.ts"),
  modulePath("commands", "target-bindings.ts"),
];

module.exports = {
  name: "shared provider workflows",
  tests: [
    {
      name: "the six verbs have one implementation, and the write half enters one transaction",
      run() {
        const workflows = modulePath("app", "provider-workflows.ts");
        const source = fs.readFileSync(workflows, "utf8");

        // Declared here...
        assert.match(
          source,
          /export function createReadWorkflows\b/,
          "the shared read workflows must be declared in src/app/provider-workflows.ts"
        );
        assert.match(
          source,
          /export function createWriteWorkflows\b/,
          "the shared write workflows must be declared in src/app/provider-workflows.ts"
        );
        assert.match(
          source,
          /export function commitProviderChange\b/,
          "the single mutation boundary for a provider write must be declared here"
        );

        // ...and entered from nowhere else in `src/`. The generic argument has to be allowed for:
        // every call site spells the record type, so `commitProviderChange<ProviderRecord>(` is
        // what a call looks like, and a pattern that only accepted `(` would find no callers at
        // all and pass while a second transaction quietly held a second lock.
        const CALL = /[^.\w]commitProviderChange\s*(<[^<>]*>)?\s*\(/;
        const callers = sourceFiles(SOURCE_ROOT)
          .filter((file) => CALL.test(fs.readFileSync(file, "utf8")))
          .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
          .sort();
        const expected = path.relative(repoRoot, workflows).split(path.sep).join("/");
        assert.deepEqual(
          callers,
          [expected],
          "the mutation boundary must be entered from the module that declares it, and nowhere else"
        );
      },
    },
    {
      name: "a target adapter declares, and never orchestrates",
      run() {
        const files = sourceFiles(TARGETS_DIR);
        assert.ok(files.length >= 4, "the target adapters must still be under src/app/targets/");

        const offenders = [];
        for (const file of files) {
          for (const imported of importedModules(file)) {
            if (ORCHESTRATION_MODULES.includes(imported)) {
              offenders.push(`${path.relative(repoRoot, file)} imports ${path.relative(repoRoot, imported)}`);
            }
          }
        }
        assert.deepEqual(
          offenders,
          [],
          "an adapter supplies files and changes; the shared layer owns the lock, the backup and the registry: " +
            offenders.join("; ")
        );

        // The commands layer is the same rule one level up: it binds a target and calls the bound
        // workflow, and it never takes a lock itself.
        const commandFiles = sourceFiles(path.join(SOURCE_ROOT, "commands"));
        const commandOffenders = commandFiles
          .filter((file) => /[^.\w](runMutation|commitProviderChange)\s*\(/.test(fs.readFileSync(file, "utf8")))
          .map((file) => path.relative(repoRoot, file));
        assert.deepEqual(
          commandOffenders,
          [],
          "a command handler routes to a shared workflow rather than opening its own transaction"
        );
      },
    },
    {
      name: "both targets implement the same adapter contract",
      run() {
        // Built with throwaway paths: constructing an adapter only closes over them, so this
        // asserts the surface without reading or writing anything.
        const scratch = makeTempDir("agent-provider-switch-adapter-");
        const { createCodexAdapter } = require("../dist/app/targets/codex-adapter.js");
        const { createClaudeAdapter } = require("../dist/app/targets/claude-adapter.js");

        const codex = createCodexAdapter({
          providersPath: path.join(scratch, "providers.json"),
          configPath: path.join(scratch, "config.toml"),
          codexDir: scratch,
          authPath: path.join(scratch, "auth.json"),
        });
        const claude = createClaudeAdapter({
          claudeProvidersPath: path.join(scratch, "claude-providers.json"),
          claudeSettingsPath: path.join(scratch, "settings.json"),
          defaults: null,
        });

        // The hooks the shared workflows call. A target that implements fewer is not asked for the
        // ones it skipped — it fails here, at the seam, rather than at the first invocation that
        // happens to need the missing one.
        const expected = [
          "codec",
          "collectAddInput",
          "currentData",
          "currentWithoutRegistry",
          "duplicateProvider",
          "listData",
          "listOrder",
          "listRow",
          "match",
          "metadata",
          "missingName",
          "mutationOperation",
          "planRemove",
          "planSwitch",
          "prepareAdd",
          "readLive",
          "readMode",
          "registryErrors",
          "removePolicy",
          "resolve",
          "selection",
          "selectionMessage",
          "showData",
        ];

        assert.deepEqual(Object.keys(codex).sort(), expected, "the Codex adapter's surface changed");
        assert.deepEqual(Object.keys(claude).sort(), expected, "the Claude adapter's surface changed");
      },
    },
    {
      name: "the shared verbs are one vocabulary, not a case list per handler",
      run() {
        const { PROVIDER_VERBS, isProviderVerb } = require("../dist/domain/command.js");

        assert.deepEqual(
          [...PROVIDER_VERBS].sort(),
          ["add", "current", "list", "remove", "show", "switch"],
          "the shared verb vocabulary changed"
        );
        assert.equal(isProviderVerb("switch"), true);
        assert.equal(isProviderVerb("edit"), false, "edit is Codex-exclusive, not a shared verb");
        assert.equal(isProviderVerb("config-compact"), false);
        assert.equal(isProviderVerb("help"), false, "the widened context union must answer no");

        // The Claude handler asks the vocabulary instead of listing the six ids a second time.
        // Spelling them out again is how the two lists drift: a verb added to the shared workflows
        // would reach Codex and silently miss Claude.
        const claudeSource = fs.readFileSync(path.join(SOURCE_ROOT, "commands", "claude-handlers.ts"), "utf8");
        for (const verb of PROVIDER_VERBS) {
          assert.doesNotMatch(
            claudeSource,
            new RegExp(`case\\s+"${verb}"\\s*:`),
            `claude-handlers.ts must not re-list the shared verb "${verb}" as a case label`
          );
        }
        assert.match(
          claudeSource,
          /isProviderVerb\(ctx\.command\)/,
          "claude-handlers.ts must recognize the shared verbs from the shared vocabulary"
        );
      },
    },
  ],
};
