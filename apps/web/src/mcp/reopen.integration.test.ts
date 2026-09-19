import { executionAttempt, handoff, task, taskComment } from "@agent-board/db";
import { TaskClaimOutputSchema, TaskCreateFullOutputSchema, TaskGetOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadReopenRows } from "../lib/insights";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("MCP rejection and reclaim (OCL-187)", () => {
  let world: TestWorld;
  afterEach(async () => { if (world) await closeTestWorld(world); });
  const ctx = () => ({ tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "reviewer" });

  async function deliveredCard() {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, title: "Reviewable", type: "bug",
      o_que: "Review the delivery", por_que: "Close the loop",
      como_confirmo: [{ step: "Review", expected: "Reclaimable" }], origem: { cli: "test" },
    });
    if (!created.ok) throw new Error("create failed");
    const card = TaskCreateFullOutputSchema.parse(created.value).task;
    expect((await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx(), "task_deliver", { task_id: card.id, summary: "First delivery" })).ok).toBe(true);
    return card;
  }

  it("reopens with a report, preserves history and gives the reason to a different executor", async () => {
    const card = await deliveredCard();
    await world.db.update(task).set({ revisado: true, validationTicks: [{ index: 0, byUserId: "reviewer", byEmail: "reviewer", at: new Date().toISOString() }] }).where(eq(task.id, card.id));
    const reason = "The empty state still fails.";
    const result = await invokeTool(world.db, ctx(), "task_reopen", { task_id: card.short_id, reason });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ short_id: card.short_id, status: "aberto" });
    const [reopened] = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(reopened).toMatchObject({ status: "aberto", revisado: false, claimedByTokenId: null, validationTicks: [] });
    const comments = await world.db.select().from(taskComment).where(eq(taskComment.taskId, card.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "report", body: reason, authorAgentRef: "reviewer" });
    expect(await world.db.select().from(handoff).where(eq(handoff.taskId, card.id))).toHaveLength(1);
    const previous = await world.db.select().from(executionAttempt).where(eq(executionAttempt.taskId, card.id));
    expect(previous).toHaveLength(1);
    expect(previous[0]?.result).toBe("success");
    expect(previous[0]?.finishedAt).not.toBeNull();
    expect(await loadReopenRows(world.db, world.workspaceId)).toHaveLength(1);

    // An ordinary report must not overwrite the actual rejection reason.
    await invokeTool(world.db, ctx(), "task_update", { task_id: card.id, comment_kind: "report", comment: "Unrelated progress" });
    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: card.id });
    expect(got.ok && TaskGetOutputSchema.parse(got.value).task.reopen_comment).toBe(reason);
    expect(got.ok && TaskGetOutputSchema.parse(got.value).task.reports_count).toBe(2);
    expect(await loadReopenRows(world.db, world.workspaceId)).toHaveLength(1);
    const claimed = await invokeTool(world.db, { ...ctx(), tokenId: world.secondTokenId }, "task_claim", { task_id: card.id });
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(TaskClaimOutputSchema.parse(claimed.value).briefing_markdown).toContain(reason);
    expect(await world.db.select().from(executionAttempt).where(eq(executionAttempt.taskId, card.id))).toHaveLength(2);
  });

  it("requires a reason and cannot validate a card or cross a workspace", async () => {
    const card = await deliveredCard();
    for (const reason of [undefined, "", "  "]) {
      expect((await invokeTool(world.db, ctx(), "task_reopen", { task_id: card.id, reason })).ok).toBe(false);
    }
    const outsider = await invokeTool(world.db, { ...ctx(), workspaceId: "00000000-0000-4000-8000-000000000001" }, "task_reopen", { task_id: card.id, reason: "Reject" });
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.error.code).toBe("NOT_FOUND");
    expect((await invokeTool(world.db, ctx(), "task_update", { task_id: card.id, status: "validado" })).ok).toBe(false);
    const [unchanged] = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(unchanged?.status).toBe("feito");
    expect(await world.db.select().from(taskComment).where(eq(taskComment.taskId, card.id))).toHaveLength(0);
  });

  it("only reopens delivered cards and refuses duplicate reopens", async () => {
    const card = await deliveredCard();
    for (const status of ["aberto", "em_execucao", "validado", "descartado"] as const) {
      await world.db.update(task).set({ status }).where(eq(task.id, card.id));
      const result = await invokeTool(world.db, ctx(), "task_reopen", { task_id: card.id, reason: "Reject" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_TRANSITION");
    }
    await world.db.update(task).set({ status: "feito" }).where(eq(task.id, card.id));
    expect((await invokeTool(world.db, ctx(), "task_reopen", { task_id: card.id, reason: "Reject" })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx(), "task_reopen", { task_id: card.id, reason: "Again" })).ok).toBe(false);
    expect(await world.db.select().from(taskComment).where(eq(taskComment.taskId, card.id))).toHaveLength(1);
  });
});
