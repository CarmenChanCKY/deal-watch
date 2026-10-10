## T4 — Trigger + self-monitoring

Runner: `TestT4.gs` (this folder) → select `runAllT4Checks` in the function dropdown → Run.

Good news: no test mails needed. The default path sends nothing to Telegram and makes no network calls — one bad rule row gives every run a small harmless error to work with.

### 0. Prep (manual, 3 minutes)

1. Use a test copy, never the live Sheet. If it is not set up yet, follow the T3 prep once: paste `../src/Code.gs`, replace `appsscript.json`, run `ensureSchema` and authorize.

2. Unhide `Rules` and add ONE row under the header (columns: `id | sender | keywords | enabled | topic_hint | updated_at`):
   - `91 | bad sender!!} | sale | TRUE | | <now>` (deliberately invalid — it gives every run a small error to send, and proves a bad row never breaks the batch).

3. Open **Project Settings (gear icon in left sidebar) > Script Properties** and make sure there is NO `bot_token` row. If one is there from earlier experiments, delete it for this pass — we test the failure path here. The success path (real bot) is a separate manual check in section 4.

### 1. T4-a — Trigger (half manual, half runner)

- [x] **Manual**: select `ensureTrigger` in the function dropdown → Run. Open the **Triggers page (clock icon in left sidebar)** and expect exactly ONE trigger for `runWatchAndNotify`. Run `ensureTrigger` again — still exactly one, never two.

- [x] **Runner**: `runAllT4Checks` → in **Executions (clock icon) > latest run > Logs** expect `PASS` for:
  - `T4-a one trigger`, `T4-a idempotent rerun`.
  - `T4-a set 60` (the runner sets 60, then puts 15 back by itself).
  - `T4-a invalid ignored` (999 changes nothing).
  - `T4-a restore 15`.

### URLs you need during T4 verification

- **Web App `/exec` URL** — copy from **Deploy > Manage deployments > Web app > Copy URL** (ends with `/exec`). This is the URL that `setWebhook` points to. Paste it into Setup when prompted.

- **Telegram `getWebhookInfo` URL** — open in browser: `https://api.telegram.org/bot<your_bot_token>/getWebhookInfo`. Check that the `"url"` field matches the `/exec` URL above (it will have `?secret=...` appended; ignore that suffix). Note the `pending_update_count` value — Troubleshooting bind below explains what it means when bind fails.

- **Telegram clear-queue URL** — open in browser (use before binding): `https://api.telegram.org/bot<your_bot_token>/deleteWebhook?drop_pending_updates=true`. Then re-check `getWebhookInfo` until `pending_update_count` is `0`. Warning: this URL also deletes the webhook (`url` becomes `""`) — rerun **Deal Watch > Setup** afterwards so it re-registers, otherwise nothing is delivered.

### 2. T4-b — Merged message (runner only, no network)

- [x] **Runner checks, no setup needed** — you only read the Logs:
  - `T4-b silence` (nothing to send returns `""`).
  - `T4-b digest only`, `T4-b note only`, `T4-b merged shape`.
  - `T4-b truncate 4000` (oversize text is cut with a `(truncated)` tail).

### 3. T4-b — Send failure + retry (runner + one eyeball)

- [x] **Runner performs live runs** — each writes one real `Runs` row, that is expected, not a bug. Expect `PASS` for:
  - `T4-b missing token fails safe` (returns before any network call).
  - `T4-b Runs grew by 1`, `T4-b sent=0`, `T4-b Runs error mentions Send failed`.
  - `T4-b last_error set`, `T4-b consecutive 1`, `T4-b consecutive 2`.
  - `T4-b give-up counter 4`, `T4-b give-up drops backlog` (old errors are dropped after the limit, but polling and `Runs` logging continue).

- [x] **Manual**: open **Project Settings (gear icon) > Script Properties** while the checks run — you should see `last_error` and `consecutive_send_failures` appear. After the give-up check, `last_error` is gone and the counter reads `4`.

### 4. Real Telegram bot testing (optional, T4+)

- [x] **Setup complete**: Run **Deal Watch > Setup** in the Sheet (or follow the T5 Setup flow). Ensure the alert shows `Setup complete. Bind Telegram once:` with the binding link.

