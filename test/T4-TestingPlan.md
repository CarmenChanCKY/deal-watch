## T4 — Trigger + self-monitoring

Runner: `TestT4.gs` (this folder) → select `runAllT4Checks` in the function dropdown → Run.

Good news: no test mails needed. The default path sends nothing to Telegram and makes no network calls — one bad rule row gives every run a small harmless error to work with.

### 0. Prep (manual, 3 minutes)

1. Use a test copy, never the live Sheet. If it is not set up yet, follow the T3 prep once: paste `../src/Code.gs`, replace `appsscript.json`, run `ensureSchema` and authorize.
2. Unhide `Rules` and add ONE row under the header (columns: `id | sender | keywords | enabled | topic_hint | updated_at`):
   - `91 | bad sender!!} | sale | TRUE | | <now>` (deliberately invalid — it gives every run a small error to send, and proves a bad row never breaks the batch).
3. Open **Project Settings (gear) > Script Properties** and make sure there is NO `bot_token` row. If one is there from earlier experiments, delete it for this pass — we test the failure path here. The success path (real bot) is a separate manual check in step 3.

### 1. T4-a — Trigger (half manual, half runner)

- [x] Manual: select `ensureTrigger` in the function dropdown → Run. Open the **Triggers page (clock icon)** and expect exactly ONE trigger for `runWatchAndNotify`. Run `ensureTrigger` again — still exactly one, never two.
- [ ] Runner: `runAllT4Checks` → in **Executions > latest run > Logs** expect `PASS` for:
  - `T4-a one trigger`, `T4-a idempotent rerun`.
  - `T4-a set 60` (the runner sets 60, then puts 15 back by itself).
  - `T4-a invalid ignored` (999 changes nothing).
  - `T4-a restore 15`.

### 2. T4-b — Merged message (runner only, no network)

- [x] Runner checks, no setup needed — you only read the Logs:
  - `T4-b silence` (nothing to send returns `""`).
  - `T4-b digest only`, `T4-b note only`, `T4-b merged shape`.
  - `T4-b truncate 4000` (oversize text is cut with a `(truncated)` tail).

### 3. T4-b — Send failure + retry (runner + one eyeball)

- [x] Runner performs live runs — each writes one real `Runs` row, that is expected, not a bug. Expect `PASS` for:
  - `T4-b missing token fails safe` (returns before any network call).
  - `T4-b Runs grew by 1`, `T4-b sent=0`, `T4-b Runs error mentions Send failed`.
  - `T4-b last_error set`, `T4-b consecutive 1`, `T4-b consecutive 2`.
  - `T4-b give-up counter 4`, `T4-b give-up drops backlog` (old errors are dropped after the limit, but polling and `Runs` logging continue).
- [ ] Manual: open **Script Properties** while the checks run — you should see `last_error` and `consecutive_send_failures` appear. After the give-up check, `last_error` is gone and the counter reads `4`.
- [ ] If you HAVE a real bot (optional): set `bot_token` + `owner_chat_id`, delete the two failure properties, run `runWatchAndNotify` once manually. Expect the merged note on your phone, the newest `Runs` row `sent=1`, and both properties gone. (With no token set, the runner `SKIP`s this instead of failing.)

### 4. Cleanup (manual, in this order)

1. **Triggers page** → delete the `runWatchAndNotify` trigger. Do this first — otherwise it writes a new `Runs` row every 15 minutes.
2. **Script Properties** → delete `poll_interval_minutes`, `last_error`, `consecutive_send_failures` (only the ones added for testing).
3. In the Sheet, delete rule `91` and all test-added `Runs` rows.
4. In the editor file list, click the `⋮` next to the temporary runner file → **Delete**.
5. Re-run `ensureSchema()` once so `Rules`/`Log`/`Runs` are hidden again.
