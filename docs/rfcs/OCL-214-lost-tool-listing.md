# OCL-214 — the tools/list that never comes back

## Short answer

1. **The board answers.** Every `tools/list` a timed-out session sent reached the origin and was answered 200 in under 1 s. The wait happens after the answer leaves the origin: in the Cloudflare → client leg or in the client's HTTP stack. It does not happen on the board.
2. **Claude Code gives up, not the board.** On a failed `tools/list`, Claude Code 2.1.280 logs `Failed to fetch tools`, stores `toolsListError` and returns `[]` as the tool list. It never asks again. That code lives in the Claude Code binary and in neither of our repositories. Retrying and warning the human belong to whoever spawns the session: the Overclock app. A card was opened there.
3. **Fixed on the board:** `GET /mcp` answered 200 with an event stream that closed at once. Every live client reopened it in a loop: 2,229 GETs against 118 POSTs in three minutes, each one rebuilding the whole server. It now answers `405 Allow: POST, DELETE`, which the MCP spec defines as "no stream here". The SDK client (1.30.0, `client/streamableHttp.js`) treats 405 as that and stops asking.

## Evidence

### The server answered the listing that the session never received

Sources: Claude Code's MCP logs (`~/Library/Caches/claude-cli-nodejs/<cwd>/mcp-logs-overclick/*.jsonl`) and the proxy's JSON access log. They are crossed minute by minute by `scripts/ocl-214/lost-listing.mjs`, which prints no addresses.

- 22 and 23/09: 624 sessions, 29 timed out (4.6%), in 21 distinct minutes.
- In **21 of 21** minutes, the proxy has at least as many `tools/list` (the 46-byte Claude Code body) as there were sessions, all 200, none over 1 s. Slowest in the two days: 713 ms.
- Two minutes had exactly one session, and it failed:
  - 22/09 12:11:48.213: connected, then timed out. The proxy shows that session's `tools/list` at 12:11:48.339, answered 200 with 45,716 bytes in 72 ms.
  - 22/09 16:22:03.093: same pattern. Answered 200 in 483 ms.
- 23/09 15:35:16 (the dev-1324 wave): 7 sessions, 7 `initialize`, 7 `tools/list` answered 200 (14–106 ms). Two of the seven sessions timed out anyway.

### What the client saw

- A failed session logs nothing between `Connection established` and `Failed to fetch tools: Request timed out` at exactly 30.0 s.
- `HTTP connection dropped` appears in 28% of failed sessions and 1% of healthy ones; `Connection error: The operation was aborted` in 24% and 0%. Both come 3 to 40 s *after* the timeout. The HTTP connection carrying the answer was already dead and the client only noticed later.
- Every request crosses Cloudflare (`server: cloudflare`) and speaks HTTP/2 to the proxy.

### Reproduced without Claude Code

`initialize` + `tools/list` with the plain Node SDK against the real board, in waves of 8: 1 hang in 1,400. The request connected in 177 ms and the listing never returned in 10 s. The rate is far below the 3–6% seen in real panes. Treat it as proof that the hang is not specific to Claude Code, not as a rate.

## What was ruled out

- **Response size or slow server:** the origin answers in 14–713 ms, including for the sessions that failed.
- **Server contention or cold start:** zero `tools/list` over 1 s in two days at the proxy, including the 00:49–01:09 wave of 30–64 sessions.
- **Request never sent or lost on the way in:** the proxy sees the request of every failed session.
- **Timeout too short:** the answer arrived at the origin in milliseconds. Raising `MCP_TIMEOUT` only lengthens the wait on a dead stream.

## Not identified

We did not establish which hop loses a response already sent. Candidates are the Cloudflare edge and the client's HTTP/2 stack. No Cloudflare logs were available. The GET storm fixed here ran on the same HTTP/2 connections as the listing. Whether it contributed is not proven. It is fixed for what it costs on its own.

## Measure after

After the batch release, run the same script over the days after deploy. Before: **4.6%** on 22–23/09; **3.1%** over 19/08–23/09 in OCL-209. The drop to near zero depends on the retry in the Overclock app. The GET fix alone does not promise it.
