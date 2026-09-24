import { createHash, randomInt } from "node:crypto";
import { mcpToken, pairingCode, pairingFailure } from "@agent-board/db";
import { and, eq, isNull } from "drizzle-orm";
import { clearBudget, spendBudget, spendBudgetStatement } from "./attempt-budget";
import { generateTokenSecret, hashToken } from "../mcp/token";
import type { McpDatabase } from "../mcp/types";

/**
 * One-time pairing: the human reads a 6-digit code to the agent, the agent
 * exchanges it on the public endpoint and receives the real bearer token.
 * The token value never travels through a chat. The code is consumed on
 * first use and expires quickly; only one code is active per workspace.
 */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses one origin may spend inside a window before the endpoint
 * stops looking at its codes at all.
 *
 * Six digits is a million combinations, which sounds like plenty until you
 * notice nothing serialises the attempts: a flat delay on the failure path
 * is paid by each request on its own, so concurrent requests wait in
 * parallel and the ceiling is the caller's connection count, not the delay.
 * Inside a ten minute TTL that is reachable, and the prize is a real bearer
 * token for the workspace.
 *
 * Counting instead of slowing removes the concurrency advantage: an attempt
 * costs budget before anyone looks at the code it carries, so a hundred
 * parallel guesses drain the budget a hundred times faster and then get
 * refused unread.
 */
export const MAX_PAIRING_FAILURES = 10;

/**
 * Which bucket an attempt is charged to.
 *
 * A wrong guess matches no row, because the lookup is by hash, so there is
 * no code to attribute it to and the budget has to live outside the codes.
 * One bucket for the whole instance would work as a brake and fail as a
 * design: ten anonymous requests would then be enough to freeze the pairing
 * of every workspace at once, which is a denial of service handed to any
 * stranger. So the bucket is the origin the deployment can honestly name,
 * and callers that cannot be told apart share the fallback one.
 *
 * The escape hatch out of a drained bucket is not time, it is the human:
 * see `createPairingCode`.
 */
function pairingFailureScope(origin?: string | null): string {
  const named = origin?.trim().slice(0, 100);
  return `origin:${named || "unknown"}`;
}

/**
 * Codes one person may generate inside a window (OCL-227).
 *
 * Generating a code reopens the guessing budget of the origin that asked for
 * it (see `createPairingCode`). With one user that was only ever the honest
 * human; with members, the person generating can be the one guessing, so each
 * generation would buy a fresh round of guesses. Capping generations per user
 * bounds that: at most this many resets, each worth `MAX_PAIRING_FAILURES`
 * guesses, per window. Generating is a click, so five covers a human who
 * mistyped the label or let a code expire.
 */
export const MAX_PAIRING_CODES_PER_USER = 5;

/**
 * The generation budget lives in the same table as the guessing one, under a
 * prefix no origin can produce, the way `login_failure` keeps two kinds apart.
 */
function pairingGenerationScope(userId: string): string {
  return `generate:user:${userId}`;
}

/** Spends one code generation for the user; false once the window is spent. */
export async function spendPairingGeneration(
  db: McpDatabase,
  userId: string,
): Promise<boolean> {
  return spendBudget(
    db,
    pairingFailure,
    pairingGenerationScope(userId),
    MAX_PAIRING_CODES_PER_USER,
    PAIRING_CODE_TTL_MS,
  );
}

export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(`ovk-pair:${code}`, "utf8").digest("hex");
}

