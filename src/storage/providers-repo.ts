import { ProviderRecord } from "../domain/providers";
import {
  ProvidersFile,
  cleanProviderRecord,
  sortProviders,
  validateProvidersShape,
} from "../domain/providers";
import { RegistryRepo, createRegistryRepo } from "./provider-registry-repo";

/**
 * The Codex registry as a generic repo over its own codec.
 *
 * Every function below is a facade: the reading, parsing, typed-error wrapping and atomic write are
 * the shared implementation's, and this module contributes only what is Codex's — its record type,
 * its codec, and the wording of its errors. The exports keep their signatures because `edit`,
 * `import`, `export` and the compact path still call them; collapsing those callers onto the repo
 * directly is a later stage's job, not a reason to leave two read implementations in the meantime.
 */
function repoFor(providersPath: string): RegistryRepo<ProviderRecord> {
  return createRegistryRepo<ProviderRecord>(
    providersPath,
    { decode: validateProvidersShape, encode: sortProviders },
    { label: "providers.json", notFoundSubject: "Provider" }
  );
}

/**
 * Reads and validates providers.json from disk.
 */
export function readProvidersFile(providersPath: string): ProvidersFile {
  return repoFor(providersPath).read("required");
}

/**
 * Reads providers.json when it exists, otherwise returns an empty registry.
 */
export function readProvidersFileIfExists(providersPath: string): ProvidersFile {
  return repoFor(providersPath).read("empty-if-missing");
}

/**
 * Persists providers.json using deterministic key ordering.
 */
export function writeProvidersFile(providersPath: string, providers: ProvidersFile): void {
  repoFor(providersPath).write(providers);
}

/**
 * Returns a single provider record or throws a typed not-found error.
 */
export function readProviderRecord(providersPath: string, providerName: string): ProviderRecord {
  const repo = repoFor(providersPath);
  return repo.find(repo.read("required"), providerName);
}

/**
 * Merges imported providers into the current registry, preferring the imported side on conflicts.
 */
export function mergeProviders(current: ProvidersFile, imported: ProvidersFile): ProvidersFile {
  const providers: Record<string, ProviderRecord> = {};
  for (const [name, record] of Object.entries(current.providers)) {
    providers[name] = cleanProviderRecord(record);
  }
  for (const [name, record] of Object.entries(imported.providers)) {
    providers[name] = cleanProviderRecord(record);
  }

  return sortProviders({ providers });
}
