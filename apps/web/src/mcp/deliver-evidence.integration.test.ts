import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  TaskDeliverFullOutputSchema as TaskDeliverOutputSchema,
} from "@agent-board/mcp-core";
import { afterEach, describe, expect, it } from "vitest";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";

// OCL-212: 21 of the 23 deliveries written twice were refused only for the
// shape of `evidence`. Through the real MCP server (the SDK validates first),
// the shapes agents actually send now land on the first call.

async function connectClient(world: TestWorld) {
  const server = await createOverclickMcpServer({
    db: world.db,
    ctx: { tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "test" },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "overclick-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: unknown) =>
  (result as ToolResult).content?.find((part) => part.type === "text")?.text ?? "";

describe("task_deliver evidence over MCP (OCL-212)", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  async function claimedCard(client: Client, cli = "claude-code") {
    const created = TaskCreateOutputSchema.parse(
      JSON.parse(
        textOf(
          await client.callTool({
            name: "task_create",
            arguments: {
              project_id: world.projectId,
              title: "Entrega de primeira",
              type: "bug",
              o_que: "Entregar numa chamada só.",
              por_que: "Refação custa a escrita inteira.",
              como_confirmo: [{ step: "entregar", expected: "aceito" }],
              origem: { agent: "test" },
              return: "full",
            },
          }),
        ),
      ),
    ).task;
    await client.callTool({
      name: "task_claim",
      arguments: {
        task_id: created.id,
        executor: { cli, model: "opus-5", session_id: "sess_212" },
      },
    });
    return created;
  }

  it("says in the tool listing that plain strings are accepted", async () => {
    world = await createTestWorld();
    const { client, server } = await connectClient(world);
    try {
      const { tools } = await client.listTools();
      const deliver = tools.find((tool) => tool.name === "task_deliver");
      const evidence = (deliver?.inputSchema.properties as Record<string, { description?: string }>)
        .evidence;
      expect(evidence?.description).toMatch(/Plain strings are accepted/);
    } finally {
      await server.close();
    }
  });

  it("accepts evidence as a string, strings and step objects on the first call", async () => {
    world = await createTestWorld();
    const { client, server } = await connectClient(world);
    try {
      const shapes: unknown[] = [
        "vitest 68 passed, tsc exit 0",
        ["vitest 68 passed", "tsc exit 0"],
        [{ step: "abrir o card", result: "ok" }, { text: "teste", url: "src/a.ts:12" }],
      ];
      const stored = [];
      for (const evidence of shapes) {
        const card = await claimedCard(client);
        const result = await client.callTool({
          name: "task_deliver",
          arguments: {
            task_id: card.id,
            summary: "Entregue de primeira.",
            evidence,
            usage: { segments: [{ model: "opus-5", input: 10, output: 5 }], turns: 1 },
            return: "full",
          },
        });
        expect((result as ToolResult).isError ?? false).toBe(false);
        const handoff = TaskDeliverOutputSchema.parse(JSON.parse(textOf(result)));
        expect(handoff.task.status).toBe("feito");
        stored.push(handoff.handoff.evidence);
      }
      expect(stored).toEqual([
        [{ text: "vitest 68 passed, tsc exit 0" }],
        [{ text: "vitest 68 passed" }, { text: "tsc exit 0" }],
        [{ text: "step: abrir o card · result: ok" }, { text: "teste · src/a.ts:12" }],
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps refusing a measured-recipe CLI that estimates without the recipe's reason", async () => {
    world = await createTestWorld();
    const { client, server } = await connectClient(world);
    try {
      const card = await claimedCard(client);
      const result = await client.callTool({
        name: "task_deliver",
        arguments: {
          task_id: card.id,
          summary: "chute",
          evidence: "nada medido",
          usage: { tokens_in: 1000, tokens_out: 200, estimated: true },
        },
      });
      expect((result as ToolResult).isError).toBe(true);
      expect(textOf(result)).toContain("INVALID_ARGUMENT");
    } finally {
      await server.close();
    }
  });
});
