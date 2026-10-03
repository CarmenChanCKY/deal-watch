# AI-Assisted Development Record

How AI was used as an engineering assistant during the design of Deal Watch.

AI explored alternatives, challenged assumptions, and surfaced edge cases; all final decisions were made by the project owner.

No implementation code exists yet — this record covers the design phase only.

## Ownership

AI acted as reviewer and options-generator throughout.

Every trade-off above — channel, runtime, storage, matching semantics, digest shape, LLM fencing, and secret handling — was decided by the owner against AI-surfaced alternatives.

The rejections are recorded with reasons so future sessions don't relitigate them.

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

**Decision.**

- Domain-contains sender scope; keyword OR.
- Case-insensitive normalized substring (`lower/trim/full-half-width`).
- `"quoted"` spans reserved for exact phrases.
- Subject + snippet screened first, body fetched only for candidates.

**Why.**

Deterministic, cheap, and auditable per run.

Word-boundary matching was rejected as meaningless for Chinese; regex deferred to a power-user phase.

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

**Decision.**

- Fires only on explicit request (`[Need ideas?]` after at least one seed word, or `/suggest <seed>`).
- Sends only the seed to OpenRouter.
- Writes nothing until the user picks items.

**Why.**

One call per request (with 24h seed caching).

Avoids exfiltrating mail content, and keeps a human in the loop so bad suggestions never silently become rules.

**Result.** Fenced integration: OpenRouter is allowed only here, never for matching, parsing, or rule writes; blank key/model disables it cleanly.

## 8. Chinese keyword matching

**Problem.** Rules mix English and Chinese (`air`, `5折`, `優惠`); matching must handle both.

**How AI was used.** AI probing showed word-boundary semantics break down for Chinese (no word delimiters), and Gmail search tokenization differs between the two languages.

So keyword filtering could not safely live inside the Gmail query.

**Decision.**

- Gmail query filters only domain + time; all keyword matching happens in script code on normalized text.
- Dropped minimum-seed-length validation — unworkable for single-character Chinese seeds.
- Partial seeds of any length are accepted, with a confirm/edit step before spending on a suggestion call.

**Why.** Keeps Chinese matching reliable (substring always hits) at the price of occasional English over-match, accepted as preferable to silent misses.

**Result.** Two-stage pipeline plus normalization rules recorded in the matching spec.

## 9. Edge cases and failure modes found through AI review

**Problem.** The initial plan assumed triggers fire on time, pushes succeed, and state stays consistent.

**How AI was used.** Ran a structured adversarial review (`grill-me` skill) against the plan and worked through each finding.

**Decisions and reasons.**

- **Silent watcher failure.**
  Added `Runs` table plus separate English error pushes — the most dangerous failure is believing "no deals" when the watcher is broken.
- **Digest spam from multi-match runs.**
  One digest message per run instead of one push per email.
- **Same email matching several rules.**
  Listed once with all matched keywords.
- **Sheet deletion (which Google cannot forbid).**
  Startup DB check, cache-backed rebuild, and hygiene guidance instead of a prevention mechanism that doesn't exist.
- **Bot abuse.**
  Single-owner allowlist, DM-only, webhook secret, silent ignore for strangers.

**Result.** Each finding became a locked constraint or a schema addition before any code was written.

## 10. Security and secret handling

**Problem.** Bot tokens and LLM keys must be usable by the script without ever being visible to the template author or leaking into logs and repos.

**Options considered.** Keys in Sheet cells or code; centrally hosted vault; per-copy platform secret store.

**How AI was used.** Used AI to compare the trust properties: only per-copy storage gives a technical (not policy-based) guarantee the author cannot read keys.

**Decision.**

- Keys live only in the user's own `ScriptProperties`, entered via own-bot DM (`/setkey`, `/setmodel`).
- Echoed masked, followed by `deleteMessage`.
- Code must never log, echo, or persist full keys.

**Why.** Combined with per-copy deployment, isolation is structural: there is no shared database or log sink where keys could accumulate.

**Result.** Secret-handling rules recorded as implementation constraints for all future code.

## 11. Listening to full email addresses

**Problem.** Owner wants to watch not only whole domains (`xxx.com`) but also specific senders (`abc@xxx.com`).

**Options considered.** Domain-only senders; sender column accepting either a domain or a full email (distinguished by presence of `@`).

**How AI was used.** Used AI (`grill-me` interview) to probe exact-match vs contains, case, `+tag`, Gmail dot handling, and the interaction when one rule watches `abc@xxx.com` and another watches `xxx.com`.

**Decision.**

