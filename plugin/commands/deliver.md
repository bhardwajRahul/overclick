---
description: Verify, push, measure, and deliver the current OverClick card.
---

Load the bundled `overclick` skill and read its linked canonical `OVERCLICK.md`.
Find this session's single executing card with `task_list`
using `status: "em_execucao"`, `claimed_by: "me"`, and the `session_id` declared
in this session's claim; stop if the session is unknown, or there is none or
more than one. Run its binary confirmation checks, commit with the card prefix,
and push the registered branch. Cite the full Git commit ID in evidence. Call
`task_deliver` with a truthful summary, check results, branch, verification
entry point and transcript. On Claude Code omit usage: the plugin's hook
measures it from this session's transcript. Elsewhere run the exact usage
recipe from the claim briefing and send the measured usage. Never mark the card
validated.
