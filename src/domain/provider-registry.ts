/**
 * A provider registry document: names to records, under one root key.
 *
 * The shape the two targets already store and the reason a single storage implementation can serve
 * both. What differs between them is the *record* type, which is a type parameter here and a target
 * domain type everywhere else; the envelope around it never differs.
 */
export type Registry<R> = { providers: Record<string, R> };

/**
 * How one target's records are read from and written to disk.
 *
 * A codec holds no path: it converts between parsed JSON and the registry shape, and the repo
 * supplies the file. That split is what lets `validateProvidersShape`/`sortProviders` and their
 * Claude counterparts stay where they are, as domain algorithms, without either of them growing a
 * filesystem dependency or a second serialization path.
 *
 * `encode` returns `unknown` rather than a string so a codec decides the *shape* of the document
 * while the repo owns the formatting (indent, trailing newline, atomic write). A codec that
 * returned text would be a second writer.
 */
export type RegistryCodec<R> = {
  decode: (input: unknown) => Registry<R>;
  encode: (file: Registry<R>) => unknown;
};

/**
 * What to do when the registry file is not there.
 *
 * Not a default the repo picks for itself. A missing registry is an error for `show` and an empty
 * list for `list`, and that is a target decision about the operation, not a property of the file —
 * so it is passed in at each call rather than baked into the reader.
 */
export type RegistryReadMode = "required" | "empty-if-missing";

/**
 * The parts of a registry read that differ between targets.
 *
 * Every one of these is wording or an extra diagnostic, never a different read: the file exists or
 * it does not, it parses or it does not, the key is there or it is not. Keeping the differences as
 * data is what lets one storage implementation serve both registries without a target branch inside
 * it — and what keeps the sentences in the layer that knows the target while the algorithm stays in
 * the layer that does not.
 *
 * The file's own name is deliberately absent: it comes from the target declaration, so it cannot
 * drift from the path the repo was built over.
 */
export type RegistryErrorWording<R> = {
  /** The sentence for a missing file, when the target's remedy is not "run init". */
  missingMessage?: string;
  /** The noun a missing name is described as, e.g. `Provider` or `Claude provider`. */
  notFoundSubject: string;
  /** Extra details for a missing name, beyond `provider` and `file`. */
  notFoundDetails?: (file: Registry<R>, name: string) => Record<string, unknown>;
};

/**
 * The registry as it stands after one name is dropped.
 *
 * A pure function rather than a step inside either writer, because a removal has two readers of the
 * same fact: the registry that gets written back, and the Codex plan that resolves a `--switch-to`
 * candidate out of the surviving set. One implementation, so the two cannot disagree about who is
 * left.
 */
export function withoutProvider<R>(file: Registry<R>, name: string): Registry<R> {
  const providers = { ...file.providers };
  delete providers[name];
  return { providers };
}
