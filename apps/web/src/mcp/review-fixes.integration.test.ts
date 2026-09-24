import { executionAttempt, mission, project, task, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import type { AuthContext } from "./types";

const origem = { session_id: "sess_ocl227", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});

/**
 * OCL-227: the paths the adversarial review of the MCP (OCL-223, L1–L5) found
 * from a member's token to the admin's data, each one closed, and the admin
 * still able to do everything.
 */
describe("MCP review fixes: a member token reaches nothing of the admin's", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let memberCard: { id: string; short_id: string };
  let memberMissionId: string;
  let sisterProjectId: string;

  const call = (ctx: AuthContext, tool: string, input: Record<string, unknown>) =>
    invokeTool(world.db, ctx, tool as never, input);
  const value = <T>(r: Awaited<ReturnType<typeof call>>): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as T;
  };
  const created = (r: Awaited<ReturnType<typeof call>>) =>
    value<{ task: { id: string; short_id: string } }>(r).task;

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    memberId = m!.id;
    // A second project in the member's own organization, to move a card into.
    const [sister] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Irmão",
        idPrefix: "SG",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    sisterProjectId = sister!.id;
    // The admin's mission carries content the member must never read.
    await world.db
      .update(mission)
      .set({
        title: "ADMIN-TITULO-SECRETO",
        objective: "ADMIN-OBJETIVO-SECRETO",
        context: "ADMIN-CONTEXTO-SECRETO",
      })
      .where(eq(mission.id, world.missionId));

    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: true,
    };
    member = {
      tokenId: world.secondTokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "member",
      userId: memberId,
      role: "member",
      organizationId: world.organizationId,
      // The flag an admin can tick on any token; it must widen nothing.
      canManage: true,
    };
    memberCard = created(
      await call(member, "task_create", card("do member", { project_id: world.projectId })),
    );
    const [mm] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        title: "missao do member",
        status: "ativa",
        createdByUserId: memberId,
      })
      .returning({ id: mission.id });
    memberMissionId = mm!.id;
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("L1: task_get and the briefing leave out a mission of the admin's", async () => {
    value(await call(admin, "task_update", { task_id: memberCard.id, mission_id: world.missionId }));

    const withMission = value<{ mission: unknown }>(
      await call(member, "task_get", { task_id: memberCard.id, include: ["mission"] }),
    );
    expect(withMission.mission ?? null).toBeNull();
    const briefing = value<Record<string, unknown>>(
      await call(member, "task_get", { task_id: memberCard.id, view: "briefing" }),
    );
    const claimed = value<Record<string, unknown>>(
      await call(member, "task_claim", { task_id: memberCard.id, executor: { cli: "claude", model: "sonnet-5" } }),
    );
    for (const text of [JSON.stringify(withMission), JSON.stringify(briefing), JSON.stringify(claimed)]) {
      expect(text).not.toContain("ADMIN-TITULO-SECRETO");
      expect(text).not.toContain("ADMIN-OBJETIVO-SECRETO");
      expect(text).not.toContain("ADMIN-CONTEXTO-SECRETO");
    }

    // The admin still reads it whole.
    const forAdmin = value<{ mission: { objective: string } | null }>(
      await call(admin, "task_get", { task_id: memberCard.id, include: ["mission"] }),
    );
    expect(forAdmin.mission?.objective).toBe("ADMIN-OBJETIVO-SECRETO");
  });

  it("L2/L3: moving or deleting the member's card never drags, names or deletes the admin's subtask", async () => {
    const sub = created(
      await call(admin, "task_create", card("subtask do admin", { project_id: world.projectId, parent: memberCard.id })),
    );
    const subRow = async () =>
      (await world.db.select().from(task).where(eq(task.id, sub.id)))[0];
    const before = await subRow();

    // Mission move.
    const toMission = await call(member, "task_update", {
      task_id: memberCard.id,
      mission_id: memberMissionId,
      return: "full",
    });
    expect(JSON.stringify(value(toMission))).not.toContain(sub.short_id);
    expect(value<{ subtasks_moved?: number }>(toMission).subtasks_moved).toBe(0);
    expect((await subRow())?.missionId).toBe(before?.missionId);

    // Project move.
    const toProject = await call(member, "task_update", {
      task_id: memberCard.id,
      project_id: sisterProjectId,
      return: "full",
    });
    const moved = value<{ project_move: { short_ids: Array<{ from: string }> } }>(toProject);
    expect(JSON.stringify(moved)).not.toContain(sub.short_id);
    expect(moved.project_move.short_ids.map((c) => c.from)).toEqual([memberCard.short_id]);
    const afterMove = await subRow();
    expect(afterMove?.projectId).toBe(world.projectId);
    expect(afterMove?.shortId).toBe(sub.short_id);

    // Delete.
    const deleted = value<Record<string, unknown>>(
      await call(member, "task_delete", { task_id: memberCard.id }),
    );
    expect(JSON.stringify(deleted)).not.toContain(sub.short_id);
    const survivor = await subRow();
    expect(survivor).toBeDefined();
    expect(survivor?.projectId).toBe(world.projectId);
    expect((await call(admin, "task_get", { task_id: sub.id })).ok).toBe(true);
  });

  it("L2: the admin deleting a card still takes every subtask with it", async () => {
    const sub = created(await call(member, "task_create", card("sub do member", { project_id: world.projectId, parent: memberCard.id })));
    value(await call(admin, "task_delete", { task_id: memberCard.id }));
    expect(await world.db.select().from(task).where(eq(task.id, sub.id))).toHaveLength(0);
  });

  it("L4: mission_delete neither mentions nor counts a card of the admin's", async () => {
    const adminCard = created(
      await call(admin, "task_create", card("do admin na missao do member", {
        project_id: world.projectId,
        mission: memberMissionId,
      })),
    );
    const result = await call(member, "mission_delete", { mission_id: memberMissionId });
    const text = JSON.stringify(result) + (result.ok ? "" : result.error.message);
    expect(result.ok).toBe(true);
    expect(text).not.toContain(adminCard.short_id);
    expect(text).not.toMatch(/not yours/i);
    expect(value<{ tasks_detached: number }>(result).tasks_detached).toBe(0);
    const [row] = await world.db.select().from(task).where(eq(task.id, adminCard.id));
    expect(row?.missionId).toBeNull();
  });

  it("L4: with their own cards in it, the count the member reads is only theirs", async () => {
    value(await call(member, "task_update", { task_id: memberCard.id, mission_id: memberMissionId }));
    value(await call(admin, "task_create", card("do admin", { project_id: world.projectId, mission: memberMissionId })));
    const refused = await call(member, "mission_delete", { mission_id: memberMissionId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("holds 1 card.");
  });

  it("L5: a member token with the manage flag cannot release or keep alive the admin's claim", async () => {
    value(await call(admin, "task_claim", { task_id: memberCard.id, executor: { cli: "claude", model: "sonnet-5" } }));
    const release = await call(member, "task_release", { task_id: memberCard.id, reason: "x" });
    const heartbeat = await call(member, "task_heartbeat", { task_id: memberCard.id });
    expect(release.ok).toBe(false);
    expect(heartbeat.ok).toBe(false);
    if (!release.ok) expect(release.error.code).toBe("PERMISSION_DENIED");
    if (!heartbeat.ok) expect(heartbeat.error.code).toBe("PERMISSION_DENIED");
    const [row] = await world.db.select().from(task).where(eq(task.id, memberCard.id));
    expect(row?.status).toBe("em_execucao");
    expect(row?.claimedByTokenId).toBe(world.tokenId);
    const open = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, memberCard.id));
    expect(open.every((a) => a.finishedAt === null)).toBe(true);

    // An admin token with the flag still can.
    const manager = { ...admin, tokenId: world.manageTokenId };
    expect((await call(manager, "task_release", { task_id: memberCard.id, reason: "x" })).ok).toBe(true);
  });

  it("R3: only the admin validates a card over MCP", async () => {
    value(await call(member, "task_claim", { task_id: memberCard.id, executor: { cli: "claude", model: "sonnet-5" } }));
    value(await call(member, "task_deliver", {
      task_id: memberCard.id,
      summary: "s",
      usage: { segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }], duration_ms: 1, turns: 1 },
    }));
    const byMember = await call(member, "task_update", {
      task_id: memberCard.id,
      status: "validado",
      comment: "Dono validou: 'ok'",
    });
    expect(byMember.ok).toBe(false);
    if (!byMember.ok) expect(byMember.error.code).toBe("PERMISSION_DENIED");
    const [still] = await world.db.select().from(task).where(eq(task.id, memberCard.id));
    expect(still?.status).toBe("feito");

    const byAdmin = await call(admin, "task_update", {
      task_id: memberCard.id,
      status: "validado",
      comment: "Dono validou: 'ok'",
    });
    expect(byAdmin.ok).toBe(true);
  });

  it("A3: insights_query leaves out the title of an admin's mission holding the member's card", async () => {
    value(await call(admin, "task_update", { task_id: memberCard.id, mission_id: world.missionId }));
    value(await call(member, "task_claim", { task_id: memberCard.id, executor: { cli: "claude", model: "sonnet-5" } }));
    value(await call(member, "task_deliver", {
      task_id: memberCard.id,
      summary: "s",
      usage: { segments: [{ model: "sonnet-5", input: 10, output: 1, cache_read: 0, cache_write: 0 }], duration_ms: 1, turns: 1 },
    }));
    const forMember = await call(member, "insights_query", {});
    expect(forMember.ok).toBe(true);
    expect(JSON.stringify(forMember)).not.toContain("ADMIN-TITULO-SECRETO");
    const forAdmin = await call(admin, "insights_query", {});
    expect(JSON.stringify(forAdmin)).toContain("ADMIN-TITULO-SECRETO");
  });
});
