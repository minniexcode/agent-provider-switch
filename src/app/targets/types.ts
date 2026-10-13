import type { ProviderChoiceVerb, ProviderVerb } from "../../domain/command";
import type { ErrorCode } from "../../domain/errors";
import type {
  Registry,
  RegistryCodec,
  RegistryErrorWording,
  RegistryReadMode,
} from "../../domain/provider-registry";
import type { Finding, TargetReport } from "../../domain/report";
import type { TargetMetadata } from "../../domain/target";
import type { CliPromptRuntime } from "../../interaction/prompt";
import type { ToolConfigInspection } from "../inspect-tool-config";
import type { CommandResult } from "../types";

/**
 * A file a mutation writes, named the way a backup manifest names it.
 *
 * Both halves are carried because they serve different masters: the absolute path is what the
 * mutation writes and rolls back, and the relative path is what the manifest records so a restore
 * can be rejected when it resolves outside its allowed root.
 */
export type ManagedFile = { absolutePath: string; relativePath: string };

/**
 * The open-ended half of a command result.
 *
 * `Record<string, unknown>` rather than a per-target payload type, and deliberately the same shape
 * as `CommandResult.data`: the JSON a command prints is a target's business, and a shared interface
 * that typed every Codex and Claude field would be a type both targets had to satisfy whether or
 * not they had anything to put in it.
 */
export type Payload = Record<string, unknown>;

/**
 * What the caller asked to see.
 *
 * `json` is also the secret-inclusion switch on the Codex `show` path, which is a documented
 * automation contract rather than a nuance: `--json` returns the real `apiKey`. It is passed as
 * data so the adapter can honour it without the workflow knowing which target masks what.
 */
export type ViewOptions = { json: boolean; reveal: boolean };

/** The already-resolved options `remove` needs. */
export type RemoveOptions = { switchTo: string | null };

/**
 * A target's own changes, ready to apply.
 *
 * The plan closes over whatever native state it read while being built — parsed TOML, a settings
 * document, a resolved path — so the shared layer can apply it without knowing which target it is
 * applying. It may read native configuration while being built; it may not read or write the
 * registry, take the lock, or run the shared error flow, all of which belong to the caller.
 */
export type NativePlan = {
  files: ManagedFile[];
  applyNative: () => Payload;
  warnings?: string[];
};

/**
 * The lock and the backups tree: shared by both targets, owned by neither.
 *
 * A narrowed type rather than the whole tool home, so a workflow cannot reach for the tool config
 * or a target's registry through the paths it was handed to write with.
 */
export type SharedMutationPaths = {
  lockPath: string;
  backupsDir: string;
  latestBackupPath: string;
};

/**
 * A refusal a target describes as data rather than raising itself.
 *
 * The shared layer owns the raising, because that is where the refusal is reached; the target owns
 * its code and its sentence, because only it knows which condition this is and how to describe it.
 * The field is named for the call it feeds — `cliError(cliErrorCode, ...)` — rather than `code`,
 * which in this tree also names the informational issues a report carries and would therefore be
 * ambiguous to a reader and to the census that checks every declared code still has a producer.
 */
export type DeclaredRefusal = {
  cliErrorCode: ErrorCode;
  message: string;
  details?: Payload;
};

/** One name the user can choose. */
export type ProviderChoice = {
  value: string;
  label: string;
  hint?: string;
};

/**
 * The data an interactive name prompt needs, in the target's own words.
 *
 * `emptyMessage` travels with the choices rather than being raised here because the two targets
 * name different remedies — one says to run `add`, the other to register anything at all — and the
 * error code they share is the point of the shared vocabulary, not a shared sentence.
 */
export type ProviderSelectionData = {
  choices: ProviderChoice[];
  emptyMessage: string;
};

/**
 * What a target contributes to the shared provider workflows.
 *
 * `R`, `E`, `L` and `M` are the stored record, the effective view, the live state and the matching
 * result. They stay target-specific on purpose: Codex has no defaults to merge and matches a live
 * `model_provider` against a profile, Claude stores a delta and matches an identity, and a shared
 * record type would have to be both. Only the *steps* are shared — read, resolve, match, project —
 * and each target supplies its own answer to each.
 */