- One entry per sender; sender is either a domain or a full email.
- Domain senders use contains; email senders use exact match after sender normalization (`lower` + strip `+tag`, e.g. `Abc+sale@XXX.com` matches `abc@xxx.com`).
- Gmail dot handling out of scope.
- No search-layer exclusion: merged `from:{...}` query searches all senders.
- Per-rule sender + keyword checks run in script; `message_id` dedup merges multi-rule hits into one digest entry with the union of matched keywords.
- `Log` rows are preserved on rule delete for dedup and audit.

**Why.** Covers specific-sender promos; dedup-after-match avoids missing fallback hits (e.g. `abc@xxx.com` with only the domain rule's keyword still notifies via the domain rule).

**Result.** `Rules.sender` / `Log.sender` replace domain-only fields; matching spec updated in `CONTEXT.md`.

## 12. Reusing keywords when adding a rule

**Problem.** Owner did not want to retype the same keywords when adding another sender.

**Options considered.** Retyping keywords for every rule; per-rule copy with a convenience fill.

**How AI was used.** AI surfaced the retyping pain and scoped the minimal fill behavior (what "last" means, hidden state).

**Decision.**

- Add-rule keywords step offers `[Use last keywords]` (hidden when no prior rule exists).
- It fills keywords from the most recently created rule for confirm/edit.
- Each rule keeps its own copied keywords afterward.

**Why.** Removes retyping with no storage-model change.

**Result.** Button-first convenience recorded as a UI constraint for T5; storage stays one-row-per-sender.

## 13. Auto-provisioning template tables

**Problem.** If the template is shared on GitHub, future users should not have to manually create the 3 tables and rules.

**Options considered.** Manual table creation by each user; static header spec/CSVs to import; code-generated provisioning on first run.

**How AI was used.** AI pointed out the already-locked startup DB check could be extended to first-run provisioning.

It also clarified the split: AI can generate the provisioning code but cannot create the Drive file itself (external action).

**Decision.**

- Blank template + idempotent `ensureSchema()` that creates/hides `Rules`/`Log`/`Runs`.
- No example rule row — examples live in the Telegram welcome/add-rule prompts.
- Rules are added via Telegram UI only, never by hand-editing the Sheet.

**Why.** Removes manual work with no storage-model change and keeps the Sheet as a hidden DB plus debug fallback.

**Result.** Recorded as a T3 constraint; manual table/rule creation by end users rejected.

## 14. Onboarding and distribution for a GitHub template

**Problem.** Owner will publish the template on GitHub with uncertain adoption, and wants minimal friction for non-tech users from link to first rule.

**Options considered.** Showing the copy link inside Telegram vs outside; Sheet-menu Setup vs Telegram-only setup; guide in README vs a static site.

**How AI was used.** AI clarified the chicken-and-egg (a user's own bot does not exist until after copy/deploy, so the copy link must live outside Telegram).

OAuth consent, Web App deploy, and trigger creation require a one-time Google UI pass — even a standalone script without a Sheet still needs one Google open.

**Decision.**

- Keep one-bot-per-user Telegram; distribute the `.../copy` link via `README.md` plus a bilingual static site `docs/index.html` (GitHub Pages, placeholder links until the owner supplies real URLs).
- Flow:
  1. copy template
  2. one-time Sheet `Setup` (OAuth + paste `bot_token` + Deploy once)
  3. Telegram `/start <token>` bind
  4. add rules.
- The Sheet menu is the bound Sheet's custom menu beside Help on desktop browser.

**Why.** Closest to one-stop achievable under per-copy isolation; a separate guide page keeps the README concise.

**Result.** Recorded as the T5/T7 plan; owner approved with plain HTML, bilingual text, and placeholders.

## 15. Quota-driven trigger and batching review (second grill round)

**Problem.** The 10-min default and single merged query had no quota grounding.

Too many senders could blow up query length or exceed Apps Script limits.

**Options considered.**

- Keep 10-min; move to 15-min default.
- Free-type interval vs fixed dropdown (`15/30/60min + 2/6/12hr`).
- Single merged search vs batched searches.
- Hard sender cap vs unbounded.
- 5-min trigger.
- Non-standard steps (20/25min, 45/75min, 23hr sliding).

**How AI was used.** AI looked up 2026 quotas (6 min/execution for consumer and Workspace; 90 min/day consumer trigger budget, 6 hr/day Workspace).

Per-run budgets: 10-min = 144 runs/day (`<37s` avg), 15-min = 96 runs/day (`<56s` avg), 5-min = 288 runs/day (`<18s` avg).

**Decision.**

- Default 15 min; fixed dropdown `15/30/60min + 2/6/12hr` (min 15 min, max 12 hr, no free type).
- Max 30 senders with 15 per query (max 2 searches/run); cross-batch `message_id` dedup.
- Rejected: 5-min trigger; 20/25min, 45/75min, and 23hr sliding as non-native (skip-counter logic + oversized `newer_than` windows for little latency benefit).

**Why.** Fixed native intervals need no validation or skip logic.

15-min gives headroom inside the daily budget; batching bounds query length and keeps each run to a couple of searches.

**Result.** Recorded in `CONTEXT.md` as the T3/T4 polling constraint.

## 16. Log retention vs never re-push

**Problem.**

- Keeping `Log` rows forever prevents re-push on re-add but grows the Sheet unboundedly (10 rules × 5 mails × 144 runs/day).
- Deleting on rule delete saves space but re-pushes old mail inside the `newer_than` window.

**Options considered.** Keep forever; delete-with-rule; sliding retention with auto-prune.

**How AI was used.** AI laid out the dedup-window vs audit-history trade-off and asked the owner to pick the priority.

**Decision.**

- Owner picked never-re-push first: sliding 30-day retention.
- `Rules` rows are untouched; `Log` rows (including those of deleted rules) are pruned only when older than 30 days.

**Why.** Dedup only needs to cover the `newer_than` window (minutes to hours); 30 days is ample while bounding Sheet growth.

`/export` stays out of scope.

**Result.** Recorded in `CONTEXT.md` as the `Log` retention constraint.

## 17. Rules cache as a per-key map

**Problem.** A single-blob rules cache risks single-value size limits and all-or-nothing rebuilds when a Sheet tab is deleted.

**Options considered.** Single JSON blob; one `rule_<id>` key per rule plus `rules_version`/`updated_at`; Sheet as source of truth vs Properties as source of truth.

**How AI was used.** AI explained `ScriptProperties` as a per-script KV store (like a JS `Map`, not in the Sheet or repo) and proposed per-key storage; the owner confirmed the mental model.

**Decision.**

- One `rule_<id>` key per rule + `rules_version`/`updated_at`, latest version only, overwritten on every rule change.
- Sheet stays the mirror/debug fallback; startup check rebuilds missing tables per key.

**Why.** Avoids single-value truncation, makes rebuilds granular, and keeps the Sheet as the human-readable mirror.

**Result.** Recorded in `CONTEXT.md` under `ScriptProperties` and file-deletion mitigation.

## 18. Send-failure fallback, idempotent Setup, and digest mute

**Problem.** Second grill round surfaced three gaps:

- Telegram send failure = silent death (error push uses the same broken channel).
- Re-running `Setup` could duplicate triggers or break binding.
- Uncapped digests with no quiet hours could buzz at night.

**Options considered.**

- Sheet `Runs` + `last_error` with re-push on next success vs no fallback.
- `getMe` token validation vs none.
- Stop-after-N-failures vs retry forever.
- Idempotent `Setup` (`Already set up`) vs run-once assumption.
- Digest caps/quiet hours vs user-side mute.

**How AI was used.** AI proposed each fallback and asked the owner to approve.

The owner approved the fallback/idempotence items and dismissed caps/quiet hours.

**Decision.**

- Send failures are logged to `Runs` + `last_error` in Properties, re-pushed on the next successful send, with retry stopped after N consecutive failures and `getMe` validation in `Setup`.
- `Setup` is idempotent: no duplicate triggers, no owner overwrite, no secret rotation.
- Digest stays uncapped with no quiet hours; the owner mutes the phone.

**Why.** There is no external fallback under per-copy isolation, so the Sheet plus next-success re-push is the cheapest reliable signal.

Idempotence prevents double polling and broken bindings at negligible cost.

**Result.** Recorded in `CONTEXT.md` as T4/T5 constraints.

## 19. One bot listening to multiple Gmail accounts

**Problem.** Whether one deployment / one Telegram bot can listen to several Gmail accounts sharing the same rules (one ruleset, merged or shared digest).

**Options considered.**

- Single deployment reading N mailboxes via `GmailApp` or Gmail API under the owner's identity.
- N deployments sharing one bot token.
- Single deployment holding N OAuth refresh tokens and polling the Gmail REST API per account (multi-OAuth).
- Service account with domain-wide delegation.
- Central backend with Postgres and a single bot.
- Isolation-preserving workarounds (filtered forwarding into the primary mailbox; one copy + one bot per mailbox).

**How AI was used.** AI checked current platform facts:

- `GmailApp` and the Gmail API under one OAuth identity only see the script owner's mailbox; Gmail UI delegation does not grant API access, and consumer `gmail.com` has no domain-wide-delegation path.
- Telegram supports only one webhook URL per bot token, so a second `setWebhook` overwrites the first and breaks inbound rule management.
- AI costed multi-poll against the consumer trigger budget and property-store limits.

**Decision.**

- Rejected as a core feature. The locked shape stays `1 copy : 1 Gmail : 1 bot`.
- Multi-mailbox stays workaround-only (filtered forward, or N copies + N bots with separate digests) and out of T3–T5 scope.
- The owner confirmed security is the top priority, which rules out the central-backend and shared-secret-store variants.

**Why.** Three independent blockers, not one missing function:

1. Google identity — one execution identity sees one mailbox, so "just switch API" changes nothing without per-account OAuth grants.
2. Telegram inbound — outbound `sendMessage` can share a token, but inbound management cannot, so N scripts cannot share one bot UI.
3. Security — centralizing mail and LLM keys downgrades the guarantee from technical (author cannot see them under per-copy isolation) to policy-based (host promises not to look), which the owner rejected.

Multi-OAuth additionally multiplies runtime against the per-execution and daily trigger budgets and the `ScriptProperties` size limits.

**Result.**

- No schema change (`Rules`/`Log` gain no `account` column), no headless-watcher mode, no `Setup`/`transfer`/`connect` redesign.
- Multi-account remains documentable as a workaround only.

## 20. T3 core locked through grill (thread collapse, body guarantee, caps)

**Problem.** T3 `Code.gs` core had five gaps before coding: thread vs message counting (reply quotes cause double-match); body-only keywords missed if subject/snippet filters; Amazon-scale senders blowing per-run quota; >30 senders; digest link shape.

**Options considered.** Per-thread one line vs per-message lines; strict (subject/snippet must hit before body read) vs loose (sender match = candidate, always read body); cap 10 vs 20 vs uncapped; block 31st rule at entry vs truncate at poll time; thread link vs message link; `newer_than` in `h` vs `m`.

**How AI was used.** `grill-me` interview forced the trade-offs; owner asked the two load-bearing counter-questions (delete-quote reply; high-volume sender).

**Decision.**

- Match per-message (`From` `<email>`, own sent ignored), display collapsed per-thread: one digest line per thread, union keywords, newest subject/date/link.
- Loose body: sender match = candidate, always `getPlainBody()`; subject/snippet display-only; `Log` `message_id` check before body read.
- Cap 20 threads/run (overflow covered by 2x overlap next run).
- Max 30 senders enforced at rule entry (T5); T3 defensive truncate + `Runs` error.
- Digest line adds date + thread link (`.../#inbox/{threadId}`).
- `newer_than:{2×interval}` in `m` unit (e.g. 15min→`30m`).

**Why.** Per-message match avoids false positives on own replies (including delete-quote case) while per-thread display avoids quote-duplicate spam; loose body guarantees no miss on body-only keywords; entry-time cap keeps T3 simple with a safe fallback; 20-cap fits the 6-min execution budget.

**Result.** Recorded in `CONTEXT.md` as T3 polling/notify constraints; T3 code not yet implemented (owner hold).

## 21. T3-a core helpers implemented (Code.gs, no send)

**Problem.** Start T3 `Code.gs` core in small verifiable slices without pulling in T4 (trigger/send) or T5 (Telegram UX) scope.

**Options considered.** One-shot full core vs sliced delivery (helpers → polling → digest); root `Code.gs` vs `src/` folder; hardcoded interval vs Properties-read interval.

**How AI was used.** AI proposed the slice breakdown and scope questions; the owner decided: core without send (Log/Runs writes stay, `sendMessage` deferred to T4/T5), `src/` folder, helpers-first slice, interval from `ScriptProperties` with 15-min fallback.

**Decision.**

- Created `src/Code.gs` with T3-a only: `ensureSchema()` (idempotent, hides `Rules`/`Log`/`Runs`, no example row), normalization (`normalizeText`, `extractEmail`, `normalizeSenderEmail`, `isEmailSender`), sender matching (`senderMatches`: domain-contains, email-exact after `+tag` strip), keyword parsing/matching (`parseKeywords`, `matchKeywordsInText`, `buildNormalizedHaystack`), interval helpers (`getPollIntervalMinutes` with `[15,30,60,120,360,720]` allowlist fallback, `getNewerThanMinutes` = 2x).
- Deferred to later slices: Gmail search/batching/dedup (T3-b), digest assembly + `Log`/`Runs` writes + 30-day prune (T3-c), Telegram send + trigger options (T4/T5).

**Why.** Helpers are pure logic verifiable by reading against `CONTEXT.md` with no Gmail/Telegram dependency; interval allowlist keeps T3 defensive while T4 owns the dropdown.

**Result.** T3-a done, untested by AI per project rule (owner verifies); awaiting owner confirmation before T3-b.

## 22. Minimal-permission manifest planned

**Problem.** The project's OAuth scopes needed a least-privilege decision before any code uses Gmail/triggers/URL-fetch.

**Options considered.** Default vs standard GCP project; full `spreadsheets` scope vs `spreadsheets.currentonly`; declaring all scopes upfront vs incrementally.

**How AI was used.** `grill-me` review of the permission plan; owner confirmed `Asia/Hong_Kong`, `gmail.readonly`, and default-GCP answers.

**Decision.**

- Manifest locked to 5 scopes (`spreadsheets.currentonly`, `gmail.readonly`, `script.storage`, `script.scriptapp`, `script.external_request`), declared upfront (fail-closed); default GCP project pinned; no editors on script/Sheet.
- Residual risk accepted: `gmail.readonly` technically reads the whole mailbox (no narrower scope exists); mitigation stays code-level per existing polling constraints.

**Why.** Upfront minimal scopes avoid repeated re-auth and silent privilege growth.

**Result.** Manifest plan recorded; T3-d implementation awaits owner approval.

## 23. Gmail query sender sanitization

**Problem.** Rule senders are concatenated into `from:{...}` queries; a malformed sender (space, `}`, quote, Gmail operator) could break the whole batch of 15 or skew results.

**Options considered.** No validation (T5 entry check only); blocklist-escaping special chars; quoting each sender; strict allowlist + skip.

**How AI was used.** Owner asked whether query injection defense is needed; AI analyzed the threat model (single-owner DM-only input under per-copy isolation: no external attacker, risk is an owner typo breaking their own batch) and the query construction in `src/Code.gs`.

**Decision.** Owner chose skip + `Runs` count: T3 validates sender shape (domain or full email allowlist, ASCII), excludes invalid senders from queries and candidate matching, and counts them in the `Runs` error string. `newer_than` stays numeric-only via `parseInt`. T5 entry validation remains the primary check; T3 is the defensive fallback (same pattern as the >30 truncate).

**Why.** Blocklist escaping and quoting risk changing Gmail match semantics; allowlist-skip keeps queries safe by construction, isolates one bad row, and leaves an auditable count instead of silent loss.

**Result.** Recorded in `CONTEXT.md` polling/T3-b constraints; sanitization slice pending on top of the T3-b base.

## 24. Reusable T3 acceptance tests (checklist + runner)

**Problem.** T3 had code but no repeatable way to verify it; re-running
from memory risked missed or mistaken steps.

**Options considered.** Markdown checklist only; temporary `Test.gs`
runner only; local Node automation; both checklist + runner.

**How AI was used.** AI confirmed local automation only covers pure
helpers (`normalizeText`, `senderMatches`, …) — anything touching
`SpreadsheetApp`/`GmailApp`/`PropertiesService` needs the bound
environment, so mocking it locally buys little for the maintenance cost.

**Decision.** Owner chose both, one file per milestone (T3 vs T4 split,
not per subtask):

- `test/TESTING.md` (English, in-repo): the master flow — prep with exact
  `Rules` rows and a second-account test-mail recipe (real `From` headers
  cannot be forged, so a `gmail.com` + full-email rule pair on one mail
  exercises contains/exact/union), per-subtask boxes with expected results,
  ordered cleanup. T4–T8 reserved as placeholders.
- `test/TestT3.gs`: one `runAllT3Checks()` pasted into the editor as a
  temporary file, run once, deleted after; `PASS/FAIL/SKIP` lines map 1:1
  to the checklist, with `SKIP` (not fail) for prep-dependent checks on the
  720-fallback path. Expected writes (`Log`/`Runs`, prune dummy) are part
  of the design and removed in Cleanup. Never shipped in the template
  (`test/` is not pushed to Apps Script).

**Why.** The checklist removes memory dependence (every manual click
spelled out); the runner removes per-function manual runs (the editor Run
button takes no arguments and hides bare returns). One file per milestone
keeps each pass one-paste-one-run — splitting per subtask would multiply
steps and miss risk.

**Result.** T3 verifiable in one repeatable pass; the same pattern applies
to T4+ runners later.
