import { block, countTasks, enabled, failOpen, parseJson, readStdin, sessionClaims } from "./common.mjs";

failOpen(async () => {
  if (!enabled("enforce_stop")) return;

  const claims = await sessionClaims(parseJson(readStdin()) ?? {}, 2);
  if (!claims) return;

  if (countTasks(claims) > 0) {
    block(
      "An OverClick card is still claimed by this session. Deliver it or call task_release before stopping.",
    );
  }
});
