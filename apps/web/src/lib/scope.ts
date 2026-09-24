import { mission, organization, project, task, user } from "@agent-board/db";
import { eq, sql, type SQL } from "drizzle-orm";
import type { AuthContext, McpDatabase } from "../mcp/types";

/**
 * The one place that answers "what may this person see and change?".
 *
 * Every door (web actions and pages, the MCP tools) asks here instead of
 * deciding for itself, so the rule cannot drift between them. The model:
 *
 * - admin: everything, as before.
 * - member: only the cards and missions they authored; only the projects of
 *   their own organization, and that organization; no workspace
 *   configuration; only their own tokens.
 * - anyone we cannot identify (no user behind a token, a user that was
 *   deactivated): nothing. Deny is the default.
 *
 * Out of scope means non-existent: callers answer "not found" for a row that
 * fails these checks, never "forbidden", so its existence is not revealed.
 */
export type Role = "admin" | "member";

export type Principal = {
  userId: string;
  role: Role;
  /** The member's organization. Always null for an admin, who has no fence. */
  organizationId: string | null;
};

/** Null means "no access at all". */
export type MaybePrincipal = Principal | null;

/** The token's owner as a principal; a token with no owner has none. */
export function principalFromAuth(ctx: AuthContext): MaybePrincipal {
  if (!ctx.userId || !ctx.role) return null;
  return {
    userId: ctx.userId,
    role: ctx.role,
    organizationId: ctx.role === "admin" ? null : (ctx.organizationId ?? null),
  };
}

/** The signed-in user of a web session as a principal. */
export async function principalFromUserId(
  db: Pick<McpDatabase, "select">,
  userId: string,
): Promise<MaybePrincipal> {
  const [row] = await db
    .select({
      id: user.id,
      role: user.role,
      organizationId: user.organizationId,
      active: user.active,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row || !row.active) return null;
  return {
    userId: row.id,
    role: row.role,
    organizationId: row.role === "admin" ? null : row.organizationId,
  };
}

export function isAdmin(principal: MaybePrincipal): boolean {
  return principal?.role === "admin";
}

/** Harness, executors, prices, invitations, team, other people's tokens. */
export function canManageWorkspace(principal: MaybePrincipal): boolean {
  return isAdmin(principal);
}

/** Creating, editing or deleting a project or an organization. */
export function canManageStructure(principal: MaybePrincipal): boolean {
  return isAdmin(principal);
}

export function canSeeTask(
  principal: MaybePrincipal,
  row: { createdByUserId: string | null },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return row.createdByUserId !== null && row.createdByUserId === principal.userId;
}

export function canSeeMission(
  principal: MaybePrincipal,
  row: { createdByUserId: string | null },
): boolean {
  return canSeeTask(principal, row);
}

export function canSeeProject(
  principal: MaybePrincipal,
  row: { organizationId: string },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return (
    principal.organizationId !== null &&
    row.organizationId === principal.organizationId
  );
}

export function canSeeOrganization(
  principal: MaybePrincipal,
  row: { id: string },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return principal.organizationId !== null && row.id === principal.organizationId;
}

/** A member manages only tokens that are theirs; an admin manages any. */
export function canManageToken(
  principal: MaybePrincipal,
  row: { ownerUserId: string | null },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return row.ownerUserId !== null && row.ownerUserId === principal.userId;
}

const NOTHING = sql`false`;

/**
 * SQL counterparts of the checks above, for list and aggregate queries that
 * must filter in the database. `undefined` means "no restriction" (admin), so
 * the result can go straight into `and(...)`.
 */
export function taskScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  return eq(task.createdByUserId, principal.userId);
}

export function missionScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  return eq(mission.createdByUserId, principal.userId);
}

export function projectScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  if (!principal.organizationId) return NOTHING;
  return eq(project.organizationId, principal.organizationId);
}

export function organizationScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  if (!principal.organizationId) return NOTHING;
  return eq(organization.id, principal.organizationId);
}
