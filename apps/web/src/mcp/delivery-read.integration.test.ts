import { TaskCreateFullOutputSchema, TaskGetOutputSchema } from "@agent-board/mcp-core";
import { handoff } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("reading delivered artifacts (OCL-188)", () => {
  let world: TestWorld;
  afterEach(async () => { if (world) await closeTestWorld(world); });

  it("reads complete artifacts and paginates older deliveries without bloating default reads", async () => {
    world = await createTestWorld();
    const ctx = { workspaceId: world.workspaceId, tokenId: world.tokenId, tokenLabel: "test" };
    const created = await invokeTool(world.db, ctx, "task_create", {
      project_id: world.projectId, title: "RFC", type: "rfc", o_que: "Read the document",
      por_que: "Review by reference", como_confirmo: [{ step: "Read", expected: "Full text" }], origem: { cli: "test" },
    });
    if (!created.ok) throw new Error("create failed");
    const card = TaskCreateFullOutputSchema.parse(created.value).task;
    const markdown = "# RFC\n\n" + "A complete paragraph.\n".repeat(1000) + "\nEND";
    const firstArtifacts = [{ kind: "rfc_markdown", name: "Proposal", markdown }];
    const firstEvidence = [{ text: "Reviewed locally" }];
    expect((await invokeTool(world.db, ctx, "task_claim", { task_id: card.id })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx, "task_deliver", {
      task_id: card.id, summary: "First proposal", artifacts: firstArtifacts, evidence: firstEvidence,
    })).ok).toBe(true);

    const normal = await invokeTool(world.db, ctx, "task_get", { task_id: card.id });
    expect(normal.ok && normal.value).not.toHaveProperty("deliveries");
    const first = await invokeTool(world.db, ctx, "task_get", { task_id: card.short_id, include: ["delivery"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(TaskGetOutputSchema.parse(first.value)).toMatchObject({
      deliveries: [{ summary: "First proposal", artifacts: firstArtifacts, evidence: firstEvidence }],
      deliveries_truncated: false, next_delivery_offset: null,
    });

    expect((await invokeTool(world.db, ctx, "task_reopen", { task_id: card.id, reason: "Revise" })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx, "task_claim", { task_id: card.id })).ok).toBe(true);
    const secondArtifacts = [{ kind: "markdown", name: "Revision", markdown: "# Revision" }, { kind: "link", name: "Source", url: ["https:/", "example.org", "document"].join("/") }];
    expect((await invokeTool(world.db, ctx, "task_deliver", { task_id: card.id, summary: "Revision", artifacts: secondArtifacts })).ok).toBe(true);
    const latest = await invokeTool(world.db, ctx, "task_get", { task_id: card.id, include: ["delivery"] });
    expect(latest.ok && TaskGetOutputSchema.parse(latest.value)).toMatchObject({
      deliveries: [{ summary: "Revision", artifacts: secondArtifacts }], deliveries_truncated: true, next_delivery_offset: 1,
    });
    const older = await invokeTool(world.db, ctx, "task_get", { task_id: card.id, include: ["delivery"], delivery_offset: 1 });
    expect(older.ok && TaskGetOutputSchema.parse(older.value)).toMatchObject({
      deliveries: [{ summary: "First proposal", artifacts: firstArtifacts }], deliveries_truncated: false, next_delivery_offset: null,
    });
    const beyond = await invokeTool(world.db, ctx, "task_get", { task_id: card.id, include: ["delivery"], delivery_offset: 2 });
    expect(beyond.ok && TaskGetOutputSchema.parse(beyond.value)).toMatchObject({ deliveries: [], deliveries_truncated: false });
    const full = await invokeTool(world.db, ctx, "task_get", { task_id: card.id, view: "full", delivery_limit: 2 });
    expect(full.ok && TaskGetOutputSchema.parse(full.value).deliveries).toHaveLength(2);
    const outsider = await invokeTool(world.db, { ...ctx, workspaceId: "00000000-0000-4000-8000-000000000001" }, "task_get", { task_id: card.id, include: ["delivery"] });
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.error.code).toBe("NOT_FOUND");
    expect((await invokeTool(world.db, ctx, "task_get", { task_id: card.id, include: ["delivery"], delivery_limit: 21 })).ok).toBe(false);
    await world.db.update(handoff).set({
      evidences: [{ kind: "text", value: "Legacy evidence" }],
      artifacts: [{ name: "Legacy document", mime: "text/markdown", content: "# Legacy" }],
    }).where(eq(handoff.taskId, card.id));
    const legacy = await invokeTool(world.db, ctx, "task_get", { task_id: card.id, include: ["delivery"] });
    expect(legacy.ok && TaskGetOutputSchema.parse(legacy.value)).toMatchObject({
      deliveries: [{ evidence: [{ text: "Legacy evidence" }], artifacts: [{ kind: "file", name: "Legacy document", mime_type: "text/markdown", content: "# Legacy" }] }],
    });
  });
});
