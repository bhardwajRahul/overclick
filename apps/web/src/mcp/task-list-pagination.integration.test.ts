import { task } from "@agent-board/db";
import { TaskListOutputSchema } from "@agent-board/mcp-core";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("task_list pagination and session scope (OCL-189)", () => {
  let world: TestWorld;
  afterEach(async () => { if (world) await closeTestWorld(world); });
  const ctx = () => ({ workspaceId: world.workspaceId, tokenId: world.tokenId, tokenLabel: "shared token" });

  it("reaches every card beyond 200 with deterministic newest-first pages and an exclusive date filter", async () => {
    world = await createTestWorld();
    const start = Date.parse("2026-09-18T00:00:00.000Z");
    await world.db.insert(task).values(Array.from({ length: 225 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      projectId: world.projectId, shortId: `OC-${index + 1}`, title: `Card ${index + 1}`,
      // Ties are intentional: pages still need a stable secondary order.
      createdAt: new Date(start + Math.floor(index / 2) * 1000),
    })));
    const first = await invokeTool(world.db, ctx(), "task_list", { project_id: "OC", order: "newest", limit: 200 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstPage = TaskListOutputSchema.parse(first.value);
    expect(firstPage.tasks).toHaveLength(200);
    expect(firstPage.tasks[0]?.short_id).toBe("OC-225");
    expect(firstPage.tasks[199]?.short_id).toBe("OC-26");
    expect(firstPage.next_offset).toBe(200);
    expect(firstPage.truncated).toBe(true);
    const next = await invokeTool(world.db, ctx(), "task_list", { project_id: "OC", order: "newest", limit: 200, offset: firstPage.next_offset });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const lastPage = TaskListOutputSchema.parse(next.value);
    expect(lastPage.tasks).toHaveLength(25);
    expect(lastPage.tasks[0]?.short_id).toBe("OC-25");
    expect(lastPage.tasks[24]?.short_id).toBe("OC-1");
    expect(lastPage.next_offset).toBeNull();
    expect(lastPage.truncated).toBe(false);
    expect(new Set([...firstPage.tasks, ...lastPage.tasks].map(row => row.short_id)).size).toBe(225);
    const recent = await invokeTool(world.db, ctx(), "task_list", { order: "newest", created_after: "2026-09-18T00:01:50.000Z" });
    expect(recent.ok && TaskListOutputSchema.parse(recent.value).tasks.map(row => row.short_id)).toEqual(["OC-225", "OC-224", "OC-223"]);
    const oldest = await invokeTool(world.db, ctx(), "task_list", { limit: 1 });
    expect(oldest.ok && TaskListOutputSchema.parse(oldest.value).tasks[0]?.short_id).toBe("OC-1");
    const other = await invokeTool(world.db, { ...ctx(), workspaceId: "00000000-0000-4000-8000-000000999999" }, "task_list", { order: "newest" });
    expect(other.ok && TaskListOutputSchema.parse(other.value).tasks).toEqual([]);
  });

  it("isolates sessions sharing a token and makes token-wide listing explicit", async () => {
    world = await createTestWorld();
    const rows = await world.db.insert(task).values([
      { projectId: world.projectId, shortId: "OC-1", title: "First session" },
      { projectId: world.projectId, shortId: "OC-2", title: "Second session" },
    ]).returning();
    for (const [index, row] of rows.entries()) {
      expect((await invokeTool(world.db, ctx(), "task_claim", {
        task_id: row.id, executor: { cli: "claude-code", model: "opus-5", session_id: `session-${index + 1}` },
      })).ok).toBe(true);
    }
    const mine = await invokeTool(world.db, ctx(), "task_list", { claimed_by: "me", session_id: "session-1" });
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(TaskListOutputSchema.parse(mine.value).tasks.map(row => row.short_id)).toEqual(["OC-1"]);
    const ambiguous = await invokeTool(world.db, ctx(), "task_list", { claimed_by: "me" });
    expect(ambiguous.ok).toBe(false);
    const token = await invokeTool(world.db, ctx(), "task_list", { claimed_by: "token" });
    expect(token.ok && TaskListOutputSchema.parse(token.value).tasks).toHaveLength(2);
    expect((await invokeTool(world.db, ctx(), "task_release", { task_id: rows[0]!.id, reason: "Done for now" })).ok).toBe(true);
    const released = await invokeTool(world.db, ctx(), "task_list", { claimed_by: "me", session_id: "session-1" });
    expect(released.ok && TaskListOutputSchema.parse(released.value).tasks).toEqual([]);
    for (const bad of [{ offset: -1 }, { created_after: "bad-date" }, { order: "unknown" }]) {
      expect((await invokeTool(world.db, ctx(), "task_list", bad)).ok).toBe(false);
    }
  });
});
