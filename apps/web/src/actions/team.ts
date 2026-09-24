"use server";

import { isValidPassword } from "@agent-board/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionResult } from "../lib/action-result";
import { getSession, setSession } from "../lib/cookies";
import { db } from "../lib/db";
import { dict } from "../lib/i18n";
import {
  acceptInvitation,
  createInvitation,
  dismissInstallNotices,
  revokeInvitation,
  setMemberActive,
} from "../lib/invitations";
import { hashPassword } from "../lib/password";
import { ADMIN_ONLY, sessionPrincipal } from "../lib/web-scope";

/**
 * Invitations and the team (OCL-222). Everything here but accepting a link is
 * the admin's; a member calling it gets the refusal and nothing changes.
 */
type AdminSession =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; error: string };

async function adminSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (principal?.role !== "admin") return { ok: false, error: ADMIN_ONLY };
  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };
  return { ok: true, userId: session.userId, workspaceId: ws.id };
}

export type CreateInvitationResult =
  | { ok: true; path: string; expiresAt: string }
  | { ok: false; error: string };

/** The link is returned once, here; the database keeps only its hash. */
export async function createInvitationAction(input: {
  email: string;
  organizationId: string;
}): Promise<CreateInvitationResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;

  const created = await createInvitation(db(), {
    workspaceId: admin.workspaceId,
    email: input.email,
    organizationId: input.organizationId,
    createdByUserId: admin.userId,
  });
  if (!created.ok) return created;
  revalidatePath("/settings");
  return { ok: true, path: created.path, expiresAt: created.expiresAt.toISOString() };
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  const done = await revokeInvitation(db(), {
    workspaceId: admin.workspaceId,
    invitationId,
  });
  if (!done) return { ok: false, error: "Invitation not found, or already used." };
  revalidatePath("/settings");
  return { ok: true };
}

export async function setMemberActiveAction(
  userId: string,
  active: boolean,
): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  const result = await setMemberActive(db(), {
    targetUserId: userId,
    active,
    actingUserId: admin.userId,
  });
  if (!result.ok) return result;
  revalidatePath("/settings");
  return { ok: true };
}

/** The admin read the "member finished installing" notice on the home. */
export async function dismissInstallNoticesAction(): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  await dismissInstallNotices(db(), admin.userId);
  revalidatePath("/home");
  return { ok: true };
}

export type AcceptState = { error: string } | null;

/** Public: the invited person sets a password and lands signed in on the board. */
export async function acceptInvitationAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const secret = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const ws = await db().query.workspace.findFirst();
  const t = dict(ws?.language).auth;
  if (!isValidPassword(password)) return { error: t.errPassword };
  if (password !== confirm) return { error: t.errMismatch };

  const accepted = await acceptInvitation(db(), secret, await hashPassword(password));
  if (!accepted.ok) return { error: t.inviteRefused[accepted.reason] };

  await setSession({
    userId: accepted.userId,
    sessionVersion: accepted.sessionVersion,
  });
  // Signed up, the member goes on to install: the plugin and the pairing that
  // mints their own token (the owner's decision, 2026-09-24).
  redirect("/onboarding");
}
