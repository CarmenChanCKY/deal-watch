# Deal Watch — Context

## Goal and status

Watch Gmail for promotion emails from user-chosen senders (domain or full email) containing user-chosen keywords, and push a phone notification.

MVP is single-user; future non-tech users via per-copy deployment.

T3 core done (`src/Code.gs` + `src/appsscript.json`) with reusable acceptance tests (`test/`); T4 trigger + self-monitoring done (with reusable acceptance tests); T5-a/b done (`doPost` router + auth gate, Sheet Setup + `/start` bind + `/transfer` + `/connect`, rules mirror cache); T5-c done (rule CRUD + `/cancel` everywhere) + T5-d done (interval/status/help + `setMyCommands` menu) + T5-e done (`T5-TestingPlan.md` + `TestT5.gs`); T6 suggestion done via a Telegram Mini App (`/setai` Settings + `[Need ideas?]` Ideas view) — T6-a…T6-m done; T7 done (static site + README, English-first with `/zh-Hant/` reserved); T8 planned (see Build plan); T9 done (version in `/status` + digest update notice; manual update flow).

Architecture below is the intended design unless the user changes it.
Do not replace locked decisions on personal preference; if implementation conflicts with one, explain before changing it.

## Architecture, stack and integrations

Flow:

Telegram (button-first UI, DM only)
↔ bound Apps Script
↔ hidden Sheet DB
↔ Gmail
→ Telegram Bot API
→ phone

No other backend, server, or dependency.

Stack:

- Runtime: Apps Script bound to the template Sheet (`GmailApp` + `SpreadsheetApp` + `PropertiesService` + `CacheService` + `UrlFetchApp`).
- Trigger: time-driven, default 15 min, fixed options `15/30/60min + 2/6/12hr` (min 15 min, max 12 hr).
- Telegram: inbound (webhook + `secret_token`) and outbound (`sendMessage`, `deleteMessage`, `setWebhook`, `getMe` for token validation, `getUpdates` for initial `chat_id`).
- Gmail: read via the owner's account, server-side `GmailApp.search()` only.
- OpenRouter `/chat/completions`: optional, suggestion-only.
- BotFather bot creation is manual user action, never done by AI.

## Telegram UX, Setup and onboarding

- UI:
  - Command menu (`setMyCommands`) + guided Q&A + inline per-rule buttons; slash commands are fallback.
  - The only surface touched daily.
  - Button-first; raw typing is fallback only; free-text control rejected; persistent reply keyboard never built.
  - Add-rule is sender → keywords → confirm; keywords step offers `[Use last keywords]` (hidden when no prior rule exists), filling keywords from the most recently created rule for confirm/edit.
  - Mini App (`src/MiniApp.html`, served by `doGet`): one page, two views — Settings (`/setai`: OpenRouter key + model) and Ideas (`[Need ideas?]`: type a topic → chips → hand back to the chat confirm). Opened by a bot-issued `web_app` button; dark theme; works on mobile and desktop/web Telegram (`XFrameOptionsMode.ALLOWALL`, T6-m).

- Access:
  - Single owner, DM-only.
  - Deep-link `/start <one-time token>` binding.
  - Non-owners silently ignored; groups rejected.

- Script:
  - Gmail polling / matching / digest.
  - `doPost` command + callback router.
  - Per-chat conversation state in `CacheService` (`conv_<chat_id>`, 10-min TTL).
  - Setup / transfer / connect flows (suggestions live in the Mini App since T6).

- Setup is idempotent per deployment:
  - `ensureSchema()` + trigger creation (no duplicates) + `getMe` token validation + `setWebhook` to a manually pasted `/exec` URL (stored as `webapp_url`; `getService().getUrl()` returns login-walled `/dev`, Telegram gets 401) + binding-link generation.
  - Pre-bind rerun re-shows the same link (no rotation); post-bind rerun outputs `Already set up` without overwriting owner or rotating secrets.
  - Phone change = no action; TG-account change = `/transfer`; token rotation = `/connect`.
  - Rules persist because storage is decoupled from Telegram identity.

- Onboarding is one-time Google Setup + rest-in-Telegram:
  - Copy template via `.../copy` link.
  - Then `Deal Watch > Setup` (OAuth + paste `bot_token` + Deploy Web App once + paste the `/exec` URL).
  - Then Telegram `/start <token>` bind.
  - Telegram-only setup is impossible (OAuth consent, Web App deploy, trigger creation require Google UI).