export type ProviderReadAdapter<R, E, L, M> = {
  metadata: TargetMetadata;
  codec: RegistryCodec<R>;
  /**
   * This target's wording for the three registry failures.
   *
   * The file's name is *not* here: the binding takes it from `metadata.registryFile`, so the
   * sentence a user reads cannot disagree with the path the repo was built over.
   */
  registryErrors: RegistryErrorWording<R>;
  /** Which read a verb needs: `list` is lenient where `show` is not, and that is per target. */
  readMode: (verb: ProviderChoiceVerb) => RegistryReadMode;
  /**
   * Reads the live state a verb needs.
   *
   * `"list"` is the lenient read the interactive chooser also uses: it renders the same "current"
   * markers as the list, and it must not fail when the live file is absent.
   */
  readLive: (verb: "list" | "current") => L;
  /** Expands one stored record into what a read-only command shows. Never writes. */
  resolve: (record: R) => E;
  /** Asks the live state which registered provider, if any, is in use. */
  match: (live: L, providers: Registry<E>) => M;
  /**
   * The order `list` renders its rows in.
   *
   * A hook rather than a rule because the two targets genuinely differ: Codex sorts the names it
   * read, and Claude renders the registry in the order the file holds.
   */
  listOrder: (file: Registry<R>) => string[];
  listRow: (name: string, raw: R, effective: E, match: M) => Payload;
  listData: (rows: Payload[], live: L, match: M) => Payload;
  showData: (name: string, raw: R, effective: E, view: ViewOptions) => Payload;
  /**
   * The result `current` can produce without reading the registry, or `null` to carry on.
   *
   * Only for short circuits the live state already answers, such as a Claude run with no
   * `settings.json` at all. A target with nothing to short-circuit returns `null` — and `show`
   * never consults this, so a name lookup does not acquire a live read it did not have.
   */
  currentWithoutRegistry: (live: L) => Payload | null;
  currentData: (live: L, match: M) => Payload;
  /** The choices an interactive name prompt offers, built from the data the workflow already read. */
  selection: (file: Registry<R>, live: L, match: M) => ProviderSelectionData;
  /** The prompt sentence for a verb, in this target's words. */
  selectionMessage: (verb: ProviderChoiceVerb) => string;
  /** The failure for a verb that needed a name and was given none. */
  missingName: (verb: ProviderVerb) => DeclaredRefusal;
};

/**
 * The option values one invocation supplied, read by the target that understands them.
 *
 * A narrow accessor rather than the parser's map, so a target reads option values the way the
 * commands layer does — last value wins for a single-valued flag, in order for a repeatable one —
 * without either side handing the other its argument vocabulary.
 */
export type ProviderOptionBag = {
  value: (flag: string) => string | null;
  values: (flag: string) => string[];
  has: (flag: string) => boolean;
};

/** The write verbs, which are the three whose operation name a backup manifest records. */
export type ProviderMutationVerb = Extract<ProviderVerb, "add" | "switch" | "remove">;

/**
 * What an `add` invocation offers a target before it has settled on a record.
 *
 * The name is separate from the options because it arrives as a positional, and `canPrompt` is
 * decided once by the caller rather than re-derived here: the CLI's rule for "may this invocation
 * prompt at all" is one rule, and two spellings of it are how the two drift.
 */
export type AddRequest = {
  /** The name from the command line, or `null` when it was omitted. */
  name: string | null;
  options: ProviderOptionBag;
  runtime: CliPromptRuntime;
  canPrompt: boolean;
};

/** The name and the target's own input an `add` invocation settled on. */
export type AddInput<I> = { name: string; input: I };

/** A record to store, beside the native changes that go with it. */
export type NativeRecordPlan<R> = { record: R; native: NativePlan };

/**
 * The write half of a target's contribution to the shared provider workflows.
 *
 * `I` is the target's own input — the fields its collector gathers and its `prepareAdd` reads. It
 * stays a parameter because the two targets collect different things, and the seam between
 * `collectAddInput` and `prepareAdd` sits inside one closure where `I` is still concrete, so the
 * type is never erased on the way through.
 */
export type ProviderWriteAdapter<R, E, I> = {
  /** The operation name a backup manifest records; `add`/`switch`/`remove` and the Claude prefixes. */
  mutationOperation: (verb: ProviderMutationVerb) => string;
  /**
   * Gathers the values `add` needs, prompting for the ones the invocation omitted.
   *
   * The registry is passed in so a collector can reject a name that is already taken while it is
   * being typed, rather than after the prompt has finished. Nothing is written here.
   */
  collectAddInput: (request: AddRequest, registry: Registry<R>) => Promise<AddInput<I>>;
  /** Turns settled values into the record to store and the native changes to apply with it. */
  prepareAdd: (name: string, input: I) => NativeRecordPlan<R>;
  /** The refusal for a name that is already taken, in this target's words. */
  duplicateProvider: (name: string) => DeclaredRefusal;
  /** The native changes a switch applies. A switch never rewrites the registry. */
  planSwitch: (name: string, raw: R, effective: E) => NativePlan;
  /** The native changes a remove applies, given the registry exactly as it was read. */
  planRemove: (name: string, raw: R, registry: Registry<R>, options: RemoveOptions) => NativePlan;
  /**
   * What `remove` requires of an invocation that cannot confirm interactively.
   *
   * Data rather than a check, because both targets ask the same question and only the sentence
   * differs: the caller owns the `canPrompt()` rule and the target owns its wording.
   */
  removePolicy: { requiresForce: boolean; forceRequiredMessage: string };
};

