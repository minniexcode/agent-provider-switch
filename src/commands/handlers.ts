import * as fs from "node:fs";
import { collectReport } from "../app/collect-target-reports";
import { editProvider } from "../app/edit-provider";
import { exportProviders } from "../app/export-providers";
import { inspectToolConfig } from "../app/inspect-tool-config";
import { initCodex } from "../app/init-codex";
import { importProviders } from "../app/import-providers";
import { listConfigProfilesView } from "../app/list-config-profiles";
import { listBackupEntries } from "../app/list-backups";
import { pruneBackupEntries, resolveBackupRetention } from "../app/prune-backups";
import { rollbackBackup } from "../app/rollback-backup";
import { migrateCodex } from "../app/setup-codex";
import { showConfig } from "../app/show-config";
import { unlockLock } from "../app/unlock-lock";
import { buildManagedProfileViews } from "../domain/config";
import { createBackupOwnership } from "../domain/backups";
import { cliError } from "../domain/errors";
import { routesToClaudeHandler } from "../domain/target";
import { collectMigrateAdoptability, SetupProviderDetails } from "../domain/setup";
import { validateProvidersShape } from "../domain/providers";
import {
  canPrompt,
  chooseCodexDir,
  chooseSetupProfiles,
  chooseSetupStrategy,
  collectEditInput,
  collectSetupProviderDetails,
  confirmExportOverwrite,
  confirmImport,
  confirmRollback,
  exportTargetExists,
} from "../interaction/interactive";
import { createPromptRuntime } from "../interaction/prompt";
import { createReportPorts } from "../app/targets/report-ports";
import { findCodexDirCandidates, readStructuredConfig } from "../storage/config-repo";
import { createClaudePaths } from "../storage/claude-paths";
import { createCodexPaths } from "../storage/codex-paths";
import { resolveLockPath, TOOL_CONFIG_FILENAME } from "../storage/tool-home-paths";
import { mergeProviders, readProvidersFileIfExists } from "../storage/providers-repo";
import { createOptionBag, getSingleOption, hasFlag } from "./args";
import { bindCodexTarget } from "./target-bindings";
import { handleClaudeCommand } from "./claude-handlers";
import { CommandExecutionContext, ParsedCommand } from "./types";

/**
 * Executes one command handler selected from the shared command registry.
 */
