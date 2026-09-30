# Deal Watch — Context

## Goal and status

Watch Gmail for promotion emails from user-chosen senders (domain or full email) containing user-chosen keywords, and push a phone notification.

MVP is single-user; future non-tech users via per-copy deployment.

T3-a helpers done (`src/Code.gs`); T3-b–T3-d then T4–T8 planned (see Build plan). No tests or deployment yet.

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
  - Reply keyboard, guided Q&A, inline per-rule buttons, power-user slash commands.
  - The only surface touched daily.
  - Button-first; raw commands are fallback only; free-text control rejected.
  - Add-rule keywords step offers `[Use last keywords]` (hidden when no prior rule exists), filling keywords from the most recently created rule for confirm/edit.

- Access:
  - Single owner, DM-only.
  - Deep-link `/start <one-time token>` binding.
  - Non-owners silently ignored; groups rejected.

- Script:
  - Gmail polling / matching / digest.
  - `doPost` command + callback router.
  - Per-chat conversation state.
  - Setup / transfer / connect and suggestion flows.

- Setup is idempotent per deployment:
  - `ensureSchema()` + trigger creation (no duplicates) + `getMe` token validation + `setWebhook` + binding-link generation.
  - Rerun outputs `Already set up` without overwriting owner or rotating secrets.
  - Phone change = no action; TG-account change = `/transfer`; token rotation = `/connect`.
  - Rules persist because storage is decoupled from Telegram identity.

- Onboarding is one-time Google Setup + rest-in-Telegram:
  - Copy template via `.../copy` link.
  - Then `Deal Watch > Setup` (OAuth + paste `bot_token` + Deploy Web App once).
  - Then Telegram `/start <token>` bind.
  - Telegram-only setup is impossible (OAuth consent, Web App deploy, trigger creation require Google UI).

- Distribution:
  - `copy` link + setup guide live in `README.md` and bilingual static site `docs/index.html` (GitHub Pages, placeholder links until owner supplies real URLs).
  - The copy link is never shown inside Telegram (own bot does not exist until after copy/deploy).

## Data and storage

- `Rules`:
  - `id` (stable, not a row number) `| sender | keywords (OR, comma) | enabled | topic_hint | updated_at`.
  - One entry per sender; sender is the natural key.
  - Sender is either a domain (`xxx.com`) or a full email (`abc@xxx.com`), distinguished by presence of `@`.

- `Log`:
  - `timestamp | message_id | sender | matched_keywords | subject | status`.
  - Sliding 30-day retention; rows kept after rule delete for dedup and audit, then pruned.
  - `/export` is out of scope.

- `Runs`:
  - `start | end | found | sent | error` (watcher self-monitoring).

- `ScriptProperties`:
  - Secrets + owner binding + `last_error` + rules cache.
  - Cache is one `rule_<id>` key per rule + `rules_version`/`updated_at`, latest version only; Sheet is the mirror.

- Secrets (never in Sheet/code/repo/logs):
  - `bot_token | owner_chat_id | setup_token (single-use) | openrouter_key | llm_model | webhook_secret`.

- Provisioning:
  - Tables auto-provisioned by idempotent `ensureSchema()` (then hidden).
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
  - Batched `from:{...}` queries (max 30 senders enforced at rule entry, 15 per query, max 2 searches/run; T3 defensive truncate + `Runs` error) with `newer_than:{2×interval}` overlap (`m` unit, e.g. 15min→`30m`).
  - Cross-batch `message_id` dedup; cap 20 threads/run (overflow covered by overlap next run). Match per-message (`From` `<email>`, own sent ignored), digest collapsed per-thread (union keywords, newest subject/date/link).

- Notify:
  - One digest message per run (zero matches = silence).
  - No caps, no quiet hours (user mutes phone).
  - One thread appears once per digest with the union of matched keywords across rules and messages, plus subject/date/thread link (`.../#inbox/{threadId}`), no row/ID references.
  - Errors pushed separately in English: send failures logged to `Runs` + `last_error`, missed errors re-pushed on next successful send, retry stops after N consecutive failures.

## Security, secrets and AI boundaries

- Per-copy isolation:
  - Each user deploys their own copy, so keys stay in their own account and the template author cannot see them.

- Secret entry:
  - Via own-bot DM (`/setkey`, `/setmodel`).
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

- T3 — `Code.gs` core (sliced; confirm each before next; no `sendMessage`, send is T4/T5):
  - T3-a (done): helpers in `src/Code.gs` — `ensureSchema()`, normalization (`normalizeText`, `+tag` strip), `senderMatches`, `parseKeywords`/`matchKeywordsInText`, interval helpers (Properties read, 15 fallback, `newer_than` = 2x).
  - T3-b: polling + per-message match — load enabled rules; batched `from:{...}` (15/query, max 2 searches/run, `newer_than:{2×}m`); cross-batch `message_id` dedup; `Log` check before `getPlainBody()`; own sent ignored; 20-thread cap; >30 senders truncate + `Runs` error.
  - T3-c: digest + writes — per-thread collapse (union keywords, newest subject/date/link); one digest string per run (silence on zero); `Log`/`Runs` writes; 30-day `Log` prune; main entry returns digest without sending.
  - T3-d: `src/appsscript.json` — `Asia/Hong_Kong`, V8, webapp (`USER_DEPLOYING` + `ANYONE_ANONYMOUS`), 5 minimal scopes (`spreadsheets.currentonly`, `gmail.readonly`, `script.storage`, `script.scriptapp`, `script.external_request`); default GCP project, no editors. Done = auth screen shows exactly these.

- T4 — Trigger + self-monitoring:
  Trigger options + `Runs`/error pushes per above.

- T5 — Telegram UX + one-time Setup:
  Flows per above.

- T6 — Suggestion (optional):
  Fenced OpenRouter seed-only flow per above.

- T7 — Static site + README:
  Bilingual `docs/index.html` + minimal README with `copy` link; BotFather -> copy -> Setup -> bind guide.

- T8 — Self-verification (user):
  Add rule -> test mail -> digest -> error/transfer check; AI provides steps only, never runs app/tests.

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
