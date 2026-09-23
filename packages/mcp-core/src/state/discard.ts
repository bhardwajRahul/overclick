import type { CardStatus } from "./machine.js";

/**
 * What decides whether a card may be discarded, gathered by the caller so the
 * rule stays pure. The board UI and MCP reach it through the same task_update
 * path: whatever can be discarded by clicking can be discarded over MCP
 * (OCL-203).
 */
export type DiscardCheck = {
  shortId: string;
  status: CardStatus;
  /** A continuation card was named: the work goes on somewhere else. */
  continues: boolean;
  /** Only read while the card is in execution. */
  claim?: {
    /** The caller is the token that holds the claim. */
    ownedByCaller: boolean;
    /** The lease ran out: nobody has renewed it within the workspace timeout. */
    stale: boolean;
    /** Who holds it, as the claim recorded it (cli or agent). */
    holder: string | null;
    lastActivityAt: string | null;
    expiresAt: string | null;
  };
};

/**
 * Null when the card may be discarded; otherwise why not and what to do first.
 *
 * An open card, a delivered one and one whose claim is the caller's own, has
 * expired or is being handed to a continuation can all go. What is refused is
 * pulling a card from under an executor that is still working on it, and
 * touching a card that is already closed. A refusal that only says "no" is
 * what sent the owner to the board UI by hand, so every branch names the way
 * out.
 */
export function discardRefusal(check: DiscardCheck): string | null {
  const id = check.shortId;
  switch (check.status) {
    case "aberto":
    case "feito":
      return null;
    case "em_execucao": {
      const claim = check.claim;
      if (!claim || claim.ownedByCaller || claim.stale || check.continues) {
        return null;
      }
      const holder = claim.holder ?? "another executor";
      const activity = claim.lastActivityAt
        ? `, last activity ${claim.lastActivityAt}`
        : "";
      const expiry = claim.expiresAt ? `, expires at ${claim.expiresAt}` : "";
      return `${id} is in execution and its claim is live (held by ${holder}${activity}${expiry}). Discarding it now would pull the card from under an executor that is still working on it. Release the claim first with task_release {task_id: "${id}", reason} (the claiming token or a token with manage may), or wait until it expires, then discard it. To hand the work to another card instead, send superseded_by with the discard.`;
    }
    case "validado":
      return `${id} is validated: a human accepted it and a validated card is final, so it cannot be discarded. If the work has to be undone or redone, create a new card for it.`;
    case "descartado":
      return `${id} is already discarded.`;
  }
}
