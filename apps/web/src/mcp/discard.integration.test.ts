import { executionAttempt, task, taskComment } from "@agent-board/db";
import {
  TaskCreateFullOutputSchema,
  TaskUpdateFullOutputSchema,
} from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

/**
 * OCL-203: the orchestrator had to discard a card that lost its reason to
 * exist while it was still open, and MCP refused with "only a card in
 * execution can be superseded". The board and MCP now share one rule, the
 * discard carries its reason, and every refusal says what to do first.
 */
describe("discarding a card over MCP (OCL-203)", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function worker() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "worker",
      canManage: false,
    };
  }

  function manager() {
    return {
      tokenId: world.manageTokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "orchestrator",
      canManage: true,
    };
  }

  async function createCard(title: string) {
    const created = await invokeTool(world.db, worker(), "task_create", {
      project_id: world.projectId,
      title,
      type: "bug",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem: { agent: "test" },
    });
    if (!created.ok) throw new Error(created.error.message);
    return TaskCreateFullOutputSchema.parse(created.value).task;
  }

  async function discard(taskId: string, reason?: string, ctx = manager()) {
    return invokeTool(world.db, ctx, "task_update", {
      task_id: taskId,
      status: "descartado",
      ...(reason ? { comment: reason } : {}),
    });
  }

  async function statusOf(taskId: string) {
    const [row] = await world.db.select().from(task).where(eq(task.id, taskId));
    return row?.status;
  }

  it("discards an open card and records the reason on its history", async () => {
    world = await createTestWorld();
    const card = await createCard("Lost its reason to exist");

    const discarded = await discard(card.short_id, "the decision changed; OVKA-734 replaces it");
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(TaskUpdateFullOutputSchema.parse(discarded.value).task.status).toBe("descartado");

    const comments = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    expect(comments.map((row) => row.body)).toContain(
      "Discarded: the decision changed; OVKA-734 replaces it",
    );
  });

  it("asks for the reason instead of discarding in silence", async () => {
    world = await createTestWorld();
    const card = await createCard("No reason given");
    const refused = await discard(card.short_id);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_ARGUMENT");
    expect(refused.error.message).toContain("reason");
    expect(await statusOf(card.id)).toBe("aberto");
  });

  it("keeps discarding a manage-token action", async () => {
    world = await createTestWorld();
    const card = await createCard("Worker cannot discard");
    const refused = await discard(card.short_id, "not mine to drop", worker());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("PERMISSION_DENIED");
    expect(await statusOf(card.id)).toBe("aberto");
  });

  it("refuses a live claim held by another executor, says who and what to do, then allows it once released", async () => {
    world = await createTestWorld();
    const card = await createCard("Someone is on it");
    const claimed = await invokeTool(world.db, worker(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "claude-code", model: "sonnet-5", effort: "high", session_id: "live" },
    });
    expect(claimed.ok).toBe(true);

    const refused = await discard(card.short_id, "no longer needed");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_TRANSITION");
    expect(refused.error.message).toContain("claim is live");
    expect(refused.error.message).toContain("held by claude-code");
    expect(refused.error.message).toContain("expires at");
    expect(refused.error.message).toContain("task_release");
    expect(await statusOf(card.id)).toBe("em_execucao");

    const released = await invokeTool(world.db, manager(), "task_release", {
      task_id: card.short_id,
      reason: "the decision changed",
    });
    expect(released.ok).toBe(true);
    const discarded = await discard(card.short_id, "no longer needed");
    expect(discarded.ok).toBe(true);
    expect(await statusOf(card.id)).toBe("descartado");
  });

  it("discards a card in execution under the caller's own claim, closing the attempt with the reason", async () => {
    world = await createTestWorld();
    const card = await createCard("My own run");
    const claimed = await invokeTool(world.db, manager(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "claude-code", model: "opus-5", effort: "max", session_id: "mine" },
    });
    expect(claimed.ok).toBe(true);

    const discarded = await discard(card.short_id, "superseded by a better plan");
    expect(discarded.ok).toBe(true);
    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.result).toBe("abandoned");
    expect(attempt?.resultNote).toBe("superseded by a better plan");
  });

  it("discards a card whose claim has expired", async () => {
    world = await createTestWorld();
    const card = await createCard("Abandoned run");
    const claimed = await invokeTool(world.db, worker(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "claude-code", model: "sonnet-5", session_id: "gone" },
    });
    expect(claimed.ok).toBe(true);
    expect(await statusOf(card.id)).toBe("em_execucao");
    await world.db
      .update(executionAttempt)
      .set({ lastActivityAt: new Date(Date.now() - 3 * 60 * 60_000) })
      .where(eq(executionAttempt.taskId, card.id));

    const discarded = await discard(card.short_id, "the executor died and the plan changed");
    expect(discarded.ok).toBe(true);
    expect(await statusOf(card.id)).toBe("descartado");
  });

  it("discards a delivered card, and refuses a validated or an already discarded one with why", async () => {
    world = await createTestWorld();
    const delivered = await createCard("Delivered, then moot");
    await invokeTool(world.db, worker(), "task_claim", { task_id: delivered.short_id });
    await invokeTool(world.db, worker(), "task_deliver", {
      task_id: delivered.short_id,
      summary: "done",
      usage: { tokens_in: 1, tokens_out: 1 },
    });
    expect((await discard(delivered.short_id, "the feature was dropped")).ok).toBe(true);

    const again = await discard(delivered.short_id, "twice");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.message).toContain("already discarded");

    const validated = await createCard("Accepted");
    await invokeTool(world.db, worker(), "task_claim", { task_id: validated.short_id });
    await invokeTool(world.db, worker(), "task_deliver", {
      task_id: validated.short_id,
      summary: "done",
      usage: { tokens_in: 1, tokens_out: 1 },
    });
    await invokeTool(world.db, worker(), "task_update", {
      task_id: validated.short_id,
      status: "validado",
      comment: "Owner said: ok",
    });
    const refused = await discard(validated.short_id, "too late");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_TRANSITION");
    expect(refused.error.message).toContain("validated");
    expect(await statusOf(validated.id)).toBe("validado");
  });

  it("lets a signed-in human in the board follow the same rule (no token of theirs holds a claim)", async () => {
    world = await createTestWorld();
    const card = await createCard("An agent is on it");
    const claimed = await invokeTool(world.db, worker(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "claude-code", model: "sonnet-5", session_id: "agent" },
    });
    expect(claimed.ok).toBe(true);
    // What discardTaskAction sends: the human's user id and manage authority.
    const human = {
      tokenId: "00000000-0000-4000-8000-00000000beef",
      workspaceId: world.workspaceId,
      tokenLabel: "owner@board.local",
      canManage: true,
    };
    const refused = await discard(card.short_id, "stop", human);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("task_release");

    const open = await createCard("Nobody on it");
    expect((await discard(open.short_id, "not needed", human)).ok).toBe(true);
  });
});
