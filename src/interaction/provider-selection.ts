import { cliError } from "../domain/errors";
import { ProviderSelectionData } from "../app/targets/types";
import { CliPromptRuntime } from "./prompt";

/**
 * Asks the user to choose one provider, given the choices the target built.
 *
 * One prompt for both targets. The labels and hints are the target's, assembled from the registry
 * and the live state it already read; what is shared is that there is exactly one place a name is
 * chosen, and therefore one place the empty case is reported.
 *
 * The empty case raises the plural code, the same one both targets already used: there is nobody to
 * choose from, which is a different finding from a named provider that could not be found. The
 * sentence is the target's, because the remedy is.
 */
export async function selectProvider(
  runtime: CliPromptRuntime,
  message: string,
  selection: ProviderSelectionData
): Promise<string> {
  if (selection.choices.length === 0) {
    throw cliError("PROVIDERS_NOT_FOUND", selection.emptyMessage);
  }

  return runtime.selectOne(message, selection.choices);
}
