# Harness routing: removed from the board

Until OCL-202 the board carried a routing table: twenty activity types, each mapped to a
line of succession of CLI, model and effort, read over MCP with `harness_recommend` and
`harness_list`, edited with `harness_set` and in Settings › Harness policy, and stamped on
every card as its planned `harness` when the card was created.

That table is gone. The board records what ran; it does not decide what runs.

- **A card is born without a harness.** *What / Why / How to confirm* are the whole
  contract.
- **The claim records the harness that runs it.** `task_claim` takes the executor's CLI,
  exact model and effort; the card returns them as `executor` on `task_get`.
- **The delivery records what it cost.** `task_deliver` adds the measured usage per
  model, so a run that switched models says so.

Which harness runs a piece of work is decided where the work is launched. In Overclock
that is the per-task Harness table (Settings, or `overclock_list kind: harness` over its
MCP). Two tables with the same name and the same fields made agents answer questions about
one with the other, which is why the board's copy was removed rather than renamed.

## What happened to the old data

- The `harness` stored on cards created before OCL-202 stays in the database untouched.
  Nothing writes it anymore and neither the MCP surface nor the board shows it: it was a
  forecast, and the attempts already hold what really ran.
- The policy rows (`cardapio_entry`) stay in the database the same way, unread.
- Dropping both is a separate cleanup, after the release that tolerates the old inputs.

## For clients written against the old contract

For one release, `task_create` and `task_update` still accept `harness` (and
`subtasks[].harness`): the value is ignored and the answer carries a `warnings` entry
instead of an error. `task_list` and `task_search` accept `include: ["harness"]` the same
way. The three policy tools are no longer published; a client that still calls them gets
the MCP "unknown tool" error, and a plugin installed before this release should be
reinstalled so its optional `enforce_harness` guard, which called `harness_recommend`,
goes away.
