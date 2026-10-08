"use strict";

const assert = require("node:assert/strict");
const {
  mergeClaudeSettings,
  diffClaudeSettings,
  collectInheritedPaths,
  collectDroppedPaths,
} = require("../dist/domain/claude-settings-merge");

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Small deterministic PRNG, so the randomized properties below are reproducible. A failure
 * prints the seed-derived case rather than being a flake nobody can replay.
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["a", "b", "c", "d", "env"];

function randomValue(random, depth) {
  const roll = random();
  if (roll < 0.25) return ["x", "y", ""][Math.floor(random() * 3)];
  if (roll < 0.4) return [1, 2, 0][Math.floor(random() * 3)];
  if (roll < 0.5) return random() < 0.5;
  if (roll < 0.6) return [[1], [2], [], [1, 2]][Math.floor(random() * 4)];
  if (roll < 0.7) return null;
  if (roll < 0.78) return {};
  return depth > 0 ? randomObject(random, depth - 1) : "leaf";
}

function randomObject(random, depth) {
  const result = {};
  for (const key of KEYS) {
    if (random() < 0.5) result[key] = randomValue(random, depth);
  }
  return result;
}

function getPath(value, dotted) {
  let current = value;
  for (const part of dotted.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function hasNullMember(value) {
  if (Array.isArray(value)) return false; // arrays are data, copied verbatim
  if (value === null) return true;
  if (typeof value !== "object") return false;
  return Object.values(value).some(hasNullMember);
}

// The shape of the real file this feature exists for: a shared block plus a 5-key provider delta.
const SHARED = {
  env: {
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_EFFORT_LEVEL: "XHIGH",
    MCP_CONNECT_TIMEOUT_MS: "30000",
  },
  model: "sonnet",
  theme: "dark",
  editorMode: "normal",
  autoCompactEnabled: true,
};

module.exports = {
  name: "claude settings merge",
  tests: [
    {
      name: "merge: the override wins, and nested env merges key by key",
      run() {
        const merged = mergeClaudeSettings(SHARED, {
          env: { ANTHROPIC_BASE_URL: "https://x", CLAUDE_CODE_EFFORT_LEVEL: "LOW" },
          model: "opus",
        });
        assert.deepEqual(merged, {
          env: {
            CLAUDE_CODE_USE_VERTEX: "0",
            CLAUDE_CODE_EFFORT_LEVEL: "LOW",
            MCP_CONNECT_TIMEOUT_MS: "30000",
            ANTHROPIC_BASE_URL: "https://x",
          },
          model: "opus",
          theme: "dark",
          editorMode: "normal",
          autoCompactEnabled: true,
        });
      },
    },
    {
      name: "merge: arrays are replaced wholesale, not merged element by element",
      run() {
        const merged = mergeClaudeSettings(
          { permissions: { allow: ["Read(*)", "Edit(*)"], deny: ["Bash(rm -rf *)"] } },
          { permissions: { allow: ["Bash(ls*)"] } }
        );
        assert.deepEqual(merged.permissions, { allow: ["Bash(ls*)"], deny: ["Bash(rm -rf *)"] });
      },
    },
    {
      name: "merge: null deletes an inherited key, and is a no-op over an absent one",
      run() {
        const merged = mergeClaudeSettings(SHARED, { theme: null, neverSet: null, env: { MCP_CONNECT_TIMEOUT_MS: null } });
        assert.equal("theme" in merged, false);
        assert.equal("neverSet" in merged, false);
        assert.equal("MCP_CONNECT_TIMEOUT_MS" in merged.env, false);
        assert.equal(merged.env.CLAUDE_CODE_EFFORT_LEVEL, "XHIGH");
      },
    },
    {
      name: "merge: an empty object inherits instead of clearing; null clears",
      run() {
        const defaults = { enabledPlugins: { "pyright-lsp@claude-plugins-official": true } };

        assert.deepEqual(mergeClaudeSettings(defaults, { enabledPlugins: {} }), defaults);
        assert.deepEqual(mergeClaudeSettings(defaults, { enabledPlugins: null }), {});
      },
    },
    {
      name: "merge: an empty object over an absent default is kept",
      run() {
        assert.deepEqual(mergeClaudeSettings({}, { enabledPlugins: {} }), { enabledPlugins: {} });
        assert.deepEqual(mergeClaudeSettings(null, { enabledPlugins: {} }), { enabledPlugins: {} });
      },
    },
    {
      name: "merge: a null default reads as absent, including one nested inside a default object",
      run() {
        const merged = mergeClaudeSettings({ a: null, env: { X: null, Y: "1" } }, { env: { Z: "2" } });
        assert.deepEqual(merged, { env: { Y: "1", Z: "2" } });
        assert.equal(hasNullMember(merged), false);
      },
    },
    {
      name: "merge: null and undefined defaults/overrides are tolerated",
      run() {
        assert.deepEqual(mergeClaudeSettings(null, null), {});
        assert.deepEqual(mergeClaudeSettings(undefined, undefined), {});
        assert.deepEqual(mergeClaudeSettings(null, SHARED), SHARED);
        assert.deepEqual(mergeClaudeSettings(SHARED, null), SHARED);
      },
    },
    {
      name: "merge: never mutates its inputs, and returns an object that does not alias them",
      run() {
        const defaults = clone(SHARED);
        const overrides = { env: { ANTHROPIC_BASE_URL: "https://x" }, permissions: { allow: ["Read(*)"] } };
        const defaultsBefore = clone(defaults);
        const overridesBefore = clone(overrides);

        const merged = mergeClaudeSettings(defaults, overrides);
        merged.env.CLAUDE_CODE_EFFORT_LEVEL = "MUTATED";
        merged.permissions.allow.push("MUTATED");

        assert.deepEqual(defaults, defaultsBefore);
        assert.deepEqual(overrides, overridesBefore);
      },
    },
    {
      name: "diff: drops entries equal to a default and keeps the rest",
      run() {
        const full = {
          env: { ...SHARED.env, ANTHROPIC_BASE_URL: "https://x", CLAUDE_CODE_EFFORT_LEVEL: "LOW" },
          model: "sonnet",
          theme: "light",
          editorMode: "normal",
          autoCompactEnabled: true,
        };
        assert.deepEqual(diffClaudeSettings(SHARED, full), {
          env: { ANTHROPIC_BASE_URL: "https://x", CLAUDE_CODE_EFFORT_LEVEL: "LOW" },
          theme: "light",
        });
      },
    },
    {
      name: "diff: slimming is inheritance-first — a default the file omits is inherited, not lost",
      run() {
        const full = { env: { ANTHROPIC_BASE_URL: "https://x" } };
        const delta = diffClaudeSettings(SHARED, full);

        assert.deepEqual(delta, { env: { ANTHROPIC_BASE_URL: "https://x" } });
        // The expanded result gains every default the file never mentioned: that is the feature.
        assert.equal(mergeClaudeSettings(SHARED, delta).theme, "dark");
        assert.notDeepEqual(mergeClaudeSettings(SHARED, delta), full);
      },
    },
    {
      name: "diff: a null survives only where it deletes a real default",
      run() {
        const delta = diffClaudeSettings(SHARED, { theme: null, neverSet: null, env: { MCP_CONNECT_TIMEOUT_MS: null, NOPE: null } });
        assert.deepEqual(delta, { theme: null, env: { MCP_CONNECT_TIMEOUT_MS: null } });

        // Dropping the deletion would make the deleted value reappear.
        const merged = mergeClaudeSettings(SHARED, delta);
        assert.equal("theme" in merged, false);
        assert.equal("MCP_CONNECT_TIMEOUT_MS" in merged.env, false);
      },
    },
    {
      name: "diff: an empty object is stored over an absent default and omitted over a present one",
      run() {
        assert.deepEqual(diffClaudeSettings({}, { enabledPlugins: {} }), { enabledPlugins: {} });
        assert.deepEqual(diffClaudeSettings({ enabledPlugins: { a: true } }, { enabledPlugins: {} }), {});
      },
    },
    {
      name: "diff: a differing array is stored whole, an equal one is dropped",
      run() {
        const defaults = { permissions: { allow: ["Read(*)", "Edit(*)"], deny: [] } };
        assert.deepEqual(diffClaudeSettings(defaults, { permissions: { allow: ["Read(*)"], deny: [] } }), {
          permissions: { allow: ["Read(*)"] },
        });
        assert.deepEqual(diffClaudeSettings(defaults, clone(defaults)), {});
      },
    },
    {
      name: "diff: with no defaults it is the identity (minus nulls)",
      run() {
        assert.deepEqual(diffClaudeSettings(null, SHARED), SHARED);
        assert.deepEqual(diffClaudeSettings(undefined, { a: 1, b: null }), { a: 1 });
      },
    },
    {
      name: "diff: never mutates its inputs",
      run() {
        const defaults = clone(SHARED);
        const full = { env: { ANTHROPIC_BASE_URL: "https://x" }, theme: null };
        const defaultsBefore = clone(defaults);
        const fullBefore = clone(full);
        diffClaudeSettings(defaults, full);
        assert.deepEqual(defaults, defaultsBefore);
        assert.deepEqual(full, fullBefore);
      },
    },
    {
      name: "collectInheritedPaths: reports leaves and arrays, skipping overrides and deletions",
      run() {
        const defaults = {
          env: { A: "1", B: "2" },
          model: "sonnet",
          theme: "dark",
          permissions: { allow: ["x"] },
          enabledPlugins: {},
        };
        const overrides = { env: { A: "9" }, model: null, extra: 1 };
        assert.deepEqual(collectInheritedPaths(defaults, overrides), [
          "enabledPlugins",
          "env.B",
          "permissions.allow",
          "theme",
        ]);
      },
    },
    {
      name: "collectInheritedPaths: with no overrides everything is inherited, and no value is returned",
      run() {
        const paths = collectInheritedPaths({ env: { SECRET_TOKEN: "sk-do-not-leak" } }, null);
        assert.deepEqual(paths, ["env.SECRET_TOKEN"]);
        assert.equal(JSON.stringify(paths).includes("sk-do-not-leak"), false);
        assert.deepEqual(collectInheritedPaths(null, { a: 1 }), []);
      },
    },
    {
      name: "collectDroppedPaths: reports what diff would drop, as paths",
      run() {
        const full = {
          env: { ...SHARED.env, ANTHROPIC_BASE_URL: "https://x" },
          model: "opus",
          theme: "dark",
        };
        assert.deepEqual(collectDroppedPaths(SHARED, full), [
          "env.CLAUDE_CODE_EFFORT_LEVEL",
          "env.CLAUDE_CODE_USE_VERTEX",
          "env.MCP_CONNECT_TIMEOUT_MS",
          "theme",
        ]);
        assert.deepEqual(collectDroppedPaths(null, full), []);
      },
    },
    {
      name: "property: merge(defaults, diff(defaults, x)) equals merge(defaults, x) — slimming never changes what a switch writes",
      run() {
        const random = mulberry32(0xc1a0de);
        for (let index = 0; index < 3000; index += 1) {
          const defaults = randomObject(random, 3);
          const full = randomObject(random, 3);
          const delta = diffClaudeSettings(defaults, full);
          assert.deepEqual(
            mergeClaudeSettings(defaults, delta),
            mergeClaudeSettings(defaults, full),
            `case ${index}: defaults=${JSON.stringify(defaults)} full=${JSON.stringify(full)} delta=${JSON.stringify(delta)}`
          );
        }
      },
    },
    {
      name: "property: diff is idempotent — compacting a delta changes nothing",
      run() {
        const random = mulberry32(0x1de3);
        for (let index = 0; index < 3000; index += 1) {
          const defaults = randomObject(random, 3);
          const full = randomObject(random, 3);
          const delta = diffClaudeSettings(defaults, full);
          assert.deepEqual(
            diffClaudeSettings(defaults, delta),
            delta,
            `case ${index}: defaults=${JSON.stringify(defaults)} full=${JSON.stringify(full)}`
          );
        }
      },
    },
    {
      name: "property: the merged result never contains a null object member, and inputs are untouched",
      run() {
        const random = mulberry32(0xbeef);
        for (let index = 0; index < 3000; index += 1) {
          const defaults = randomObject(random, 3);
          const overrides = randomObject(random, 3);
          const defaultsBefore = clone(defaults);
          const overridesBefore = clone(overrides);

          const merged = mergeClaudeSettings(defaults, overrides);

          assert.equal(hasNullMember(merged), false, `case ${index}: ${JSON.stringify(merged)}`);
          assert.deepEqual(defaults, defaultsBefore);
          assert.deepEqual(overrides, overridesBefore);
        }
      },
    },
    {
      name: "property: every inherited path holds the default's value in the merged result",
      run() {
        const random = mulberry32(0x5eed);
        for (let index = 0; index < 3000; index += 1) {
          const defaults = randomObject(random, 3);
          const overrides = randomObject(random, 3);
          const merged = mergeClaudeSettings(defaults, overrides);
          const cleanDefaults = mergeClaudeSettings(defaults, null);

          for (const inheritedPath of collectInheritedPaths(defaults, overrides)) {
            const effective = getPath(merged, inheritedPath);
            assert.notEqual(effective, undefined, `case ${index}: ${inheritedPath} missing from ${JSON.stringify(merged)}`);
            assert.deepEqual(effective, getPath(cleanDefaults, inheritedPath), `case ${index}: ${inheritedPath}`);
          }
        }
      },
    },
    {
      name: "property: a dropped path never appears in the delta",
      run() {
        const random = mulberry32(0xd20b);
        for (let index = 0; index < 3000; index += 1) {
          const defaults = randomObject(random, 3);
          const full = randomObject(random, 3);
          const delta = diffClaudeSettings(defaults, full);

          for (const droppedPath of collectDroppedPaths(defaults, full)) {
            assert.equal(
              getPath(delta, droppedPath),
              undefined,
              `case ${index}: ${droppedPath} dropped but present in ${JSON.stringify(delta)}`
            );
          }
        }
      },
    },
  ],
};