export function isValidPairingCodeFormat(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * Charges one attempt to the scope and says whether it may be evaluated.
 *
 * A single statement, so a burst cannot have every request read the same
 * count and write back the same increment; concurrency was the whole
 * weakness, so the accounting is the one place it may not leak. The count
 * comes back from the statement that spent it, which is what lets the
 * caller decide *before* it looks at the code: past the budget the guess is
 * refused without ever being hashed or compared, so the thousandth guess of
 * a burst cannot win even when it happens to be right.
 *
 * The window is the code TTL: outside it there was no live code to protect,
 * so the count starts over.
 *
 * The two timestamps go in as ISO strings with an explicit cast, and that is
 * not a style choice (OCL-109). A value handed to `.values()` is mapped by the
 * column that receives it; a value interpolated into `sql` has no column, so
 * it reaches the driver as whatever it already was. postgres-js, which is what
 * production runs, refuses a `Date` in that position and the whole endpoint
 * answers 500. PGlite, which is what the integration tests run, accepts it,
 * which is exactly how a green suite shipped a pairing endpoint that could not
 * pair.
 *
 * The statement is built by an exported function for that reason alone: a test
 * can read the parameters it is about to send without needing the driver that
 * would have caught them.
 */
export function spendAttemptStatement(
  db: McpDatabase,
  scope: string,
  now: Date,
) {
  return spendBudgetStatement(db, pairingFailure, scope, now, PAIRING_CODE_TTL_MS);
}

async function spendAttempt(db: McpDatabase, scope: string): Promise<boolean> {
  return spendBudget(db, pairingFailure, scope, MAX_PAIRING_FAILURES, PAIRING_CODE_TTL_MS);
}

/** A successful pairing clears the budget: nobody there was guessing. */
async function clearAttempts(db: McpDatabase, scope: string): Promise<void> {
  await clearBudget(db, pairingFailure, scope);
}

export async function createPairingCode(
  db: McpDatabase,
  input: {
    workspaceId: string;
    label: string;
    userId?: string;
    /** Where the human asking for the code is, as `/api/pair` would name it. */
    origin?: string | null;
  },
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

  // One active code per person: a new code replaces any unconsumed one of
  // theirs, which keeps the guessing space at one live code per signed-in
  // human. Scoped to the author (OCL-222) so a member pairing an agent cannot
  // cancel the code the admin is reading out at the same time.
  await db
    .delete(pairingCode)
    .where(
      and(
        eq(pairingCode.workspaceId, input.workspaceId),
        isNull(pairingCode.consumedAt),
        input.userId
          ? eq(pairingCode.createdByUserId, input.userId)
          : isNull(pairingCode.createdByUserId),
      ),
    );

  // Generating a code is a signed-in human saying "I am here now", and it
  // is what reopens a drained bucket. Without this a guesser could leave
  // the endpoint refusing the very attempt the legitimate agent is about
  // to make. Only the bucket of the origin asking is reopened (OCL-227):
  // clearing every bucket let a member, who is a signed-in human too, wipe
  // the budget of the origin guessing at the admin's live code as often as
  // they liked. Their own origin is still reopened, and the per-user cap on
  // generations (`spendPairingGeneration`) bounds how often.
  await db.delete(pairingFailure).where(eq(pairingFailure.id, pairingFailureScope(input.origin)));

  const [row] = await db
    .insert(pairingCode)
    .values({
      workspaceId: input.workspaceId,
      codeHash: hashPairingCode(code),
      secret: generateTokenSecret(),
      label: input.label.trim() || "paired agent",
      createdByUserId: input.userId ?? null,
      expiresAt,
    })
    .returning({ id: pairingCode.id });
  if (!row) throw new Error("failed to insert pairing code");

  return { id: row.id, code, expiresAt };
}

/**
 * A workspace may not hold two tokens under the same label, and revoking one
 * does not free it: `mcp_token_workspace_label` does not exclude revoked rows.
 * The default label is a constant ("paired agent"), so the second pairing on a
 * workspace collided, the insert below threw, and `/api/pair` answered 500 with
 * no way back through the UI — the instance was simply unpairable from then on.
 * That state is reached by the most ordinary action there is: pairing again
 * after a first attempt died before the token reached the agent.
 *
 * So the label the human chose is a preference, not a key: when it is taken,
 * the next free "<label> (n)" is used. The name still says which agent it is,
 * and pairing stays repeatable.
 */
async function freeTokenLabel(
  tx: McpDatabase,
  workspaceId: string,
  desired: string,
): Promise<string> {
  const rows = await tx
    .select({ label: mcpToken.label })
    .from(mcpToken)
    .where(eq(mcpToken.workspaceId, workspaceId));
  const taken = new Set(rows.map((r) => r.label));
  if (!taken.has(desired)) return desired;
  for (let n = 2; n <= 500; n += 1) {
    const candidate = `${desired} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  // 500 tokens deep the suffix is no longer telling anyone anything; fall back
  // to something that cannot collide rather than throwing the 500 back.
  return `${desired} (${randomInt(1_000_000, 10_000_000)})`;
}

export type ExchangeResult =
  | { ok: true; token: string; label: string }
  | { ok: false; error: string };

export async function exchangePairingCode(
  db: McpDatabase,
  rawCode: string,
  origin?: string | null,
): Promise<ExchangeResult> {
  const notFound: ExchangeResult = {
    ok: false,
    error:
      "Pairing code not found or expired. Ask the human to generate a fresh code in the board Settings or onboarding wizard.",
  };
  const scope = pairingFailureScope(origin);

  // The gate, and the whole point of it: the budget is spent and read
  // before the code is looked at, so a drained bucket refuses the attempt
  // without evaluating it. Nothing downstream of here runs on a guess the
  // budget did not pay for. The answer is the same one a wrong code gets,
  // so the refusal is not an oracle either — and it already tells the
  // caller the way out, which is to ask the human for a fresh code.
  if (!(await spendAttempt(db, scope))) return notFound;

  if (!isValidPairingCodeFormat(rawCode.trim())) return notFound;

  const result: ExchangeResult = await db.transaction(async (tx) => {
    // Consume atomically: the update only wins while consumed_at is null,
    // so a second exchange with the same code loses even in a race.
    const [consumed] = await tx
      .update(pairingCode)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(pairingCode.codeHash, hashPairingCode(rawCode.trim())),
          isNull(pairingCode.consumedAt),
        ),
      )
      .returning();
    if (!consumed) return notFound;
    if (consumed.expiresAt.getTime() < Date.now()) return notFound;

    const secret = consumed.secret;
    const label = await freeTokenLabel(tx, consumed.workspaceId, consumed.label);
    const [token] = await tx
      .insert(mcpToken)
      .values({
        workspaceId: consumed.workspaceId,
        label,
        hash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
        ownerUserId: consumed.createdByUserId,
        createdByUserId: consumed.createdByUserId,
      })
      .returning({ id: mcpToken.id });
    if (!token) throw new Error("failed to create token from pairing code");

    // Blank the plaintext secret: from here on only the token hash exists.
    await tx
      .update(pairingCode)
      .set({ secret: "", tokenId: token.id })
      .where(eq(pairingCode.id, consumed.id));

    return { ok: true, token: secret, label };
  });

  if (result.ok) await clearAttempts(db, scope);
  return result;
}

/**
 * Wizard polling: paired once the code was exchanged. Only the person who
 * generated the code may ask (OCL-227); anyone else's pairing reads as never
 * paired, the same answer an unknown id gets.
 */
export async function pairingStatus(
  db: McpDatabase,
  id: string,
  userId: string,
): Promise<{ paired: boolean }> {
  const [row] = await db
    .select({ consumedAt: pairingCode.consumedAt })
    .from(pairingCode)
    .where(and(eq(pairingCode.id, id), eq(pairingCode.createdByUserId, userId)))
    .limit(1);
  return { paired: row?.consumedAt != null };
}
