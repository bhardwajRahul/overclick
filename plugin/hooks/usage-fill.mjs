// OCL-211: usage by reference, on the machine that ran the card.
//
// A board in the cloud never sees the agent's disk, so it cannot read the
// transcript a delivery names. This hook can: it runs next to the session,
// before task_deliver leaves, and when the call carries no usage it measures
// the session transcript from the claim boundary and puts the numbers into the
// call itself. The agent stops retyping what the recipe already printed.
//
// Numbers the agent sent always win: a call with usage passes untouched. So
// does anything this hook cannot measure honestly — no claim marker for this
// card, no transcript, no usage lines in the window. Those deliveries go on
// exactly as before, and the board answers them as it always has.
//
// The counting rule is the shipped Claude Code recipe's (packages/db
// usage-recipe.ts), message.id dedupe included (OCL-215); a test holds the
// two to the same numbers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimFile, failOpen, hookCwd, hookSession, parseJson, readStdin } from "./common.mjs";

const DELIVER = /^(mcp__.*__)?task_deliver$/;

function expandHome(file) {
  if (file === "~") return os.homedir();
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return file;
}

function readMarker(cwd) {
  try {
    return parseJson(fs.readFileSync(claimFile(cwd), "utf8"));
  } catch {
    return null;
  }
}

/** Tokens per model from a Claude Code transcript, from claimedAt on. */
function measureClaudeTranscript(file, claimedAt) {
  const claim = Date.parse(claimedAt ?? "");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  // One response is written as one line per content block, each repeating
  // its usage under the same message.id: the last line for an id wins, and a
  // line with no id stands for itself.
  const responses = new Map();
  let anonymous = 0;
  for (const line of raw.split("\n")) {
    const entry = parseJson(line);
    if (!entry || typeof entry !== "object") continue;
    if (!Number.isNaN(claim)) {
      const at = Date.parse(String(entry.timestamp ?? ""));
      if (Number.isNaN(at) || at < claim) continue;
    }
    const message = entry.message ?? {};
    if (!message.usage) continue;
    const key = typeof message.id === "string" && message.id !== ""
      ? `id:${message.id}`
      : `line:${anonymous++}`;
    responses.set(key, { model: message.model, usage: message.usage });
  }
  if (responses.size === 0) return null;

  const byModel = new Map();
  for (const { model, usage } of responses.values()) {
    const name = model || "unknown";
    const row = byModel.get(name) ?? { model: name, input: 0, output: 0, cache_read: 0, cache_write: 0 };
    row.input += usage.input_tokens || 0;
    row.output += usage.output_tokens || 0;
    row.cache_read += usage.cache_read_input_tokens || 0;
    row.cache_write += usage.cache_creation_input_tokens || 0;
    byModel.set(name, row);
  }
  return { segments: [...byModel.values()], turns: responses.size };
}

/** The task_deliver input with usage filled in, or null to leave it alone. */
function filledDeliverInput(hookInput, now = new Date()) {
  const input = hookInput?.tool_input;
  if (!input || typeof input !== "object") return null;
  if (input.usage !== undefined && input.usage !== null) return null;

  const cwd = hookCwd(hookInput) || process.cwd();
  const marker = readMarker(cwd);
  if (!marker || typeof marker.claimed_at !== "string") return null;
  // The marker holds the one card this directory claimed; a delivery of any
  // other card, or from another session, is not this marker's to measure.
  if (marker.task_id !== input.task_id) return null;
  const session = hookSession(hookInput);
  if (marker.session_id && session && marker.session_id !== session) return null;

  const named = typeof input.transcript?.path === "string" ? input.transcript.path.trim() : "";
  const file = expandHome(named || hookInput?.transcript_path || "");
  if (!file) return null;

  const measured = measureClaudeTranscript(file, marker.claimed_at);
  if (!measured) return null;
  const started = Date.parse(marker.claimed_at);
  const duration = Number.isNaN(started) ? undefined : Math.max(0, now.getTime() - started);

  return {
    ...input,
    usage: {
      segments: measured.segments,
      turns: measured.turns,
      ...(duration === undefined ? {} : { duration_ms: duration }),
      estimated: false,
    },
    transcript: { ...(input.transcript ?? {}), path: file },
  };
}

failOpen(async () => {
  const hookInput = parseJson(readStdin()) ?? {};
  const tool = hookInput?.tool_name ?? hookInput?.toolName ?? "";
  if (!DELIVER.test(tool)) return;
  const updated = filledDeliverInput(hookInput);
  if (!updated) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "OverClick filled usage from this session's transcript",
        updatedInput: updated,
      },
    })}\n`,
  );
});