- Distribution:
  - `copy` link + setup guide live in `README.md` and a static site under `docs/` (GitHub Pages, relative paths, `main` + `/docs`). English-only pages at the root (`index/setup/usage/faq.html`); `/zh-Hant/` is reserved for a future Chinese mirror. Template distribution uses the public Sheet share link (`.../edit?usp=sharing`, in `docs/setup.html` + `README.md`) plus an instruction to use **File &gt; Make a copy**; the `/copy` URL is deliberately not used (it lands on a bare Google page that reads as suspicious). Site and repository URLs are hardcoded (`https://carmenchancky.github.io/deal-watch/`, `https://github.com/CarmenChanCKY/deal-watch`); no placeholder tokens remain. Screenshot figures use a single `assets/img/placeholder.svg` until real images land. Social preview uses `assets/img/og.png` (1200x630, generated from `og.svg`); the home hero reuses the Usage digest screenshot. License: MIT (`LICENSE`, `Copyright (c) 2026 Carmen Chan`).
  - The copy link is never shown inside Telegram (own bot does not exist until after copy/deploy).
  - Updates are manual (no auto-update): `SCRIPT_VERSION` shows in `/status` and a throttled once-a-day check appends an "update available" line to the digest (never a message on its own) while a newer `version.txt` exists. `CHANGELOG.md` + GitHub Releases are the announcement channel.

## Data and storage

- `Rules`:
  - `id` (stable, not a row number) `| sender | keywords (OR, comma) | enabled | topic_hint | updated_at`.
  - One entry per sender; sender is the natural key.
  - New `id`s are `max(id)+1` allocated under `ScriptLock`.
  - Sender is either a domain (`xxx.com`) or a full email (`abc@xxx.com`), distinguished by presence of `@`.

- `Log`:
  - `timestamp | message_id | sender | matched_keywords | subject | status`.
  - Sliding 30-day retention; rows kept after rule delete for dedup and audit, then pruned.
  - `/export` is out of scope.

- `Runs`:
  - `start | end | found | sent | error` (watcher self-monitoring).

- `ScriptProperties`:
  - Secrets + owner binding + `webapp_url` + `last_error` + `poll_interval_minutes` + `consecutive_send_failures` + rules cache.
  - Cache is one `rule_<id>` key per rule + `rules_version`/`updated_at`, latest version only; Sheet is the mirror.

- Secrets (never in Sheet/code/repo/logs):
  - `bot_token | owner_chat_id | setup_token (single-use) | openrouter_key | llm_model | webhook_secret`.

- Provisioning:
  - Tables auto-provisioned by idempotent `ensureSchema()` (then hidden); a visible `Home` front sheet is kept because Sheets forbids hiding every sheet.
  - No example rule row — examples live in the Telegram welcome/add-rule prompts.
  - Users never create tables manually.
  - File deletion cannot be forbidden; mitigation is startup DB check + per-key `ScriptProperties` rebuild (`rule_<id>`) + file-hygiene guidance.

## Matching and notification

- Sender scope:
  - Domain senders use contains.
  - Email senders use exact match after normalization (`lower` + strip `+tag`, e.g. `Abc+sale@XXX.com` matches `abc@xxx.com`).
  - Gmail dot handling is out of scope.

- Keywords:
  - OR + case-insensitive normalized substring (`lower/trim/full-half-width`).
  - `"quoted"` spans are exact phrases.

- Polling:
  - Sender match = candidate; `getPlainBody()` for all candidates (subject/snippet display-only, never filter, so body-only keywords not missed). `Log` `message_id` check before body read.
  - Batched `from:{...}` queries (max 30 senders enforced at rule entry, 15 per query, max 2 searches/run; T3 defensive truncate + invalid-sender skip, both counted in `Runs` error) with `newer_than:{2×interval}` overlap (`m` unit, e.g. 15min→`30m`).
  - Cross-batch `message_id` dedup; cap 20 threads/run (overflow covered by overlap next run). Match per-message (`From` `<email>`, own sent ignored), digest collapsed per-thread (union keywords, newest subject/date/link).

- Notify:
  - One digest message per run (zero matches = silence).
  - No caps, no quiet hours (user mutes phone).
  - One thread appears once per digest with the union of matched keywords across rules and messages, plus subject/date/thread link (`.../#inbox/{threadId}`), no row/ID references.
  - Errors merged into the same message in English: send failures logged to `Runs` + `last_error`, missed errors re-pushed on next successful send, retry stops after 3 consecutive failures.
  - `Runs.sent` is `0/1` per run (one merged message max; silence or send failure = `0`).

