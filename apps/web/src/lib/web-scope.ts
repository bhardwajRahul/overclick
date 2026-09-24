import { notFound } from "next/navigation";
import { getSession } from "./cookies";
import { db } from "./db";
import {
  canManageWorkspace,
  principalFromUserId,
  type MaybePrincipal,
} from "./scope";

/**
 * What the signed-in web user may see, for pages and server actions. Null when
 * nobody is signed in or the user cannot be identified: callers then refuse,
 * because deny is the default.
 */
export async function sessionPrincipal(session: {
  userId: string;
}): Promise<MaybePrincipal> {
  return principalFromUserId(db(), session.userId);
}

/** For a page: an unidentifiable user gets the same "not found" as anything out of scope. */
export async function pagePrincipal(session: {
  userId: string;
}): Promise<NonNullable<MaybePrincipal>> {
  const principal = await sessionPrincipal(session);
  if (!principal) notFound();
  return principal;
}

/** What a member hears from an action that changes the workspace configuration. */
export const ADMIN_ONLY = "Only an admin can change the workspace configuration.";

/**
 * Harness, executors, prices, recipes, language, updates, claim timeout,
 * invitations, team: the admin's. True when the signed-in user may change them.
 */
export async function sessionCanManageWorkspace(session: {
  userId: string;
}): Promise<boolean> {
  return canManageWorkspace(await sessionPrincipal(session));
}
