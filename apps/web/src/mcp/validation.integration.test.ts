import { task, taskComment } from "@agent-board/db";
import { TaskCreateFullOutputSchema, TaskGetOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("MCP human validation registered by an agent", () => {
  let world: TestWorld;
  afterEach(async () => { if (world) await closeTestWorld(world); });
  const ctx = () => ({ tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "agent reviewer" });

  async function newCard() {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, title: "Reviewable", type: "bug",
      o_que: "Review the result", por_que: "Close the loop",
      como_confirmo: [{ step: "Check", expected: "Works" }], origem: { cli: "test" },
    });
    if (!created.ok) throw new Error("create failed");
    return TaskCreateFullOutputSchema.parse(created.value).task;
  }

  it("validates a delivered card and exposes the cited agent stamp in the timeline", async () => {
    world = await createTestWorld();
    const card = await newCard();
    expect((await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx(), "task_deliver", { task_id: card.id, summary: "Done" })).ok).toBe(true);

    const citation = "Dono validou ao vivo: 'ok, funcionou'";
    const updated = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.short_id, status: "validado", comment: citation,
    });
    expect(updated.ok).toBe(true);
    const got = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id, include: ["comments"],
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const full = TaskGetOutputSchema.parse(got.value);
    expect(full.task.status).toBe("validado");
    expect(full.comments).toEqual([expect.objectContaining({
      kind: "validation", author: "agent reviewer", body: citation,
    })]);
    const rows = await world.db.select().from(taskComment).where(eq(taskComment.taskId, card.id));
    expect(rows).toEqual([expect.objectContaining({
      kind: "validation", authorAgentRef: "agent reviewer", body: citation,
    })]);
  });

  it("rejects missing citation and invalid source states without changing the card", async () => {
    world = await createTestWorld();
    const card = await newCard();
    const citation = "Dono validou ao vivo: 'ok'";
    for (const status of ["aberto", "em_execucao"] as const) {
      if (status === "em_execucao") {
        expect((await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id })).ok).toBe(true);
      }
      const rejected = await invokeTool(world.db, ctx(), "task_update", {
        task_id: card.id, status: "validado", comment: citation,
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("INVALID_TRANSITION");
      const [unchanged] = await world.db.select().from(task).where(eq(task.id, card.id));
      expect(unchanged?.status).toBe(status);
    }
    expect((await invokeTool(world.db, ctx(), "task_deliver", { task_id: card.id, summary: "Done" })).ok).toBe(true);
    for (const comment of [undefined, "   "]) {
      const rejected = await invokeTool(world.db, ctx(), "task_update", {
        task_id: card.id, status: "validado", comment,
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.message).toMatch(/cit.*human/i);
    }
    const [unchanged] = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(unchanged?.status).toBe("feito");
    expect(await world.db.select().from(taskComment).where(eq(taskComment.taskId, card.id))).toHaveLength(0);
  });

  it("does not let a token from another workspace validate the card", async () => {
    world = await createTestWorld();
    const card = await newCard();
    expect((await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx(), "task_deliver", { task_id: card.id, summary: "Done" })).ok).toBe(true);
    const refused = await invokeTool(world.db, {
      ...ctx(), workspaceId: "00000000-0000-4000-8000-000000000001",
    }, "task_update", {
      task_id: card.id, status: "validado", comment: "Dono validou: 'ok'",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("NOT_FOUND");
    const [unchanged] = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(unchanged?.status).toBe("feito");
  });
});
