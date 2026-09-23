import { project, workspace } from "@agent-board/db";
import {
  ProjectCreateOutputSchema,
  ProjectListFullOutputSchema,
  ProjectListOutputSchema,
  TaskCreateFullOutputSchema,
  TaskCreateOutputSchema,
  TaskListOutputSchema,
  type ProjectResolution,
} from "@agent-board/mcp-core";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpRequest } from "./http";
import {
  closeTestWorld,
  createTestWorld,
  insertOrganization,
  type TestWorld,
} from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

const origem = { session_id: "sess_repo", cli: "claude-code" };

describe("task_create finds the project from the repo; project_list answers small (OCL-208)", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function ctx() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test",
    };
  }

  function card(where: Record<string, unknown>) {
    return {
      title: "Card sem project_list",
      type: "feature" as const,
      o_que: "O board acha o projeto sozinho.",
      por_que: "O agente já sabe onde está.",
      como_confirmo: [{ step: "cria o card com repo", expected: "cai no projeto certo" }],
      mode: "solo" as const,
      origem,
      ...where,
    };
  }

  async function createProject(name: string, id_prefix: string, repo_url?: string) {
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name,
      id_prefix,
      ...(repo_url ? { repo_url } : {}),
    });
    if (!created.ok) throw new Error(`project_create ${id_prefix} failed`);
    return ProjectCreateOutputSchema.parse(created.value).project;
  }

  /** One JSON-RPC call over /mcp, the way a connected agent makes it. */
  async function overMcp(method: string, params: unknown) {
    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${world.secret}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      { db: world.db },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      result: {
        tools?: Array<{
          name: string;
          inputSchema: { properties?: Record<string, unknown>; required?: string[] };
        }>;
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
    };
  }

  async function seedBoard() {
    world = await createTestWorld();
    await createProject("Overclock App", "OVKA", "https://github.com/ustoppble/overclock-app");
    await createProject("OverClick", "OCL", "https://github.com/ustoppble/overclick.git");
    await createProject("Lab", "LAB", "file:///Users/me/lab");
    await createProject("Marketing", "MKT");
  }

  it("files the card in the project whose repo_url matches, in a small answer that says how", async () => {
    await seedBoard();

    const created = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "git@github.com:ustoppble/overclick.git", return: "ack" }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(TaskCreateOutputSchema.safeParse(created.value).success).toBe(true);
    const ack = created.value as { short_id: string; project: ProjectResolution };
    expect(ack.short_id).toBe("OCL-1");
    expect(ack.project).toEqual({
      id_prefix: "OCL",
      from: "repo",
      match: "remote",
      repo_url: "https://github.com/ustoppble/overclick.git",
    });
    // The acknowledgement stays the size of any task_create: no inventory.
    const text = JSON.stringify(created.value);
    expect(text.length).toBeLessThan(600);
    expect(text).not.toContain("OVKA");
    expect(text).not.toContain("Marketing");
  });

  it("resolves the path an agent works in: inside a file:// checkout, or a worktree named after the repository", async () => {
    await seedBoard();

    const local = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "/Users/me/lab/packages/core" }),
    );
    if (!local.ok) throw new Error(local.error.message);
    const inLab = TaskCreateFullOutputSchema.parse(local.value);
    expect(inLab.task.short_id).toBe("LAB-1");
    expect(inLab.project).toEqual({
      id_prefix: "LAB",
      from: "repo",
      match: "path",
      repo_url: "file:///Users/me/lab",
    });

    const worktree = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "/Users/me/Developer/overclock-app/.worktrees/dev-1324" }),
    );
    if (!worktree.ok) throw new Error(worktree.error.message);
    const inApp = TaskCreateFullOutputSchema.parse(worktree.value);
    expect(inApp.task.short_id).toBe("OVKA-1");
    expect(inApp.project).toMatchObject({ id_prefix: "OVKA", from: "repo", match: "name" });
  });

  it("publishes repo on task_create and takes a call without project_id over /mcp", async () => {
    await seedBoard();

    const listed = await overMcp("tools/list", {});
    const tool = listed.result.tools?.find((item) => item.name === "task_create");
    expect(tool?.inputSchema.properties).toHaveProperty("repo");
    expect(tool?.inputSchema.required ?? []).not.toContain("project_id");

    const called = await overMcp("tools/call", {
      name: "task_create",
      arguments: card({ repo: "https://github.com/ustoppble/overclock-app.git" }),
    });
    expect(called.result.isError).toBeFalsy();
    const ack = JSON.parse(called.result.content?.[0]?.text ?? "{}") as {
      short_id?: string;
      project?: ProjectResolution;
    };
    expect(ack.short_id).toBe("OVKA-1");
    expect(ack.project).toEqual({
      id_prefix: "OVKA",
      from: "repo",
      match: "remote",
      repo_url: "https://github.com/ustoppble/overclock-app",
    });
  });

  it("lets a declared project_id win, also when it names another repository than repo", async () => {
    await seedBoard();

    const declared = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ project_id: "ovka", repo: "https://github.com/ustoppble/overclick" }),
    );
    if (!declared.ok) throw new Error(declared.error.message);
    const out = TaskCreateFullOutputSchema.parse(declared.value);
    expect(out.task.short_id).toBe("OVKA-1");
    expect(out.project).toEqual({ id_prefix: "OVKA", from: "project_id" });

    // A repo nobody registered does not stand in the way of a declared project.
    const elsewhere = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ project_id: "MKT", repo: "/somewhere/unregistered" }),
    );
    expect(elsewhere.ok).toBe(true);
  });

  it("refuses a repo no project matches, saying what it looked for and offering project_create", async () => {
    await seedBoard();

    const remote = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "https://x-access-token:s3cr3t@github.com/ustoppble/unknown.git" }),
    );
    expect(remote.ok).toBe(false);
    if (remote.ok) return;
    expect(remote.error.code).toBe("NOT_FOUND");
    expect(remote.error.message).toContain("ustoppble/unknown");
    expect(remote.error.message).toContain("project_create");
    expect(remote.error.message).toContain("project_id");
    // Never the credential, never the inventory.
    expect(remote.error.message).not.toContain("s3cr3t");
    for (const other of ["OVKA", "OCL", "LAB", "MKT", "Overclock App"]) {
      expect(remote.error.message).not.toContain(other);
    }

    const path = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "/Users/me/elsewhere/new-thing" }),
    );
    expect(path.ok).toBe(false);
    if (path.ok) return;
    expect(path.error.code).toBe("NOT_FOUND");
    expect(path.error.message).toContain("/Users/me/elsewhere/new-thing");
    expect(path.error.message).toContain("git remote get-url origin");

    const listed = await invokeTool(world.db, ctx(), "task_list", {});
    if (!listed.ok) throw new Error("task_list failed");
    expect(TaskListOutputSchema.parse(listed.value).tasks).toHaveLength(0);
  });

  it("refuses a repo two projects share, listing only those two", async () => {
    await seedBoard();
    await createProject("Site A", "SA", "https://github.com/acme/site");
    await createProject("Site B", "SB", "https://github.com/acme/site.git");

    const twins = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "git@github.com:acme/site.git" }),
    );
    expect(twins.ok).toBe(false);
    if (twins.ok) return;
    expect(twins.error.code).toBe("INVALID_ARGUMENT");
    expect(twins.error.message).toContain("SA (Site A, https://github.com/acme/site)");
    expect(twins.error.message).toContain("SB (Site B, https://github.com/acme/site.git)");
    for (const other of ["OVKA", "OCL", "LAB", "MKT"]) {
      expect(twins.error.message).not.toContain(other);
    }
  });

  it("asks for project_id or repo when the call names neither", async () => {
    await seedBoard();

    const nowhere = await invokeTool(world.db, ctx(), "task_create", card({}));
    expect(nowhere.ok).toBe(false);
    if (nowhere.ok) return;
    expect(nowhere.error.code).toBe("INVALID_ARGUMENT");
    expect(nowhere.error.message).toContain("project_id");
    expect(nowhere.error.message).toContain("repo");
  });

  it("never resolves a repo to a project of another workspace", async () => {
    await seedBoard();
    const [otherWs] = await world.db
      .insert(workspace)
      .values({ name: "Other", executors: [] })
      .returning({ id: workspace.id });
    if (!otherWs) throw new Error("failed to insert other workspace");
    await world.db.insert(project).values({
      workspaceId: otherWs.id,
      organizationId: await insertOrganization(world.db, otherWs.id),
      name: "Private",
      idPrefix: "PRV",
      repoUrl: "https://github.com/acme/private",
      nextNumber: 1,
    });

    const leaked = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      card({ repo: "acme/private" }),
    );
    expect(leaked.ok).toBe(false);
    if (leaked.ok) return;
    expect(leaked.error.code).toBe("NOT_FOUND");
    expect(leaked.error.message).not.toContain("PRV");
  });

  it("lists id_prefix, name and repo_url by default, and the complete rows only with view: full", async () => {
    await seedBoard();

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    const rows = ProjectListOutputSchema.parse(listed.value).projects;
    expect(rows.map((row) => row.id_prefix)).toEqual(["OC", "OVKA", "OCL", "LAB", "MKT"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["id_prefix", "name", "repo_url"]);
    }
    expect(rows.find((row) => row.id_prefix === "MKT")?.repo_url).toBeNull();

    const full = await invokeTool(world.db, ctx(), "project_list", { view: "full" });
    if (!full.ok) throw new Error("project_list full failed");
    const complete = ProjectListFullOutputSchema.parse(full.value).projects;
    expect(complete).toHaveLength(5);
    expect(complete[1]).toMatchObject({
      id_prefix: "OVKA",
      organization_name: "General",
      has_context: false,
      next_number: 1,
    });
    expect(complete[1]?.cards.total).toBe(0);

    // Same board, both answers: the default is a fraction of the full one.
    const small = JSON.stringify(listed.value).length;
    const large = JSON.stringify(full.value).length;
    expect(small / large).toBeLessThan(0.4);
  });
});
