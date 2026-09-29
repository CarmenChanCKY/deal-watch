# Deal Watch — Context

## Project goal and scope

Watch Gmail for promotion emails from user-chosen senders (domain or full email address) containing user-chosen keywords, and push a phone notification. MVP is single-user; the design must allow future non-tech users via per-copy deployment. No implementation code exists yet; planning is complete through the T2 spec.

## Current architecture and data flow

Planned architecture (not implemented yet):

Telegram (button-first UI, DM only)
↔ user's bound Apps Script
↔ hidden Sheet DB
↔ Gmail
→ Telegram Bot API
→ phone

The project currently has no implementation code. The architecture is defined in the planning/specification documents and should be treated as the current intended design unless the user explicitly changes it.

Unless explicitly asked to reconsider the architecture, do not replace or simplify locked decisions based only on personal preference. If an implementation issue conflicts with a locked decision, explain the conflict before changing it.

## Tech stack and runtime

Google Apps Script (bound to the template Sheet), GmailApp + SpreadsheetApp + PropertiesService + CacheService + UrlFetchApp; time-driven trigger (default 10 min, user-editable); Telegram Bot API inbound (webhook + `secret_token`) and outbound; OpenRouter chat-completions API (optional).

## Components and responsibilities

- Telegram UI: reply keyboard, guided Q&A, inline per-rule buttons, power-user slash commands; the only surface the user touches daily. Add-rule keywords step offers `[Use last keywords]` (hidden when no prior rule exists); it fills keywords from the most recently created rule for confirm/edit.
- Apps Script: Gmail polling/matching/digest, `doPost` command + callback router, per-chat conversation state, setup/transfer/connect flows, suggestion flow.
- Hidden Sheet DB: `Rules`, `Log`, `Runs` tables.
- `ScriptProperties`: secrets + owner binding + rules cache. No other backend, server, or dependency.

## Data/storage structure

- `Rules`: `id` (stable, not a row number) `| sender | keywords (OR, comma) | enabled | topic_hint | updated_at`. One entry per sender; sender is the natural key. Sender is either a domain (`xxx.com`) or a full email (`abc@xxx.com`), distinguished by presence of `@`.
- `Log`: `timestamp | message_id | sender | matched_keywords | subject | status`. `Log` rows are preserved on rule delete for dedup and audit.
- `Runs`: `start | end | found | sent | error` (watcher self-monitoring).
- Secrets (never in Sheet/code/repo/logs): `bot_token | owner_chat_id | setup_token (single-use) | openrouter_key | llm_model | webhook_secret`.

## External APIs and integrations

- Gmail (read via the owner's account; server-side `GmailApp.search()` only).
- Telegram Bot API (`sendMessage`, `deleteMessage`, `setWebhook`, `getUpdates` for initial `chat_id`).
- BotFather (manual bot creation; user action, never done by AI).
- OpenRouter (`/chat/completions` with user-supplied model/key; suggestion calls only).

## Key implementation decisions and constraints

- Button-first UX; raw commands are fallback only; free-text natural-language control rejected.
- Single owner, DM-only, deep-link `/start <one-time token>` binding; non-owners silently ignored; groups rejected.
- Setup runs once per deployment; phone change = no action; TG-account change = `/transfer`; token rotation = `/connect`; rules persist because storage is decoupled from Telegram identity.
- File deletion cannot be forbidden; mitigation is startup DB check + `ScriptProperties` cache rebuild + file-hygiene guidance. `/export` is out of scope.
- Keep `CONTEXT.md`/`README.md` clean and concise; AI writes docs only when asked; external actions (bot creation, OAuth, API keys) are the user's job.

## Matching and notification behaviour

- Sender scope: domain senders use contains; email senders use exact match after sender normalization (`lower` + strip `+tag`, e.g. `Abc+sale@XXX.com` matches `abc@xxx.com`); Gmail dot handling is out of scope. Keywords OR + case-insensitive normalized substring (`lower/trim/full-half-width`), `"quoted"` spans are exact phrases.
- Two-stage: subject + snippet first, `getPlainBody()` only for candidates; merged `from:{...}` query with `newer_than:{2×interval}h` overlap; `message_id` dedup.
- One digest message per run (zero matches = silence); no caps, no quiet hours; one email appears once per digest with the union of matched keywords across rules, no row/ID references; errors pushed separately in English.

## Security/secrets handling

Per-copy isolation: each user deploys their own copy, so keys stay in their own account and the template author cannot see them. Entry via own-bot DM (`/setkey`, `/setmodel`), masked echo, immediate `deleteMessage`, DM-only. Code must never log, echo, or persist full keys; audit for exfiltration. `llm_model`/key blank = suggestion disabled with a pricing warning; no default model.

## Development status

Planning complete through T2; no source files, no tests, nothing deployed. Next: T3 `Code.gs` core (only after explicit user approval), then T4 trigger, T5 UX, optional T6 suggestion, T7 self-verification guide.

## Explicitly rejected (with reasons)

- No-code automations (cost/privacy); self-hosted service (maintenance); external DB (overkill); `ScriptProperties`-only rules (size/debug limits).
- Word-boundary matching (meaningless for Chinese); regex now (Phase 2); per-email LLM classification (per-message cost/latency).
- Precise `after:timestamp` checkpoints (Gmail search lacks timestamp precision); per-message pushes (spam); centrally shared bot (host could read keys); free-text bot parsing (fragile + needs LLM); auto suggestion (cost).

## AI boundaries

OpenRouter is fenced to keyword suggestion from an explicit user seed: on-demand, cost-gated, cached, human-picked, never automatic. It must never read email content, perform matching, parse commands, or modify rules. Missing key/model must disable the feature cleanly without affecting notifications.
