import {
  KNOWN_EXECUTORS,
  user,
  workspace,
} from "@agent-board/db";
import { count } from "drizzle-orm";
import { db } from "./db";

export async function countUsers(): Promise<number> {
  const [row] = await db().select({ n: count() }).from(user);
  return Number(row?.n ?? 0);
}

export async function ensureWorkspace(): Promise<{ id: string }> {
  const [existing] = await db()
    .select({ id: workspace.id })
    .from(workspace)
    .limit(1);
  if (existing) return existing;

  const [created] = await db()
    .insert(workspace)
    .values({
      name: "Agent Board",
      executors: KNOWN_EXECUTORS,
    })
    .returning({ id: workspace.id });

  // No harness policy is seeded (OCL-202): the board records which harness
  // ran a card, the Overclock app decides which one runs.
  if (!created) throw new Error("failed to create workspace");

  return created;
}