## Security, secrets and AI boundaries

- Per-copy isolation:
  - Each user deploys their own copy, so keys stay in their own account and the template author cannot see them.

- Secret entry:
  - Via own-bot DM: `/setai` opens Mini App Settings (OpenRouter key + model); the key is validated, stored, and only ever shown masked with a delete action.
  - Masked echo, immediate `deleteMessage`, DM-only.
  - Code must never log, echo, or persist full keys; audit for exfiltration.
  - `llm_model`/key blank = suggestion disabled with pricing warning; no default model.

- OpenRouter fence:
  - Keyword suggestion from an explicit user seed only.
  - On-demand, cost-gated, cached, human-picked, never automatic.
  - Must never read email content, perform matching, parse commands, or modify rules.
  - Missing key/model disables cleanly without affecting notifications.

- AI rules:
  - AI writes docs only when asked; keep `CONTEXT.md`/`README.md` clean and concise.
  - External actions (bot creation, OAuth, API keys) are the user's job.

## Build plan

- T1 — Manual prerequisites (user, AI never does):
  BotFather `/newbot` for `bot_token`; optional OpenRouter key/model; Google account ready.

- T2 — Spec (done):
  Schema, sender/keyword semantics, one-digest-per-run, per-copy isolation.

- T3 — `Code.gs` core (done; no `sendMessage`, send is T4):
  - T3-a (done): helpers in `src/Code.gs` — `ensureSchema()`, normalization (`normalizeText`, `+tag` strip), `senderMatches`, `parseKeywords`/`matchKeywordsInText`, interval helpers (Properties read, 15 fallback, `newer_than` = 2x).
  - T3-b (done): polling + per-message match — load enabled rules; batched `from:{...}` (15/query, max 2 searches/run, `newer_than:{2×}m`); cross-batch `message_id` dedup; `Log` check before `getPlainBody()`; own sent ignored; 20-thread cap; >30 senders truncate + invalid senders skip, both counted in `Runs` error.
  - T3-c (done): digest + writes — per-thread collapse (union keywords, newest subject/date/link); one digest string per run (silence on zero); `Log`/`Runs` writes; 30-day `Log` prune; main entry returns digest without sending.
  - T3-d (done): `src/appsscript.json` — `Asia/Hong_Kong`, V8, webapp (`USER_DEPLOYING` + `ANYONE_ANONYMOUS`), 5 minimal scopes (`spreadsheets.currentonly`, `gmail.readonly`, `script.storage`, `script.scriptapp`, `script.external_request`); default GCP project, no editors. Done = auth screen shows exactly these.
  - Acceptance tests (done): `test/TESTING.md` + `test/T3-TestingPlan.md` + `test/TestT3.gs` (temporary runner, one-paste-one-run).

- T4 — Trigger + self-monitoring (sliced; backend only, no Sheet menu; interval UI is T5):
  - T4-a (done): `ensureTrigger()` + `setPollIntervalMinutes()` (idempotent, no duplicates); `15/30/60` via `everyMinutes`, `120/360/720` via `everyHours`; handler `runWatchAndNotify()` (stub calls `runWatchOnce()`).
  - T4-b (done): send + fallback — one merged `sendMessage` per run (digest + English error block); `Runs.sent 0/1`; `last_error` + `consecutive_send_failures` with stop-after-3; silence stays silent unless a pending error exists.
  - T4-c (done): human-readable `T4-TestingPlan.md` + `TestT4.gs` (temporary runner, one-paste-one-run; no test mails needed).

- T5 — Telegram UX + one-time Setup:
  - T5-a (done): `doPost` router + auth gate (URL `secret` check — Apps Script cannot read the `secret_token` header — DM-only, owner allowlist, silent ignore for strangers/groups).
  - T5-b (done): Sheet `Setup` (menu item only) + `/start <token>` bind + `/transfer` + `/connect` (both with inline confirm); `rule_<id>` mirror cache; English UI first.
  - T5-c/d/e (done): rule CRUD (`/list` 10/page, 2 buttons/row, → detail with Enable/Disable + Edit keywords/sender + Delete-confirm, duplicate sender → edit, 30-enabled block at entry; keywords validated by `parseKeywords`, empty rejected; Cancel button on every input step) + interval (inline fixed dropdown) / status (interval + rule count + last run + `last_error`) / help + command menu (`setMyCommands` in Setup/re-attach) + unknown → short help (strangers/groups stay silent) + `T5-TestingPlan.md` + `TestT5.gs`; English-first.
  - Deferred to T6 (now done): suggestion UI + key/model entry via the Mini App (`/setai`); `topic_hint` written on confirm.

