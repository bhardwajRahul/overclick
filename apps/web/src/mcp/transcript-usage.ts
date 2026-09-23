import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRecipeSetting, factoryUsageRecipes, type UsageSegment } from "@agent-board/db";
import { recipeForCli } from "../lib/recipes";

/** What the board measured off a transcript it could read. */
export type TranscriptUsage = {
  segments: UsageSegment[];
  turns: number;
};

const NODE_PREFIX = 'node -e "';

/** How long one recipe may run before the delivery gives up on it. */
const RECIPE_TIMEOUT_MS = 10_000;

/** `~/x` as the recipe printed it, resolved against this machine's home. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function readable(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function runScript(script: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["-e", script, ...args],
      {
        // The recipe falls back to TRANSCRIPT_PATH, session ids and the cwd
        // when an argument is missing; none of the server's own may leak in.
        env: { NODE_ENV: "production" },
        encoding: "utf8",
        cwd: tmpdir(),
        timeout: RECIPE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * Usage by reference (OCL-211): the delivery names its transcript instead of
 * retyping the numbers, and the board runs the CLI's shipped recipe on it,
 * from the claim boundary. The same script, the same numbers as the agent's
 * own run of the recipe, with no copy in between.
 *
 * Only a shipped recipe runs here, never one a workspace rewrote: that one is
 * code somebody typed into Settings, and the board does not execute it on its
 * own machine. Null whenever there is nothing honest to record — no recipe
 * that yields tokens, a path this machine cannot read (a board in the cloud
 * never sees the agent's disk), or a recipe that came back estimated.
 */
export async function usageFromTranscript(input: {
  cli: string | null | undefined;
  path: string | null | undefined;
  claimedAt: Date | null | undefined;
}): Promise<TranscriptUsage | null> {
  const raw = (input.path ?? "").trim();
  if (!raw) return null;
  const path = expandHome(raw);
  if (!readable(path)) return null;

  const recipe = recipeForCli(factoryUsageRecipes(), input.cli);
  if (!recipe || recipe.yields !== "tokens_per_model") return null;
  if (!recipe.command.startsWith(NODE_PREFIX) || !recipe.command.endsWith('"')) return null;
  const script = recipe.command.slice(NODE_PREFIX.length, -1);

  // The same percent-encoded `key=value` arguments task_claim binds; the
  // recipe prelude decodes them.
  const args = [`transcript=${encodeRecipeSetting(path)}`];
  if (input.claimedAt) {
    args.push(`claimed_at=${encodeRecipeSetting(input.claimedAt.toISOString())}`);
  }

  const stdout = await runScript(script, args);
  if (!stdout) return null;
  let printed: { segments?: unknown; turns?: unknown; estimated?: unknown };
  try {
    printed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (printed.estimated !== false) return null;
  if (!Array.isArray(printed.segments) || printed.segments.length === 0) return null;
  const turns = typeof printed.turns === "number" ? printed.turns : 0;
  return { segments: printed.segments as UsageSegment[], turns };
}
