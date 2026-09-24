"use server";

import { project, task } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { authContextForUser } from "../lib/scope";
import { invokeTool } from "../mcp/tools";

/**
 * Human discard from the card detail (OCL-203). It goes through task_update,
 * the same path MCP uses, so the board and an agent follow one rule: what one
 * of them can discard, the other can too, and a refusal reads the same.
 */
export async function discardTaskAction(
  taskId: string,
  reason: string,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!reason.trim()) {
    return { ok: false, error: "Say why the card is being discarded." };
  }

  const [found] = await db()
    .select({ workspaceId: project.workspaceId })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(eq(task.id, taskId))
    .limit(1);
  if (!found) return { ok: false, error: "Card not found." };

  const acting = await authContextForUser(db(), session, found.workspaceId);
  if (!acting) return { ok: false, error: "Session expired. Sign in again." };
  const discarded = await invokeTool(
    db(),
    acting,
    "task_update",
    { task_id: taskId, status: "descartado", comment: reason.trim() },
  );
  if (!discarded.ok) return { ok: false, error: discarded.error.message };

  revalidatePath("/home");
  return { ok: true };
}
