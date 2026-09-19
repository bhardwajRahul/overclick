import { executionAttempt, factoryModelPrices, findModelPrice, modelPrice, project, task, workspace } from "@agent-board/db";
import { TaskGetOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { repriceUnpricedAstra } from "../lib/reprice-astra";
import { closeTestWorld, createTestWorld, insertOrganization, TEST_EXECUTORS, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("Astra pricing (OCL-191)", () => {
  let world: TestWorld;
  afterEach(async () => { if (world) await closeTestWorld(world); });
  const ctx = () => ({ workspaceId: world.workspaceId, tokenId: world.tokenId, tokenLabel: "test" });

  it("covers every model advertised by the affected workspace's task_claim enum", () => {
    // Captured from the board's enabled executor configuration on 2026-09-19.
    const models = ["fable-5", "opus-5", "sonnet-5", "haiku-4-5", "gpt-5.6-sol",
      "gpt-daybreak-blue-latest", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex-spark",
      "gpt-6-astra", "k3", "grok-4.6"];
    expect(models.filter(model => !findModelPrice(factoryModelPrices(), model))).toEqual([]);
  });

  it("returns computed cost through task_get after a measured Astra delivery", async () => {
    world = await createTestWorld({ executors: [...TEST_EXECUTORS,
      { id: "codex", label: "Codex", enabled: true, models: ["gpt-6-astra"] },
    ] });
    const [card] = await world.db.insert(task).values({ projectId: world.projectId, shortId: "OC-1", title: "Astra" }).returning();
    expect((await invokeTool(world.db, ctx(), "task_claim", { task_id: card!.id,
      executor: { cli: "codex", model: "gpt-6-astra", session_id: "astra-session" },
    })).ok).toBe(true);
    expect((await invokeTool(world.db, ctx(), "task_deliver", { task_id: card!.id, summary: "Measured",
      usage: { segments: [{ model: "gpt-6-astra", input: 1_000, output: 200, cache_read: 3_000, cache_write: 400 }], turns: 1 },
    })).ok).toBe(true);
    const fetched = await invokeTool(world.db, ctx(), "task_get", { task_id: card!.id });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) expect(TaskGetOutputSchema.parse(fetched.value)).toMatchObject({ cost_usd: 0.028, cost_status: "computed" });
  });

  it("recovers frozen history idempotently, preserving usage, flags and workspace custom rates", async () => {
    world = await createTestWorld();
    const [other] = await world.db.insert(workspace).values({ name: "Custom prices" }).returning();
    const organizationId = await insertOrganization(world.db, other!.id);
    const [otherProject] = await world.db.insert(project).values({ workspaceId: other!.id, organizationId, name: "Other", idPrefix: "OT" }).returning();
    await world.db.insert(modelPrice).values({ workspaceId: other!.id, model: "gpt-6-astra", label: "Astra custom",
      inputPerMtok: "20", outputPerMtok: "100", cachePerMtok: "2", cacheWritePerMtok: "25" });
    const rows = [];
    for (let index = 0; index < 7; index++) {
      const [card] = await world.db.insert(task).values({ projectId: index === 1 ? otherProject!.id : world.projectId,
        shortId: `OC-${index + 1}`, title: "Historical", status: "feito" }).returning();
      const [attempt] = await world.db.insert(executionAttempt).values({ taskId: card!.id, model: "gpt-6-astra",
        finishedAt: index === 4 ? null : new Date(),
        usageSegments: [{ model: "gpt-6-astra", input: 100_000, output: 20_000, cache_read: 300_000, cache_write: 40_000 },
          ...(index === 6 ? [{ model: "future-model", input: 100 }] : [])],
        tokensIn: 100_000, tokensOut: 20_000, tokensCache: 340_000,
        costStatus: index === 5 ? "computed" : "unpriced", costUsd: index === 5 ? "99" : null,
        costUnpricedModels: index === 5 ? [] : ["gpt-6-astra", ...(index === 6 ? ["future-model"] : [])],
        usageEstimated: index === 2, usageSuspect: index === 3,
      }).returning();
      rows.push(attempt!);
    }
    expect(await repriceUnpricedAstra(world.db)).toMatchObject({ candidates: 5, recovered: 5, updated: 0 });
    expect((await world.db.select().from(executionAttempt).where(eq(executionAttempt.id, rows[0]!.id)))[0]?.costUsd).toBeNull();
    expect(await repriceUnpricedAstra(world.db, true)).toMatchObject({ updated: 5, computed: 2 });
    const actual = await world.db.select().from(executionAttempt);
    for (const [index, before] of rows.entries()) {
      const after = actual.find(row => row.id === before.id)!;
      const { costUsd, costSource, costStatus, costUnpricedModels, costBreakdown, ...facts } = after;
      expect(facts).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) =>
        !["costUsd", "costSource", "costStatus", "costUnpricedModels", "costBreakdown"].includes(key))));
      expect(costUsd == null ? null : Number(costUsd)).toBe([2.8, 5.6, 2.8, 2.8, null, 99, null][index]);
      expect(costStatus).toBe(["computed", "computed", "estimated", "suspect", "unpriced", "computed", "unpriced"][index]);
      if (index === 6) expect(costUnpricedModels).toEqual(["future-model"]);
    }
    expect(await repriceUnpricedAstra(world.db, true)).toMatchObject({ candidates: 0, updated: 0 });
  });
});
