// OCL-213 non-regression: contract density of real cards, read from the
// task_create calls mined by scripts/ocl-209/mine-claude.mjs. Compare 5 cards
// filed before the cut with 5 filed after it.
//   node density.mjs <since-iso> [until-iso]
// Per card: o_que and por_que characters, como_confirmo steps, and characters
// of step + expected. Text como_confirmo is read with the board's own rule.
import fs from "node:fs";

const [since, until = "9999"] = process.argv.slice(2);
const ARROW = /\s*(?:→|->|=>)\s*/;
const BULLET = /^\s*(?:\d+[.)]|[-*•])\s+/;
const steps = (value) =>
  Array.isArray(value)
    ? value
    : String(value ?? "")
        .split("\n")
        .map((line) => line.replace(BULLET, "").trim())
        .filter(Boolean)
        .map((line) => {
          const at = ARROW.exec(line);
          return at ? { step: line.slice(0, at.index), expected: line.slice(at.index + at[0].length) } : { step: line, expected: "" };
        });

const rows = [];
for (const line of fs.readFileSync("claude-payloads.jsonl", "utf8").split("\n")) {
  if (!line) continue;
  const call = JSON.parse(line);
  if (call.tool !== "task_create" || call.date < since || call.date >= until) continue;
  if (!call.result || call.result.includes('"error"')) continue;
  let args;
  try { args = JSON.parse(call.args); } catch { continue; }
  if (args.__unparsedToolInput) continue;
  const list = steps(args.como_confirmo);
  rows.push({
    card: /"short_id":"([^"]+)"/.exec(call.result)?.[1] ?? "?",
    filed: call.date.slice(0, 16),
    o_que: (args.o_que ?? "").length,
    por_que: (args.por_que ?? "").length,
    steps: list.length,
    step_chars: list.reduce((sum, s) => sum + s.step.length + s.expected.length, 0),
    binary: list.every((s) => s.step.trim() && s.expected.trim()),
    form: Array.isArray(args.como_confirmo) ? "list" : "text",
    origem: args.origem ? "sent" : "board",
  });
}
console.log("card | filed | o_que | por_que | steps | step chars | every step binary | como_confirmo | origem");
for (const r of rows) console.log(Object.values(r).join(" | "));
