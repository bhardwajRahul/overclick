// OCL-212 — task_deliver calls per card and why the extra ones happened.
// Reads the sessions.jsonl / claude-payloads.jsonl produced by the OCL-209
// miners (scripts/ocl-209 on its branch). Groups deliveries by session + card
// and counts the calls up to the first accepted one, so a session that works
// several cards does not count one card's delivery inside another's window
// (flow.mjs does, which is where its 1.31 came from).
//   node deliver-retries.mjs <sessions.jsonl> <claude-payloads.jsonl> [since]
import fs from "node:fs";

const [, , sessionsFile, payloadsFile, since = "2026-09-09"] = process.argv;
const results = new Map();
for (const line of fs.readFileSync(payloadsFile, "utf8").split("\n")) {
  if (!line) continue;
  const p = JSON.parse(line);
  if (p.tool === "task_deliver") results.set(p.call_id, p.result ?? "");
}
const short = (t) => t?.replace(/^mcp__overclick__/, "");
const deliveries = fs
  .readFileSync(sessionsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => short(r.tool) === "task_deliver" && new Date(r.ts).toISOString() >= since);

function cause(call) {
  const res = results.get(call.call_id) ?? "";
  if (/could not be parsed as JSON/.test(res)) return "malformed JSON (client)";
  if (/at evidence/.test(res)) return "evidence shape";
  if (/INVALID_TRANSITION/.test(res)) return "invalid transition (already delivered)";
  if (/usage|estimated/i.test(res)) return "usage refused";
  if (/commit|remote/i.test(res)) return "commit not reachable";
  return `other: ${res.slice(0, 100)}`;
}

const byCard = new Map();
for (const d of deliveries) {
  const key = `${d.session}|${d.task_ref}`;
  if (!byCard.has(key)) byCard.set(key, []);
  byCard.get(key).push(d);
}
let cards = 0;
let calls = 0;
const causes = {};
for (const [, ds] of byCard) {
  ds.sort((a, b) => a.seq - b.seq);
  const ok = ds.findIndex((d) => !d.is_error);
  if (ok < 0) continue;
  cards += 1;
  calls += ok + 1;
  for (const d of ds.slice(0, ok)) causes[cause(d)] = (causes[cause(d)] ?? 0) + 1;
}
const failed = {};
for (const d of deliveries.filter((d) => d.is_error)) failed[cause(d)] = (failed[cause(d)] ?? 0) + 1;
console.log(`since ${since}: ${cards} cards, ${calls} deliver calls up to the first accepted one = ${(calls / cards).toFixed(3)} per card`);
console.log("causes of the extra calls:", causes);
console.log(`every refused task_deliver (${deliveries.filter((d) => d.is_error).length} of ${deliveries.length}):`, failed);
