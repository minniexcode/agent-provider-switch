import { cliError } from "../domain/errors";
import { Registry, withoutProvider } from "../domain/provider-registry";
import type { TargetId } from "../domain/target";
import { RegistryRepo } from "../storage/provider-registry-repo";
import { runMutation } from "./run-mutation";
import {
  AddInput,
  ManagedFile,
  NativePlan,
  Payload,
  ProviderAdapter,
  ProviderReadAdapter,
  RemoveOptions,
  SharedMutationPaths,
  ViewOptions,
} from "./targets/types";
import { CommandResult } from "./types";

/**
 * Expands every stored record into what a read-only command shows.
 *
 * The stored registry is what `write()` takes; this is a separate value that never goes back to it.
 * For Claude the two are genuinely different objects — the stored record is a delta and the
 * effective view is the merged settings — and returning the expanded one to the writer would
 * materialize the defaults into every record the next `remove` saved.
 *
 * Exported because the interactive chooser needs the same expansion to render the same markers the
 * list does, and re-deriving it there is how the two would drift.
 */
export function expandRegistry<R, E>(adapter: { resolve: (record: R) => E }, file: Registry<R>): Registry<E> {
  const providers: Record<string, E> = {};
  for (const [name, record] of Object.entries(file.providers)) {
    providers[name] = adapter.resolve(record);
  }
  return { providers };
}

/**
 * The read half of the shared provider workflows.
 *
 * Six workflows exist across the two CLI surfaces; three of them — `list`, `show` and `current` —
 * differ between Codex and Claude only in which of the adapter's hooks runs. This module owns the
 * *sequence*: read the registry the verb's mode asks for, expand each record into its effective
 * view, read the live state, ask the target what matches, and project the answer. No branch on a
 * target name appears here, and none may: a branch is what the adapter exists to replace.
 *
 * Nothing here prompts, takes a lock, or writes. Those belong to the caller — the binding chooses
 * names, `runMutation()` owns the transaction, and a read has no business doing either.
 */
export function createReadWorkflows<R, E, L, M>(
  adapter: ProviderReadAdapter<R, E, L, M>,
  repo: RegistryRepo<R>
): {
  list: () => Promise<CommandResult>;
  show: (name: string, view: ViewOptions) => Promise<CommandResult>;
  current: () => Promise<CommandResult>;
} {
  /** Reads the registry the way this verb's policy says it should be read. */
  const readRegistry = (verb: "list" | "show" | "current"): Registry<R> =>
    repo.read(adapter.readMode(verb));

  const effectiveRegistry = (file: Registry<R>): Registry<E> => expandRegistry(adapter, file);

  return {
    async list(): Promise<CommandResult> {
      const file = readRegistry("list");
      const providers = effectiveRegistry(file);
      const live = adapter.readLive("list");
      const match = adapter.match(live, providers);
      const rows: Payload[] = adapter
        .listOrder(file)
        .map((name) => adapter.listRow(name, file.providers[name], providers.providers[name], match));

      return { data: adapter.listData(rows, live, match) };
    },

    async show(name: string, view: ViewOptions): Promise<CommandResult> {
      const file = readRegistry("show");
      const raw = repo.find(file, name);
      // No live read on this path, on purpose: `show` answers about a registered record, and a
      // live read would make it fail — or spend I/O — on state it does not report.
      return { data: adapter.showData(name, raw, adapter.resolve(raw), view) };
    },

    async current(): Promise<CommandResult> {
      const live = adapter.readLive("current");
      // Asked before the registry is touched, because the answer can be complete without it: a
      // target whose live state says "nothing is configured here" needs no registry to say so, and
      // reading one first would turn a definite answer into an error about a file that is not the
      // subject.
      const shortCircuit = adapter.currentWithoutRegistry(live);
      if (shortCircuit !== null) {
        return { data: shortCircuit };
      }

      const match = adapter.match(live, effectiveRegistry(readRegistry("current")));
      return { data: adapter.currentData(live, match) };
    },
  };
}

/**
 * De-duplicates the files one mutation writes, by absolute path, first sighting wins.
 *
 * A registry path that also appears in a target's native plan is one file, not two, and listing it
 * twice would have `runMutation` back it up twice and compute its allowed roots from a set it did
 * not need to grow.
 */