- T6 — Suggestion (optional; Telegram Mini App):
  - T6-a/b/c (superseded): key/model storage, OpenRouter suggestion client, and in-chat idea chips (replaced by T6-i).
  - T6-d/i (done): one Mini App page (`src/MiniApp.html`) served by `doGet` behind a bot-issued open token; single `/setai` replaces `/setkey`+`/setmodel`; `[Need ideas?]` is a direct `web_app` button.
  - T6-e (done): `model_meta` metadata cache (`CacheService`) + reasoning-off / `max_tokens` request tuning.
  - T6-f/g (done): Settings view — key set/replace (masked)/delete; model search/pick/clear; free-only filter.
  - T6-h (done): Ideas view — type a topic → suggestions (toggle chips, ≤3 batches) → add hands back to the chat confirm.
  - T6-k (done): responsive layout for small screens (narrow gutters + field rows wrap to full width; wide screens capped to a reading width).
  - T6-l (done): mobile viewport fix — Apps Script ignores meta tags in the HTML file, so `serveMiniApp_`/`serveMiniAppError_` inject the viewport via `HtmlOutput.addMetaTag` (`MINI_APP_VIEWPORT`); the inline `<meta name="viewport">` in `MiniApp.html` was removed. Fixes tiny/desktop-scaled rendering on phones.
  - T6-m (done): desktop/web framing fix — `serveMiniApp_`/`serveMiniAppError_` set `XFrameOptionsMode.ALLOWALL`, so Telegram Desktop/Web (which load the Mini App in a frame) display it instead of the browser's `xframe-neterror-page`; the minted token + owner check remains the guard.

- T7 — Static site + README (done):
  Four vanilla pages under `docs/` — `index.html` (hero with a shared digest screenshot + a four-step "how it works" + prerequisites; feature cards in a 2x2 grid), `setup.html` (BotFather -> copy template -> deploy Web App -> Setup -> bind -> test), `usage.html` (commands, rules, keywords, senders, limits, interval, status/errors, digest, optional keyword ideas, maintenance), `faq.html` (8 common questions with a top table of contents and card + icon layout) — plus shared `assets/css/style.css`, `assets/js/site.js` (hamburger nav toggle + copy-to-clipboard), `assets/img/placeholder.svg` + `favicon.svg` + `og.svg`/`og.png` (1200x630 social card), and `docs/.nojekyll`; light theme, system fonts, no build, no framework, no CDN, relative paths. Mobile nav collapses behind a right-aligned hamburger (GitHub icon stays visible). Footer carries `© 2026 Carmen Chan`. `README.md` rewritten as a short intro + copy link + site link. `LICENSE` (MIT). English-only now; `/zh-Hant/` reserved (no language switch shown yet). Deferred to the owner: real screenshots (phone first; desktop allowed when no mobile version exists) and real URLs for the placeholder tokens.

- T8 — Self-verification (user):
  Add rule -> test mail -> digest -> error/transfer check; AI provides steps only, never runs app/tests.

- T9 — Version + update notice (done):
  `SCRIPT_VERSION` in Config + `version.txt` upstream; `SCRIPT_VERSION` shown in `/status`; a throttled (once/day) fetch of `version.txt` caches the latest in `ScriptProperties` and appends an "update available" line to the digest (never a message on its own). Failures are silent (never counted in `Runs`). Docs: `docs/usage.html` Updating section, `CHANGELOG.md`, GitHub Releases.

## Explicitly rejected (with reasons)

- No-code automations (cost/privacy).
- Self-hosted service (maintenance).
- External DB (overkill).
- `ScriptProperties`-only rules (size/debug limits).
- Word-boundary matching (meaningless for Chinese).
- Regex now (Phase 2).
- Per-email LLM classification (per-message cost/latency).
- Precise `after:timestamp` checkpoints (Gmail search lacks timestamp precision).
- Per-message pushes (spam).
- Centrally shared bot (host could read keys).
- Free-text bot parsing (fragile + needs LLM).
- Auto suggestion (cost).
- Manual table/rule creation by end users (replaced by `ensureSchema()` + Telegram UI).