export async function handleRegisteredCommand(
  ctx: CommandExecutionContext,
  parsed: ParsedCommand,
  runtime = createPromptRuntime()
): Promise<import("../app/types").CommandResult> {
  // The flag guards have already run — `executeCommand` calls them, because the guard's refusal
  // has to be raised while the context still carries a definite scope, and because it must land
  // before the early-return below (which would otherwise let `switch --claude --full` through and
  // reach a handler that ignores `--full`).
  //
  // Routing reads the normalized selection rather than the flags, so `--claude` and
  // `--target claude` cannot take different paths. `routesToClaudeHandler()` is what keeps `both`
  // out: `doctor`, `status`, and `backups list` accept a Claude selection and must still reach
  // their own handler, because no Claude service could produce the whole answer.
  if (
    parsed.targetSelection.kind === "explicit" &&
    parsed.targetSelection.id === "claude" &&
    routesToClaudeHandler(ctx.command)
  ) {
    return handleClaudeCommand(ctx, parsed, runtime);
  }

  // `config compact` used to be refused here, for the `--claude` it was missing. The scope
  // resolver refuses it earlier now, before any file is read — which is also where the requirement
  // belongs, since the same declaration produces the help text for it.

  // The lock lives in the tool home rather than in a Codex directory, so unlock has to run
  // before the codexDir guard below. Requiring a Codex directory to clear a lock would make
  // the command unusable in the situation it exists for.
  if (ctx.command === "unlock") {
    return unlockLock({
      lockPath: resolveLockPath(),
      force: hasFlag(parsed.commandOptions, "--force"),
    });
  }

  const packageVersion = (require("../../package.json") as { version?: string }).version ?? "0.0.0";
  if (!ctx.options.codexDir) {
    throw cliError("CODEX_DIR_NOT_FOUND", "No Codex directory could be resolved.");
  }
  let setupPaths = createCodexPaths(ctx.options.codexDir);
  const paths = setupPaths;

  // Both targets' paths, and the ownership table a backup is classified against. Resolved once here
  // rather than per case: `doctor`, `status`, `backups list`, and `rollback` all need the Claude
  // root, and the root is what a classification must not read from the manifest it is judging.
  //
  // The table is built from the same declarations the rest of the tool reads, so a target's registry
  // name is stated once. The tool home is not one of the roots on purpose — it holds both registries,
  // so containment in it says nothing about ownership; the artifact names are what decide.
  const claudePaths = createClaudePaths(paths.toolHomeDir);
  const backupOwnership = createBackupOwnership({
    roots: [
      { target: "codex", root: paths.codexDir },
      { target: "claude", root: claudePaths.claudeDir },
    ],
    sharedArtifacts: [TOOL_CONFIG_FILENAME],
    toolHomeDir: paths.toolHomeDir,
  });

  /** The lock and backups tree Codex mutations run under, shared with every other target. */
  const shared = {
    lockPath: paths.lockPath,
    backupsDir: paths.backupsDir,
    latestBackupPath: paths.latestBackupPath,
  };
  const codexTarget = () =>
    bindCodexTarget({
      providersPath: paths.providersPath,
      configPath: paths.configPath,
      codexDir: paths.codexDir,
      authPath: paths.authPath,
      shared,
    });
  /** The request shape every shared verb takes, built from this invocation. */
  const providerRequest = (verb: import("../domain/command").ProviderVerb) => ({
    verb,
    positionals: parsed.positionals,
    view: { json: ctx.options.json, reveal: ctx.options.reveal },
    runtime,
    options: createOptionBag(parsed.commandOptions),
    shared,
  });

  switch (ctx.command) {
    // The six provider verbs go through the shared workflows. Which target runs is already settled —
    // a Claude selection was routed to the Claude handler above — so this asks by id and lets the
    // verb pick the workflow. The scope resolver is what makes that a definite answer rather than
    // an assumption about reaching this line.
    case "list":
    case "show":
    case "current":
    case "add":
    case "switch":
    case "remove": {
      return codexTarget().executeProvider(providerRequest(ctx.command));
    }
    // `status` and `doctor` publish the same report — same sections, same shared block, same health
    // fields — so they are one composition with one difference: the mode, which decides which checks
    // the target collectors run. Split into two cases again, they would be two chances for the two
    // payloads to drift.
    case "status":
    case "doctor": {
      return collectReport({
        mode: ctx.command === "doctor" ? "doctor" : "status",
        targets: ctx.targets,
        toolHomeRoot: paths.toolHomeDir,
        toolConfig: ctx.toolConfigInspection ?? inspectToolConfig(paths.toolConfigPath),
        lockPath: paths.lockPath,
        ports: createReportPorts({
          codex: {
            providersPath: paths.providersPath,
            codexDir: ctx.codexDirUnavailableReason ? null : paths.codexDir,
            codexDirUnavailableReason: ctx.codexDirUnavailableReason ?? null,
          },
          claude: {
            claudeDir: claudePaths.claudeDir,
            claudeProvidersPath: claudePaths.claudeProvidersPath,
            claudeSettingsPath: claudePaths.claudeSettingsPath,
          },
        }),
      });
    }
    case "init": {
      return initCodex({
        toolHomeDir: setupPaths.toolHomeDir,
        toolConfigPath: setupPaths.toolConfigPath,
        providersPath: setupPaths.providersPath,
        version: packageVersion,
        defaultCodexDir: ctx.options.codexDirExplicit ? setupPaths.codexDir : null,
      });
    }
    case "config-show":
      return showConfig({
        configPath: paths.configPath,
        providersPath: paths.providersPath,
        profileName: parsed.positionals[0] ?? null,
      });
    case "config-list-profiles":
      return listConfigProfilesView({
        configPath: paths.configPath,
        providersPath: paths.providersPath,
      });
    case "import": {
      const sourceFile = parsed.positionals[0];
      if (!sourceFile) {
        throw cliError("INVALID_ARGUMENT", "Missing import file path.");
      }
      const merge = hasFlag(parsed.commandOptions, "--merge");
      if (canPrompt(runtime, ctx.options.json)) {
        await confirmImport(runtime, sourceFile, merge);
        const document = readStructuredConfig(paths.configPath);
        const imported = validateProvidersShape(JSON.parse(fs.readFileSync(sourceFile, "utf8")));
        const current = readProvidersFileIfExists(paths.providersPath);
        const next = merge ? mergeProviders(current, imported) : imported;
        // Precompute orphaned references during confirmation so the interactive path fails before mutation.
        buildManagedProfileViews(document, next)
          .filter((view) => view.source === "orphaned-reference")
          .map((view) => view.name)
          .sort();
      }

      return importProviders({
        codexDir: paths.codexDir,
        lockPath: paths.lockPath,
        backupsDir: paths.backupsDir,
        latestBackupPath: paths.latestBackupPath,
        providersPath: paths.providersPath,
        configPath: paths.configPath,
        sourceFile,
        merge,
      });
    }
    case "export": {
      const targetFile = parsed.positionals[0];
      if (!targetFile) {
        throw cliError("INVALID_ARGUMENT", "Missing export file path.");
      }

      let force = hasFlag(parsed.commandOptions, "--force");
      if (!force && canPrompt(runtime, ctx.options.json) && exportTargetExists(targetFile)) {
        const confirmed = await confirmExportOverwrite(runtime, targetFile);
        if (!confirmed) {
          throw cliError("PROMPT_CANCELLED", "Export cancelled.");
        }
        force = true;
      }

      return exportProviders({
        providersPath: paths.providersPath,
        targetFile,
        force,
      });
    }
    case "edit": {
      // `edit` is not one of the six shared verbs, so it is dispatched here rather than by target
      // id — but the chooser it offers is the binding's, so a user sees the same names, markers and
      // order whether they are editing a provider or switching to one.
      // Annotated `string | null`: with the index signature unchecked, `positionals[0] ?? null` is
      // typed `string`, which would make the assignment below unreachable to the checker.
      let providerName: string | null = parsed.positionals[0] ?? null;
      if (!providerName) {
        providerName = await codexTarget().chooseName("edit", {
          positionals: parsed.positionals,
          view: { json: ctx.options.json, reveal: ctx.options.reveal },
          runtime,
        });
      }

      if (!providerName) {
        throw cliError("INVALID_ARGUMENT", "Missing provider name for edit command.");
      }

      let profile: string | undefined = getSingleOption(parsed.commandOptions, "--profile") ?? undefined;
      let apiKey: string | undefined = getSingleOption(parsed.commandOptions, "--api-key") ?? undefined;
      let baseUrl: string | undefined = getSingleOption(parsed.commandOptions, "--base-url") ?? undefined;
      let model: string | undefined = getSingleOption(parsed.commandOptions, "--model") ?? undefined;
      let note: string | undefined = getSingleOption(parsed.commandOptions, "--note") ?? undefined;
      let tags: string[] | undefined = parsed.commandOptions.has("--tag") ? parsed.commandOptions.get("--tag") ?? [] : undefined;
      const createProfile = hasFlag(parsed.commandOptions, "--create-profile");
      const switchToProfile = getSingleOption(parsed.commandOptions, "--switch-to") ?? undefined;

      // `--create-profile` is an action in its own right, because it writes a section the default
      // projection does not. Counting it here keeps `aps edit p --create-profile` from being
      // refused as an empty update, and suppresses the interactive collector — prompting for fields
      // after an explicit flag would be the command second-guessing the invocation.
      const hasEditAction =
        profile !== undefined ||
        apiKey !== undefined ||
        baseUrl !== undefined ||
        model !== undefined ||
        note !== undefined ||
        tags !== undefined ||
        createProfile;

      if (!hasEditAction && canPrompt(runtime, ctx.options.json)) {
        const provider = readProvidersFileIfExists(paths.providersPath).providers[providerName];
        if (!provider) {
          throw cliError("PROVIDER_NOT_FOUND", `Provider "${providerName}" was not found.`);
        }
        // Prompted edit starts from the stored record so blank answers can safely preserve current values.
        const prompted = await collectEditInput(runtime, provider);
        profile = prompted.profile;
        apiKey = prompted.apiKey;
        baseUrl = prompted.baseUrl;
        note = prompted.note;
        tags = prompted.tags;
      }

      if (!hasEditAction) {
        throw cliError("INVALID_ARGUMENT", "edit requires at least one field to update.");
      }

      return editProvider({
        codexDir: paths.codexDir,
        lockPath: paths.lockPath,
        backupsDir: paths.backupsDir,
        latestBackupPath: paths.latestBackupPath,
        providersPath: paths.providersPath,
        configPath: paths.configPath,
        authPath: paths.authPath,
        providerName,
        profile,
        apiKey,
        baseUrl,
        model,
        note,
        tags,
        createProfile,
        switchToProfile,
      });
    }
    case "migrate": {
      let codexDir = ctx.options.codexDir;
      const candidates = findCodexDirCandidates(ctx.options.codexDirExplicit ? ctx.options.codexDir : null);
      if (!ctx.options.codexDirExplicit) {
        if (candidates.length > 1) {
          if (!canPrompt(runtime, ctx.options.json)) {
            throw cliError("CODEX_DIR_AMBIGUOUS", "Multiple Codex directories were found.", {
              candidates,
            });
          }
          // Ambiguous auto-discovery must be resolved before path-dependent flags are interpreted.
          codexDir = await chooseCodexDir(runtime, candidates);
        } else if (candidates.length === 0) {
          if (!canPrompt(runtime, ctx.options.json)) {
            throw cliError("CODEX_DIR_NOT_FOUND", "No Codex directory could be found.");
          }
          codexDir = await chooseCodexDir(runtime, candidates);
        } else {
          codexDir = candidates[0];
        }
      }
      setupPaths = createCodexPaths(codexDir);
      const overwrite = hasFlag(parsed.commandOptions, "--overwrite");
      const merge = hasFlag(parsed.commandOptions, "--merge");
      if (overwrite && merge) {
        throw cliError("INVALID_ARGUMENT", "migrate does not allow both --merge and --overwrite.");
      }

      const providersExists = fs.existsSync(setupPaths.providersPath);
      const document = readStructuredConfig(setupPaths.configPath);
      const currentProviders = providersExists ? validateProvidersShape(readProvidersFileIfExists(setupPaths.providersPath)) : null;
      const adoptability = collectMigrateAdoptability(document, currentProviders);
      if (adoptability.availableProfiles.length === 0) {
        throw cliError("PROFILE_NOT_FOUND", "No profiles were found in config.toml.", {
          file: setupPaths.configPath,
        });
      }
      if (adoptability.adoptableProfiles.length === 0) {
        throw cliError("MIGRATE_NO_ADOPTABLE_PROFILES", "No adoptable profiles were found for migrate.", {
          availableProfiles: adoptability.availableProfiles,
          adoptableProfiles: adoptability.adoptableProfiles,
          blockingReasonsByProfile: adoptability.blockingReasonsByProfile,
        });
      }

      let strategy: "merge" | "overwrite" | null = overwrite ? "overwrite" : merge ? "merge" : null;
      const registryIsEmpty = !currentProviders || Object.keys(currentProviders.providers).length === 0;
      if (providersExists && strategy === null && !registryIsEmpty) {
        if (!canPrompt(runtime, ctx.options.json)) {
          throw cliError("PROVIDERS_ALREADY_EXISTS", "providers.json already exists. Pass --merge or --overwrite.", {
            file: setupPaths.providersPath,
          });
        }

        const selected = await chooseSetupStrategy(runtime);
        if (selected === "cancel") {
          throw cliError("PROMPT_CANCELLED", "Setup cancelled.");
        }
        strategy = selected;
      }

      const adoptableProfiles = adoptability.adoptableProfileDetails;
      let adoptProfiles: string[] = [];
      let providerDetailsByProfile: Record<string, SetupProviderDetails> = {};

      if (canPrompt(runtime, ctx.options.json)) {
        adoptProfiles = await chooseSetupProfiles(runtime, adoptableProfiles);
        // Defaults are derived from config.toml so interactive setup only asks for missing provider metadata.
        const collectedDetails = await collectSetupProviderDetails(
          runtime,
          adoptProfiles,
          adoptableProfiles.reduce<Record<string, { providerName?: string; baseUrl?: string }>>((accumulator, profile) => {
            accumulator[profile.name] = {
              providerName: profile.name,
              baseUrl: profile.baseUrl,
            };
            return accumulator;
          }, {})
        );
        providerDetailsByProfile = Object.fromEntries(
          Object.entries(collectedDetails).map(([profile, detail]) => [
            profile,
            {
              providerName: detail.providerName,
              apiKey: detail.apiKey,
              baseUrl: detail.baseUrl,
              note: detail.note,
              tags: detail.tags,
            },
          ])
        );
      } else {
        throw cliError(
          "INVALID_ARGUMENT",
          "migrate currently requires an interactive TTY to choose adoptable profiles and collect provider details.",
          {
            availableProfiles: adoptability.availableProfiles,
            adoptableProfiles: adoptability.adoptableProfiles,
            blockingReasonsByProfile: adoptability.blockingReasonsByProfile,
            suggestion: "Run `aps migrate` in an interactive terminal. Non-interactive migrate flags for profile selection and provider secrets are not available in this release.",
          }
        );
      }

      return migrateCodex({
        codexDirOption: ctx.options.codexDir,
        codexDir: setupPaths.codexDir,
        lockPath: setupPaths.lockPath,
        configPath: setupPaths.configPath,
        providersPath: setupPaths.providersPath,
        authPath: setupPaths.authPath,
        backupsDir: setupPaths.backupsDir,
        latestBackupPath: setupPaths.latestBackupPath,
        strategy: strategy ?? "overwrite",
        adoptProfiles,
        providerDetailsByProfile,
      });
    }
    case "setup":
      throw cliError("COMMAND_DEPRECATED", "setup has been split into init and migrate.", {
        replacements: ["init", "migrate"],
      });
    case "backups-list":
      return listBackupEntries({
        backupsDir: paths.backupsDir,
        ownership: backupOwnership,
        targets: ctx.targets,
      });
    case "backups-prune":
      return pruneBackupEntries({
        lockPath: paths.lockPath,
        backupsDir: paths.backupsDir,
        latestBackupPath: paths.latestBackupPath,
        keep: resolveBackupRetention(getSingleOption(parsed.commandOptions, "--keep")),
      });
    case "rollback":
      if (parsed.positionals.length > 1) {
        throw cliError("INVALID_ARGUMENT", "rollback accepts at most one backup id.");
      }
      if (canPrompt(runtime, ctx.options.json)) {
        await confirmRollback(runtime, paths.latestBackupPath, paths.backupsDir, parsed.positionals[0] ?? null);
      }
      return rollbackBackup({
        latestBackupPath: paths.latestBackupPath,
        backupsDir: paths.backupsDir,
        // Both targets share one backup directory, so a Codex rollback may legitimately
        // restore a Claude settings file. The Claude root is resolved here, not read from
        // the manifest, because the manifest is the untrusted input.
        allowedRoots: [paths.toolHomeDir, paths.codexDir, claudePaths.claudeDir],
        // The same roots again, read only to report which target the restored backup belonged to.
        ownership: backupOwnership,
        backupId: parsed.positionals[0] ?? null,
      });
    default:
      throw cliError("UNKNOWN_COMMAND", `Unknown command: ${ctx.command}`);
  }
}
