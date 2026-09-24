import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { task } from "@agent-board/db";
import { TaskCreateFullOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

// OCL-213: filing a card stops asking for what the board already knows and
// accepts como_confirmo in the form models write it, while the contract
// (o_que, por_que, como_confirmo) stays required.
describe("task_create without ceremony", () => {
  let world: TestWorld;
  afterEach(async () => { if (world) await closeTestWorld(world); });
  const ctx = () => ({ tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "laschuk-mac", userId: world.adminUserId, role: "admin" as const });
  const contract = {
    title: "Ceremony", type: "feature" as const,
    o_que: "Filing a card is faster", por_que: "It is the board's most expensive call",
  };

  it("accepts a card with no origem and records the token that filed it", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, ...contract,
      como_confirmo: [{ step: "Create a card", expected: "Accepted" }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateFullOutputSchema.parse(created.value).task;
    expect(card.origem).toEqual({ agent: "laschuk-mac" });
  });

  it("keeps an origem that says what the board cannot know", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, ...contract,
      como_confirmo: [{ step: "Create a card", expected: "Accepted" }],
      origem: { reportado_por: "the owner, live" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(TaskCreateFullOutputSchema.parse(created.value).task.origem).toEqual({ reportado_por: "the owner, live" });
  });

  it("stores como_confirmo written as text exactly like the list form", async () => {
    world = await createTestWorld();
    const asText = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, ...contract,
      como_confirmo: "1. Open the report → the score shows\n\n- Click export -> a PDF downloads\n* Reload the page => the score is still there",
    });
    const asList = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, ...contract,
      como_confirmo: [
        { step: "Open the report", expected: "the score shows" },
        { step: "Click export", expected: "a PDF downloads" },
        { step: "Reload the page", expected: "the score is still there" },
      ],
    });
    expect(asText.ok && asList.ok).toBe(true);
    if (!asText.ok || !asList.ok) return;
    const textCard = TaskCreateFullOutputSchema.parse(asText.value).task;
    const listCard = TaskCreateFullOutputSchema.parse(asList.value).task;
    expect(textCard.como_confirmo).toEqual(listCard.como_confirmo);
    const rows = await world.db.select().from(task).where(eq(task.id, textCard.id));
    const twin = await world.db.select().from(task).where(eq(task.id, listCard.id));
    expect(rows[0]?.comoConfirmo).toBe(twin[0]?.comoConfirmo);
  });

  it("refuses a text step without an expected result, saying how to write it", async () => {
    world = await createTestWorld();
    const refused = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId, ...contract,
      como_confirmo: "Open the report → the score shows\nCheck it works",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_ARGUMENT");
    expect(refused.error.message).toMatch(/line 2/);
    expect(refused.error.message).toMatch(/step → expected/);
  });

  it("still refuses a card without o_que, por_que or como_confirmo", async () => {
    world = await createTestWorld();
    const full = {
      project_id: world.projectId, ...contract,
      como_confirmo: "Create a card → accepted",
    };
    for (const key of ["o_que", "por_que", "como_confirmo"] as const) {
      const { [key]: _dropped, ...rest } = full;
      const refused = await invokeTool(world.db, ctx(), "task_create", rest);
      expect(refused.ok, key).toBe(false);
      if (!refused.ok) expect(refused.error.message).toMatch(new RegExp(key));
    }
    for (const empty of ["", "   ", []]) {
      const refused = await invokeTool(world.db, ctx(), "task_create", { ...full, como_confirmo: empty });
      expect(refused.ok).toBe(false);
    }
  });

  it("takes the short form through the real MCP handshake, which advertises it", async () => {
    world = await createTestWorld();
    const server = await createOverclickMcpServer({ db: world.db, ctx: ctx() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ocl-213-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tool = (await client.listTools()).tools.find((item) => item.name === "task_create");
      const required = (tool?.inputSchema.required ?? []) as string[];
      expect(required).not.toContain("origem");
      expect(JSON.stringify(tool?.inputSchema.properties?.como_confirmo)).toContain('"string"');
      const called = await client.callTool({
        name: "task_create",
        arguments: {
          project_id: world.projectId, ...contract,
          como_confirmo: "1. Create a card → accepted\n2. Open it → the steps show",
        },
      });
      expect(called.isError).toBeFalsy();
      const [row] = await world.db.select().from(task).where(eq(task.title, "Ceremony"));
      expect(JSON.parse(row?.comoConfirmo ?? "[]")).toEqual([
        { step: "Create a card", expected: "accepted" },
        { step: "Open it", expected: "the steps show" },
      ]);
      expect(row?.origin).toEqual({ agent: "laschuk-mac" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
