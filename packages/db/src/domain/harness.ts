/**
 * The model a claim declared against the models its usage recorded.
 *
 * A board card has room for one value, not two lines. This folds both into a
 * single string that is short when there is nothing to report and only grows
 * when the run switched model. (Before OCL-202 the first value was the card's
 * planned model; the board no longer plans one.)
 */

import { normalizeModelKey } from "./pricing";

/**
 * "sonnet-5" when the run stayed on the model it claimed with, "sonnet-5 →
 * fable-5" when it did not, and the whole path when it switched more than once.
 *
 * Models are printed by their normalized key, so the binary's name
 * ("claude-fable-5") and the catalog's ("fable-5") read the same and never
 * pretend to be two different models.
 */
export function harnessChain(
  claimed: string | null | undefined,
  ran: readonly (string | null | undefined)[] = [],
): string | null {
  const shown: string[] = [];
  for (const model of [claimed, ...ran]) {
    if (!model) continue;
    const key = normalizeModelKey(model);
    if (!key || shown.includes(key)) continue;
    shown.push(key);
  }
  return shown.length > 0 ? shown.join(" → ") : null;
}
