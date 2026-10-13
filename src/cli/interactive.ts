/**
 * Compatibility facade that re-exports interactive command helpers.
 *
 * Nothing imports it — the 1.x roadmap tracks this whole module, with the other dead `src/cli/`
 * shims, for deletion under P2-1. It stays one name shorter than it was: the provider chooser moved
 * to `interaction/provider-selection.ts` for both targets in `1.2.0`, so re-exporting the old
 * Codex-only prompt here would have been a facade for a function that no longer exists.
 */
export {
  canPrompt,
  chooseCodexDir,
  chooseSetupProfiles,
  chooseSetupStrategy,
  collectEditInput,
  collectSetupProviderDetails,
  confirmExportOverwrite,
  confirmImport,
  confirmProviderRemoval,
  confirmRollback,
  exportTargetExists,
  getRollbackSummary,
  getRollbackSummaryById,
} from "../interaction/interactive";
