import type { McpToolName } from "@agent-board/mcp-core";
import { user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { invokeTool as invokeMcpTool } from "./tools";
import type { AuthContext, McpDatabase } from "./types";

/**
 * Existing integration scenarios inspect the complete object after a write.
 * Keep those scenarios explicit about that legacy-shaped assertion while the
 * production default remains the compact acknowledgement.
 */
const FULL_RESPONSE_WRITES = new Set<McpToolName>([
  "project_update",
  "mission_update",
  "task_create",
  "task_release",
  "task_heartbeat",
  "task_update",
  "task_deliver",
  "executors_update",
]);

/**
 * The scope module gives a token with no owner no access. The older fixtures
 * hand-build a context without one and mean "the workspace admin", so this
 * helper (never production code) fills that in; a context that names its
 * userId, even as null, is passed through untouched.
 */
async function withLegacyAdmin(
  db: McpDatabase,
  ctx: AuthContext,
): Promise<AuthContext> {
  if ("userId" in ctx) return ctx;
  const [admin] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "admin"))
    .limit(1);
  return admin ? { ...ctx, userId: admin.id, role: "admin" } : ctx;
}

export async function invokeToolForTests(
  db: McpDatabase,
  ctx: AuthContext,
  name: McpToolName,
  args: unknown,
): ReturnType<typeof invokeMcpTool> {
  ctx = await withLegacyAdmin(db, ctx);
  if (
    FULL_RESPONSE_WRITES.has(name) &&
    args &&
    typeof args === "object" &&
    !("return" in args)
  ) {
    args = { ...(args as Record<string, unknown>), return: "full" };
  }
  return invokeMcpTool(db, ctx, name, args);
}
