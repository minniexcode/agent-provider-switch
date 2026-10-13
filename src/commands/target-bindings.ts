import { createReadWorkflows, createWriteWorkflows, expandRegistry } from "../app/provider-workflows";
import { createClaudeAdapter } from "../app/targets/claude-adapter";
import { createCodexAdapter } from "../app/targets/codex-adapter";
import {
  BoundTarget,
  ManagedFile,
  ProviderAdapter,
  ProviderCommandRequest,
  ProviderNameRequest,
  SharedMutationPaths,
} from "../app/targets/types";
import type { CommandResult } from "../app/types";
import { ProviderChoiceVerb, ProviderVerb } from "../domain/command";
import { cliError } from "../domain/errors";
import { canPrompt, confirmProviderRemoval } from "../interaction/interactive";
import { selectProvider } from "../interaction/provider-selection";
import { createRegistryRepo } from "../storage/provider-registry-repo";

/**
 * Builds the registry repo for one target, with the target's own error wording.
 *
 * The file's name comes from the target declaration rather than from a literal here, so the
 * sentence a user reads and the path the repo opened cannot disagree.
 */
function repoFor<R, E, L, M, I>(adapter: ProviderAdapter<R, E, L, M, I>, registryPath: string) {
  return createRegistryRepo<R>(registryPath, adapter.codec, {
    label: adapter.metadata.registryFile,
    ...adapter.registryErrors,
  });
}

/**
 * Binds one target's adapter to the shared workflows.
 *
 * The record type is closed over here and never escapes: `bindTarget` returns a `BoundTarget`,
 * whose only type parameters are the ones the commands layer speaks. That is what lets one
 * `Map<TargetId, BoundTarget>` hold two targets whose registries have nothing in common — without a
 * cast, an optional-field universal record, or an `any`, each of which would move the mistake from
 * a compile error to a runtime one.
 *
 * The wrapper owns what is genuinely the command line's business and not the target's: reading the
 * positional, deciding whether a prompt is allowed at all, and choosing the name. The target owns
 * what the choices say and what the failure to name one means — which is why both come from the
 * adapter rather than from a branch on a target id here.
 *
 * The target's own input type never passes through this file either: `collectAddInput()` hands its
 * value straight to `add()`, both inside this one closure, so `I` is concrete at the seam.
 */
