## T6 — Suggestion (optional, OpenRouter, Telegram Mini App)

Runner: `TestT6.gs` (this folder) → paste as a temporary file → select `runAllT6Checks` in the function dropdown → Run.

The runner covers pure helpers (prompt/parse/cache key/error map, model-metadata slim/sort/search, suggestion mode mapping) plus token-guard checks on the Mini App entries and one self-cleaning `Rules` round-trip that checks `topic_hint`. It makes **no OpenRouter calls** and sends **no Telegram messages** — every live suggestion is a manual eyeball below.

Suggestions are optional: with no key/model the `[Need ideas?]` button simply never appears and nothing else changes.

### 0. Prep (manual, 5 minutes)

1. Use a test copy, never the live one.
2. In the editor, paste the latest `../src/Code.gs` **and** add `../src/MiniApp.html` as an **HTML file** (File > New > HTML file, name it exactly `MiniApp`). Run `ensureSchema()` and authorize if needed.
3. Paste `TestT6.gs` from this folder as a temporary editor file (delete it in Cleanup).
4. Bind the test copy to your bot (Setup + `/start <token>`) and rerun **Deal Watch > Setup** once after pasting, so `setMyCommands` registers the new command menu (`/setai`).
5. **Deploy > Manage deployments > edit > Version: New version > Deploy** so `doGet` serves the Mini App.
6. Have an OpenRouter API key ready (with a small credit balance) for the live checks. The model list endpoint is public and free.

### 1. Runner — pure + guards + round-trip (no Telegram, no OpenRouter)

- [x] **Runner**: `runAllT6Checks` → in **Executions > latest run > Logs** expect `PASS` for:
  - `T6-b prompt has seed / no @ (no email) / asks comma list`, `T6-b parse dedup / cap 5 + marker strip / bullets + quotes / empty / leading digit kept`, `T6-b cache key case-insensitive / differs / prefix`, `T6-b err 200 empty / 401 / 403 / 402 / 429 / 500`, `T6-b missing key/model guard / missing model guard`.
  - `T6-c mode dup / edit / add / fallback`, `T6-c extract message id ok / not ok / garbage`.
  - `T6-e router auto / free / not router`, `T6-e reasoning none / mandatory / optional`, `T6-e free 0/0 / paid / free missing`, `T6-e text out / audio only / no arch`, `T6-e slim drops router + non-text / slim no router / slim no audio-only`, `T6-e sorted: fast free first / mandatory last`, `T6-e search by name / empty query returns all / no match`.
  - `T6-f owner guard empty token / bad token`, `T6-f getModels / setModel / clearModel rejects bad token`.
  - `T6-g getState / setKey / deleteKey rejects bad token`, `T6-g state shape`.
  - `T6-h suggest / ideasAdd rejects bad token`.
  - `T6 append with hint / manual update preserves topic_hint / update sets topic_hint / delete round-trip row` (one real `t6test.example.com` row, deleted by the runner itself).

### 2. Manual — `/setai` opens Mini App Settings

- [x] Send `/setai` → expect a message with an **Open settings** button (and a `Suggestions: on/off` line). Tap it → the Mini App opens on the **Settings** view (dark theme).
- [x] Tap **Set key**, paste a **bogus** key (`sk-bogus`) → expect a rejection message in the app; nothing stored.
- [x] Set the **real** OpenRouter key → expect `Key saved.` and the masked `sk-...last4` shown; header flips to `Suggestions: on` once a model is also set.
- [x] Tap **Replace**, then **Remove** (confirm the browser dialog) → expect the key gone and `Suggestions: off`. Re-set the real key before continuing.
- [x] In the search box type `gpt` → the list filters (free/paid badges, no `openrouter/*` routers); pick one → expect it marked selected and saved; header shows the model.
- [x] Toggle **Free only** → only free models list. Tap **Clear** → model removed (`Suggestions: off`). Re-pick a model.
- [x] Send `/status` → expect a `Suggestions: on` line and a `Model: <id>` line (both `off` / `none` when key or model is cleared).

### 3. Manual — `[Need ideas?]` opens the Mini App Ideas view

- [x] With key+model set: `/add` → sender `t6a.example.com` → the keywords prompt shows **Need ideas?** (and `[Use last keywords]` if a prior rule exists).
- [x] Tap **Need ideas?** → the Mini App opens on the **Ideas** view. Type a topic (e.g. `sneaker`) → **Get ideas** → chips appear; tap to select (they toggle).
- [x] Tap **More ideas** → new chips are appended, no duplicates; after the 3rd batch, **More ideas** reports "No more ideas for now." (max 3 batches).
- [x] Tap **Add selected** with nothing picked → expect "Select at least one keyword." Pick some, then **Add selected** → expect "Sent to Telegram. Open the chat to confirm."
- [x] **Switch back to the chat**: the `(3/3)` confirm appears with the selected keywords. Tap **Confirm** → `Rule added`.
- [x] Unhide `Rules` → the new row's `topic_hint` column equals the topic you typed. Hide it again.
- [x] Start a rule, open the Ideas view, and **let the conv expire** (wait > 10 min) → **Add selected** → expect "Session expired. Send /add in the chat to restart." in the app; the chat shows nothing new.
- [x] `/setai` → **Clear** the model → `/add` again → the keywords prompt must have **no** `[Need ideas?]` (suggestions disabled). Re-set a model afterwards.

### 4. Manual — responsive (narrow + wide)

- [x] On a small phone (or a ~320px wide preview): the Settings key field, the model search bar, and the Ideas topic field each stack their button below the input; `Add selected` / `More ideas` stack; nothing overflows sideways.
- [x] Focusing the key (password) field does **not** make the page zoom in (iOS).
- [x] On a wide window (≥ 640px) the content is centred at a comfortable width instead of stretching edge to edge.

### 5. Manual — edit + duplicate sender

- [x] `/list` → open a rule → **Edit keywords** → prompt shows **Need ideas?**; send plain keywords → expect the **Save / Cancel** confirm → **Save** → `Rule updated`.
- [x] Edit keywords again and use **Need ideas?** → **Add selected** → **Save** → the rule's `topic_hint` becomes the topic you typed.
- [x] Edit keywords **manually** (no ideas) on a rule that already has a `topic_hint` → **Save** → the existing `topic_hint` is preserved.
- [x] `/add` with a sender already watched → the duplicate prompt shows **Need ideas?**; use it → **Add selected** → **Confirm update** → `Rule updated`.

### 6. Cleanup (manual, in this order)

1. Delete the manual test rules via the bot (detail → **Delete** → Yes) so the test copy ends empty.
2. **Runner**: `runAllT6Checks` already deleted its own row; re-run once only if a previous run was interrupted.
3. In the editor file list, click the `⋮` next to the temporary runner file (`TestT6.gs`) → **Delete**.
4. Optional: clear the model/key on the test copy, or leave them (test copy only).
5. Re-run `ensureSchema()` once so `Rules`/`Log`/`Runs` are hidden again.
