import type { Database } from "@agent-board/db";

export type AuthContext = {
  tokenId: string;
  workspaceId: string;
  tokenLabel: string;
  /**
   * Who the token belongs to. Absent for a token no user can be traced to;
   * the scope module gives that token no access.
   */
  userId?: string | null;
  role?: "admin" | "member" | null;
  /** The member's organization; null for admins. */
  organizationId?: string | null;
  /**
   * Token may change the workspace configuration (harness policy, executors).
   * Off unless the owner ticked it in Settings; absent means off.
   */
  canManage?: boolean;
};

/** Postgres or PGlite drizzle client — the query surface the tools use. */
export type McpDatabase = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "transaction"
>;
