import { project, task } from "@agent-board/db";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { looksLikeUuid } from "../mcp/map";
import { getSession } from "./cookies";
import { db } from "./db";
import {
  canManageWorkspace,
  principalFromUserId,
  projectScope,
  taskScope,
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

/** What an action answers for a card that does not exist or is out of scope. */
export const CARD_NOT_FOUND = "Card not found.";

/**
 * The workspace of a card the principal may see, or null for anything else:
 * someone else's card, an id that matches nothing, an id that is not a uuid.
 * One answer for all three (OCL-227), so an action that looks a card up before
 * handing it to a tool cannot tell a member which uuids exist.
 */
export async function visibleCardWorkspace(
  principal: MaybePrincipal,
  taskId: string,
): Promise<string | null> {
  if (!principal || !looksLikeUuid(taskId)) return null;
  const [found] = await db()
    .select({ workspaceId: project.workspaceId })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(and(eq(task.id, taskId), projectScope(principal), taskScope(principal)))
    .limit(1);
  return found?.workspaceId ?? null;
}
