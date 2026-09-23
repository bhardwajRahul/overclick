# RFC OCL-213: filing a card without ceremony

- **Date:** 2026-09-23
- **Status:** cuts implemented, shipping in the diet batch release. The "after" numbers are collected once that release is live (see the end).
- **Rule:** o_que, por_que and como_confirmo are the contract. They stay required and are not shortened. Only what is not contract is cut.

## Re-measured before cutting

OCL-209 measured `task_create` at 18.6 s of writing (p50, 09/09–23/09). That window predates OCL-202 (harness removed, v0.3.19 live at 13:43 UTC on 23/09). OCL-208 (project from repo) and OCL-210 (acks stop echoing) are not live yet, so neither is part of any number below.

Same miner as OCL-209 (`scripts/ocl-209/mine-claude.mjs`), Claude Code transcripts from both accounts, single-call messages only:

| Window | n | write p50 | args chars p50 |
|---|---|---|---|
| 09/09–23/09 (OCL-209 window) | 445 | 18.7 s | 2,058 |
| 21/09–23/09 | 173 | 19.0 s | 2,205 |
| since v0.3.19 went live | 16 | **23.6 s** | 3,372 |

The newest number is higher because today's cards carry longer contracts (o_que p50 ~3k chars on the diet mission), not because of ceremony.

## Where the time goes, by part

`scripts/ocl-213/parts.mjs`: seconds = chars / 1.95 chars per token / the model's measured writing speed (OCL-209).

| Part | 21/09–23/09 (n=162) | since v0.3.19 (n=16) | Verdict |
|---|---|---|---|
| (c) contract: o_que + por_que + como_confirmo | 10.1 s | 16.2 s | **stays, untouched** |
| model start + thinking | 3.8 s | 6.5 s | composing a good contract; not cut |
| (a) `origem` | 0.79 s (96% of calls) | 0.79 s (100%) | board fills it: **cut** |
| (a) `harness` | 0.27 s (85%) | 0.00 s (2 of 23) | already cut by OCL-202 |
| (a) project | 0.11 s | 0.08 s | OCL-208 (repo), in this batch |
| (d) JSON around como_confirmo | 0.51 s (106 chars) | 0.59 s | text form accepted: **cut** |
| (d) refusals for como_confirmo written as text | 11 of 259 calls (4.2%), each a full rewrite of ~20 s ≈ 0.85 s per card | — | text form accepted: **cut** |
| (b) text repeated from a sibling card of the same mission | 4.7% of o_que (1 of 16 cards) | 12.6% (1 of 6) | description says: reference the mission, do not paste it |

Expected cut per card: origem 0.8 s + como_confirmo JSON 0.5 s + refusals 0.85 s ≈ **2.2 s** (≈ 12% of the 18.6 s, ≈ 9% of today's 23.6 s). The rest is the contract, and it stays.

## What changed

- `origem` is optional on `task_create`. Omitted, the card records the token that filed it (`{agent: <token label>}`). Sent, it is kept as is: `reportado_por` is the one thing the board cannot know.
- `como_confirmo` also takes text: one `step → expected` per line (`->` and `=>` too; `1.`, `-`, `*` markers dropped). It is stored as the same `[{step, expected}]` list, so the card renders the same. A line missing either side is refused with its number and the form to use.
- The contract is still required: without o_que, por_que or como_confirmo the card is refused, and an empty text is refused.
- The `task_create` description, `docs/mcp.md` and `plugin/OVERCLICK.md` say the contract stays, what the board fills, and that the mission's context reaches the executor through the briefing and should not be pasted into the card.
- `harness` stays accepted and ignored. Dropping it from the strict schema would turn the few callers still sending it into refusals, each costing a full rewrite.

## Non-regression: contract density

`scripts/ocl-213/density.mjs <since> [until]`. Five real cards filed before the cut:

| card | o_que | por_que | steps | step chars | every step binary |
|---|---|---|---|---|---|
| OVKA-743 | 3,217 | 145 | 7 | 729 | yes |
| OVKA-744 | 2,666 | 166 | 7 | 694 | yes |
| OVKA-746 | 3,645 | 139 | 5 | 666 | yes |
| OVKA-747 | 3,888 | 144 | 6 | 642 | yes |
| OVKA-748 | 2,485 | 165 | 6 | 624 | yes |

After the batch release is live: mine again and run `parts.mjs <release time>` and `density.mjs <release time>` on the first five cards. The cut failed if their o_que, por_que, step count or step chars drop against this table, or if any step loses its expected result, even if the time went down.
