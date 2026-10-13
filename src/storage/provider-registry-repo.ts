import * as fs from "node:fs";
import { cliError, normalizeError } from "../domain/errors";
import {
  Registry,
  RegistryCodec,
  RegistryErrorWording,
  RegistryReadMode,
} from "../domain/provider-registry";
import { writeTextFileAtomic } from "./fs-utils";

/**
 * The wording a registry read uses, plus the file it is about.
 *
 * The label is separate from the wording so a binding can take it from the target declaration
 * rather than restating it next to the path.
 */
export type RegistryErrorPolicy<R> = RegistryErrorWording<R> & {
  /** The file's name as the user sees it, in the messages raised for it. */
  label: string;
};

/**
 * A registry file, read and written as one document.
 *
 * `read()` returns the file as stored, never a resolved view of it. For Claude that is load-bearing:
 * `settings` is a delta, and `remove` reads the whole file, drops one key, and writes it back — a
 * reader that merged the defaults in would expand them into every surviving record. Whatever a
 * caller resolves is a *different* value, produced by the target domain functions and never handed
 * back to `write()`.
 */
export type RegistryRepo<R> = {
  read: (mode: RegistryReadMode) => Registry<R>;
  find: (file: Registry<R>, name: string) => R;
  write: (file: Registry<R>) => void;
};

/**
 * Builds a repo over one registry path and one target's codec.
 */
export function createRegistryRepo<R>(
  path: string,
  codec: RegistryCodec<R>,
  errorPolicy: RegistryErrorPolicy<R>
): RegistryRepo<R> {
  const read = (mode: RegistryReadMode): Registry<R> => {
    if (!fs.existsSync(path)) {
      if (mode === "empty-if-missing") {
        return { providers: {} };
      }
      throw cliError(
        "PROVIDERS_NOT_FOUND",
        errorPolicy.missingMessage ?? `${errorPolicy.label} does not exist.`,
        { file: path }
      );
    }

    const raw = fs.readFileSync(path, "utf8");
    try {
      return codec.decode(JSON.parse(raw));
    } catch (error: unknown) {
      // Both the JSON parse and the shape validation land here: to a caller they are one failure —
      // this file cannot be read as a registry — and the cause carries the distinction.
      throw cliError("PROVIDERS_PARSE_ERROR", `Failed to parse ${errorPolicy.label}.`, {
        file: path,
        cause: normalizeError(error).message,
      });
    }
  };

  const find = (file: Registry<R>, name: string): R => {
    const record = file.providers[name];
    if (!record) {
      throw cliError("PROVIDER_NOT_FOUND", `${errorPolicy.notFoundSubject} "${name}" was not found.`, {
        provider: name,
        file: path,
        ...errorPolicy.notFoundDetails?.(file, name),
      });
    }
    return record;
  };

  const write = (file: Registry<R>): void => {
    writeTextFileAtomic(path, `${JSON.stringify(codec.encode(file), null, 2)}\n`);
  };

  return { read, find, write };
}
