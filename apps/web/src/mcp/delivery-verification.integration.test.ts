import { project, task, workspace } from "@agent-board/db";
import { TaskCreateFullOutputSchema, TaskDeliverFullOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("private repository delivery verification (OCL-185)", () => {
  let world: TestWorld;
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (world) await closeTestWorld(world);
  });

  it.each([false, true])("uses the workspace credential and the delivered branch (stored branch: %s)", async (storedBranch) => {
    world = await createTestWorld();
    const ctx = { tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "test" };
    const repoUrl = ["https:/", "github.com", "example", "private-repo"].join("/");
    await world.db.update(project).set({ repoUrl }).where(eq(project.id, world.projectId));
    await world.db.update(workspace).set({ githubToken: "workspace-fixture" }).where(eq(workspace.id, world.workspaceId));
    vi.stubEnv("GITHUB_TOKEN", "environment-fixture");
    const made = await invokeTool(world.db, ctx, "task_create", {
      project_id: world.projectId, title: "Private delivery", type: "bug",
      o_que: "Verify the pushed commit", por_que: "Reliable delivery",
      como_confirmo: [{ step: "Deliver", expected: "Verified" }], origem: { cli: "test" },
    });
    if (!made.ok) throw new Error("create failed");
    const card = TaskCreateFullOutputSchema.parse(made.value).task;
    expect((await invokeTool(world.db, ctx, "task_claim", { task_id: card.id })).ok).toBe(true);
    if (storedBranch) await world.db.update(task).set({ branch: "feat/motion-dna" }).where(eq(task.id, card.id));

    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      seen.push(pathname);
      if (new Headers(init?.headers).get("authorization") !== "Bearer workspace-fixture") {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (pathname.endsWith("/commits/832022f5f")) return Response.json({ sha: "832022f5f9b5c935e7b3016029ff00dc19ed70b7" });
      if (pathname.endsWith("/branches/feat%2Fmotion-dna")) return Response.json({ commit: { sha: "9097249b2fba807ed6aa667e7ce2a10eabc3e65d" } });
      if (pathname.endsWith("/compare/832022f5f...feat%2Fmotion-dna")) return Response.json({ status: "ahead" });
      return Response.json({ message: "Not Found" }, { status: 404 });
    });
    const result = await invokeTool(world.db, ctx, "task_deliver", {
      task_id: card.id, summary: "Delivered", commit: "832022f5f",
      ...(storedBranch ? {} : { branch: "feat/motion-dna" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const delivered = TaskDeliverFullOutputSchema.parse(result.value);
    expect(delivered.task).toMatchObject({
      branch: "feat/motion-dna", delivery_verification: "verified",
      delivery_unverified: false, delivery_warning: null,
    });
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("workspace-fixture");
  });
});
