import { describe, expect, it } from "vitest";
import { TaskUpdateInputSchema, discardRefusal, type DiscardCheck } from "../src/index.js";

const liveClaim: NonNullable<DiscardCheck["claim"]> = {
  ownedByCaller: false,
  stale: false,
  holder: "codex",
  lastActivityAt: "2026-09-23T12:00:00.000Z",
  expiresAt: "2026-09-23T13:00:00.000Z",
};

describe("discarding a card (OCL-203)", () => {
  it("lets an open or a delivered card go", () => {
    expect(discardRefusal({ shortId: "OCL-1", status: "aberto", continues: false })).toBeNull();
    expect(discardRefusal({ shortId: "OCL-1", status: "feito", continues: false })).toBeNull();
  });

  it("lets a card in execution go when the claim is the caller's, expired, or handed on", () => {
    const base = { shortId: "OCL-1", status: "em_execucao" as const, continues: false };
    expect(discardRefusal({ ...base, claim: { ...liveClaim, ownedByCaller: true } })).toBeNull();
    expect(discardRefusal({ ...base, claim: { ...liveClaim, stale: true } })).toBeNull();
    expect(discardRefusal({ ...base, continues: true, claim: liveClaim })).toBeNull();
  });

  it("refuses a live claim held by another executor, and says what to do first", () => {
    const refusal = discardRefusal({
      shortId: "OCL-1",
      status: "em_execucao",
      continues: false,
      claim: liveClaim,
    });
    expect(refusal).toContain("OCL-1 is in execution");
    expect(refusal).toContain("held by codex");
    expect(refusal).toContain("expires at 2026-09-23T13:00:00.000Z");
    expect(refusal).toContain('task_release {task_id: "OCL-1", reason}');
    expect(refusal).toContain("superseded_by");
  });

  it("refuses a closed card with the reason", () => {
    expect(
      discardRefusal({ shortId: "OCL-1", status: "validado", continues: false }),
    ).toContain("validated");
    expect(
      discardRefusal({ shortId: "OCL-1", status: "descartado", continues: false }),
    ).toBe("OCL-1 is already discarded.");
  });

  it("asks for the reason unless a continuation is named", () => {
    const noReason = TaskUpdateInputSchema.safeParse({ task_id: "OCL-1", status: "descartado" });
    expect(noReason.success).toBe(false);
    if (!noReason.success) {
      expect(noReason.error.issues[0]?.message).toContain("reason");
    }
    expect(
      TaskUpdateInputSchema.safeParse({
        task_id: "OCL-1",
        status: "descartado",
        comment: "the decision changed",
      }).success,
    ).toBe(true);
    expect(
      TaskUpdateInputSchema.safeParse({
        task_id: "OCL-1",
        status: "descartado",
        superseded_by: "OCL-2",
      }).success,
    ).toBe(true);
  });
});
