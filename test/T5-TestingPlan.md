## T5 — Telegram UX (rules + interval/status/help)

Runner: `TestT5.gs` (this folder) → paste as a temporary file → select `runAllT5Checks` in the function dropdown → Run.

The runner covers pure layout checks plus a self-cleaning Sheet round-trip — no Telegram sends, no Gmail reads. Everything the bot says (`/add`, `/list`, buttons, `/interval`, `/status`, `/help`, Menu) is a manual eyeball below on the test copy.

### 0. Prep (manual, 5 minutes)

1. Use a test copy, never the live one. Paste the latest `../src/Code.gs`, run `ensureSchema()` and authorize if needed.
2. Paste `TestT5.gs` from this folder as a temporary editor file (delete it in Cleanup).
3. Bind the test copy to your bot first (Setup + `/start <token>` per T4-TestingPlan.md section 4), so manual sections have an owner. Rerun **Deal Watch > Setup** once after pasting the new code so `setMyCommands` registers the Menu.
4. Start with an empty `Rules` sheet (unhide it to check, hide it again after).

### 1. Runner — pure + round-trip (no Telegram)

- [x] **Runner**: `runAllT5Checks` → in **Executions > latest run > Logs** expect `PASS` for:
  - `T5-c same sender +tag / case domain / different / email vs domain`, `T5-c keywords ok / empty / commas only`.
  - `T5-c limit at 30 / below 30 / empty` (30-entry synthetic array; the same predicate gates `/add` entry, confirm, and enable).
  - `T5-c clamp high / low / NaN`, `T5-c interval label/button *`.
  - `T5-c list empty text`, `T5-c page 1/2`, `T5-c 2-per-row rows`, `T5-c rows hold 2`, `T5-c nav Next only`, `T5-c page 2/2`, `T5-c last page view+Prev`.
  - `T5-c detail Enabled / Disable btn / Enable btn`.
  - `T5-c append / find by id / find by sender / update / delete / cache cleaned` (one real `t5test.example.com` row, deleted by the runner itself).

### 2. Manual — `/add` flow

- [x] Send `/add` → expect `(1/3)` sender prompt with a Cancel button.
- [x] Send a bad sender (`bad sender!!}`) → expect the retry prompt, still in the flow. Send `/cancel` → expect `Cancelled. Nothing changed.`
- [x] Send `/add` → sender `t5a.example.com` → expect `(2/3)` keywords prompt WITHOUT `[Use last keywords]` (no prior rule yet).
- [x] Send an empty line of commas (` , , `) → expect the non-empty retry. Send `air, 5折` → expect `(3/3)` confirm. Tap **Confirm** → expect `Rule added (t5a.example.com). It is enabled.`
- [x] Send `/add` → sender `t5b.example.com` → this time expect `[Use last keywords]`. Tap it → expect `(3/3)` prefilled with `air, 5折`. Tap **Confirm**.
- [x] Send `/add` → sender `t5A.example.com` (same, different case) → expect the already-watched update prompt (no second row). Send `sale` → Confirm → expect `Rule updated`. `/list` must still show one row for that sender.

### 3. Manual — `/list` + detail

- [x] Send `/list` → expect numbered lines with `[ON]` and number buttons TWO per row.
- [x] Tap a number → expect a NEW detail message (`Sender / Keywords / Status / Updated` + Enable-or-Disable, Edit keywords, Edit sender, Delete, Back to list).
- [x] Tap **Disable** → the detail message edits in place to `Disabled`. Tap **Enable** → flips back.
- [x] Tap **Edit keywords** → send `deal` → expect `Rule updated`. Tap **Edit sender** → send `t5c.example.com` → expect `Rule updated (t5c.example.com)`. Both edit prompts carry a **Cancel** button (tap → `Cancelled. Nothing changed.`).
- [x] Edit sender to an already-watched sender → expect the already-watched rejection, nothing changes.
- [x] Tap **Delete** → expect the confirm prompt (`Log rows are kept`). Tap **Cancel** → back to detail. Tap **Delete** again → **Yes, delete** → expect `Rule deleted`. Tap **Back to list** on another detail → expect the list again (page 1 by design).

### 4. Manual — paging (11 temp rows)

- [x] **Runner**: select `seedT5PagingRules` → Run → Logs show `created 11`.
- [x] Send `/list` → expect `page 1/2`, 5 rows of 2 buttons + a `Next` row. Tap **Next** → the SAME message edits to `page 2/2`. Tap a number → opens that rule (numbering restarts per page by design).
- [x] **Runner**: select `cleanupT5TestRules` → Run → Logs show `removed 11`. `/list` is back to the manual rules.

### 5. Manual — interval / status / help / menu

- [x] Send `/interval` → expect 3 rows of 2 + a **Cancel** row, current marked `(current)`. Tap **Cancel** → expect `Cancelled. Nothing changed.` and the buttons disappear.
- [x] Send `/interval` → pick `30min` → expect the set confirm. Open the **Triggers page** → the `runWatchAndNotify` trigger reflects 30 min. Pick `15min` to restore.
- [x] Send `/status` → expect five lines: `Interval`, `Rules: N (M enabled)`, `Last run`, `Error: none` (or the pending error text after a failed send).
- [x] Send `/help` → expect the 7 commands plus the digest line.
- [x] Tap the Telegram **Menu** button (bottom-left) → expect 7 commands (`list add interval status help transfer connect`), no typing needed.
- [x] Send `/nope` → expect `Unknown command. Available: /list, /add, /interval, /status, /help, /transfer, /connect.` Strangers/groups behavior is unchanged (silence).
- [x] 30-enabled block is covered by the runner predicate check (section 1). A live 30-rule eyeball is optional — seeding 30 by hand is not worth it; entry, confirm, and enable share the same `isRuleLimitReached_` gate.

### 6. Cleanup (manual, in this order)

1. Delete the manual test rules via the bot (detail → **Delete* * → Yes) so the test copy ends empty.
2. **Runner**: select `cleanupT5TestRules` → Run (removes any leftover `t5page*` seeds).
3. In the editor file list, click the `⋮` next to the temporary runner file (`TestT5.gs`) → **Delete**.
4. Re-run `ensureSchema()` once so `Rules`/`Log`/`Runs` are hidden again.
5. Leave the trigger at 15 min (restore via `/interval` if section 5 left it elsewhere).