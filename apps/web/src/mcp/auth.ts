import { mcpToken, user } from "@agent-board/db";
import type { ErrorCode } from "@agent-board/mcp-core";
import { eq, sql } from "drizzle-orm";
import { hashToken, parseBearerToken } from "./token";
import type { AuthContext, McpDatabase } from "./types";

export type AuthSuccess = { ok: true; ctx: AuthContext };
export type AuthFailure = {
  ok: false;
  status: 401;
  code: ErrorCode;
  message: string;
};
export type AuthResult = AuthSuccess | AuthFailure;

function fail(code: ErrorCode, message: string): AuthFailure {
  return { ok: false, status: 401, code, message };
}

export async function authenticateBearer(
  db: McpDatabase,
  authorization: string | null | undefined,
): Promise<AuthResult> {
  const secret = parseBearerToken(authorization ?? null);
  if (!secret) {
    return fail(
      "TOKEN_MISSING",
      "Authorization: Bearer <token> is required.",
    );
  }

  const hash = hashToken(secret);
  const [row] = await db
    .select()
    .from(mcpToken)
    .where(eq(mcpToken.hash, hash))
    .limit(1);

  if (!row) {
    return fail("UNAUTHORIZED", "Invalid MCP token.");
  }
  if (row.revoked) {
    return fail("TOKEN_REVOKED", "MCP token was revoked.");
  }

  const [owner] = row.ownerUserId
    ? await db
        .select({
          id: user.id,
          role: user.role,
          organizationId: user.organizationId,
          active: user.active,
        })
        .from(user)
        .where(eq(user.id, row.ownerUserId))
        .limit(1)
    : [];

  // A deactivated owner keeps the token row but the door closes at once
  // (OCL-222): the token is refused here, before any tool runs, and stays
  // refused until an admin reactivates that person.
  if (owner && !owner.active) {
    return fail("TOKEN_REVOKED", "The owner of this MCP token was deactivated.");
  }

  const now = new Date();
  await db
    .update(mcpToken)
    // The first call is kept (OCL-222): it is when an install worked.
    .set({ lastUsedAt: now, firstUsedAt: sql`coalesce(${mcpToken.firstUsedAt}, now())` })
    .where(eq(mcpToken.id, row.id));

  // A token with no user behind it loses every door: no user on the context
  // means no principal, and the scope module answers "nothing".
  const acting = owner?.active ? owner : undefined;

  return {
    ok: true,
    ctx: {
      tokenId: row.id,
      workspaceId: row.workspaceId,
      tokenLabel: row.label,
      canManage: row.canManage,
      userId: acting?.id ?? null,
      role: acting?.role ?? null,
      organizationId: acting?.organizationId ?? null,
    },
  };
}
