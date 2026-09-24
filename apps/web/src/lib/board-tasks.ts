import { task, type Database } from "@agent-board/db";
import { and, asc, inArray } from "drizzle-orm";
import { canSeeMission, canSeeTask, taskScope, type MaybePrincipal } from "./scope";

/**
 * The board's cards with everything the card line and detail panel read.
 *
 * The cards themselves are filtered by scope in the query. What they point at
 * is filtered here (OCL-227): an admin can put a member's card in one of their
 * missions, or continue it in a card of theirs, and the member's card would
 * otherwise carry that mission's title or that card's id and short id along
 * with it. A reference the reader may not see reads as no reference at all.
 */
export async function loadBoardTasks(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
) {
  if (projectIds.length === 0) return [];
  const rows = await database.query.task.findMany({
    where: and(inArray(task.projectId, projectIds), taskScope(principal)),
    orderBy: asc(task.createdAt),
    with: {
      mission: { columns: { id: true, title: true, createdByUserId: true } },
      project: { columns: { name: true, repoUrl: true, organizationId: true } },
      createdBy: { columns: { email: true } },
      reviewer: { columns: { email: true } },
      attempts: true,
      handoffs: true,
      comments: true,
      supersedes: { columns: { id: true, shortId: true, createdByUserId: true } },
      supersededBy: { columns: { id: true, shortId: true, createdByUserId: true } },
    },
  });
  return rows.map((row) => {
    const mission = row.mission && canSeeMission(principal, row.mission) ? row.mission : null;
    const supersedes =
      row.supersedes && canSeeTask(principal, row.supersedes) ? row.supersedes : null;
    const supersededBy =
      row.supersededBy && canSeeTask(principal, row.supersededBy) ? row.supersededBy : null;
    return {
      ...row,
      mission,
      missionId: mission ? row.missionId : null,
      supersedes,
      supersedesId: supersedes ? row.supersedesId : null,
      supersededBy,
      supersededById: supersededBy ? row.supersededById : null,
    };
  });
}
