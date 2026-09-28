# AI-Assisted Development Record

How AI was used as an engineering assistant during the design of Deal Watch. AI explored alternatives, challenged assumptions, and surfaced edge cases; all final decisions were made by the project owner. No implementation code exists yet — this record covers the design phase only.

## 1. Choosing the notification approach

**Problem.** Get a phone notification (iOS and Android) when a Gmail message from a watched sender contains promotion keywords.

**Options considered.** Native Gmail filters and labels; no-code automation (IFTTT/Zapier/Make) to a push service; Google Apps Script calling a push API; a self-hosted polling service.

**How AI was used.** Asked AI to lay out the approaches with cost, privacy, latency, and maintenance trade-offs instead of picking one outright.

**Decision.** Telegram Bot as the push channel.

**Why.** Free, works on both OSes with no new app, and supports both outbound alerts and (later) an inbound management UI over one integration.

**Result.** Single-channel design: all alerts and all rule management go through the user's own Telegram bot.

## 2. Choosing Apps Script and the deployment model

**Problem.** Where should the polling and matching logic run for a single user today, while keeping a path open for non-tech users later?

**Options considered.** Central hosted service; per-user no-code automation; per-user Apps Script deployment from a shared template.

**How AI was used.** Used AI to compare single-tenant vs multi-tenant hosting, focusing on who holds credentials and who performs setup steps.

**Decision.** Google Apps Script bound to a template Sheet, deployed per-copy under each user's own Google account.

**Why.** Gmail, Sheet, and Script stay in one account with no extra infrastructure; per-copy isolation means the template author never holds another user's keys or mail access.

**Result.** Locked constraint: shared multi-tenant hosting rejected; every deployment runs as its owner.

## 3. Choosing storage

**Problem.** Rules, logs, and run history need a store the script can read and write.

**Options considered.** Hidden Sheet as database; `ScriptProperties` JSON only; external database (Firestore/Supabase).

**How AI was used.** Asked AI to compare size limits, debuggability, audit history, and operational cost for a single-user workload.

**Decision.** Hidden Sheet (`Rules`, `Log`, `Runs` tables) for data; `ScriptProperties` for secrets, owner binding, and a rules cache only.

**Why.** The workload is tabular and tiny; the Sheet gives free history and a debugging fallback, while Properties avoids the ~500KB quota and opaque failure modes of a JSON-only store. An external database was rejected as overkill.

**Result.** Schema with stable `id`s (never row numbers) and domain as the natural key.

## 4. Gmail polling, overlap windows, and deduplication

**Problem.** Poll every 10 minutes without missing mail when a run fails and without downloading the whole inbox.

**Options considered.** Precise `after:timestamp` checkpoint; `newer_than` window sized to the interval; `newer_than` window with overlap plus `message_id` dedup.

**How AI was used.** AI review flagged that Gmail search `after:` has date-level granularity, so a timestamp checkpoint cannot work as assumed.

**Decision.** Merged server-side query (`from:{...} newer_than:{2×interval}h`) with deliberate overlap, deduplicated on `message_id` in `Log`.

**Why.** Overlap trades a small amount of re-scanning for gap-free coverage across failed or jittered runs; the dedup log makes re-scans idempotent.

**Result.** Polling spec: server-side domain/time filter first, newest-first, capped threads per run.

## 5. Deterministic keyword matching

**Problem.** Define matching precisely enough to implement: sender scope, keyword logic, case handling, and match surface.

**Options considered.** Substring vs word-boundary vs exact-phrase vs regex vs semantic classification.

**How AI was used.** Used AI to enumerate the semantics of each method and probe them against the owner's examples (mixed English/Chinese promo text).

**Decision.** Domain-contains sender scope; keyword OR; case-insensitive normalized substring (`lower/trim/full-half-width`); `"quoted"` spans reserved for exact phrases; subject + snippet screened first, body fetched only for candidates.

**Why.** Deterministic, cheap, and auditable per run. Word-boundary matching was rejected as meaningless for Chinese; regex deferred to a power-user phase.

**Result.** Matching behavior is fully specified without any model call in the hot path.