/**
 * Everything one target contributes to the shared workflows, read and write.
 */
export type ProviderAdapter<R, E, L, M, I> = ProviderReadAdapter<R, E, L, M> & ProviderWriteAdapter<R, E, I>;

/**
 * A command line already normalized by the `commands` layer.
 *
 * Verbs, positionals and options only: no argv, no `ParsedCommand`. That boundary is what keeps the
 * app layer free of the CLI's argument vocabulary while still letting one wrapper serve every
 * target.
 */
export type ProviderCommandRequest = {
  verb: ProviderVerb;
  positionals: string[];
  view: ViewOptions;
  runtime: CliPromptRuntime;
  /** The option values this invocation supplied, as the parser recorded them. */
  options: ProviderOptionBag;
  /** The lock and the backups tree, which both targets share and neither owns. */
  shared: SharedMutationPaths;
};

/**
 * One target, bound to its adapter and workflows, with its record type closed over.
 *
 * This is the type the dispatch table holds: `Map<TargetId, BoundTarget>`. The record type never
 * escapes, which is what lets one map hold two targets whose registries have nothing in common —
 * without a cast, an optional-field universal record, or an `any`.
 */
export type BoundTarget = {
  metadata: TargetMetadata;
  executeProvider: (request: ProviderCommandRequest) => Promise<CommandResult>;
  /**
   * Offers this target's providers for a verb that needs a name, or `null` when no prompt is allowed.
   *
   * The same chooser `executeProvider` uses, exposed for the target-exclusive commands that take a
   * provider name without being one of the six shared verbs — Codex `edit` is the only one — so the
   * choices a user sees cannot differ between an `edit` and a `switch`.
   */
  chooseName: (verb: ProviderChoiceVerb, request: ProviderNameRequest) => Promise<string | null>;
};

/**
 * The parts of a request an interactive name prompt reads.
 *
 * Narrower than {@link ProviderCommandRequest} on purpose: the chooser is also reachable from a
 * target-exclusive verb, which has no business handing over a verb token the shared dispatcher
 * would then have to refuse.
 */
export type ProviderNameRequest = Pick<ProviderCommandRequest, "positionals" | "view" | "runtime">;

/**
 * Which report is being composed.
 *
 * The one difference between the two commands, and it is a difference in *checks* rather than in
 * shape: `doctor` runs the checks a target can only run against a live installation, and `status`
 * reports the same sections without them. Passing it to the collector rather than letting the
 * composer add findings afterwards keeps those checks inside the target that owns them — the Codex
 * runtime probe reads Codex state, and nothing outside that target should have to know it ran.
 */
export type ReportMode = "status" | "doctor";

/**
 * What one target contributes to a report.
 *
 * The section is the target's own half of the payload; the three finding lists stay separate
 * because they mean different things downstream — only `issues` decides `healthy`, only `notes` is
 * printed without judgement, and `warnings` travel on the envelope rather than inside the report.
 *
 * `readings` is what `complete` is computed from, carried rather than inferred from the section: a
 * target may keep a reading beside the section when folding it in would lose the distinction
 * between "nothing configured" and "could not look".
 */
export type TargetReportContribution = {
  section: TargetReport;
  issues: Finding[];
  notes: Finding[];
  warnings: string[];
  readings: unknown[];
};

/**
 * The shared inputs every collector reads, assembled once by the composer.
 *
 * Read here rather than by each collector, because the tool config and the tool home are facts
 * about the installation rather than about a target: reading them per target would inspect one file
 * twice and let the two readings disagree.
 */
export type ReportContext = {
  mode: ReportMode;
  toolHomeRoot: string;
  toolConfig: ToolConfigInspection;
};

/**
 * One target's report adapter.
 *
 * The pairing of a target with the collector that builds its section, so the composer can iterate
 * the selected targets without naming one. A target missing from the map is an internal error, not
 * a reason to fall back to another target's section.
 */
export type TargetReportPort = {
  metadata: TargetMetadata;
  collect: (context: ReportContext) => Promise<TargetReportContribution>;
};
