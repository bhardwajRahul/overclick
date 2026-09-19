import { and, eq, isNotNull, sql } from "drizzle-orm";
import { assessAttemptCost, executionAttempt, project, task } from "@agent-board/db";
import type { McpDatabase } from "../mcp/types";
import { loadModelPrices } from "./prices";

/** OCL-191: repair only closed card attempts frozen without an Astra price. */
export async function repriceUnpricedAstra(db: McpDatabase, apply = false) {
  return db.transaction(async tx => {
    // Lock the attempts so a simultaneous usage correction cannot be replaced
    // by an assessment of older counters. Dry runs write nothing.
    const candidates = await tx.select({
      attempt: executionAttempt,
      workspaceId: project.workspaceId,
    }).from(executionAttempt)
      .innerJoin(task, eq(task.id, executionAttempt.taskId))
      .innerJoin(project, eq(project.id, task.projectId))
      .where(and(
        isNotNull(executionAttempt.finishedAt),
        sql`${executionAttempt.costUnpricedModels} @> '["gpt-6-astra"]'::jsonb`,
      )).for("update", { of: executionAttempt });
    const pricesByWorkspace = new Map<string, Awaited<ReturnType<typeof loadModelPrices>>>();
    let recovered = 0;
    let computed = 0;
    for (const { attempt, workspaceId } of candidates) {
      if (!attempt.usageSegments?.length) continue;
      let prices = pricesByWorkspace.get(workspaceId);
      if (!prices) {
        prices = await loadModelPrices(tx, workspaceId);
        pricesByWorkspace.set(workspaceId, prices);
      }
      const assessment = assessAttemptCost(attempt.usageSegments, prices, {
        tokensReported: true,
        reportedCostUsd: attempt.reportedCostUsd == null ? null : Number(attempt.reportedCostUsd),
        usageEstimated: attempt.usageEstimated,
        usageSuspect: attempt.usageSuspect,
      });
      if (assessment.unpricedModels.includes("gpt-6-astra")) continue;
      recovered++;
      if (assessment.status === "computed") computed++;
      if (apply) await tx.update(executionAttempt).set({
        costUsd: assessment.costUsd?.toFixed(6) ?? null,
        costSource: assessment.source,
        costStatus: assessment.status,
        costUnpricedModels: assessment.unpricedModels,
        costBreakdown: assessment.breakdown,
      }).where(eq(executionAttempt.id, attempt.id));
    }
    return { apply, candidates: candidates.length, recovered, computed, updated: apply ? recovered : 0 };
  });
}