export function bindTarget<R, E, L, M, I>(
  adapter: ProviderAdapter<R, E, L, M, I>,
  registryPath: string,
  shared: SharedMutationPaths
): BoundTarget {
  const repo = repoFor(adapter, registryPath);
  // The registry file's manifest name comes from the declaration, so a backup records the file the
  // target names rather than a literal that could drift from it.
  const registryFile: ManagedFile = { absolutePath: registryPath, relativePath: adapter.metadata.registryFile };
  const reads = createReadWorkflows(adapter, repo);
  const writes = createWriteWorkflows(adapter, repo, registryFile, shared);

  /**
   * Offers the target's providers for a verb, or answers `null` when no prompt is allowed.
   *
   * `null` rather than an error, because the two callers want different things from "could not
   * ask": a shared verb reports its own missing-name failure, and Codex `edit` has one of its own.
   */
  const chooseName = async (verb: ProviderChoiceVerb, request: ProviderNameRequest): Promise<string | null> => {
    if (!canPrompt(request.runtime, request.view.json)) {
      return null;
    }

    // The chooser's markers describe the same live state the list reports, so it reads the same
    // live state — and it reads it only here, on the path that actually prompts. An automated
    // `show` or `switch` never reaches this line and therefore never pays for a live read.
    const file = repo.read(adapter.readMode(verb));
    const live = adapter.readLive("list");
    const selection = adapter.selection(file, live, adapter.match(live, expandRegistry(adapter, file)));
    return selectProvider(request.runtime, adapter.selectionMessage(verb), selection);
  };

  /**
   * Resolves the name a verb needs: the one it was given, or one chosen interactively.
   *
   * Both spellings land in the same lookup, so there is one place a name is validated and one place
   * a missing one is reported.
   */
  const resolveName = async (request: ProviderCommandRequest, verb: ProviderVerb): Promise<string> => {
    const given = request.positionals[0] ?? null;
    if (given) {
      return given;
    }

    const chosen = await chooseName(verb, request);
    if (chosen) {
      return chosen;
    }

    const { cliErrorCode, message } = adapter.missingName(verb);
    throw cliError(cliErrorCode, message);
  };

  /** Reads the registry, collects whatever `add` still needs, and hands both to the workflow. */
  const add = async (request: ProviderCommandRequest): Promise<CommandResult> => {
    const registry = repo.read(adapter.readMode("add"));
    const collected = await adapter.collectAddInput(
      {
        name: request.positionals[0] ?? null,
        options: request.options,
        runtime: request.runtime,
        canPrompt: canPrompt(request.runtime, request.view.json),
      },
      registry
    );
    return writes.add(collected, registry);
  };

  /**
   * Refuses, confirms, then removes — in that order, which is the order both handlers used.
   *
   * The confirmation belongs here rather than in the target because it asks the same question of
   * every target; only the sentence for the non-interactive refusal is the target's.
   */
  const remove = async (request: ProviderCommandRequest): Promise<CommandResult> => {
    const name = await resolveName(request, "remove");
    const promptAllowed = canPrompt(request.runtime, request.view.json);

    if (adapter.removePolicy.requiresForce && !request.options.has("--force") && !promptAllowed) {
      throw cliError("INVALID_ARGUMENT", adapter.removePolicy.forceRequiredMessage);
    }
    if (promptAllowed) {
      await confirmProviderRemoval(request.runtime, name);
    }

    return writes.remove(name, { switchTo: request.options.value("--switch-to") });
  };

  return {
    metadata: adapter.metadata,

    chooseName,

    executeProvider: async (request: ProviderCommandRequest): Promise<CommandResult> => {
      switch (request.verb) {
        case "list":
          return reads.list();
        case "show":
          return reads.show(await resolveName(request, "show"), request.view);
        case "current":
          return reads.current();
        case "add":
          return add(request);
        case "switch":
          return writes.switchTo(await resolveName(request, "switch"));
        case "remove":
          return remove(request);
        default:
          // Every verb reaching this line has a workflow, so this is unreachable through dispatch.
          // It is spelled out rather than defaulted so that adding a verb to the shared set without
          // adding its workflow is a failure here instead of a silently empty result.
          throw cliError("UNKNOWN_COMMAND", `"${request.verb}" has no shared workflow for ${adapter.metadata.label}.`);
      }
    },
  };
}

/**
 * The composition root: the one place both targets are named, next to the paths each needs.
 *
 * Two binders rather than one table, because the halves are not interchangeable. A Claude command
 * runs without a Codex directory at all, so a combined call would either require a path that does
 * not exist or accept a placeholder for it — and a placeholder is exactly the kind of value that
 * looks like it works until a command reads it.
 *
 * Construction touches no files: each adapter closes over its paths, and every read happens inside
 * a verb. Building a binding therefore costs nothing and cannot fail.
 */
export function bindCodexTarget(paths: {
  providersPath: string;
  configPath: string;
  codexDir: string;
  authPath: string;
  shared: SharedMutationPaths;
}): BoundTarget {
  return bindTarget(
    createCodexAdapter({
      providersPath: paths.providersPath,
      configPath: paths.configPath,
      codexDir: paths.codexDir,
      authPath: paths.authPath,
    }),
    paths.providersPath,
    paths.shared
  );
}

export function bindClaudeTarget(paths: {
  claudeProvidersPath: string;
  claudeSettingsPath: string;
  defaults: Record<string, unknown> | null;
  shared: SharedMutationPaths;
}): BoundTarget {
  return bindTarget(createClaudeAdapter(paths), paths.claudeProvidersPath, paths.shared);
}
