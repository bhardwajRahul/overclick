// OCL-214 — did the tools/list that a session never received reach the board?
// Crosses Claude Code's own MCP logs (one file per session connection, listed in
// <file-list.txt>) with the proxy's JSON access log read from stdin, minute by
// minute. A session that timed out while the proxy shows its tools/list answered
// 200 means the answer was lost after leaving the origin. Prints only times,
// counts, sizes and statuses: never addresses, URLs or headers.
//   ssh <host> 'docker exec <proxy> grep "\"/mcp\"" /traefik/access.log' \
//     | node lost-listing.mjs <file-list.txt> [--since=YYYY-MM-DD]
import fs from "node:fs";
import readline from "node:readline";

const files = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const since = (process.argv.find((a) => a.startsWith("--since=")) ?? "--since=2000-01-01").slice(8);
const minute = (t) => t.slice(0, 16);
const buckets = {};
const bucket = (t) => (buckets[minute(t)] ??= { sessions: 0, timedOut: 0, listed: 0, listedSlow: 0, listedNot200: 0 });

let sessions = 0, timedOut = 0;
for (const f of files) {
  let ev;
  try { ev = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { continue; }
  const msg = (e) => String(e.debug ?? e.error ?? "");
  if (!ev.some((e) => /host=cloud\.overclock\.sh/.test(msg(e)))) continue;
  const connected = ev.find((e) => /^Successfully connected/.test(msg(e)));
  if (!connected || connected.timestamp < since) continue;
  const b = bucket(connected.timestamp);
  b.sessions += 1; sessions += 1;
  if (ev.some((e) => /Failed to fetch tools/.test(msg(e)))) { b.timedOut += 1; timedOut += 1; }
}

// Claude Code's tools/list body is the 46-byte {"method":"tools/list","jsonrpc":"2.0","id":1}.
const LIST_BYTES = 46;
let listed = 0, slowest = 0;
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.RequestMethod !== "POST" || e.RequestContentSize !== LIST_BYTES || e.StartUTC < since) continue;
  const b = bucket(e.StartUTC);
  const ms = Math.round(e.Duration / 1e6);
  b.listed += 1; listed += 1; slowest = Math.max(slowest, ms);
  if (ms > 1000) b.listedSlow += 1;
  if (e.DownstreamStatus !== 200) b.listedNot200 += 1;
}

const rows = Object.entries(buckets).filter(([, b]) => b.timedOut > 0).sort();
for (const [m, b] of rows) {
  console.log(`${m}  sessions=${b.sessions} timed_out=${b.timedOut} proxy_tools_list=${b.listed} (slow>1s ${b.listedSlow}, not200 ${b.listedNot200})`);
}
const answeredAnyway = rows.filter(([, b]) => b.listed >= b.sessions && b.listedSlow === 0 && b.listedNot200 === 0).length;
console.log(JSON.stringify({
  sessions, timed_out: timedOut, rate: sessions ? +(timedOut / sessions * 100).toFixed(1) : null,
  proxy_tools_list: listed, proxy_slowest_ms: slowest,
  minutes_with_timeouts: rows.length,
  minutes_where_every_listing_was_answered_fast: answeredAnyway,
}));
