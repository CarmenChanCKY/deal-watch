## T3 — Core (`../src/Code.gs`, `../src/appsscript.json`)

Runner: `TestT3.gs` (this folder) → select `runAllT3Checks` in the function dropdown → Run.

### 0. Prep (all manual)

- [x] Make a test copy: open the [template Sheet](../Deal-Watch-Template.xlsx) in Google Drive → **File > Make a copy** (e.g. name it `Deal Watch TEST`). All T3 testing happens in this copy.
- [x] In the copy, open **Extensions > Apps Script**. Delete whatever is in the default `Code.gs` and paste the full contents of `../src/Code.gs` from this repo.
- [x] Set the manifest: in the editor, open **Project Settings (gear) > Show "appsscript.json" manifest file in editor** (tick the box), go back to the file list, open `appsscript.json`, replace its contents with `../src/appsscript.json` from this repo, save.
- [x] Back in the editor, select `ensureSchema` in the function dropdown → Run. On the very first run Google shows an authorization dialog: click through **Review permissions → your test account → Advanced → Go to project → Allow**. (This is also the moment to eyeball the OAuth consent screen for the T3-d check below.)
- [x] Back in the Sheet, confirm `Rules`, `Log`, `Runs` tabs exist, each with its header row, and are hidden. If you need to edit them, reveal via **View > Hidden sheets**.
- [x] Unhide `Rules` and add these 5 rows directly under the header (columns: `id | sender | keywords | enabled | topic_hint | updated_at`; `updated_at` accepts anything readable, e.g. `2026-10-01 12:00`). Add all 5 in one go — every row is exercised by the checks:
  - `1 | example.com | sale | FALSE | | <now>` (disabled — must never match).
  - `2 | bad sender!!} | sale | TRUE | | <now>` (invalid — must be skipped and counted in the error string).
  - `3 | empty-test.com | (leave blank) | TRUE | | <now>` (no keywords — must be skipped by `loadEnabledRules`).
  - `4 | gmail.com | fives | TRUE | | <now>`  (domain-contains rule for the second account's mail).
  - `5 | friend@gmail.com | air | TRUE | | <now>` (exact-email rule; replace with the real second-account address; together with rule 4, one mail exercises both sender kinds plus the multi-rule union).
- [x] Send Mail A and Mail B above, then select `runAllT3Checks` in Apps Script and press Run within ~10 minutes (the query window is `newer_than:30m`, so stale mail is invisible). Order vs rules does not matter — mail-first or rules-first both work, as long as both are done before you press Run.
  - Mail A — the mail that must match. **Log in as the second account** (e.g. your other Gmail — the `From` will be that address, e.g. `friend@gmail.com`) and send one mail to the test account:
    - `To`: `<your test account address>`.
    - `Subject`: `weekend stuff` (must NOT contain `air` or `fives` — the point is keywords live in the body only, so keep the subject clean to prove body matching works).
    - `Body`: `AIR fives` (exactly these two words: `fives` hits rule 4 `gmail.com`; `AIR` hits rule 5 `friend@gmail.com`. Uppercase is deliberate — it proves case-insensitive matching. Both words on one mail proves the multi-rule keyword union).
  - Mail B — the own-sent trap. **Log back in as the test account** and send one mail to yourself:
    - `To`: `<your test account address>` (itself).
    - `Body`: contains `air` (e.g. `air test — ignore me`).
    - Purpose: the content DOES hit rule 5's keyword, but the mail must still be ignored because `From` is yourself. If it shows up in matches, the T3-b `own-sent ignored` check FAILs.
  - Fallback if the second account is unavailable: pick a real promo mail received in the last 24h, set a Script Property `poll_interval_minutes = 720` (**Project Settings > Script Properties > Add script property**), build the rules from that mail's real sender + body words, and delete the property in Cleanup so the 15-min default returns.

### 1. T3-a — Helpers (runner asserts; two manual eyeballs)

- [x] Manual: run `ensureSchema()` a second time (re-select it in the function dropdown and Run again). Expect all three at once:
  - No error.
  - No duplicated headers.
  - No data loss (row counts unchanged).
- [x] Manual: the three tabs stay hidden after the rerun (only visible via **View > Hidden sheets**).
- [x] Runner Testing — the runner checks the pure helpers by itself. Inputs such as `"ＡＢＣ　 "` → `"abc"` are fed by the runner; you only read the results in **Executions > latest run > Logs**. Expect every `PASS` line:
  - Normalization: `T3-a normalize full-width`, `T3-a normalize Chinese passthrough`.
  - Sender: `T3-a sender +tag strip`, `T3-a isEmailSender domain`, `T3-a isEmailSender email`, `T3-a domain-contains`, `T3-a email-exact +tag`, `T3-a non-match`, `T3-a empty rule`.
  - Keywords: `T3-a parse count`, `T3-a parse phrase flag`, `T3-a OR match`.
- [x] Runner Testing — interval helpers, same Logs (runner asserts):
  - `PASS [T3-a interval allowlist]`.
  - `PASS [T3-a newer_than 2x]`.
  - Values: no property set → `15` / `30`; with the 720 fallback → `720` / `1440` (both PASS). If you used the fallback, Cleanup deletes the property and the default returns.

### 2. T3-b — Polling + per-message match (runner asserts)

- [x] Runner Testing — `loadEnabledRules()` filtering (runner asserts; you only read Logs):
  - Enabled rules with keywords are returned.
  - Rule 1 (disabled) and rule 3 (no keywords) are skipped.
  - Rule 2 (invalid sender) is kept here — invalid senders are filtered one layer down.
- [x] Runner Testing — `buildGmailQueries(rules, 30)` shape (runner asserts):
  - 1–2 queries, each shaped `from:{...} newer_than:30m`.
  - Invalid sender reported as `invalidSkipped=1` with samples.
- [x] Runner Testing — `pollNewMatches()` results (runner asserts):
  - `threadsScanned > 0`.
  - Matches contain the second-account mail with both `air` and `fives` (union across rules 4+5).
  - The own-account mail is absent.
  - `error` mentions the skipped invalid sender.
- [x] Runner Testing — `pollNewMatches()` run again before any `Log` write returns the same matches (dedup only takes effect after T3-c writes `Log` — this repetition is expected, not a bug).

### 3. T3-c — Digest + writes (runner asserts; Sheet eyeballs)

- [x] Manual: in **Executions > latest run > Logs**, open the `INFO digest` text and check its shape:
  - First line is `Deal Watch: <count> thread(s) matched` (e.g. `Deal Watch: 1 thread matched` — the number replaces `N`, and the singular has no `s`). In Logs, search for `Deal Watch:` under the `INFO digest` lines. (A repeat run with no new mail returns `""`, so nothing appears — that is expected silence, not a failure.)
  - One `• subject` block per thread.
  - Each block shows `date | keywords`.
  - Each block ends with a `https://mail.google.com/.../#inbox/{threadId}` link.
- [x] Manual: unhide the sheets and check the writes:
  - `Log`: one new `status=matched` row per match — columns `timestamp | message_id | sender | matched_keywords | subject | status`.
  - `Runs`: one new row `start | end | found | sent | error` with `found=N`, `sent=0`, error naming the invalid sender.
- [x] Runner Testing — `runWatchOnce()` run immediately again returns `""` (silence — same mails deduped via `Log`).
- [x] Manual prune check, in this order:
  - Append one row at the bottom of `Log`: `timestamp` = 31+ days ago (type e.g. `8/30/2026 10:00`), `message_id` = `prune-test-dummy-id`, `sender` = `prune@test.com`, `matched_keywords` = `test`, `subject` = `prune test`, `status` = `matched`.
  - Run `runWatchOnce()` again (select it in the function dropdown and Run).
  - Digest stays `""` and the dummy row is gone.
- [x] Manual: repo-wide search for `sendMessage` returns zero hits (T3 must never send — send is T4/T5). Either method works:
  - In the editor, click the **Search (magnifier) icon** and search `sendMessage`.
  - Or locally from repo root run `grep -rn "sendMessage" src/ test/`.

### 4. T3-d — Manifest (all manual)

- [x] Manual: open `appsscript.json` in the editor and compare field by field with `../src/appsscript.json`:
  - `timeZone` = `Asia/Hong_Kong`.
  - `runtimeVersion` = `V8`.
  - `webapp.executeAs` = `USER_DEPLOYING`, `webapp.access` = `ANYONE_ANONYMOUS`.
  - Exactly these 5 scope URLs (full form `https://www.googleapis.com/auth/...`): `spreadsheets.currentonly`, `gmail.readonly`, `script.storage`, `script.scriptapp`, `script.external_request`.
- [x] Manual: open **Project Settings > Scopes** and check the list:
  - Exactly those 5 scopes are listed — no more, no fewer. (You also saw the consent screen during the first authorized Run in Prep.)

### 5. Cleanup (all manual, in this order)

- [x] If you set `poll_interval_minutes` (720 fallback): **Project Settings > Script Properties** → delete that row (restores the 15-min default).
- [x] Manual: in the Sheet, delete the test data (select rows → right-click → Delete rows):
  - All test `Rules` rows.
  - All test-added `Log` rows.
  - All test-added `Runs` rows.
- [x] In Gmail, delete the test mails (keeps the mailbox clean for the next run; the `Log` dedup rows are already deleted above, so repeats work).
- [x] In the editor file list, click the `⋮` next to the temporary runner file → **Delete**.
- [x] Manual: re-run `ensureSchema()` once so `Rules`/`Log`/`Runs` are hidden again.
- [x] Close the copy. It is ready for the next full pass.