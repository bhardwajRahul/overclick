import { workspace } from "@agent-board/db";
import {
  ExecutorsUpdateFullOutputSchema as ExecutorsUpdateOutputSchema,
  TaskClaimOutputSchema,
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  toolContracts,
} from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { selectionFromConfig } from "../lib/executors";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("executors_update manages the executor config over MCP", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function worker() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test-agent",
      canManage: false,
    };
  }

  function manager() {
    return {
      tokenId: world.manageTokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "owner-console",
      canManage: true,
    };
  }

  async function storedConfig() {
    const [ws] = await world.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, world.workspaceId))
      .limit(1);
    return ws?.executors ?? [];
  }

  async function createCard(title: string) {
    const created = await invokeTool(world.db, worker(), "task_create", {
      project_id: world.projectId,
      title,
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem: { cli: "codex" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("task_create failed");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("adds a model that Settings sees and a claim may then declare", async () => {
    world = await createTestWorld();
    const updated = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      add_models: ["opus-5"],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const out = ExecutorsUpdateOutputSchema.parse(updated.value);
    expect(out.updated).toBe("claude-code");
    expect(out.removed).toBe(false);
    const row = out.executors.find((item) => item.id === "claude-code");
    expect(row?.models).toContain("opus-5");
    expect(row?.catalog).toContain("opus-5");
    expect(row?.enabled).toBe(true);

    // What Settings renders comes from selectionFromConfig over the stored
    // config: the model has to be in the editable list and checked.
    const sel = selectionFromConfig(await storedConfig());
    expect(sel.models["claude-code"]).toContain("opus-5");
    expect(sel.enabled["claude-code"]).toContain("opus-5");

    // The catalog is what a claim is checked against: the new model is now a
    // legal thing to declare, and the card records it as what ran.
    const card = await createCard("Card claimed on the new model");
    const claimed = await invokeTool(world.db, worker(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "claude-code", model: "opus-5", effort: "high" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).task.executor).toEqual({
      cli: "claude-code",
      model: "opus-5",
      effort: "high",
    });
  });

  it("publishes per-model efforts, and the claim records the effort it declared", async () => {
    world = await createTestWorld();
    const updated = await invokeTool(world.db, manager(), "executors_update", {
      cli: "codex",
      label: "Codex",
      add_models: ["gpt-5.6-sol"],
      efforts: { "gpt-5.6-sol": ["low", "high"] },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const row = ExecutorsUpdateOutputSchema.parse(updated.value).executors.find(
      (item) => item.id === "codex",
    );
    expect(row?.efforts["gpt-5.6-sol"]).toEqual(["low", "high"]);
    expect(row?.effort_sources?.["gpt-5.6-sol"]).toBe("custom");

    // The board records what ran; it does not hold the claim to a menu.
    const card = await createCard("Record the declared effort");
    const claimed = await invokeTool(world.db, worker(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "codex", model: "gpt-5.6-sol", effort: "max" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const claimedOut = TaskClaimOutputSchema.parse(claimed.value);
    expect(claimedOut.attempt.executor.effort).toBe("max");
    expect(claimedOut.task.executor?.effort).toBe("max");
    expect(claimedOut).not.toHaveProperty("harness_divergence");
  });

  it("refuses a worker token and leaves the config untouched", async () => {
    world = await createTestWorld();
    const before = JSON.stringify(await storedConfig());

    const denied = await invokeTool(world.db, worker(), "executors_update", {
      cli: "codex",
      add_models: ["gpt-5.6-sol"],
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(await storedConfig())).toBe(before);
  });

  it("adds a CLI that was not configured and resolves the agent's binary name", async () => {
    world = await createTestWorld();
    const added = await invokeTool(world.db, manager(), "executors_update", {
      cli: "codex",
      label: "Codex",
      add_models: ["gpt-5.6-sol"],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(
      ExecutorsUpdateOutputSchema.parse(added.value).executors.find(
        (item) => item.id === "codex",
      ),
    ).toMatchObject({ label: "Codex", enabled: true, models: ["gpt-5.6-sol"] });

    // "claude" is what the CLI actually reports; it must not create a twin.
    const aliased = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude",
      add_models: ["haiku-4-5"],
    });
    expect(aliased.ok).toBe(true);
    if (!aliased.ok) return;
    const out = ExecutorsUpdateOutputSchema.parse(aliased.value);
    expect(out.updated).toBe("claude-code");
    expect(out.executors.filter((item) => item.id === "claude-code")).toHaveLength(1);
  });

  it("removes a model with no routing table left to warn about (OCL-202)", async () => {
    world = await createTestWorld();
    const removed = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      remove_models: ["haiku-4-5", "sonnet-5"],
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const out = ExecutorsUpdateOutputSchema.parse(removed.value);
    expect(
      out.executors.find((item) => item.id === "claude-code")?.models,
    ).not.toContain("sonnet-5");
    expect(removed.value).not.toHaveProperty("policy_warnings");
  });

  it("drops a whole CLI and reports an unknown one as NOT_FOUND", async () => {
    world = await createTestWorld();
    const dropped = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      remove: true,
    });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    const out = ExecutorsUpdateOutputSchema.parse(dropped.value);
    expect(out.removed).toBe(true);
    expect(out.executors.map((item) => item.id)).not.toContain("claude-code");
    expect(await storedConfig()).toHaveLength(0);

    const missing = await invokeTool(world.db, manager(), "executors_update", {
      cli: "nothing-here",
      remove: true,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("NOT_FOUND");
    expect(missing.error.message).toContain("Settings");
    expect(missing.error.message).not.toContain("harness_list");
  });

  it("rejects a call that asks for nothing and one that mixes remove with edits", async () => {
    world = await createTestWorld();
    const empty = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe("INVALID_ARGUMENT");

    const mixed = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      remove: true,
      add_models: ["opus-5"],
    });
    expect(mixed.ok).toBe(false);
    if (mixed.ok) return;
    expect(mixed.error.code).toBe("INVALID_ARGUMENT");
  });

  it("turns a CLI off without losing its models", async () => {
    world = await createTestWorld();
    const off = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      enabled: false,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    const row = ExecutorsUpdateOutputSchema.parse(off.value).executors.find(
      (item) => item.id === "claude-code",
    );
    expect(row?.enabled).toBe(false);
    expect(row?.models).toEqual([
      "fable-5",
      "opus-5",
      "opus-4-8",
      "sonnet-5",
      "haiku-4-5",
    ]);
    expect(
      (await storedConfig()).find((item) => item.id === "claude-code")?.enabled,
    ).toBe(false);
  });

  it("returns a compact ack that matches its own output schema (OCL-75 regression: removed used to sit inside changed, failing ExecutorsWriteAckSchema)", async () => {
    world = await createTestWorld();
    const off = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      enabled: false,
      return: "ack",
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    // The real bug: this call site validates the tool's own output schema,
    // the same check the MCP server runs on every response. It used to throw
    // "invalid response from executors_update: Invalid input" here.
    const parsed = toolContracts.executors_update.output.parse(off.value);
    expect(parsed).toMatchObject({ id: "claude-code", removed: false });
  });
});