## 6. Deciding against per-email LLM classification

**Problem.** Whether the LLM should judge if each email "is a promotion."

**How AI was used.** Asked AI to cost out calling a model per message versus deterministic matching.

**Decision.** Rejected.

**Why.** Per-message cost and latency on every poll, nondeterministic results, and no benefit over keyword rules for this use case.

**Result.** The hot path contains zero LLM calls by design.

## 7. On-demand LLM keyword suggestion

**Problem.** Users often don't know which keywords to watch (e.g. they care about sneaker deals but only think of one term).

**Options considered.** Automatic suggestion on every rule; suggestion only when asked; no suggestion feature.

**How AI was used.** AI helped scope the feature down to a cost-bounded interaction: seed-required, cost-gated, cached, human-confirmed.

**Decision.** Suggestion fires only on explicit request (`[Need ideas?]` after the user types at least one seed word, or `/suggest <seed>`), sends only the seed to OpenRouter, and writes nothing until the user picks items.

**Why.** Bounds cost to one call per request (with 24h seed caching), avoids exfiltrating mail content, and keeps a human in the loop so bad suggestions never silently become rules.

**Result.** Fenced integration: OpenRouter is allowed only here, never for matching, parsing, or rule writes; blank key/model disables it cleanly.

## 8. Chinese keyword matching

**Problem.** Rules mix English and Chinese (`air`, `5折`, `優惠`); matching must handle both.

**How AI was used.** AI probing showed word-boundary semantics break down for Chinese (no word delimiters) and that Gmail search tokenization differs between the two languages, so keyword filtering could not safely live inside the Gmail query.

**Decision.** Gmail query filters only domain + time; all keyword matching happens in script code on normalized text; minimum-seed-length validation was dropped after review showed it was unworkable for single-character Chinese seeds — partial seeds of any length are accepted with a confirm/edit step before spending on a suggestion call.

**Why.** Keeps Chinese matching reliable (substring always hits) at the price of occasional English over-match, which the owner accepted as preferable to silent misses.

**Result.** Two-stage pipeline plus normalization rules recorded in the matching spec.

## 9. Edge cases and failure modes found through AI review

**Problem.** The initial plan assumed triggers fire on time, pushes succeed, and state stays consistent.

**How AI was used.** Ran a structured adversarial review (`grill-me` skill) against the plan and worked through each finding.

**Decisions and reasons.**
- Silent watcher failure → added `Runs` table plus separate English error pushes, because the most dangerous failure is believing "no deals" when the watcher is broken.
- Digest spam from multi-match runs → one digest message per run instead of one push per email.
- Same email matching several rules → listed once with all matched keywords.
- Sheet deletion (which Google cannot forbid) → startup DB check, cache-backed rebuild, and hygiene guidance instead of a prevention mechanism that doesn't exist.
- Bot abuse → single-owner allowlist, DM-only, webhook secret, silent ignore for strangers.

**Result.** Each finding became a locked constraint or a schema addition before any code was written.

## 10. Security and secret handling

**Problem.** Bot tokens and LLM keys must be usable by the script without ever being visible to the template author or leaking into logs and repos.

**Options considered.** Keys in Sheet cells or code; centrally hosted vault; per-copy platform secret store.

**How AI was used.** Used AI to compare the trust properties: only per-copy storage gives a technical (not policy-based) guarantee the author cannot read keys.

**Decision.** Keys live only in the user's own `ScriptProperties`, entered via own-bot DM (`/setkey`, `/setmodel`), echoed masked, followed by `deleteMessage`; code must never log, echo, or persist full keys.

**Why.** Combined with per-copy deployment, isolation is structural: there is no shared database or log sink where keys could accumulate.

**Result.** Secret-handling rules recorded as implementation constraints for all future code.

## Ownership

AI acted as reviewer and options-generator throughout. Every trade-off above — channel, runtime, storage, matching semantics, digest shape, LLM fencing, and secret handling — was decided by the owner against AI-surfaced alternatives, and the rejections are recorded with reasons so future sessions don't relitigate them.