- [x] **Bind your bot**: open the clear-queue URL above first, then confirm `pending_update_count` is `0`. Open the binding link `https://t.me/<your_bot_username>?start=<setup_token>` in Telegram, or send exactly `/start <setup_token>` (replace with the real token; add nothing after `/start` except the token) to your bot. Expect `Setup complete. This account now owns the watcher.` in Telegram, plus `owner_chat_id` set and `setup_token` gone in **Script Properties**. If anything else happens, see Troubleshooting bind below — do not resend repeatedly.

- [x] **Test `/transfer`**: In Telegram, send `/transfer`. Confirm with the inline button. Expect `Transfer confirmed` spinner, then `Transfer token minted (single-use)`. On the NEW Telegram account, send `/start <transfer_token>` to bind the watcher to the new account. Expect `Setup complete. This account now owns the watcher.` on the new account, and silence on the old account.

- [x] **Test `/connect`**: In Telegram, send `/connect`. Confirm with the inline button. Expect to be prompted to paste a new BotFather token. Paste the new token as one message (it will be deleted right after). Expect `Token replaced (masked). Webhook re-attached. The old token stops working.` in Telegram.

- [x] **Send a test mail**: Send a Gmail from a watched sender to your test account. Expect the merged digest notification on your phone within the polling interval.

- [x] **Verify error handling**: Send a mail from an invalid sender (or delete the rule). Expect `Runs` row with `sent=0` and `error` mentioning `Send failed`. Expect `last_error` and `consecutive_send_failures` to appear in **Project Settings > Script Properties**.

### 4b. Troubleshooting bind (only if step 4 fails)

Find your symptom below. Each fix ends with sending `/start` exactly once — never resend repeatedly.

- **`/start` gets no reply, no `doPost` in Executions.**
  - Cause: Telegram is queueing updates. `getWebhookInfo` shows a rising `pending_update_count`.
  - Fix: confirm Deploy access is `Anyone`, the `url` matches your `/exec` (ignore `?secret=`), and the deployment is a **New version** carrying the `HtmlService` ack fix. Then open the clear-queue URL above once and send `/start` once.

- **`Invalid or expired token` for a token you just copied.**
  - Cause: Telegram delivered a queued old update, not the one you just sent.
  - Fix: open the clear-queue URL above, confirm `pending_update_count` is `0`, then send the current token once.

- **One `/start` produces several `doPost` rows within seconds.**
  - Cause: normal queue flush + at-least-once delivery. Not a bug.
  - Fix: none. Same-`update_id` replays are dropped silently (dedup); the first binds (`Setup complete`), and a distinct re-`/start` replies `Already set up` at most once per 10 minutes (rate-limit).

- **Bot previously served another copy (old Sheet/script).**
  - Cause: one bot points at one copy only (`setWebhook` overwrites — the last Setup wins).
  - Fix: delete the old copy (or its deployment + triggers), rerun Setup on the live copy, open the clear-queue URL above, bind once.

- **Any command (`/transfer`, `/connect`, …) gets no reply, but `doPost` rows keep appearing every ~60s.**
  - Cause: queue head-of-line block, not a command bug. Telegram delivers updates in order and waits for a `200 OK` per update, so the head update retries forever and newer commands wait behind it. Telltale: `pending_update_count` rises with every resend, and no `doPost` row matches your new send time (the rows are old `update_id` replays, dropped by dedup). This should no longer occur after the `HtmlService` ack fix — if it does, the deployment is stale or deleted.
  - Fix: do NOT resend (each resend adds one to the queue). Wait for the watchdog alert (trigger run, at most 15 minutes after `pending` reaches 3) and tap `Clear queue + re-attach`, then send your command again — once. Manual fallback is the clear-queue URL above + an immediate **Deal Watch > Setup** rerun (the clear also deletes the registration, so re-registering is mandatory). The watcher itself (Gmail polling + digest) is unaffected throughout — only inbound commands stall.

### 5. Cleanup (manual, in this order)

1. **Triggers page (clock icon in left sidebar)** → delete the `runWatchAndNotify` trigger. Do this first — otherwise it writes a new `Runs` row every 15 minutes.

2. **Project Settings (gear icon) > Script Properties** → delete `poll_interval_minutes`, `last_error`, `consecutive_send_failures` (only the ones added for testing).

3. In the Sheet, unhide `Rules` and `Runs` (View > Hidden sheets), delete rule `91` and all test-added `Runs` rows.

4. In the editor file list, click the `⋮` next to the temporary runner file (`TestT4.gs`) → **Delete**.

5. Re-run `ensureSchema()` once so `Rules`/`Log`/`Runs` are hidden again.

6. Delete all testing email.