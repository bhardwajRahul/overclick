import { invitation, mcpToken, project, user, workspace } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashInvitationSecret, loadInstallNotices, loadTeam } from "../lib/invitations";
import { exchangePairingCode } from "../lib/pairing";
import { principalFromUserId } from "../lib/scope";
import { authenticateBearer } from "../mcp/auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { generateTokenSecret, hashToken } from "../mcp/token";

let world: TestWorld;
let sessionUserId = "";
const sessionsSet: { userId: string; sessionVersion: number }[] = [];

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

vi.mock("../lib/cookies", () => ({
  getSession: async () =>
    sessionUserId
      ? { userId: sessionUserId, sessionVersion: 1, email: "who@example.test" }
      : null,
  setSession: async (payload: { userId: string; sessionVersion: number }) => {
    sessionsSet.push(payload);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));

const team = await import("./team");
const { saveExecutorsAction } = await import("./executors");
const { savePricesAction, savePricingEnabledAction } = await import("./prices");
const { saveRecipesAction } = await import("./recipes");
const { saveLanguageAction } = await import("./language");
const { saveClaimTimeoutAction } = await import("./claims");
const { saveProjectAction } = await import("./onboarding");
const { createOrganizationAction } = await import("./organizations");
const {
  createTokenAction,
  setTokenManageAction,
  revokeTokenAction,
  createPairingCodeAction,
} = await import("./tokens");

function acceptForm(token: string, password = "s3cret-pass") {
  const form = new FormData();
  form.set("token", token);
  form.set("password", password);
  form.set("confirm", password);
  return form;
}

async function accept(token: string) {
  try {
    return await team.acceptInvitationAction(null, acceptForm(token));
  } catch (error) {
    if (error instanceof Redirected) return { redirectedTo: error.to };
    throw error;
  }
}

async function invite(email: string) {
  sessionUserId = world.adminUserId;
  const created = await team.createInvitationAction({
    email,
    organizationId: world.organizationId,
  });
  if (!created.ok) throw new Error(created.error);
  sessionUserId = "";
  return created.path.split("/").pop()!;
}

/** OCL-222: the admin brings a member in, and can switch them off. */
describe("invitation and team", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionsSet.length = 0;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("admin creates a single-use link with an expiry; the hash is all that is stored", async () => {
    sessionUserId = world.adminUserId;
    const created = await team.createInvitationAction({
      email: "Func@Example.test",
      organizationId: world.organizationId,
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{40,}$/);
    const secret = created.path.split("/").pop()!;
    const [row] = await world.db.select().from(invitation);
    expect(row?.email).toBe("func@example.test");
    expect(row?.tokenHash).toBe(hashInvitationSecret(secret));
    expect(row?.tokenHash).not.toContain(secret);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("step 2: opening the link and setting a password creates a member of that organization, signed in", async () => {
    const secret = await invite("func@example.test");
    expect(await accept(secret)).toEqual({ redirectedTo: "/home" });

    const [member] = await world.db
      .select()
      .from(user)
      .where(eq(user.email, "func@example.test"));
    expect(member?.role).toBe("member");
    expect(member?.organizationId).toBe(world.organizationId);
    expect(member?.passwordHash).not.toContain("s3cret-pass");
    expect(sessionsSet).toEqual([{ userId: member!.id, sessionVersion: member!.sessionVersion }]);
  });

  it("step 3: the same link a second time is refused as used", async () => {
    const secret = await invite("func@example.test");
    await accept(secret);
    const again = await accept(secret);
    expect(again).toEqual({ error: expect.stringContaining("already used") });
    const members = await world.db.select().from(user).where(eq(user.role, "member"));
    expect(members).toHaveLength(1);
  });

  it("step 4: an expired or tampered link is refused and creates nobody", async () => {
    const secret = await invite("func@example.test");
    const tampered = await accept(`${secret.slice(0, -2)}xx`);
    expect(tampered).toEqual({ error: expect.stringContaining("not valid") });

    await world.db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.tokenHash, hashInvitationSecret(secret)));
    expect(await accept(secret)).toEqual({ error: expect.stringContaining("expired") });

    const withdrawn = await invite("other@example.test");
    const [row] = await world.db
      .select({ id: invitation.id })
      .from(invitation)
      .where(eq(invitation.tokenHash, hashInvitationSecret(withdrawn)));
    sessionUserId = world.adminUserId;
    expect(await team.revokeInvitationAction(row!.id)).toEqual({ ok: true });
    sessionUserId = "";
    expect(await accept(withdrawn)).toEqual({ error: expect.stringContaining("withdrawn") });

    expect(await world.db.select().from(user).where(eq(user.role, "member"))).toHaveLength(0);
  });

  it("step 8: the open signup stays closed after the first admin", async () => {
    const { signupAction } = await import("./auth");
    const form = new FormData();
    form.set("email", "intruder@example.test");
    form.set("password", "s3cret-pass");
    form.set("confirm", "s3cret-pass");
    expect(await signupAction(null, form)).toEqual({ error: expect.any(String) });
    expect(
      await world.db.select().from(user).where(eq(user.email, "intruder@example.test")),
    ).toHaveLength(0);
  });

  describe("signed in as the member", () => {
    let memberId = "";

    beforeEach(async () => {
      await accept(await invite("func@example.test"));
      const [m] = await world.db.select().from(user).where(eq(user.email, "func@example.test"));
      memberId = m!.id;
      sessionUserId = memberId;
    });

    it("step 5: tokens and pairing codes the member creates are theirs", async () => {
      const created = await createTokenAction("member laptop");
      if (!created.ok) throw new Error(created.error);
      const [tok] = await world.db.select().from(mcpToken).where(eq(mcpToken.id, created.id));
      expect(tok?.ownerUserId).toBe(memberId);
      expect(tok?.canManage).toBe(false);

      const pairing = await createPairingCodeAction("member agent");
      if (!pairing.ok) throw new Error(pairing.error);
      const exchanged = await exchangePairingCode(world.db, pairing.code);
      if (!exchanged.ok) throw new Error(exchanged.error);
      const auth = await authenticateBearer(world.db, `Bearer ${exchanged.token}`);
      expect(auth.ok && auth.ctx.userId).toBe(memberId);
      expect(auth.ok && auth.ctx.role).toBe("member");
    });

    it("step 6: every workspace-configuration action refuses the member and changes nothing", async () => {
      const [before] = await world.db.select().from(workspace);
      const projectsBefore = await world.db.select().from(project);
      const adminTokensBefore = await world.db.select().from(mcpToken);

      const refusals = [
        await team.createInvitationAction({ email: "x@example.test", organizationId: world.organizationId }),
        await team.revokeInvitationAction("00000000-0000-0000-0000-000000000000"),
        await team.setMemberActiveAction(world.adminUserId, false),
        await saveExecutorsAction({ enabled: {}, models: {}, efforts: {} } as never),
        await savePricesAction([]),
        await savePricingEnabledAction(true),
        await saveRecipesAction([]),
        await saveLanguageAction("pt-BR"),
        await saveClaimTimeoutAction(5),
        await saveProjectAction({ name: "Hijack", repoUrl: "", prefix: "HJ", organizationName: "Nova" }),
        await createOrganizationAction({ name: "Nova" }),
        await setTokenManageAction(world.tokenId, false),
        await createTokenAction("sneaky", true),
      ];
      for (const r of refusals) expect(r).toMatchObject({ ok: false });

      // Someone else's token is "not found", never revoked.
      expect(await revokeTokenAction(world.tokenId)).toEqual({ ok: false, error: "Token not found." });

      const [after] = await world.db.select().from(workspace);
      expect(after).toEqual(before);
      expect(await world.db.select().from(project)).toEqual(projectsBefore);
      const adminTokensAfter = await world.db.select().from(mcpToken);
      expect(adminTokensAfter).toEqual(adminTokensBefore);
      expect(await world.db.select().from(invitation)).toHaveLength(1);
      const [admin] = await world.db.select().from(user).where(eq(user.id, world.adminUserId));
      expect(admin?.active).toBe(true);
    });

    it("the member revokes their own token", async () => {
      const created = await createTokenAction("mine");
      if (!created.ok) throw new Error(created.error);
      expect(await revokeTokenAction(created.id)).toEqual({ ok: true });
    });
  });

  it("step 7: deactivating the member drops their web session and refuses their tokens", async () => {
    await accept(await invite("func@example.test"));
    const [m] = await world.db.select().from(user).where(eq(user.email, "func@example.test"));
    const secret = generateTokenSecret();
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      label: "member token",
      hash: hashToken(secret),
      ownerUserId: m!.id,
      createdByUserId: m!.id,
    });
    expect((await authenticateBearer(world.db, `Bearer ${secret}`)).ok).toBe(true);

    sessionUserId = world.adminUserId;
    expect(await team.setMemberActiveAction(m!.id, false)).toEqual({ ok: true });

    const [after] = await world.db.select().from(user).where(eq(user.id, m!.id));
    expect(after?.active).toBe(false);
    // The cookie carries the old version: getSession no longer matches it.
    expect(after?.sessionVersion).toBe(m!.sessionVersion + 1);
    expect(await principalFromUserId(world.db, m!.id)).toBeNull();
    const refused = await authenticateBearer(world.db, `Bearer ${secret}`);
    expect(refused).toMatchObject({ ok: false, code: "TOKEN_REVOKED" });

    // An admin cannot be switched off from here, themselves included.
    expect(await team.setMemberActiveAction(world.adminUserId, false)).toMatchObject({ ok: false });

    expect(await team.setMemberActiveAction(m!.id, true)).toEqual({ ok: true });
    expect((await authenticateBearer(world.db, `Bearer ${secret}`)).ok).toBe(true);
  });

  it("the admin sees a member go from registered to installed, and is told once", async () => {
    await accept(await invite("func@example.test"));
    const [m] = await world.db.select().from(user).where(eq(user.email, "func@example.test"));
    const secret = generateTokenSecret();
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      label: "member token",
      hash: hashToken(secret),
      ownerUserId: m!.id,
    });

    const registered = (await loadTeam(world.db, world.workspaceId)).find((p) => p.id === m!.id);
    expect(registered?.installedAt).toBeNull();
    const notices = () =>
      loadInstallNotices(world.db, { workspaceId: world.workspaceId, adminUserId: world.adminUserId });
    expect(await notices()).toEqual([]);

    await authenticateBearer(world.db, `Bearer ${secret}`);
    const [tok] = await world.db.select().from(mcpToken).where(eq(mcpToken.hash, hashToken(secret)));
    const first = tok!.firstUsedAt;
    expect(first).not.toBeNull();
    await authenticateBearer(world.db, `Bearer ${secret}`);
    const [again] = await world.db.select().from(mcpToken).where(eq(mcpToken.hash, hashToken(secret)));
    expect(again!.firstUsedAt).toEqual(first);

    const installed = (await loadTeam(world.db, world.workspaceId)).find((p) => p.id === m!.id);
    expect(installed?.installedAt).not.toBeNull();
    expect((await notices()).map((n) => n.email)).toEqual(["func@example.test"]);

    sessionUserId = world.adminUserId;
    expect(await team.dismissInstallNoticesAction()).toEqual({ ok: true });
    expect(await notices()).toEqual([]);

    // A member cannot dismiss the admin's notice.
    sessionUserId = m!.id;
    expect(await team.dismissInstallNoticesAction()).toMatchObject({ ok: false });
  });
});