export function uniqueManagedFiles(files: ManagedFile[]): ManagedFile[] {
  const seen = new Set<string>();
  const unique: ManagedFile[] = [];
  for (const file of files) {
    if (seen.has(file.absolutePath)) {
      continue;
    }
    seen.add(file.absolutePath);
    unique.push(file);
  }
  return unique;
}

/**
 * The one mutation boundary every provider write goes through (design §8).
 *
 * The registry is written first and the native plan second, inside a single lock, backup and
 * rollback. That order is the one both targets already used: a plan that refuses — Codex's missing
 * `base_url`, for instance — leaves a registry that was already rewritten and rolled back, which is
 * the same state the caller started from, whereas the reverse order would leave native state
 * pointing at a record that no longer exists.
 *
 * `nextRegistry` being absent is the switch case, and it is not an optimisation: a switch changes
 * which record is *in use*, never the set of them, so listing the registry file would back up a
 * file this operation does not write.
 */
export function commitProviderChange<R>(args: {
  shared: SharedMutationPaths;
  target: TargetId;
  operation: string;
  repo: RegistryRepo<R>;
  registryFile: ManagedFile;
  nextRegistry?: Registry<R>;
  native: NativePlan;
}): CommandResult {
  const nextRegistry = args.nextRegistry;
  const result = runMutation({
    ...args.shared,
    target: args.target,
    operation: args.operation,
    files: uniqueManagedFiles([
      ...(nextRegistry ? [args.registryFile] : []),
      ...args.native.files,
    ]),
    mutate: () => {
      if (nextRegistry) {
        args.repo.write(nextRegistry);
      }
      return args.native.applyNative();
    },
  });

  return {
    data: result.data,
    warnings: [...(args.native.warnings ?? []), ...result.warnings],
  };
}

/**
 * The write half of the shared provider workflows.
 *
 * The three verbs differ in what the registry read is for — a duplicate check, a lookup whose
 * result is not rewritten, a lookup whose record is dropped — and in what the target does natively.
 * Everything else is one sequence, and the `default` case is spelled out so a verb added to the
 * shared set without a workflow fails here rather than silently returning nothing.
 */
export function createWriteWorkflows<R, E, L, M, I>(
  adapter: ProviderAdapter<R, E, L, M, I>,
  repo: RegistryRepo<R>,
  registryFile: ManagedFile,
  shared: SharedMutationPaths
): {
  add: (collected: AddInput<I>, registry: Registry<R>) => Promise<CommandResult>;
  switchTo: (name: string) => Promise<CommandResult>;
  remove: (name: string, options: RemoveOptions) => Promise<CommandResult>;
} {
  const commit = (args: { operation: string; native: NativePlan; nextRegistry?: Registry<R> }): CommandResult =>
    commitProviderChange<R>({
      shared,
      target: adapter.metadata.id,
      operation: args.operation,
      repo,
      registryFile,
      nextRegistry: args.nextRegistry,
      native: args.native,
    });

  return {
    async add(collected: AddInput<I>, registry: Registry<R>): Promise<CommandResult> {
      const { name, input } = collected;
      // Checked before the plan is built, because "this name is taken" is a property of the
      // registry alone and should not be reported after a prompt-like flow has already run — and
      // because a plan that read native state for a name that cannot be added is work thrown away.
      if (registry.providers[name]) {
        const { cliErrorCode, message, details } = adapter.duplicateProvider(name);
        throw details === undefined ? cliError(cliErrorCode, message) : cliError(cliErrorCode, message, details);
      }

      const { record, native } = adapter.prepareAdd(name, input);
      return commit({
        operation: adapter.mutationOperation("add"),
        nextRegistry: { providers: { ...registry.providers, [name]: record } },
        native,
      });
    },

    async switchTo(name: string): Promise<CommandResult> {
      const file = repo.read(adapter.readMode("switch"));
      const raw = repo.find(file, name);
      return commit({
        operation: adapter.mutationOperation("switch"),
        native: adapter.planSwitch(name, raw, adapter.resolve(raw)),
      });
    },

    async remove(name: string, options: RemoveOptions): Promise<CommandResult> {
      const file = repo.read(adapter.readMode("remove"));
      const raw = repo.find(file, name);
      return commit({
        operation: adapter.mutationOperation("remove"),
        nextRegistry: withoutProvider(file, name),
        native: adapter.planRemove(name, raw, file, options),
      });
    },
  };
}
