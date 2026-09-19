---
description: Stamp the current OverClick card with an exact release tag.
argument-hint: <release-tag>
---

Load the bundled `overclick` skill and read its linked canonical `OVERCLICK.md`.
Find this session's single executing card with `task_list`
using `status: "em_execucao"`, `claimed_by: "me"`, and the `session_id` declared
in this session's claim. Refuse an unknown session. Treat `$ARGUMENTS` as the
exact release tag and call `task_update` with `resolved_in`. Refuse an empty tag
or an ambiguous set of active claims. This command does not validate or deploy
the card.
