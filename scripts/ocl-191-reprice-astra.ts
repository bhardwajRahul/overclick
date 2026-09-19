/**
 * Run after the OCL-191 release against the target board database.
 * DATABASE_URL is read silently; dry run by default, --apply writes only cost
 * snapshots. Tokens, identities, handoffs and human validation are preserved.
 * pnpm --filter @agent-board/db exec tsx ../../scripts/ocl-191-reprice-astra.ts [--apply]
 */
import { createDb } from "../packages/db/src/client";
import { repriceUnpricedAstra } from "../apps/web/src/lib/reprice-astra";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { db, sql } = createDb(process.env.DATABASE_URL);
  try {
    console.log(JSON.stringify(await repriceUnpricedAstra(db, process.argv.includes("--apply"))));
  } finally {
    await sql.end();
  }
}

main().catch(() => {
  console.error("Astra repricing failed; connection details and database values are suppressed.");
  process.exitCode = 1;
});
