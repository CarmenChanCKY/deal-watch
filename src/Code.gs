/**
 * Deal Watch — T3 core (bound Apps Script).
 *
 * Scope (per user-confirmed T3 slices):
 * - T3-a: ensureSchema() + normalization + sender/keyword matching + interval helper.
 * - T3-b: polling + per-message match (no digest, no Log/Runs writes, no send).
 * - T3-c: digest collapse + digest string + Log/Runs writes + 30-day prune (no send).
 * - T4-a: trigger management (ensureTrigger + setPollIntervalMinutes).
 * - T4-b: one merged send + last_error + stop-after-3 (runWatchAndNotify).
 * - T5-a/b: doPost router + Setup/bind/transfer/connect (see inbound section).
 * - T5-c: rule CRUD (/add flow, /list pages, detail inline buttons).
 * - T5-d: interval/status/help + setMyCommands menu.
 * - T6-a: OpenRouter key/model storage + validation (helpers; see T6-i for entry).
 * - T6-b: OpenRouter suggestion client (seed-only prompt, parse, cache, call).
 * - T6-c: keyword ideas ([Need ideas?] opens Mini App Ideas; topic_hint on confirm).
 * - T6-d: Mini App plumbing (bot-issued open token + doGet HTML route + smoke).
 * - T6-i: single /setai opens Mini App Settings; legacy inline pickers removed.
 *
 * Conventions follow CONTEXT.md:
 * - Rules: id | sender | keywords (OR, comma) | enabled | topic_hint | updated_at
 * - Sender is a domain (no "@") or a full email (has "@").
 * - Keywords: OR, case-insensitive normalized substring (lower/trim/full-half-width).
 *   "quoted" spans are exact phrases (matched as normalized substrings).
 * - Gmail dot handling is out of scope (no dot normalization).
 */

// ---------------------------------------------------------------------------
// Constants (locked constraints from CONTEXT.md)
// ---------------------------------------------------------------------------

// sheet name
const SHEET_RULES = 'Rules';
const SHEET_LOG = 'Log';
const SHEET_RUNS = 'Runs';

// Canonical display time zone; script (appsscript.json) and spreadsheet must agree.
const SPREADSHEET_TIME_ZONE = 'Asia/Hong_Kong';

// sheet header list
const HEADERS_RULES = ['id', 'sender', 'keywords', 'enabled', 'topic_hint', 'updated_at'];
const HEADERS_LOG = ['timestamp', 'message_id', 'sender', 'matched_keywords', 'subject', 'status'];
const HEADERS_RUNS = ['start', 'end', 'found', 'sent', 'error'];

const DEFAULT_INTERVAL_MINUTES = 15;
const ALLOWED_INTERVAL_MINUTES = [15, 30, 60, 120, 360, 720];

const MAX_SENDERS = 30;
const SENDERS_PER_QUERY = 15;
const MAX_THREADS_PER_RUN = 20;
const LOG_RETENTION_DAYS = 30;

const PROP_POLL_INTERVAL = 'poll_interval_minutes';

const PROP_BOT_TOKEN = 'bot_token';
const PROP_OWNER_CHAT_ID = 'owner_chat_id';
const PROP_LAST_ERROR = 'last_error';
const PROP_CONSECUTIVE_FAILURES = 'consecutive_send_failures';

// T6 — OpenRouter suggestion fence (optional; disabled cleanly when blank).
// Only the seed is ever sent; never email content, matching, or rule writes.
const PROP_OPENROUTER_KEY = 'openrouter_key';
const PROP_LLM_MODEL = 'llm_model';
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
// T6-b suggestion client: one call per request, seed-only, cached (~6h).
const SUGGESTION_COUNT = 5;
const SUGGEST_CACHE_TTL_SECONDS = 21600;
// Always cap completion length — keyword lists are short and this bounds cost.
const SUGGESTION_MAX_TOKENS = 300;

// T6-d Mini App: the bot sends a one-tap web_app button whose URL carries a
// token bound to the owner chat. Apps Script cannot read Telegram initData
// (launch params sit in the top-level URL, not the served iframe), so this
// token is the auth substitute: TTL counts from button mint, reusable within
// it, and re-checked on every google.script.run call.
const APP_TOKEN_TTL_SECONDS = 7200;
const APP_TOKEN_CACHE_PREFIX = 'app_tok_';
const APP_PARAM_APP = 'app';
const APP_PARAM_TOKEN = 't';
const APP_SMOKE = 'smoke';
const MINI_APP_TITLE = 'Deal Watch';
// Apps Script ignores meta tags in the HTML file, so the viewport is injected
// via HtmlOutput.addMetaTag (the only meta tags Apps Script allows).
const MINI_APP_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';
// Cap the model list the Mini App renders in one search result (long-list UI
// polish is deferred to T6-k); the search box narrows before hitting this.
const MINI_APP_MODEL_RESULT_MAX = 30;
// Mini App views. The ?app= query param selects which view the page renders.
const MINI_APP_VIEW_IDEAS = 'ideas';
const MINI_APP_VIEW_SETTINGS = 'settings';

// T6-e model metadata: one slim cache key (CacheService) shared by the picker
// and the suggestion call (reasoning-off decision). ~30KB, best-effort.
const MODEL_META_CACHE_KEY = 'model_meta';
const MODEL_META_CACHE_TTL_SECONDS = 21600;
// Dynamic router pseudo-models (openrouter/auto, openrouter/free, …) pick the
// real model at random per request — hidden because latency/quality are unknown.
const MODEL_ROUTER_PREFIX = 'openrouter/';
const MODEL_REASONING_MANDATORY = 'mandatory';
const MODEL_REASONING_OPTIONAL = 'optional';
const MODEL_REASONING_NONE = 'none';

const MAX_CONSECUTIVE_FAILURES = 3;
const TELEGRAM_MAX_TEXT = 4000;
const TELEGRAM_TRUNCATE_RESERVE = 20;
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;
const DEBUG_TRUNCATE_LEN = 200;
const ERROR_ENTRY_MAX_LEN = 500;
const ALERT_TRUNCATE_LEN = 300;

const UNICODE_FULLWIDTH_SPACE = 0x3000;
const UNICODE_FULLWIDTH_START = 0xFF01;
const UNICODE_FULLWIDTH_END = 0xFF5E;
const UNICODE_FULLWIDTH_OFFSET = 0xFEE0;

const SENDER_MAX_LEN = 254;
const INVALID_SAMPLE_MAX = 3;

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86400000;
const LOCK_WAIT_MS = 5000;
const TOKEN_MIN_LEN = 20;
const SETUP_TOKEN_LEN = 32;

// ---------------------------------------------------------------------------
// Shared Util (pure, no IO; Telegram fetch/redact/truncate/error centralised)
// ---------------------------------------------------------------------------

/**
 * Trim helper — pure, Never throws.
 */
function trim_(v) {
  if (v === null || v === undefined) {
    return '';
  }
  return String(v).replace(/^\s+|\s+$/g, '');
}

/**
 * Build a Telegram Bot API URL — pure, Never throws.
 */
function telegramApiUrl_(token, method) {
  return TELEGRAM_API_BASE + token + '/' + method;
}

/**
 * Redact secrets from an error string — pure, Never throws.
 */
function redactToken_(text, token, secret) {
  let out = String(text === null || text === undefined ? '' : text);
  if (token) {
    out = out.split(token).join('[redacted]');
  }
  if (secret) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Truncate debug/error detail to a safe length — pure, Never throws.
 */
function truncateDebug_(s) {
  return String(s === null || s === undefined ? '' : s).substring(0, DEBUG_TRUNCATE_LEN);
}

/**
 * Map an HTTP code + Telegram body to a send error string — pure, Never throws.
 * Returns '' when the body reports ok:true; otherwise English, no secrets.
 */
function mapSendError_(code, bodyText) {
  if (code < HTTP_OK_MIN || code >= HTTP_OK_MAX) {
    return 'Telegram HTTP ' + code + '.';
  }
  try {
    const data = JSON.parse(bodyText);
    if (data && data.ok === true) {
      return '';
    }
    const desc = data && data.description ? String(data.description) : 'unknown error';
    return 'Telegram rejected send: ' + truncateDebug_(desc);
  } catch (e) {
    return 'Telegram bad response (HTTP ' + code + ').';
  }
}

/**
 * Extract result.message_id from a Telegram sendMessage body — pure, Never throws.
 * Returns '' when the id is missing so callers can fall back to a fresh send.
 */
function extractMessageId_(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data && data.ok === true && data.result && data.result.message_id !== undefined) {
      return data.result.message_id;
    }
  } catch (e) {
    // Best-effort parse; a missing id just means nothing to edit later.
  }
  return '';
}

/**
 * Describe a callback/edit Telegram result — pure, Never throws.
 */
function describeCallbackResult_(code, bodyText) {
  let desc = 'http=' + code;
  try {
    const data = JSON.parse(bodyText);
    if (data && data.ok === true) {
      return { ok: true, desc: 'ok' };
    }
    desc = data && data.description ? String(data.description).substring(0, DEBUG_TRUNCATE_LEN) : desc;
  } catch (e2) {
    // Keep default desc; best-effort parse only.
  }
  return { ok: false, desc: desc };
}

/**
 * Find a column index by header name — pure, Never throws.
 */
function getColumnIndex_(headers, name, fallback) {
  try {
    const want = trim_(name).toLowerCase();
    for (let c = 0; c < headers.length; c++) {
      if (trim_(headers[c]).toLowerCase() === want) {
        return c;
      }
    }
  } catch (e) {
    // Fall through to fallback; header scan must never throw.
  }
  return fallback;
}

/**
 * Resolve Runs sent/error column indexes — pure, Never throws.
 */
function getRunsHeaderIndex_(headers) {
  return {
    sentIdx: getColumnIndex_(headers, 'sent', HEADERS_RUNS.length - 2),
    errIdx: getColumnIndex_(headers, 'error', HEADERS_RUNS.length - 1)
  };
}

/**
 * True when a Sheet cell value is a Date object — pure, Never throws.
 */
function isSheetDate_(v) {
  return v instanceof Date;
}

/**
 * Format a Sheet cell stamp for display — pure, Never throws.
 */
function formatSheetStamp_(v) {
  if (isSheetDate_(v)) {
    return formatRunDate_(v);
  }
  if (v === null || v === undefined) {
    return ''; // Blank cell has no stamp to show.
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SHEET_HOME = 'Home';

/**
 * Idempotent schema provisioning: creates Rules/Log/Runs with headers when
 * missing, then hides them. Never writes example rows; never overwrites data.
 * Also aligns the spreadsheet time zone with Config (display-only, data kept).
 * Safe to call on every startup (open trigger / Setup rerun).
 * A visible Home sheet is kept because Sheets forbids hiding every sheet.
 */
function ensureSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSpreadsheetTimeZone_(ss);
  ensureSheetWithHeaders_(ss, SHEET_RULES, HEADERS_RULES);
  ensureSheetWithHeaders_(ss, SHEET_LOG, HEADERS_LOG);
  ensureSheetWithHeaders_(ss, SHEET_RUNS, HEADERS_RUNS);
  ensureVisibleFrontSheet_(ss);
  hideSheetIfOthersVisible_(ss, SHEET_RULES);
  hideSheetIfOthersVisible_(ss, SHEET_LOG);
  hideSheetIfOthersVisible_(ss, SHEET_RUNS);
}

/**
 * True when the spreadsheet time zone already matches Config — Never throws.
 */
function isTimeZoneAligned_(ss) {
  try {
    return !!ss && ss.getSpreadsheetTimeZone() === SPREADSHEET_TIME_ZONE;
  } catch (e) {
    return true; // Unreadable state; stay a silent no-op rather than risk a write.
  }
}

/**
 * Align the spreadsheet time zone with Config — best-effort, Never throws.
 */
function ensureSpreadsheetTimeZone_(ss) {
  if (isTimeZoneAligned_(ss)) {
    return; // Already aligned or unreadable; silent no-op.
  }
  try {
    ss.setSpreadsheetTimeZone(SPREADSHEET_TIME_ZONE);
  } catch (e) {
    // Best-effort only; per-call formatting still falls back to the script time zone.
  }
}

/**
 * Ensure one sheet exists with headers — Never throws (Sheet IO guarded by callers).
 */
function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * Sheets rejects hiding the last visible sheet, so keep one front sheet
 * visible. Created once with a short pointer; never overwritten.
 */
function ensureVisibleFrontSheet_(ss) {
  const sheets = ss.getSheets();
  let visibleCount = 0;
  for (let i = 0; i < sheets.length; i++) {
    try {
      if (!sheets[i].isSheetHidden()) {
        visibleCount++;
      }
    } catch (e) {
      visibleCount++;
    }
  }
  if (visibleCount > 0) {
    return;
  }
  let home = ss.getSheetByName(SHEET_HOME);
  if (!home) {
    home = ss.insertSheet(SHEET_HOME);
  }
  try {
    if (!home.isSheetHidden()) {
      // already visible
    } else {
      home.showSheet();
    }
  } catch (e) {
    // Ignore; hiding phase below will no-op if nothing is visible.
  }
  try {
    if (home.getLastRow() === 0) {
      home.getRange(1, 1, 2, 1).setValues([
        ['Deal Watch — manage everything from Telegram.'],
        ['Run Deal Watch > Setup once, then bind your bot with /start <token>. Rules/Log/Runs stay hidden.']
      ]);
    }
    ss.setActiveSheet(home);
  } catch (e) {
    // Content is cosmetic; schema is already provisioned.
  }
}

/**
 * Hide one DB sheet, but never hide the last visible sheet.
 */
function hideSheetIfOthersVisible_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    return;
  }
  let hidden = false;
  try {
    hidden = sheet.isSheetHidden();
  } catch (e) {
    return;
  }
  if (hidden) {
    return;
  }
  const sheets = ss.getSheets();
  let visibleCount = 0;
  for (let i = 0; i < sheets.length; i++) {
    try {
      if (!sheets[i].isSheetHidden()) {
        visibleCount++;
      }
    } catch (e) {
      visibleCount++;
    }
  }
  // Keep the DB out of the daily UI; users manage rules via Telegram only.
  if (visibleCount > 1) {
    sheet.hideSheet();
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize free text for keyword matching:
 * full-half-width (full-width ASCII + full-width space) -> half-width,
 * then lower-case + trim. Chinese characters pass through unchanged.
 */
function normalizeText(s) {
  if (s === null || s === undefined) {
    return '';
  }
  const out = String(s);
  let converted = '';
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);

    if (code === UNICODE_FULLWIDTH_SPACE) {
      // Full-width space
      // change to half-width space
      converted += ' ';
    } else if (code >= UNICODE_FULLWIDTH_START && code <= UNICODE_FULLWIDTH_END) {
      // Full-width character
      // change to half-width character
      converted += String.fromCharCode(code - UNICODE_FULLWIDTH_OFFSET);
    } else {
      converted += out.charAt(i);
    }
  }
  return trim_(converted.toLowerCase());
}

/**
 * Extract a bare email from a Gmail From header.
 * "Promo Name <abc@xxx.com>" -> "abc@xxx.com"; bare address passes through.
 */
function extractEmail(fromHeader) {
  if (fromHeader === null || fromHeader === undefined) {
    return '';
  }
  const s = String(fromHeader);
  const m = s.match(/<([^<>]+)>/);
  const candidate = m ? m[1] : s;
  return trim_(candidate);
}

/**
 * Normalize a sender email: lower + trim + strip "+tag" from the local part.
 * Example: "Abc+sale@XXX.com" -> "abc@xxx.com".
 * Gmail dot handling is out of scope (dots are left untouched).
 */
function normalizeSenderEmail(email) {
  let s = String(email === null || email === undefined ? '' : email);
  s = trim_(s).toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 0) {
    return s;
  }
  let local = s.substring(0, at);
  const domain = s.substring(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) {
    local = local.substring(0, plus);
  }
  return local + '@' + domain;
}

/**
 * True when the rule sender is a full email (contains "@"), false for domain.
 */
function isEmailSender(ruleSender) {
  return String(ruleSender || '').indexOf('@') >= 0;
}

// ---------------------------------------------------------------------------
// Sender matching
// ---------------------------------------------------------------------------

/**
 * Match a rule sender against a message From header.
 * - Domain sender: normalized "contains" on the full normalized From address.
 * - Email sender: exact match after normalizeSenderEmail on both sides.
 * Callers pass the raw From header; extraction + normalization happen here.
 */
function senderMatches(ruleSender, fromHeader) {
  const rule = trim_(ruleSender).toLowerCase();
  if (!rule) {
    return false;
  }
  const fromEmail = normalizeSenderEmail(extractEmail(fromHeader));
  if (!fromEmail) {
    return false;
  }
  if (isEmailSender(rule)) {
    return normalizeSenderEmail(rule) === fromEmail;
  }
  return fromEmail.indexOf(rule) !== -1;
}

// ---------------------------------------------------------------------------
// Keyword parsing + matching
// ---------------------------------------------------------------------------

/**
 * Parse a rule keywords cell ("a, b, \"c d\"") into match entries.
 * Returns [{ display, text, isPhrase }]:
 * - display: trimmed original item (for digest/Log echo).
 * - text: normalized match key ("" quotes stripped, then normalizeText).
 * - isPhrase: true when the item was double-quoted.
 * Empty items are dropped.
 */
function parseKeywords(raw) {
  if (raw === null || raw === undefined) {
    return [];
  }
  const parts = String(raw).split(',');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const item = trim_(parts[i]);
    if (!item) {
      continue;
    }
    const isPhrase = item.length >= 2 && item.charAt(0) === '"' && item.charAt(item.length - 1) === '"';
    const inner = isPhrase ? item.substring(1, item.length - 1) : item;
    const text = normalizeText(inner);
    if (!text) {
      continue;
    }
    out.push({ display: item, text: text, isPhrase: isPhrase });
  }
  return out;
}

/**
 * OR-match parsed keywords against an already-normalized haystack.
 * Returns the subset of entries that hit (preserves parse order).
 */
function matchKeywordsInText(normalizedHaystack, parsedKeywords) {
  const hits = [];
  if (!normalizedHaystack || !parsedKeywords) {
    return hits;
  }
  for (let i = 0; i < parsedKeywords.length; i++) {
    const kw = parsedKeywords[i];
    if (kw && kw.text && normalizedHaystack.indexOf(kw.text) !== -1) {
      hits.push(kw);
    }
  }
  return hits;
}

/**
 * Build the normalized match surface from subject + plain body.
 * Subject/snippet are display-only elsewhere; matching always sees the body.
 */
function buildNormalizedHaystack(subject, plainBody) {
  const s = subject === null || subject === undefined ? '' : String(subject);
  const b = plainBody === null || plainBody === undefined ? '' : String(plainBody);
  return normalizeText(s + '\n' + b);
}

// ---------------------------------------------------------------------------
// Interval (T4 owns trigger options; T3 only reads the value defensively)
// ---------------------------------------------------------------------------

/**
 * Poll interval in minutes for newer_than:{2x} overlap math.
 * Reads ScriptProperties "poll_interval_minutes"; any missing/invalid value
 * outside the fixed set [15,30,60,120,360,720] falls back to 15.
 */
function getPollIntervalMinutes() {
  const fallback = DEFAULT_INTERVAL_MINUTES;
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PROP_POLL_INTERVAL);
    if (raw === null || raw === undefined || raw === '') {
      return fallback;
    }
    const n = parseInt(trim_(raw), 10);
    for (let i = 0; i < ALLOWED_INTERVAL_MINUTES.length; i++) {
      if (n === ALLOWED_INTERVAL_MINUTES[i]) {
        return n;
      }
    }
    return fallback;
  } catch (e) {
    return fallback;
  }
}

/**
 * Overlap window for Gmail newer_than, in minutes: always 2x the interval.
 * Callers format it with the "m" unit (e.g. 15min -> "30m").
 */
function getNewerThanMinutes() {
  return getPollIntervalMinutes() * 2;
}

// ---------------------------------------------------------------------------
// T3-b: polling + per-message match (no digest, no Log/Runs writes, no send)
// ---------------------------------------------------------------------------
//
// Locked order per CONTEXT.md:
// - Load enabled rules; batched from:{...} (15/query, max 2 searches/run,
//   newer_than:{2x}m); cross-batch message_id dedup; Log message_id check
//   before getPlainBody(); sender match = candidate (always read body for
//   candidates, subject is display-only); own sent ignored; 20-thread cap;
//   >30 senders truncate + invalid-sender skip, both counted in Runs error
//   string (T3-c writes it).
//
// T3-c owns: per-thread collapse, digest string, Log/Runs writes, 30-day prune.

/**
 * True for enabled rule rows. Sheet checkboxes give boolean true/false;
 * accept common truthy spellings defensively, everything else is disabled.
 */
function isRuleEnabled_(value) {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === 'number') {
    return false;
  }
  if (typeof value === 'string') {
    const s = trim_(value).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  }
  return false;
}

/**
 * Allowlist sender shape check (Gmail query sanitization, see CONTEXT.md).
 * Valid = ASCII domain ("xxx.com") or full email ("abc@xxx.com"); anything
 * with whitespace, Gmail grouping/quoting chars, or operator shapes is invalid.
 * Invalid senders are skipped (never reach from:{...} or candidate matching)
 * and counted in the Runs error string. IDN/non-ASCII senders are out of scope.
 */
function isValidSender_(sender) {
  const s = trim_(sender);
  if (!s || s.length > SENDER_MAX_LEN) {
    return false;
  }
  if (/\s/.test(s)) {
    return false;
  }
  if (/[{}\(\)\"'<>]/.test(s)) {
    return false;
  }
  if (s.charAt(0) === '-') {
    return false;
  }
  if (isEmailSender(s)) {
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
  }
  return /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
}

/**
 * Runs error fragment for skipped invalid senders ("" when none).
 * Sender values are not secrets, so up to 3 samples are echoed for debugging.
 */
function formatInvalidSenderError_(invalidSkipped, invalidSamples) {
  if (!(invalidSkipped > 0)) {
    return '';
  }
  let msg = 'Skipped ' + invalidSkipped + ' invalid ' + (invalidSkipped === 1 ? 'sender' : 'senders');
  if (invalidSamples && invalidSamples.length) {
    msg += ' (e.g. "' + invalidSamples.join('", "') + '")';
  }
  return msg + ': sender must be a domain or full email.';
}

/**
 * Load enabled rules in sheet order.
 * Skips rows with empty sender, disabled flag, or zero parsed keywords
 * (no match surface). Returns [{ id, sender, keywordsRaw, keywords, topicHint }].
 */
function loadEnabledRules() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
  if (!sheet) {
    return [];
  }
  const values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) {
    return [];
  }
  const headers = values[0];
  const colIndex = {};
  for (let c = 0; c < headers.length; c++) {
    const key = trim_(headers[c]).toLowerCase();
    if (!(key in colIndex)) {
      colIndex[key] = c;
    }
  }
  if (colIndex['sender'] === undefined || colIndex['keywords'] === undefined || colIndex['enabled'] === undefined) {
    return [];
  }
  const idIdx = colIndex['id'];
  const senderIdx = colIndex['sender'];
  const keywordsIdx = colIndex['keywords'];
  const enabledIdx = colIndex['enabled'];
  const topicIdx = colIndex['topic_hint'];
  const rules = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!isRuleEnabled_(row[enabledIdx])) {
      continue;
    }
    const sender = trim_(row[senderIdx]);
    if (!sender) {
      continue;
    }
    const keywordsRaw = String(row[keywordsIdx] === null || row[keywordsIdx] === undefined ? '' : row[keywordsIdx]);
    const keywords = parseKeywords(keywordsRaw);
    if (!keywords.length) {
      continue;
    }
    rules.push({
      id: idIdx === undefined ? '' : String(row[idIdx]),
      sender: sender,
      keywordsRaw: keywordsRaw,
      keywords: keywords,
      topicHint: topicIdx === undefined ? '' : String(row[topicIdx] === null || row[topicIdx] === undefined ? '' : row[topicIdx])
    });
  }
  return rules;
}

/**
 * Build batched Gmail queries for enabled rules (pure, no Gmail calls).
 * - Dedups senders case-insensitively, preserves first-seen order.
 * - Skips invalid sender shapes (see isValidSender_); skipped count + samples
 *   are returned so T3-c can count them in the Runs error.
 * - Truncates valid senders to MAX_SENDERS (30); truncated=true signals T3-c
 *   to write Runs error.
 * - Batches of SENDERS_PER_QUERY (15) -> max 2 queries.
 * - Each query: "from:{a b c} newer_than:{N}m" (search filters sender+time only;
 *   keyword checks run in script so body-only keywords are never missed).
 * Returns { queries, truncated, totalSenders, validSenders, usedSenders,
 *   invalidSkipped, invalidSamples }. totalSenders = distinct senders loaded
 *   (incl. invalid); validSenders = distinct valid senders (pre-truncate).
 */
function buildGmailQueries(rules, newerThanMinutes) {
  const empty = { queries: [], truncated: false, totalSenders: 0, validSenders: 0, usedSenders: [], invalidSkipped: 0, invalidSamples: [] };
  if (!rules || !rules.length) {
    return empty;
  }
  let n = parseInt(String(newerThanMinutes), 10);
  if (!(n > 0)) {
    n = getNewerThanMinutes();
  }
  const seen = {};
  const unique = [];
  for (let i = 0; i < rules.length; i++) {
    const sender = trim_(rules[i].sender);
    if (!sender) {
      continue;
    }
    const key = sender.toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      unique.push(sender);
    }
  }
  if (!unique.length) {
    return empty;
  }
  const valid = [];
  const invalidSamples = [];
  let invalidSkipped = 0;
  for (let i = 0; i < unique.length; i++) {
    if (isValidSender_(unique[i])) {
      valid.push(unique[i]);
    } else {
      invalidSkipped++;
      if (invalidSamples.length < INVALID_SAMPLE_MAX) {
        invalidSamples.push(unique[i]);
      }
    }
  }
  if (!valid.length) {
    return { queries: [], truncated: false, totalSenders: unique.length, validSenders: 0, usedSenders: [], invalidSkipped: invalidSkipped, invalidSamples: invalidSamples };
  }
  const truncated = valid.length > MAX_SENDERS;
  const used = truncated ? valid.slice(0, MAX_SENDERS) : valid;
  const queries = [];
  for (let i = 0; i < used.length; i += SENDERS_PER_QUERY) {
    const batch = used.slice(i, i + SENDERS_PER_QUERY);
    queries.push('from:{' + batch.join(' ') + '} newer_than:' + n + 'm');
  }
  return { queries: queries, truncated: truncated, totalSenders: unique.length, validSenders: valid.length, usedSenders: used, invalidSkipped: invalidSkipped, invalidSamples: invalidSamples };
}

/**
 * Load all logged message_ids from the Log sheet into a Set.
 * Missing sheet or no data rows -> empty Set (defensive; ensureSchema owns creation).
 */
function loadSeenMessageIds_() {
  const seen = new Set();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if (!sheet) {
    return seen;
  }
  const values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) {
    return seen;
  }
  let msgIdx = getColumnIndex_(values[0], 'message_id', -1);
  if (msgIdx < 0) {
    return seen;
  }
  for (let r = 1; r < values.length; r++) {
    const id = trim_(values[r][msgIdx]);
    if (id) {
      seen.add(id);
    }
  }
  return seen;
}

/**
 * Owner's own email, normalized for comparison. Blank when unavailable,
 * in which case own-message filtering is disabled (never drop mail blindly).
 */
function getOwnEmail_() {
  try {
    const email = Session.getEffectiveUser().getEmail();
    if (!email) {
      return '';
    }
    return normalizeSenderEmail(email);
  } catch (e) {
    return '';
  }
}

/**
 * True when the From header belongs to the owner (own sent -> ignore).
 * Own replies must not re-match via quoted promo text.
 */
function isOwnMessage_(fromHeader, ownEmailNormalized) {
  if (!ownEmailNormalized) {
    return false;
  }
  const fromEmail = normalizeSenderEmail(extractEmail(fromHeader));
  return fromEmail !== '' && fromEmail === ownEmailNormalized;
}

/**
 * Run each batched query, merge threads with cross-batch dedup by thread id,
 * and cap at maxThreads (overflow is covered by the 2x overlap window next run).
 * Query order is preserved; each GmailApp.search returns newest-first.
 */
function searchThreadsForQueries_(queries, maxThreads) {
  const out = [];
  const seenThreadIds = {};
  const cap = maxThreads > 0 ? maxThreads : MAX_THREADS_PER_RUN;
  for (let q = 0; q < queries.length; q++) {
    const found = GmailApp.search(queries[q], 0, cap);
    for (let i = 0; i < found.length; i++) {
      const id = found[i].getId();
      if (!id || seenThreadIds[id]) {
        continue;
      }
      seenThreadIds[id] = true;
      out.push(found[i]);
      if (out.length >= cap) {
        return out;
      }
    }
  }
  return out;
}

/**
 * Find rules whose sender matches a From header — pure, Never throws.
 */
function findSenderCandidates_(rules, fromHeader) {
  const candidates = [];
  for (let r = 0; r < rules.length; r++) {
    if (!isValidSender_(rules[r].sender)) {
      continue;
    }
    if (senderMatches(rules[r].sender, fromHeader)) {
      candidates.push(rules[r]);
    }
  }
  return candidates;
}

/**
 * Match candidate rules against a normalized haystack — pure, Never throws.
 * Returns { matchedKeywords, ruleIds, senders } with keyword union dedup.
 */
function matchCandidatesInHaystack_(candidates, haystack) {
  const seenKw = {};
  const matchedKeywords = [];
  const ruleIds = [];
  const senders = [];
  for (let c = 0; c < candidates.length; c++) {
    const hits = matchKeywordsInText(haystack, candidates[c].keywords);
    if (!hits.length) {
      continue;
    }
    ruleIds.push(candidates[c].id);
    senders.push(candidates[c].sender);
    for (let h = 0; h < hits.length; h++) {
      if (seenKw[hits[h].text]) {
        continue;
      }
      seenKw[hits[h].text] = true;
      matchedKeywords.push(hits[h].display);
    }
  }
  return { matchedKeywords: matchedKeywords, ruleIds: ruleIds, senders: senders };
}

/**
 * Build one per-message match entry — pure, Never throws.
 */
function buildMatchEntry_(threadId, messageId, fromHeader, subject, date, matched) {
  return {
    threadId: threadId,
    messageId: messageId,
    from: fromHeader,
    fromEmail: normalizeSenderEmail(extractEmail(fromHeader)),
    subject: subject,
    date: date,
    matchedKeywords: matched.matchedKeywords,
    ruleIds: matched.ruleIds,
    senders: matched.senders
  };
}

/**
 * T3-b main entry: poll Gmail and return per-message matches (no writes, no send).
 * Per-message loop order (locked): Log message_id check -> own-sent ignore ->
 * sender match (candidate) -> getPlainBody + keyword match.
 * Body is read only for sender candidates; subject is match surface + display,
 * never a pre-filter (body-only keywords must not be missed).
 * Returns { matches, threadsScanned, truncated, totalSenders, invalidSkipped, error } where
 * matches[] = { threadId, messageId, from, fromEmail, subject, date,
 *   matchedKeywords (union display strings), ruleIds, senders }.
 * T3-c consumes this: per-thread collapse, digest string, Log/Runs writes.
 */
function pollNewMatches() {
  const rules = loadEnabledRules();
  if (!rules.length) {
    return { matches: [], threadsScanned: 0, truncated: false, totalSenders: 0, invalidSkipped: 0, error: '' };
  }
  const built = buildGmailQueries(rules, getNewerThanMinutes());
  if (!built.queries.length) {
    return { matches: [], threadsScanned: 0, truncated: built.truncated, totalSenders: built.totalSenders, invalidSkipped: built.invalidSkipped, error: formatInvalidSenderError_(built.invalidSkipped, built.invalidSamples) };
  }
  const threads = searchThreadsForQueries_(built.queries, MAX_THREADS_PER_RUN);
  const seenIds = loadSeenMessageIds_();
  const ownEmail = getOwnEmail_();
  const seenInRun = {};
  const matches = [];
  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t];
    const threadId = thread.getId();
    const messages = thread.getMessages();
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      const messageId = msg.getId();
      if (!messageId) {
        continue;
      }
      if (seenIds.has(messageId) || seenInRun[messageId]) {
        continue;
      }
      seenInRun[messageId] = true;
      const fromHeader = msg.getFrom();
      if (isOwnMessage_(fromHeader, ownEmail)) {
        continue;
      }
      const candidates = findSenderCandidates_(rules, fromHeader);
      if (!candidates.length) {
        continue;
      }
      const plainBody = msg.getPlainBody();
      const subject = msg.getSubject();
      const haystack = buildNormalizedHaystack(subject, plainBody);
      const matched = matchCandidatesInHaystack_(candidates, haystack);
      if (matched.matchedKeywords.length) {
        matches.push(buildMatchEntry_(threadId, messageId, fromHeader, subject, msg.getDate(), matched));
      }
    }
  }
  const errorParts = [];
  if (built.truncated) {
    errorParts.push('Truncated senders from ' + built.validSenders + ' to ' + MAX_SENDERS + ' (max enforced at rule entry; T3 defensive truncate).');
  }
  const skipError = formatInvalidSenderError_(built.invalidSkipped, built.invalidSamples);
  if (skipError) {
    errorParts.push(skipError);
  }
  return { matches: matches, threadsScanned: threads.length, truncated: built.truncated, totalSenders: built.totalSenders, invalidSkipped: built.invalidSkipped, error: errorParts.join(' ') };
}

// ---------------------------------------------------------------------------
// T3-c: digest + writes (no send; T4/T5 own Telegram send)
// ---------------------------------------------------------------------------
//
// Locked per CONTEXT.md:
// - Match per-message (T3-b), display collapsed per-thread: one digest block
//   per thread, union keywords, newest subject/date/link.
// - One digest string per run; zero matches = silence ("").
// - Log/Runs writes + 30-day Log prune here; main entry returns digest string.

/**
 * Milliseconds for date comparison. Unparseable dates sort as oldest (0).
 */
function toTime_(d) {
  try {
    const t = (d instanceof Date) ? d.getTime() : new Date(d).getTime();
    return isNaN(t) ? 0 : t;
  } catch (e) {
    return 0;
  }
}

/**
 * Create one empty per-thread group — pure, Never throws.
 */
function newThreadGroup_(m) {
  return {
    threadId: m.threadId,
    subject: m.subject,
    date: m.date,
    fromEmail: m.fromEmail,
    matchedKeywords: [],
    keywordSeen: {},
    senders: [],
    senderSeen: {},
    messageCount: 0
  };
}

/**
 * Merge one message into its thread group — pure, Never throws.
 */
function mergeMessageIntoGroup_(g, m) {
  g.messageCount++;
  if (toTime_(m.date) >= toTime_(g.date)) {
    g.subject = m.subject;
    g.date = m.date;
    g.fromEmail = m.fromEmail;
  }
  const kws = m.matchedKeywords || [];
  for (let k = 0; k < kws.length; k++) {
    const key = normalizeText(kws[k]);
    if (!key || g.keywordSeen[key]) {
      continue;
    }
    g.keywordSeen[key] = true;
    g.matchedKeywords.push(kws[k]);
  }
  const snd = m.senders || [];
  for (let s = 0; s < snd.length; s++) {
    const sKey = trim_(snd[s]).toLowerCase();
    if (!sKey || g.senderSeen[sKey]) {
      continue;
    }
    g.senderSeen[sKey] = true;
    g.senders.push(snd[s]);
  }
}

/**
 * Collapse per-message matches into per-thread groups (pure, no IO).
 * Preserves first-seen thread order. Each group:
 * { threadId, subject, date, fromEmail, matchedKeywords, senders, messageCount }
 * - matchedKeywords: union across messages/rules, first-seen order, deduped
 *   case-insensitively on the normalized form (display keeps first spelling).
 * - subject/date/fromEmail: from the newest message in the thread.
 * - senders: union of rule sender strings that matched in this thread.
 */
function collapseMatchesByThread(matches) {
  const groups = {};
  const order = [];
  if (!matches || !matches.length) {
    return [];
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || !m.threadId) {
      continue;
    }
    let g = groups[m.threadId];
    if (!g) {
      g = newThreadGroup_(m);
      groups[m.threadId] = g;
      order.push(m.threadId);
    }
    mergeMessageIntoGroup_(g, m);
  }
  const out = [];
  for (let i = 0; i < order.length; i++) {
    const g = groups[order[i]];
    out.push({
      threadId: g.threadId,
      subject: g.subject,
      date: g.date,
      fromEmail: g.fromEmail,
      matchedKeywords: g.matchedKeywords,
      senders: g.senders,
      messageCount: g.messageCount
    });
  }
  return out;
}

/**
 * Gmail thread link for digest display.
 */
function buildThreadLink_(threadId) {
  return 'https://mail.google.com/mail/u/0/#inbox/' + threadId;
}

/**
 * Format a message date for digest display (script timezone, yyyy-MM-dd HH:mm).
 * Falls back to "" when unparseable; never throws.
 */
function formatRunDate_(d) {
  try {
    const date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) {
      return '';
    }
    let tz = SPREADSHEET_TIME_ZONE;
    try {
      tz = Session.getScriptTimeZone() || tz;
    } catch (e) {
      // Keep default; Session may be unavailable in some contexts.
    }
    return Utilities.formatDate(date, tz, 'yyyy-MM-dd HH:mm');
  } catch (e) {
    return '';
  }
}

/**
 * Build one digest string per run (pure, no IO).
 * Zero threads -> "" (silence; T4/T5 must not send).
 * Otherwise one multi-line block per thread:
 *   • {subject}
 *     {date} | {kw1, kw2}
 *     {thread link}
 */
function buildDigestString(collapsedThreads) {
  if (!collapsedThreads || !collapsedThreads.length) {
    return '';
  }
  const lines = [];
  lines.push('Deal Watch: ' + collapsedThreads.length + (collapsedThreads.length === 1 ? ' thread' : ' threads') + ' matched');
  for (let i = 0; i < collapsedThreads.length; i++) {
    const g = collapsedThreads[i];
    const subject = trim_(g.subject) || '(no subject)';
    const dateStr = formatRunDate_(g.date);
    const kws = (g.matchedKeywords || []).join(', ');
    lines.push('');
    lines.push('\u2022 ' + subject);
    lines.push('  ' + (dateStr ? dateStr + ' | ' : '') + kws);
    lines.push('  ' + buildThreadLink_(g.threadId));
  }
  return lines.join('\n');
}

/**
 * Append one Log row per matched message.
 * Columns: timestamp | message_id | sender | matched_keywords | subject | status.
 * status is always "matched" in T3-c (only matches are logged here).
 * Returns rows written; never throws (0 on missing sheet/write failure).
 */
function appendLogRows_(matches, timestamp) {
  if (!matches || !matches.length) {
    return 0;
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_LOG);
    if (!sheet) {
      ensureSchema();
      sheet = ss.getSheetByName(SHEET_LOG);
    }
    if (!sheet) {
      return 0;
    }
    const rows = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      rows.push([
        timestamp,
        m.messageId,
        m.fromEmail || m.from,
        (m.matchedKeywords || []).join(', '),
        m.subject,
        'matched'
      ]);
    }
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS_LOG.length).setValues(rows);
    return rows.length;
  } catch (e) {
    return 0;
  }
}

/**
 * Append one Runs row per run.
 * Columns: start | end | found | sent | error.
 * found = per-message match count; sent = 0 (T3-c never sends; T4/T5 own send).
 */
function appendRunsRow_(start, end, found, sent, error) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_RUNS);
    if (!sheet) {
      ensureSchema();
      sheet = ss.getSheetByName(SHEET_RUNS);
    }
    if (!sheet) {
      return;
    }
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS_RUNS.length).setValues([[start, end, found, sent, error || '']]);
  } catch (e) {
    // Self-monitoring must never break the run; digest is already built.
  }
}

/**
 * Delete Log rows older than retentionDays (default LOG_RETENTION_DAYS = 30).
 * Rows of deleted rules are kept until they age out (dedup + audit).
 * Returns rows deleted; never throws.
 */
function pruneLog_(now, retentionDays) {
  try {
    const days = retentionDays > 0 ? retentionDays : LOG_RETENTION_DAYS;
    const base = (now instanceof Date) ? now : new Date(now);
    if (isNaN(base.getTime())) {
      return 0;
    }
    const cutoff = base.getTime() - days * MS_PER_DAY;
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
    if (!sheet || sheet.getLastRow() < 2) {
      return 0;
    }
    const values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return 0;
    }
    let tsIdx = getColumnIndex_(values[0], 'timestamp', 0);
    let deleted = 0;
    for (let r = values.length - 1; r >= 1; r--) {
      const cell = values[r][tsIdx];
      const t = (cell instanceof Date) ? cell.getTime() : new Date(cell).getTime();
      if (!isNaN(t) && t < cutoff) {
        sheet.deleteRow(r + 1);
        deleted++;
      }
    }
    return deleted;
  } catch (e) {
    return 0;
  }
}

/**
 * T3-c main entry: poll -> collapse -> digest string -> Log/Runs writes + prune.
 * No Telegram send here (T4/T5 own send). Zero matches -> returns "" (silence).
 * A Runs row is written on every path (including poll exceptions); sent is
 * always 0 until T4 sends. Returns the digest string.
 */
function runWatchOnce() {
  const start = new Date();
  let poll;
  try {
    poll = pollNewMatches();
  } catch (e) {
    const end = new Date();
    const msg = e && e.message ? e.message : String(e);
    appendRunsRow_(start, end, 0, 0, 'Poll failed: ' + msg);
    return '';
  }
  const matches = (poll && poll.matches) || [];
  const collapsed = collapseMatchesByThread(matches);
  const digest = buildDigestString(collapsed);
  let logError = '';
  if (matches.length) {
    const wrote = appendLogRows_(matches, start);
    if (wrote !== matches.length) {
      logError = 'Log write incomplete (' + wrote + '/' + matches.length + ').';
    }
  }
  pruneLog_(new Date(), LOG_RETENTION_DAYS);
  const end = new Date();
  const errorParts = [];
  if (poll && poll.error) {
    errorParts.push(poll.error);
  }
  if (logError) {
    errorParts.push(logError);
  }
  appendRunsRow_(start, end, matches.length, 0, errorParts.join(' '));
  return digest;
}

// ---------------------------------------------------------------------------
// T4-a: trigger management (no UI; T5 owns Telegram Setup/interval dropdown)
// ---------------------------------------------------------------------------
//
// Locked per CONTEXT.md:
// - Time-driven, default 15min, fixed options [15,30,60,120,360,720].
// - Idempotent: rerun never duplicates triggers.
// - Handler is runWatchAndNotify() (poll -> one merged send).
// - 15/30 use everyMinutes(n); 60/120/360/720 use everyHours(1/2/6/12).
//   (everyMinutes only accepts 1/5/10/15/30, so 60 must go the hours route.)

const TRIGGER_HANDLER = 'runWatchAndNotify';

/**
 * Store a poll interval and rebuild the trigger.
 * Valid = one of ALLOWED_INTERVAL_MINUTES; anything else is ignored
 * (no store, no trigger change) and the current effective value is returned.
 * The property is written only after the trigger builds successfully, so a
 * builder failure never leaves a stored value with no trigger behind.
 * Returns the effective interval in minutes. Throws on trigger API failure.
 */
function setPollIntervalMinutes(minutes) {
  const n = parseInt(trim_(minutes), 10);
  let valid = false;
  for (let i = 0; i < ALLOWED_INTERVAL_MINUTES.length; i++) {
    if (n === ALLOWED_INTERVAL_MINUTES[i]) {
      valid = true;
      break;
    }
  }
  if (!valid) {
    return getPollIntervalMinutes();
  }
  const props = PropertiesService.getScriptProperties();
  const prev = props.getProperty(PROP_POLL_INTERVAL);
  props.setProperty(PROP_POLL_INTERVAL, String(n));
  try {
    ensureTrigger();
  } catch (e) {
    if (prev === null || prev === undefined) {
      props.deleteProperty(PROP_POLL_INTERVAL);
    } else {
      props.setProperty(PROP_POLL_INTERVAL, prev);
    }
    throw e;
  }
  return n;
}

/**
 * Delete all project triggers whose handler is TRIGGER_HANDLER.
 * Returns the number deleted; never throws (0 on API failure).
 */
function deleteWatchTriggers_() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    let deleted = 0;
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER) {
        ScriptApp.deleteTrigger(triggers[i]);
        deleted++;
      }
    }
    return deleted;
  } catch (e) {
    return 0;
  }
}

/**
 * Count project triggers for TRIGGER_HANDLER (TestT4 helper).
 */
function countWatchTriggers_() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    let count = 0;
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER) {
        count++;
      }
    }
    return count;
  } catch (e) {
    return 0;
  }
}

/**
 * Idempotent trigger setup: delete existing watch triggers, then create one
 * from the effective interval. Throws on API failure so Setup (T5) can surface it.
 */
function ensureTrigger() {
  deleteWatchTriggers_();
  const interval = getPollIntervalMinutes();
  const builder = ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased();
  if (interval === 120) {
    builder.everyHours(2).create();
  } else if (interval === 360) {
    builder.everyHours(6).create();
  } else if (interval === 720) {
    builder.everyHours(12).create();
  } else if (interval === 30) {
    builder.everyMinutes(30).create();
  } else if (interval === 60) {
    builder.everyHours(1).create();
  } else {
    builder.everyMinutes(15).create();
  }
}

/**
 * T4-b: send + self-monitoring (T5 owns inbound UI + Setup).
 *
 * Locked per CONTEXT.md:
 * - One merged sendMessage per run (digest + English error block).
 * - Zero-match stays silent unless a pending error exists.
 * - Runs.sent is 0/1 per run (one merged message max).
 * - Send failures -> Runs + last_error, re-pushed next success,
 *   retry stops after MAX_CONSECUTIVE_FAILURES (polling continues).
 * - Code must never log, echo, or persist full keys.
 */

/**
 * Pending error carried from previous failed sends ("" when none).
 */
function getPendingError_() {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(PROP_LAST_ERROR);
    return v === null || v === undefined ? '' : String(v);
  } catch (e) {
    return '';
  }
}

/**
 * Consecutive send-failure count (0 when missing/invalid).
 */
function getConsecutiveFailures_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PROP_CONSECUTIVE_FAILURES);
    const n = parseInt(String(raw === null || raw === undefined ? '' : raw), 10);
    return n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Send text to the owner via Telegram Bot API.
 * Returns { ok, error }: error is English and never contains secrets.
 * Missing token/chat_id counts as failure (Setup incomplete).
 */
function sendTelegramMessage_(text) {
  let token = '';
  let chatId = '';
  try {
    const props = PropertiesService.getScriptProperties();
    token = trim_(props.getProperty(PROP_BOT_TOKEN));
    chatId = trim_(props.getProperty(PROP_OWNER_CHAT_ID));
  } catch (e) {
    return { ok: false, error: 'Cannot read script properties.' };
  }
  if (!token) {
    return { ok: false, error: 'Missing bot_token (Setup incomplete).' };
  }
  if (!chatId) {
    return { ok: false, error: 'Missing owner_chat_id (Setup incomplete).' };
  }
  if (!text) {
    return { ok: false, error: 'Nothing to send.' };
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(token, 'sendMessage'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ chat_id: chatId, text: text }),
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    let body = '';
    try {
      body = resp.getContentText();
    } catch (e2) {
      body = '';
    }
    const mapped = mapSendError_(code, body);
    if (!mapped) {
      return { ok: true, error: '' };
    }
    return { ok: false, error: mapped };
  } catch (e) {
    // UrlFetchApp messages can echo the request URL, which contains the
    // token — never return it raw. Redact before surfacing.
    let msg = e && e.message ? String(e.message) : String(e);
    msg = redactToken_(msg, token);
    return { ok: false, error: 'Send exception: ' + truncateDebug_(msg) };
  }
}

/**
 * Error text of the Runs row just written by runWatchOnce() ("" when none).
 */
function readLastRunsError_() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RUNS);
    if (!sheet || sheet.getLastRow() < 2) {
      return '';
    }
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, HEADERS_RUNS.length).getValues()[0];
    const errIdx = getRunsHeaderIndex_(headers).errIdx;
    const v = sheet.getRange(lastRow, errIdx + 1).getValue();
    return v === null || v === undefined ? '' : String(v);
  } catch (e) {
    return '';
  }
}

/**
 * Update the Runs row just written: set sent, optionally append to error.
 * Never throws (self-monitoring must not break the run).
 */
function updateLastRunsRow_(sent, errorSuffix) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RUNS);
    if (!sheet || sheet.getLastRow() < 2) {
      return;
    }
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, HEADERS_RUNS.length).getValues()[0];
    const idx = getRunsHeaderIndex_(headers);
    const sentIdx = idx.sentIdx;
    const errIdx = idx.errIdx;
    sheet.getRange(lastRow, sentIdx + 1).setValue(sent ? 1 : 0);
    if (errorSuffix) {
      const cur = sheet.getRange(lastRow, errIdx + 1).getValue();
      const curStr = cur === null || cur === undefined ? '' : String(cur);
      sheet.getRange(lastRow, errIdx + 1).setValue(curStr + (curStr ? ' ' : '') + errorSuffix);
    }
  } catch (e) {
    // Ignore: digest is already built and logged.
  }
}

/**
 * Build one merged message (pure, no IO).
 * Digest (any language) + English error block; "" when nothing to send.
 */
function buildMergedMessage_(digest, errorParts) {
  const d = digest === null || digest === undefined ? '' : String(digest);
  const errs = [];
  if (errorParts && errorParts.length) {
    for (let i = 0; i < errorParts.length; i++) {
      const e = trim_(errorParts[i]);
      if (e) {
        errs.push(e);
      }
    }
  }
  if (!d && !errs.length) {
    return '';
  }
  let out;
  if (d && errs.length) {
    out = d + '\n\nWatcher note:\n' + errs.join(' ');
  } else if (d) {
    out = d;
  } else {
    out = 'Deal Watch note:\n' + errs.join(' ');
  }
  if (out.length > TELEGRAM_MAX_TEXT) {
    out = out.substring(0, TELEGRAM_MAX_TEXT - TELEGRAM_TRUNCATE_RESERVE) + '... (truncated)';
  }
  return out;
}

// ---------------------------------------------------------------------------
// T5-a/b: Telegram inbound + one-time Setup (no rule CRUD, no interval UI;
//         no suggest, no /setai — those are T5-c/d and T6).
//
// Locked per CONTEXT.md + owner grill:
// - DM-only, single owner, /start <one-time token> bind.
// - Non-owners silently ignored; groups rejected (silent).
// - Sheet menu has Setup only; interval changes live in Telegram (T5-d).
// - Bot UI English for now.
// - /transfer = move to a new Telegram account (same bot/Sheet).
//   /connect = replace bot token (same Sheet/owner).
//   Both require an inline-button confirm.
// - Conversation state in CacheService conv_<chat_id>, TTL ~10 min.
// - Rules mirror in ScriptProperties rule_<id> (+ rules_version),
//   latest version only, deleted on rule delete, rebuilt on disaster.
// - max(id)+1 under ScriptLock for new rule ids (T5-c uses it).
// ---------------------------------------------------------------------------

const PROP_SETUP_TOKEN = 'setup_token';
const PROP_WEBHOOK_SECRET = 'webhook_secret';
const PROP_WEB_APP_URL = 'webapp_url';
const PROP_RULES_VERSION = 'rules_version';
const PROP_RULES_UPDATED = 'rules_updated_at';
// Queue-jam watchdog (fallback): Telegram delivers webhook updates in order
// and waits for a 200 OK per update. The HtmlService ack normally provides
// it; if a jam still occurs (stale/deleted deployment, Google outage), a
// jammed head update retries every ~60s and newer commands wait behind it.
// When pending_update_count reaches the threshold, the next trigger run
// alerts the owner with a one-tap clear button instead of staying silent.
const QUEUE_PENDING_THRESHOLD = 3;
const QUEUE_ALERT_COOLDOWN_SECONDS = 43200;
const PROP_QUEUE_ALERT_AT = 'queue_alert_at';

const CONV_TTL_SECONDS = 600;
const LIST_PAGE_SIZE = 10;
const LIST_BUTTONS_PER_ROW = 2;

// Telegram at-least-once delivery: the same update_id may arrive several
// times (retry / queue flush). Replays are dropped silently (see doPost).
const DEDUP_TTL_SECONDS = 3600;
// Owner re-/start after bind: reply at most once per window; the rest stay
// silent so queued duplicates never become message spam.
const ALREADY_SETUP_TTL_SECONDS = 600;

/**
 * Rule cache key — pure, Never throws.
 */
function ruleCacheKey_(id) {
  return 'rule_' + String(id);
}

/**
 * Conversation cache key — pure, Never throws.
 */
function convCacheKey_(chatId) {
  return 'conv_' + String(chatId);
}

/**
 * Dedup cache key — pure, Never throws.
 */
function tgUpdateKey_(updateId) {
  return 'tg_update_' + String(updateId);
}

/**
 * Start-reply rate-limit key — pure, Never throws.
 */
function tgStartReplyKey_(chatId) {
  return 'tg_startreply_' + String(chatId);
}

/**
 * True when this update_id was already processed (caller must return ok
 * silently). First sight marks the id; missing/invalid ids fail open
 * (return false) so nothing is ever dropped blindly.
 */
function isDuplicateUpdate_(updateId) {
  if (updateId === null || updateId === undefined || updateId === '') {
    return false;
  }
  try {
    const cache = CacheService.getScriptCache();
    const key = tgUpdateKey_(updateId);
    if (cache.get(key)) {
      return true;
    }
    try {
      cache.put(key, '1', DEDUP_TTL_SECONDS);
    } catch (e2) {
      // Mark is best-effort; the work below still runs once.
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * True when the owner re-/start reply may be sent now (marks the window).
 * Fail-open (true) when the cache is unavailable, preserving old behaviour.
 */
function shouldReplyAlreadySetup_(chatId) {
  try {
    const cache = CacheService.getScriptCache();
    const key = tgStartReplyKey_(chatId);
    if (cache.get(key)) {
      return false;
    }
    try {
      cache.put(key, '1', ALREADY_SETUP_TTL_SECONDS);
    } catch (e2) {
      // Mark is best-effort; the reply below still goes out once.
    }
    return true;
  } catch (e) {
    return true;
  }
}

/**
 * Run fn while holding the script lock (id allocation + Sheet/cache writes).
 * Returns fn() result; throws if the lock cannot be acquired.
 */
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {
      // Ignore release errors; the work is already done.
    }
  }
}

/**
 * Short-lived per-chat conversation state (CacheService, not Properties).
 * Value is a small JSON object, e.g. { step: 'await_new_token' }.
 */
function getConv_(chatId) {
  try {
    const raw = CacheService.getScriptCache().get(convCacheKey_(chatId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Write short-lived conversation state — Never throws (best-effort).
 */
function setConv_(chatId, obj) {
  try {
    CacheService.getScriptCache().put(
      convCacheKey_(chatId),
      JSON.stringify(obj || {}),
      CONV_TTL_SECONDS
    );
  } catch (e) {
    // Conversation state is best-effort; the user can restart the flow.
  }
}

/**
 * Clear conversation state — Never throws.
 */
function clearConv_(chatId) {
  try {
    CacheService.getScriptCache().remove(convCacheKey_(chatId));
  } catch (e) {
    // Ignore.
  }
}

/**
 * Owner chat id or '' — Never throws.
 */
function getOwnerChatId_() {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(PROP_OWNER_CHAT_ID);
    return trim_(v);
  } catch (e) {
    return '';
  }
}

/**
 * Stored bot token or '' — Never throws.
 */
function getStoredBotToken_() {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(PROP_BOT_TOKEN);
    return trim_(v);
  } catch (e) {
    return '';
  }
}

/**
 * Mask a secret for user-facing echo (never show the full value).
 * e.g. "123456:ABC..." -> "1234...WXYZ".
 */
function maskSecret_(s) {
  const t = String(s || '');
  if (t.length <= 8) {
    return '****';
  }
  return t.substring(0, 4) + '...' + t.substring(t.length - 4);
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers (outbound to an arbitrary chat; token redacted)
// ---------------------------------------------------------------------------

/**
 * Send text to any chat (binding/transfer/connect flows + future T5-c/d).
 * replyMarkup is optional (reply keyboard / inline buttons).
 * Returns { ok, error, messageId }; error never contains the token.
 * messageId is the sent message id ('' when unavailable) so callers can edit it.
 */
function sendTelegramToChat_(token, chatId, text, replyMarkup) {
  const t = trim_(token);
  const c = trim_(chatId);
  if (!t) {
    return { ok: false, error: 'Missing bot_token (Setup incomplete).' };
  }
  if (!c) {
    return { ok: false, error: 'Missing chat id.' };
  }
  if (!text) {
    return { ok: false, error: 'Nothing to send.' };
  }
  let out = String(text);
  if (out.length > TELEGRAM_MAX_TEXT) {
    out = out.substring(0, TELEGRAM_MAX_TEXT - TELEGRAM_TRUNCATE_RESERVE) + '... (truncated)';
  }
  const payload = { chat_id: c, text: out };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'sendMessage'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    let body = '';
    try {
      body = resp.getContentText();
    } catch (e2) {
      body = '';
    }
    const mapped = mapSendError_(code, body);
    if (!mapped) {
      return { ok: true, error: '', messageId: extractMessageId_(body) };
    }
    return { ok: false, error: mapped };
  } catch (e) {
    let msg = e && e.message ? String(e.message) : String(e);
    msg = redactToken_(msg, t);
    return { ok: false, error: 'Send exception: ' + truncateDebug_(msg) };
  }
}

/**
 * Dismiss a callback spinner — Never throws (best-effort).
 */
function answerTelegramCallback_(token, callbackQueryId, text) {
  const t = trim_(token);
  if (!t || !callbackQueryId) {
    return { ok: false, desc: 'skipped' };
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'answerCallbackQuery'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: String(text || '').substring(0, DEBUG_TRUNCATE_LEN)
        }),
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    let body = '';
    try {
      body = resp.getContentText();
    } catch (e2) {
      body = '';
    }
    return describeCallbackResult_(code, body);
  } catch (e) {
    // Dismissing the spinner is best-effort.
    return { ok: false, desc: 'exception' };
  }
}

/**
 * Delete a message — Never throws (best-effort).
 */
function deleteTelegramMessage_(token, chatId, messageId) {
  const t = trim_(token);
  if (!t || !chatId || !messageId) {
    return;
  }
  try {
    UrlFetchApp.fetch(
      telegramApiUrl_(t, 'deleteMessage'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ chat_id: String(chatId), message_id: messageId }),
        muteHttpExceptions: true
      }
    );
  } catch (e) {
    // Deleting the raw secret message is best-effort.
  }
}

/**
 * Replace an inline-button message's text, optionally keeping buttons.
 * Omitting replyMarkup clears the inline keyboard, so the buttons cannot
 * be tapped twice. Best-effort: edit failures (too old, not modified) are
 * ignored and never throw from the webhook. Never throws.
 */
function editTelegramMessageText_(token, chatId, messageId, text, replyMarkup) {
  const t = trim_(token);
  if (!t || !chatId || !messageId || !text) {
    return { ok: false, desc: 'skipped' };
  }
  let out = String(text);
  if (out.length > TELEGRAM_MAX_TEXT) {
    out = out.substring(0, TELEGRAM_MAX_TEXT - TELEGRAM_TRUNCATE_RESERVE) + '... (truncated)';
  }
  try {
    const payload = { chat_id: String(chatId), message_id: messageId, text: out };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'editMessageText'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    let body = '';
    try {
      body = resp.getContentText();
    } catch (e2) {
      body = '';
    }
    return describeCallbackResult_(code, body);
  } catch (e) {
    // Hiding the buttons is best-effort.
    return { ok: false, desc: 'exception' };
  }
}

/**
 * Validate a bot token via getMe (no secrets logged, token redacted on error).
 * Returns { ok, username, error }.
 */
function telegramGetMe_(token) {
  const t = trim_(token);
  if (!t) {
    return { ok: false, username: '', error: 'Empty token.' };
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'getMe'),
      { method: 'get', muteHttpExceptions: true }
    );
    const code = resp.getResponseCode();
    if (code < HTTP_OK_MIN || code >= HTTP_OK_MAX) {
      return { ok: false, username: '', error: 'Telegram HTTP ' + code + '.' };
    }
    const data = JSON.parse(resp.getContentText());
    if (data && data.ok === true && data.result) {
      return { ok: true, username: String(data.result.username || ''), error: '' };
    }
    return { ok: false, username: '', error: 'Invalid bot token.' };
  } catch (e) {
    let msg = e && e.message ? String(e.message) : String(e);
    msg = redactToken_(msg, t);
    return { ok: false, username: '', error: truncateDebug_(msg) };
  }
}

/**
 * Point the bot webhook at this deployment.
 * The secret is embedded both as Telegram secret_token and as a URL query
 * (?secret=...) because Apps Script doPost cannot read custom headers —
 * the query param is what doPost actually verifies.
 */
function telegramSetWebhook_(token, webAppUrl, secret) {
  const t = trim_(token);
  const base = trim_(webAppUrl);
  const s = trim_(secret);
  if (!t || !base || !s) {
    return { ok: false, error: 'Missing token, URL, or secret.' };
  }
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  const url = base + sep + 'secret=' + encodeURIComponent(s);
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'setWebhook'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ url: url, secret_token: s, drop_pending_updates: true, max_connections: 1 }),
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    if (code < HTTP_OK_MIN || code >= HTTP_OK_MAX) {
      return { ok: false, error: 'Telegram HTTP ' + code + '.' };
    }
    const data = JSON.parse(resp.getContentText());
    if (data && data.ok === true) {
      return { ok: true, error: '' };
    }
    const desc = data && data.description ? String(data.description).substring(0, DEBUG_TRUNCATE_LEN) : 'unknown error';
    return { ok: false, error: 'setWebhook rejected: ' + desc };
  } catch (e) {
    let msg = e && e.message ? String(e.message) : String(e);
    msg = redactToken_(msg, t, s);
    return { ok: false, error: truncateDebug_(msg) };
  }
}

// ---------------------------------------------------------------------------
// Queue-jam watchdog (early warning + one-tap clear, owner-confirmed only)
// ---------------------------------------------------------------------------

/**
 * Read the webhook queue depth via getWebhookInfo (server-side; the token
 * never leaves ScriptProperties). Returns { ok, pending }. Any failure
 * returns ok:false — callers treat meta-failures as "no signal", never as
 * an alert, so a broken check cannot manufacture noise.
 */
function getQueuePending_(token) {
  const t = trim_(token);
  if (!t) {
    return { ok: false, pending: 0 };
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'getWebhookInfo'),
      { method: 'get', muteHttpExceptions: true }
    );
    if (resp.getResponseCode() < HTTP_OK_MIN || resp.getResponseCode() >= HTTP_OK_MAX) {
      return { ok: false, pending: 0 };
    }
    const data = JSON.parse(resp.getContentText());
    if (data && data.ok === true && data.result) {
      const n = parseInt(String(data.result.pending_update_count), 10);
      return { ok: true, pending: n > 0 ? n : 0 };
    }
    return { ok: false, pending: 0 };
  } catch (e) {
    return { ok: false, pending: 0 };
  }
}

/**
 * Jam check for the trigger run. Returns { alert, pending }: alert is true
 * only when the queue is at/over threshold AND the cooldown has passed (at
 * most one alert per QUEUE_ALERT_COOLDOWN_SECONDS). Marks the alert time
 * when alerting. Pre-bind (no owner) never alerts — there is nobody to act.
 */
function checkQueueJam_() {
  const empty = { alert: false, pending: 0 };
  try {
    const props = PropertiesService.getScriptProperties();
    const token = trim_(props.getProperty(PROP_BOT_TOKEN));
    const owner = trim_(props.getProperty(PROP_OWNER_CHAT_ID));
    if (!token || !owner) {
      return empty;
    }
    let lastAlert = 0;
    try {
      lastAlert = parseInt(String(props.getProperty(PROP_QUEUE_ALERT_AT) || '0'), 10) || 0;
    } catch (e2) {
      lastAlert = 0;
    }
    if (lastAlert > 0 && Date.now() - lastAlert < QUEUE_ALERT_COOLDOWN_SECONDS * MS_PER_SECOND) {
      return empty;
    }
    const q = getQueuePending_(token);
    if (!q.ok || q.pending < QUEUE_PENDING_THRESHOLD) {
      return empty;
    }
    try {
      props.setProperty(PROP_QUEUE_ALERT_AT, String(Date.now()));
    } catch (e3) {
      // The alert below still goes out once; worst case it repeats next run.
    }
    return { alert: true, pending: q.pending };
  } catch (e) {
    return empty;
  }
}

/**
 * Alert text + one-tap clear buttons. Sent as a separate control message
 * (like transfer/connect confirmations), never merged into the digest.
 */
function sendQueueJamAlert_(token, chatId, pending) {
  sendTelegramToChat_(
    token,
    chatId,
    'Telegram queue is jammed (' + pending + ' updates pending). ' +
    'Your commands are waiting behind old retries — do not resend them. ' +
    'Tap below to clear the queue and re-attach the webhook. Rules and history stay.',
    {
      inline_keyboard: [[
        { text: 'Clear queue + re-attach', callback_data: 'queue:yes' },
        { text: 'Cancel', callback_data: 'queue:no' }
      ]]
    }
  );
}

/**
 * Owner-confirmed queue clear: drop pending updates, then re-attach the
 * webhook from the stored /exec URL + secret (no Sheet Setup round-trip,
 * no token ever shown). Resets the alert cooldown on success so a future
 * jam alerts fresh. Never throws.
 */
function clearQueueAndReattach_(token, chatId) {
  const t = trim_(token);
  const c = trim_(chatId);
  if (!t || !c) {
    return;
  }
  let dropped = 0;
  const before = getQueuePending_(t);
  if (before.ok) {
    dropped = before.pending;
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'deleteWebhook'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ drop_pending_updates: true }),
        muteHttpExceptions: true
      }
    );
    if (resp.getResponseCode() < HTTP_OK_MIN || resp.getResponseCode() >= HTTP_OK_MAX) {
      sendTelegramToChat_(t, c, 'Clear failed (Telegram HTTP ' + resp.getResponseCode() + '). Nothing changed. Rerun Deal Watch > Setup in the Sheet.');
      return;
    }
    let dropOk = false;
    try {
      dropOk = !!JSON.parse(resp.getContentText()).ok;
    } catch (e2) {
      dropOk = false;
    }
    if (!dropOk) {
      sendTelegramToChat_(t, c, 'Clear rejected by Telegram. Nothing changed. Rerun Deal Watch > Setup in the Sheet.');
      return;
    }
  } catch (e) {
    let msg = e && e.message ? String(e.message) : String(e);
    msg = truncateDebug_(redactToken_(msg, t));
    sendTelegramToChat_(t, c, 'Clear failed (' + msg + '). Nothing changed. Rerun Deal Watch > Setup in the Sheet.');
    return;
  }
  let webAppUrl = '';
  let secret = '';
  try {
    const props = PropertiesService.getScriptProperties();
    webAppUrl = trim_(props.getProperty(PROP_WEB_APP_URL));
    secret = trim_(props.getProperty(PROP_WEBHOOK_SECRET));
  } catch (e3) {
    webAppUrl = '';
    secret = '';
  }
  if (!webAppUrl || !secret) {
    sendTelegramToChat_(t, c, 'Queue cleared (' + dropped + ' dropped), but the stored webhook URL is missing — rerun Deal Watch > Setup in the Sheet to re-attach.');
    return;
  }
  const wh = telegramSetWebhook_(t, webAppUrl, secret);
  if (!wh.ok) {
    sendTelegramToChat_(t, c, 'Queue cleared (' + dropped + ' dropped), but re-attach failed: ' + wh.error + ' Rerun Deal Watch > Setup in the Sheet.');
    return;
  }
  try {
    PropertiesService.getScriptProperties().deleteProperty(PROP_QUEUE_ALERT_AT);
  } catch (e4) {
    // Cooldown reset is best-effort; the next jam still alerts after 12h.
  }
  sendTelegramToChat_(t, c, 'Queue cleared (' + dropped + ' dropped). Webhook re-attached. Send your command again — once.');
}

// ---------------------------------------------------------------------------
// Rules mirror cache (ScriptProperties rule_<id>, latest version only)
// ---------------------------------------------------------------------------

/**
 * Persist one rule mirror entry (called on every rule write in T5-c).
 * sheetRow is { id, sender, keywordsRaw, enabled, topicHint, updatedAt }.
 */
function saveRuleCache_(sheetRow) {
  if (!sheetRow || !sheetRow.id) {
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(ruleCacheKey_(sheetRow.id), JSON.stringify({
      id: String(sheetRow.id),
      sender: String(sheetRow.sender || ''),
      keywords: String(sheetRow.keywordsRaw || ''),
      enabled: !!sheetRow.enabled,
      topicHint: String(sheetRow.topicHint || ''),
      updatedAt: String(sheetRow.updatedAt || '')
    }));
    props.setProperty(PROP_RULES_VERSION, String(Date.now()));
    props.setProperty(PROP_RULES_UPDATED, formatRunDate_(new Date()));
  } catch (e) {
    // Cache writes are best-effort; the Sheet stays the mirror.
  }
}

/**
 * Delete one rule mirror entry — Never throws.
 */
function deleteRuleCache_(id) {
  if (!id) {
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(ruleCacheKey_(id));
    props.setProperty(PROP_RULES_VERSION, String(Date.now()));
    props.setProperty(PROP_RULES_UPDATED, formatRunDate_(new Date()));
  } catch (e) {
    // Ignore.
  }
}

/**
 * Next stable rule id as a numeric string (max+1), e.g. "6" after "5".
 * Callers must hold the script lock across id-gen + Sheet append + cache
 * write (use withScriptLock_); this helper reads under its own short lock
 * for standalone callers.
 */
function nextRuleId_() {
  return withScriptLock_(function () {
    return maxRuleIdPlusOne_();
  });
}

/**
 * Max rule id + 1 as a string — Never throws (falls back to cache max).
 */
function maxRuleIdPlusOne_() {
  let max = 0;
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
    if (sheet && sheet.getLastRow() >= 2) {
      const values = sheet.getDataRange().getValues();
      const idIdx = getColumnIndex_(values[0], 'id', 0);
      for (let r = 1; r < values.length; r++) {
        const n = parseInt(String(values[r][idIdx]), 10);
        if (n > max) {
          max = n;
        }
      }
    }
  } catch (e) {
    // Fall through with max=0; callers surface Sheet errors separately.
  }
  // Also consider cached ids so a freshly wiped Sheet still moves forward.
  try {
    const props = PropertiesService.getScriptProperties().getProperties();
    for (const k in props) {
      if (k.indexOf('rule_') === 0) {
        try {
          const o = JSON.parse(props[k]);
          const n = parseInt(String(o && o.id), 10);
          if (n > max) {
            max = n;
          }
        } catch (e2) {
          // Skip corrupt entries.
        }
      }
    }
  } catch (e) {
    // Ignore.
  }
  return String(max + 1);
}

/**
 * Disaster recovery: if the Rules sheet is missing/empty but cached
 * rule_<id> entries exist, recreate the rows from the cache.
 * Additive only — never deletes cache based on Sheet content.
 * Returns rows restored.
 */
function restoreRulesFromCacheIfNeeded_() {
  let restored = 0;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_RULES);
    const healthy = !!(sheet && sheet.getLastRow() >= 1);
    if (healthy && sheet.getLastRow() >= 2) {
      return 0; // Sheet has data; nothing to do.
    }
    const props = PropertiesService.getScriptProperties().getProperties();
    const rows = [];
    for (const k in props) {
      if (k.indexOf('rule_') === 0) {
        try {
          const o = JSON.parse(props[k]);
          if (o && o.id && o.sender) {
            rows.push([
              String(o.id),
              String(o.sender || ''),
              String(o.keywords || ''),
              o.enabled ? true : false,
              String(o.topicHint || ''),
              String(o.updatedAt || formatRunDate_(new Date()))
            ]);
          }
        } catch (e2) {
          // Skip corrupt entries.
        }
      }
    }
    if (!rows.length) {
      return 0;
    }
    ensureSchema();
    sheet = ss.getSheetByName(SHEET_RULES);
    if (!sheet) {
      return 0;
    }
    rows.sort(function (a, b) {
      return parseInt(a[0], 10) - parseInt(b[0], 10);
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS_RULES.length).setValues(rows);
    restored = rows.length;
  } catch (e) {
    restored = 0;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// T5-c: rule CRUD data layer (Sheet is the mirror; rule_<id> cache updated
// on every write; Log rows are never touched by rule edits/deletes)
// ---------------------------------------------------------------------------

/**
 * Read all Rules rows in sheet order — Never throws ([] on failure).
 */
function loadAllRules_() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
    if (!sheet || sheet.getLastRow() < 2) {
      return [];
    }
    const values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return [];
    }
    const headers = values[0];
    const idIdx = getColumnIndex_(headers, 'id', 0);
    const senderIdx = getColumnIndex_(headers, 'sender', 1);
    const kwIdx = getColumnIndex_(headers, 'keywords', 2);
    const enIdx = getColumnIndex_(headers, 'enabled', 3);
    const topicIdx = getColumnIndex_(headers, 'topic_hint', 4);
    const updIdx = getColumnIndex_(headers, 'updated_at', 5);
    const out = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const id = trim_(row[idIdx]);
      const sender = trim_(row[senderIdx]);
      if (!id || !sender) {
        continue;
      }
      out.push({
        row: r + 1,
        id: String(id),
        sender: String(sender),
        keywordsRaw: String(row[kwIdx] === null || row[kwIdx] === undefined ? '' : row[kwIdx]),
        enabled: isRuleEnabled_(row[enIdx]),
        topicHint: topicIdx < 0 ? '' : String(row[topicIdx] === null || row[topicIdx] === undefined ? '' : row[topicIdx]),
        updatedAt: updIdx < 0 ? '' : formatSheetStamp_(row[updIdx])
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * Find one rule by id — Never throws (null when missing).
 */
function findRuleById_(id) {
  try {
    const rules = loadAllRules_();
    for (let i = 0; i < rules.length; i++) {
      if (String(rules[i].id) === String(id)) {
        return rules[i];
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Find one rule by sender (natural key) — Never throws (null when missing).
 */
function findRuleBySender_(sender) {
  try {
    const rules = loadAllRules_();
    for (let i = 0; i < rules.length; i++) {
      if (isSameSender_(rules[i].sender, sender)) {
        return rules[i];
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * True when two sender values identify the same watched sender — pure, Never throws.
 */
function isSameSender_(a, b) {
  const x = trim_(a);
  const y = trim_(b);
  if (!x || !y) {
    return false;
  }
  if (isEmailSender(x) && isEmailSender(y)) {
    return normalizeSenderEmail(x) === normalizeSenderEmail(y);
  }
  return x.toLowerCase() === y.toLowerCase();
}

/**
 * True when raw keywords parse to at least one entry — pure, Never throws.
 */
function hasKeywords_(raw) {
  try {
    return parseKeywords(raw).length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * True when enabled rules already reach the entry cap — pure, Never throws.
 */
function isRuleLimitReached_(rules) {
  let n = 0;
  if (rules) {
    for (let i = 0; i < rules.length; i++) {
      if (rules[i] && rules[i].enabled) {
        n++;
      }
    }
  }
  return n >= MAX_SENDERS;
}

/**
 * Most recently created rule (max numeric id) — Never throws (null when none).
 */
function getLastRule_() {
  try {
    const rules = loadAllRules_();
    let best = null;
    let bestN = 0;
    for (let i = 0; i < rules.length; i++) {
      const n = parseInt(String(rules[i].id), 10);
      if (n > bestN) {
        bestN = n;
        best = rules[i];
      }
    }
    return best;
  } catch (e) {
    return null;
  }
}

/**
 * Append one enabled rule under lock — Never throws ({ ok, id, error }).
 * topicHint is optional ('' when omitted).
 */
function appendRule_(sender, keywordsRaw, topicHint) {
  try {
    return withScriptLock_(function () {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
      if (!sheet) {
        return { ok: false, id: '', error: 'Rules sheet is missing. Rerun Setup.' };
      }
      const id = maxRuleIdPlusOne_();
      const now = formatRunDate_(new Date());
      const hint = topicHint === undefined || topicHint === null ? '' : String(topicHint);
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS_RULES.length).setValues([[id, sender, keywordsRaw, true, hint, now]]);
      saveRuleCache_({ id: id, sender: sender, keywordsRaw: keywordsRaw, enabled: true, topicHint: hint, updatedAt: now });
      return { ok: true, id: id, error: '' };
    });
  } catch (e) {
    return { ok: false, id: '', error: 'Could not write the sheet. Try again.' };
  }
}

/**
 * Update one rule by id under lock — Never throws ({ ok, error }).
 */
function updateRuleById_(id, fields) {
  try {
    return withScriptLock_(function () {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
      if (!sheet || sheet.getLastRow() < 2) {
        return { ok: false, error: 'Rules sheet is missing. Rerun Setup.' };
      }
      const values = sheet.getDataRange().getValues();
      const headers = values[0];
      const idIdx = getColumnIndex_(headers, 'id', 0);
      const senderIdx = getColumnIndex_(headers, 'sender', 1);
      const kwIdx = getColumnIndex_(headers, 'keywords', 2);
      const enIdx = getColumnIndex_(headers, 'enabled', 3);
      const topicIdx = getColumnIndex_(headers, 'topic_hint', 4);
      const updIdx = getColumnIndex_(headers, 'updated_at', 5);
      let targetRow = -1;
      for (let r = 1; r < values.length; r++) {
        if (String(trim_(values[r][idIdx])) === String(id)) {
          targetRow = r + 1;
          break;
        }
      }
      if (targetRow < 0) {
        return { ok: false, error: 'Rule not found.' };
      }
      const now = formatRunDate_(new Date());
      const cur = sheet.getRange(targetRow, 1, 1, HEADERS_RULES.length).getValues()[0];
      let sender = String(cur[senderIdx]);
      let keywordsRaw = String(cur[kwIdx]);
      let enabled = isRuleEnabled_(cur[enIdx]);
      let topicHint = topicIdx < 0 ? '' : String(cur[topicIdx] === null || cur[topicIdx] === undefined ? '' : cur[topicIdx]);
      const f = fields || {};
      if (f.sender !== undefined) {
        sender = String(f.sender);
        sheet.getRange(targetRow, senderIdx + 1).setValue(sender);
      }
      if (f.keywordsRaw !== undefined) {
        keywordsRaw = String(f.keywordsRaw);
        sheet.getRange(targetRow, kwIdx + 1).setValue(keywordsRaw);
      }
      if (f.enabled !== undefined) {
        enabled = !!f.enabled;
        sheet.getRange(targetRow, enIdx + 1).setValue(enabled);
      }
      if (f.topicHint !== undefined) {
        topicHint = String(f.topicHint);
        if (topicIdx >= 0) {
          sheet.getRange(targetRow, topicIdx + 1).setValue(topicHint);
        }
      }
      sheet.getRange(targetRow, updIdx + 1).setValue(now);
      saveRuleCache_({ id: String(id), sender: sender, keywordsRaw: keywordsRaw, enabled: enabled, topicHint: topicHint, updatedAt: now });
      return { ok: true, error: '' };
    });
  } catch (e) {
    return { ok: false, error: 'Could not write the sheet. Try again.' };
  }
}

/**
 * Delete one rule row by id under lock (Log rows kept) — Never throws ({ ok, sender, error }).
 */
function deleteRuleById_(id) {
  try {
    return withScriptLock_(function () {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
      if (!sheet || sheet.getLastRow() < 2) {
        return { ok: false, sender: '', error: 'Rules sheet is missing. Rerun Setup.' };
      }
      const values = sheet.getDataRange().getValues();
      const idIdx = getColumnIndex_(values[0], 'id', 0);
      const senderIdx = getColumnIndex_(values[0], 'sender', 1);
      for (let r = 1; r < values.length; r++) {
        if (String(trim_(values[r][idIdx])) === String(id)) {
          const sender = String(values[r][senderIdx]);
          sheet.deleteRow(r + 1);
          deleteRuleCache_(id);
          return { ok: true, sender: sender, error: '' };
        }
      }
      return { ok: false, sender: '', error: 'Rule not found.' };
    });
  } catch (e) {
    return { ok: false, sender: '', error: 'Could not write the sheet. Try again.' };
  }
}

// ---------------------------------------------------------------------------
// Sheet custom menu + one-time Setup (idempotent, Setup item only)
// ---------------------------------------------------------------------------

/**
 * Sheet open hook — Never throws (best-effort menu).
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Deal Watch')
      .addItem('Setup', 'runSheetSetup')
      .addItem('Send Mini App test', 'sendMiniAppTest')
      .addToUi();
  } catch (e) {
    // Menu creation is best-effort (e.g. headless executions).
  }
}

/**
 * One-time Google Setup, run from Deal Watch > Setup in the Sheet.
 * Idempotent: rerun outputs Already set up without overwriting the owner
 * binding or rotating secrets.
 */
function runSheetSetup() {
  const ui = SpreadsheetApp.getUi();
  ensureSchema();
  restoreRulesFromCacheIfNeeded_();

  const props = PropertiesService.getScriptProperties();
  let token = getStoredBotToken_();
  const owner = getOwnerChatId_();

  if (!token) {
    const resp = ui.prompt(
      'Deal Watch Setup',
      'Paste the bot token from BotFather (/newbot):',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) {
      return;
    }
    token = trim_(resp.getResponseText());
    if (!token) {
      ui.alert('Setup cancelled: empty token.');
      return;
    }
    const check = telegramGetMe_(token);
    if (!check.ok) {
      ui.alert('Invalid bot token: ' + check.error + '\nGet a new one from BotFather and retry.');
      return;
    }
    props.setProperty(PROP_BOT_TOKEN, token);
  } else {
    const check = telegramGetMe_(token);
    if (!check.ok) {
      ui.alert(
        'Stored bot token failed getMe: ' + check.error +
        '\nIf you rotated the token, use Telegram /connect from the owner account.'
      );
      return;
    }
  }

  // Trigger first (no duplicates by design), then webhook.
  try {
    ensureTrigger();
  } catch (e) {
    ui.alert('Setup failed creating the trigger: ' + String(e && e.message ? e.message : e).substring(0, ALERT_TRUNCATE_LEN));
    return;
  }

  // Webhook target: pasted /exec URL, stored once, never rotated on rerun.
  // Never auto-detected: getService().getUrl() returns the login-walled
  // /dev URL and anonymous Telegram calls get 401.
  let webAppUrl = '';
  try {
    webAppUrl = trim_(props.getProperty(PROP_WEB_APP_URL));
  } catch (e) {
    webAppUrl = '';
  }
  if (!webAppUrl) {
    const urlResp = ui.prompt(
      'Deal Watch Setup',
      'Paste the Web app URL from Deploy > Manage deployments (must end with /exec, not /dev):',
      ui.ButtonSet.OK_CANCEL
    );
    if (urlResp.getSelectedButton() !== ui.Button.OK) {
      ui.alert('Setup paused: webhook not attached. Rerun Setup and paste the /exec URL.');
      return;
    }
    webAppUrl = trim_(urlResp.getResponseText());
    if (!webAppUrl) {
      ui.alert('Setup paused: empty URL. Rerun Setup and paste the /exec URL.');
      return;
    }
    if (/\/dev(\?.*)?$/.test(webAppUrl)) {
      ui.alert('That is a /dev test URL (needs Google login — Telegram gets 401). Copy the /exec URL from Deploy > Manage deployments instead. Nothing was stored.');
      return;
    }
    if (!/\/exec(\?.*)?$/.test(webAppUrl)) {
      ui.alert('That URL does not end with /exec. Copy the Web app URL from Deploy > Manage deployments and rerun Setup. Nothing was stored.');
      return;
    }
    props.setProperty(PROP_WEB_APP_URL, webAppUrl);
  }

  let secret = '';
  try {
    secret = trim_(props.getProperty(PROP_WEBHOOK_SECRET));
  } catch (e) {
    secret = '';
  }
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty(PROP_WEBHOOK_SECRET, secret);
  }

  const wh = telegramSetWebhook_(token, webAppUrl, secret);
  if (!wh.ok) {
    ui.alert('Trigger is set, but setWebhook failed: ' + wh.error + '\nCheck the pasted /exec URL (to replace it, delete the webapp_url row in Script Properties and rerun Setup).');
    return;
  }
  // Command menu is best-effort: typed commands keep working and the next
  // Setup rerun retries, so a menu failure never blocks Setup.
  telegramSetMyCommands_(token);

  if (owner) {
    ui.alert(
      'Already set up.\n' +
      'Owner is bound. Rerun does not overwrite the owner or rotate secrets.\n' +
      'New Telegram account? Use /transfer. New bot token? Use /connect.'
    );
    return;
  }

  // First bind: mint a single-use setup token for /start <token>.
  // Reused (never rotated) on pre-bind reruns; the caller reports which case.
  let setupToken = '';
  let freshSetupToken = false;
  try {
    setupToken = trim_(props.getProperty(PROP_SETUP_TOKEN));
  } catch (e) {
    setupToken = '';
  }
  if (!setupToken) {
    setupToken = Utilities.getUuid().replace(/-/g, '').substring(0, SETUP_TOKEN_LEN);
    props.setProperty(PROP_SETUP_TOKEN, setupToken);
    freshSetupToken = true;
  }

  const me = telegramGetMe_(token);
  const username = me.ok ? me.username : '';
  const link = username
    ? 'https://t.me/' + username + '?start=' + setupToken
    : '(open your bot and send: /start ' + setupToken + ')';

  if (freshSetupToken) {
    ui.alert(
      'Setup complete. Bind Telegram once:\n\n' + link + '\n\n' +
      'Open the link (or send /start ' + setupToken + ' to your bot). ' +
      'The token is single-use.'
    );
  } else {
    ui.alert(
      'Google Setup already done. Use the same link below — no new token minted:\n\n' + link + '\n\n' +
      'Open the link (or send /start ' + setupToken + ' to your bot).'
    );
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook router (T5-a router + T5-b Setup flows + T5-c rule CRUD)
// ---------------------------------------------------------------------------

/**
 * Browser GET entry. Routes two cases:
 * - ?app=<name>&t=<token> → the Mini App page for a valid owner token.
 * - anything else → the liveness text (browsers GET; Telegram POSTs to doPost).
 * No params, no secrets, no logic beyond token validation — proves the
 * deployment is live.
 */
function doGet(e) {
  try {
    const app = trim_(e && e.parameter ? e.parameter[APP_PARAM_APP] : '');
    if (app) {
      const token = trim_(e && e.parameter ? e.parameter[APP_PARAM_TOKEN] : '');
      const rec = readAppToken_(token);
      const owner = getOwnerChatId_();
      if (!rec || (rec.app && app !== rec.app) || (owner && !isAppTokenForChat_(rec, owner))) {
        return serveMiniAppError_();
      }
      return serveMiniApp_(app, token);
    }
    // HtmlService avoids the ContentService 302 path that Telegram treats
    // as a failed webhook delivery (pending_update_count retries).
    return HtmlService.createHtmlOutput('Deal Watch webhook alive. Open your bot in Telegram.');
  } catch (e) {
    return null;
  }
}

/**
 * True when the webhook secret mismatches — pure, Never throws.
 */
function hasWebhookSecretMismatch_(got, storedSecret) {
  return !!storedSecret && got !== storedSecret;
}

/**
 * True when the update body is missing — pure, Never throws.
 */
function isMissingUpdate_(update) {
  return !update;
}

/**
 * True when the message has no routable chat — pure, Never throws.
 */
function isMissingMessage_(msg) {
  return !msg || !msg.chat;
}

/**
 * True for non-DM chats (groups/channels) — pure, Never throws.
 */
function isNonPrivateChat_(chatType) {
  return chatType !== 'private';
}

/**
 * True when the message text is empty — pure, Never throws.
 */
function isEmptyText_(text) {
  return !text;
}

/**
 * True when a post-bind sender is not the owner — pure, Never throws.
 */
function isStranger_(chatId, owner) {
  return !!owner && String(chatId) !== String(owner);
}

/**
 * Telegram webhook entry. Verifies the URL secret (?secret=...), drops
 * redelivered update_ids silently (at-least-once dedup), enforces
 * DM-only + owner allowlist (silent ignore otherwise), then routes:
 * /start, /transfer, /connect, /add, /list, /interval, /status, /help,
 * /setai (+ callbacks).
 */
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    let storedSecret = '';
    try {
      storedSecret = trim_(props.getProperty(PROP_WEBHOOK_SECRET));
    } catch (err) {
      storedSecret = '';
    }
    if (storedSecret) {
      let got = '';
      try {
        got = trim_(e && e.parameter && e.parameter.secret);
      } catch (err2) {
        got = '';
      }
      if (hasWebhookSecretMismatch_(got, storedSecret)) {
        // Silent: forged/expired webhook call — never reveal the secret.
        return telegramOk_();
      }
    }

    let update = null;
    try {
      update = JSON.parse(e.postData.contents);
    } catch (err) {
      // Silent: unparseable body — nothing to route.
      return telegramOk_();
    }
    if (isMissingUpdate_(update)) {
      // Silent: empty update — nothing to route.
      return telegramOk_();
    }

    // At-least-once dedup (same update_id redelivered by retry / queue
    // flush): replays return ok silently without re-running any handler.
    try {
      if (update.update_id !== undefined && update.update_id !== null && update.update_id !== '') {
        if (isDuplicateUpdate_(update.update_id)) {
          // Silent: replayed update_id — at-least-once dedup.
          return telegramOk_();
        }
      }
    } catch (errDedup) {
      // Fail-open: process the update as normal.
    }

    if (update.callback_query) {
      handleCallback_(update.callback_query);
      return telegramOk_();
    }

    const msg = update.message;
    if (isMissingMessage_(msg)) {
      // Silent: no message to route (e.g. edited/deleted payloads).
      return telegramOk_();
    }
    const chatType = String(msg.chat.type || 'private');
    if (isNonPrivateChat_(chatType)) {
      return telegramOk_(); // Groups/channels rejected silently.
    }

    const chatId = String(msg.chat.id);
    const token = getStoredBotToken_();
    const owner = getOwnerChatId_();
    const text = trim_(msg.text);
    if (isEmptyText_(text)) {
      // Silent: empty text — nothing to route.
      return telegramOk_();
    }

    // Pre-bind: no owner yet — only /start claims the account.
    if (!owner) {
      if (/^\/start(\s|$)/.test(text)) {
        handleStart_(token, chatId, text);
      }
      // Everything else pre-bind is silently ignored.
      return telegramOk_();
    }

    // Post-bind: strangers silently ignored.
    if (isStranger_(chatId, owner)) {
      // Silent: non-owner DM — single-owner allowlist.
      return telegramOk_();
    }

    if (/^\/cancel(\s|$)/.test(text)) {
      clearConv_(chatId);
      sendTelegramToChat_(token, chatId, 'Cancelled. Nothing changed.');
      return telegramOk_();
    }

    // Owner conv continuation first (e.g. /connect awaiting new token).
    const conv = getConv_(chatId);
    if (conv && conv.step === 'await_new_token' && !/^\/\w/.test(text)) {
      handleConnectToken_(token, chatId, text, msg.message_id);
      return telegramOk_();
    }
    // Add/edit continuation (non-command text only; slash commands route below).
    if (conv && conv.step && !/^\/\w/.test(text)) {
      handleRuleConv_(token, chatId, text, conv);
      return telegramOk_();
    }

    if (/^\/start(\s|$)/.test(text)) {
      handleStart_(token, chatId, text);
    } else if (/^\/transfer(\s|$)/.test(text)) {
      handleTransferRequest_(token, chatId);
    } else if (/^\/connect(\s|$)/.test(text)) {
      handleConnectRequest_(token, chatId);
    } else if (/^\/add(\s|$)/.test(text)) {
      handleAddStart_(token, chatId);
    } else if (/^\/(list|rules)(\s|$)/.test(text)) {
      handleList_(token, chatId, 0);
    } else if (/^\/interval(\s|$)/.test(text)) {
      handleInterval_(token, chatId);
    } else if (/^\/status(\s|$)/.test(text)) {
      handleStatus_(token, chatId);
    } else if (/^\/help(\s|$)/.test(text)) {
      handleHelp_(token, chatId);
    } else if (/^\/setai(\s|$)/.test(text)) {
      handleSetAi_(token, chatId);
    } else {
      sendTelegramToChat_(
        token,
        chatId,
        'Unknown command. Available: /list, /add, /interval, /status, /help, /setai, /transfer, /connect.'
      );
    }
    return telegramOk_();
  } catch (err) {
    return telegramOk_();
  }
}

/**
 * Webhook ack — Never throws.
 */
function telegramOk_() {
  try {
    // HtmlService avoids the ContentService 302 path that Telegram treats
    // as a failed webhook delivery (pending_update_count retries).
    return HtmlService.createHtmlOutput('ok');
  } catch (e) {
    return null;
  }
}

/**
 * /start handler (bind + rate-limited Already set up).
 * Pre-bind with a valid single-use token claims ownership.
 */
function handleStart_(token, chatId, text) {
  const props = PropertiesService.getScriptProperties();
  const owner = getOwnerChatId_();
  if (owner) {
    if (String(chatId) === String(owner) && shouldReplyAlreadySetup_(chatId)) {
      sendTelegramToChat_(token, chatId, 'Already set up. Use /transfer to move accounts, /connect to replace the token.');
    }
    // Strangers: silent (caller already gated, double-guard here).
    return;
  }
  const m = String(text || '').match(/^\/start(?:\s+(\S+))?/);
  const arg = m && m[1] ? trim_(m[1]) : '';
  if (!arg) {
    sendTelegramToChat_(token, chatId, 'Welcome to Deal Watch. Open the Setup link from the Sheet (Deal Watch > Setup) and tap it, or send /start <token>.');
    return;
  }
  let expected = '';
  try {
    expected = trim_(props.getProperty(PROP_SETUP_TOKEN));
  } catch (e) {
    expected = '';
  }
  if (expected && arg === expected) {
    props.setProperty(PROP_OWNER_CHAT_ID, String(chatId));
    props.deleteProperty(PROP_SETUP_TOKEN);
    clearConv_(chatId);
    sendTelegramToChat_(
      token,
      chatId,
      'Setup complete. This account now owns the watcher.\nNew phone with the same account needs no action.'
    );
  } else {
    sendTelegramToChat_(token, chatId, 'Invalid or expired token. Rerun Deal Watch > Setup in the Sheet for a fresh link.');
  }
}

/**
 * Transfer confirm prompt — Never throws.
 */
function handleTransferRequest_(token, chatId) {
  sendTelegramToChat_(
    token,
    chatId,
    'Transfer moves this watcher to your current Telegram account.\nRules and history stay. The old account stops working.',
    {
      inline_keyboard: [[
        { text: 'Yes, move it here', callback_data: 'transfer:yes' },
        { text: 'Cancel', callback_data: 'transfer:no' }
      ]]
    }
  );
}

/**
 * Connect confirm prompt — Never throws.
 */
function handleConnectRequest_(token, chatId) {
  sendTelegramToChat_(
    token,
    chatId,
    'Connect replaces the bot token for the same Sheet.\nUse this only after you generated a new token in BotFather.\nRules and history stay.',
    {
      inline_keyboard: [[
        { text: 'Yes, replace token', callback_data: 'connect:yes' },
        { text: 'Cancel', callback_data: 'connect:no' }
      ]]
    }
  );
}

/**
 * Generic Cancel button — every prompt that mentions /cancel carries this.
 * Pure, Never throws.
 */
function cancelButton_() {
  return { text: 'Cancel', callback_data: 'cancel:all' };
}

/**
 * Single-row keyboard holding just the Cancel button — pure, Never throws.
 */
function cancelKeyboard_() {
  return { inline_keyboard: [[cancelButton_()]] };
}

/**
 * Callback router — silent, Never throws.
 */
function handleCallback_(cb) {
  try {
    const token = getStoredBotToken_();
    const owner = getOwnerChatId_();
    const fromId = cb.from ? String(cb.from.id) : '';
    const msg = cb.message || {};
    const chatId = msg.chat ? String(msg.chat.id) : fromId;
    if (!chatId || String(msg.chat && msg.chat.type || 'private') !== 'private') {
      return;
    }
    // Pre-bind callbacks: only /start claim is allowed; ignore buttons.
    if (!owner || chatId !== String(owner)) {
      // Allow the claimant to press nothing pre-bind — stay silent.
      return;
    }
    const data = String(cb.data || '');
    const qid = cb.id || '';
    const messageId = msg.message_id;

    if (data === 'transfer:yes') {
      answerTelegramCallback_(token, qid, 'Transfer confirmed');
      editTelegramMessageText_(token, chatId, messageId, 'Transfer confirmed. See the token below.');
      // The claiming account IS this chat (owner moving to a new account is
      // handled by minting a transfer token; pressing Yes here from the
      // owner account re-mints the token for the new device flow).
      // Simplest secure flow: mint a single-use token; the NEW account
      // claims it via /start <token>, which overwrites owner_chat_id.
      const transferToken = Utilities.getUuid().replace(/-/g, '').substring(0, SETUP_TOKEN_LEN);
      PropertiesService.getScriptProperties().setProperty(PROP_SETUP_TOKEN, transferToken);
      sendTelegramToChat_(
        token,
        chatId,
        'Transfer token minted (single-use). On the NEW Telegram account, open your bot and send:\n/start ' + transferToken
      );
    } else if (data === 'transfer:no') {
      answerTelegramCallback_(token, qid, 'Cancelled');
      editTelegramMessageText_(token, chatId, messageId, 'Transfer cancelled. Nothing changed.');
    } else if (data === 'connect:yes') {
      answerTelegramCallback_(token, qid, 'Send the new token');
      setConv_(chatId, { step: 'await_new_token' });
      editTelegramMessageText_(token, chatId, messageId, 'Confirmed. Paste the new token from BotFather as one message (it will be deleted right after). Send /connect again to abort.');
    } else if (data === 'connect:no') {
      answerTelegramCallback_(token, qid, 'Cancelled');
      clearConv_(chatId);
      editTelegramMessageText_(token, chatId, messageId, 'Connect cancelled. Nothing changed.');
    } else if (data === 'queue:yes') {
      answerTelegramCallback_(token, qid, 'Clearing queue');
      editTelegramMessageText_(token, chatId, messageId, 'Clearing queue...');
      clearQueueAndReattach_(token, chatId);
    } else if (data === 'queue:no') {
      answerTelegramCallback_(token, qid, 'Cancelled');
      editTelegramMessageText_(token, chatId, messageId, 'Nothing changed. I will remind you again in 12 hours if the queue is still jammed.');
    } else if (data === 'cancel:all') {
      clearConv_(chatId);
      answerTelegramCallback_(token, qid, 'Cancelled');
      const text = 'Cancelled. Nothing changed.';
      if (messageId) {
        editTelegramMessageText_(token, chatId, messageId, text);
      } else {
        sendTelegramToChat_(token, chatId, text);
      }
    } else if (data === 'add:confirm' || data === 'add:cancel' || data === 'add:uselast' || (data && data.indexOf('rule:') === 0)) {
      handleRuleCallback_(token, chatId, data, messageId, qid);
    } else if (data && data.indexOf('interval:') === 0) {
      handleIntervalCallback_(token, chatId, data.substring('interval:'.length), messageId, qid);
    } else if (data) {
      // Unknown callback: stay silent.
    }
  } catch (e) {
    // Never throw from the webhook.
  }
}

/**
 * Continuation for /connect: the owner pasted a new BotFather token.
 * Validates via getMe, stores, re-attaches the webhook, deletes the raw
 * token message immediately, and never echoes the full token.
 */
function handleConnectToken_(token, chatId, text, incomingMessageId) {
  const fresh = trim_(text);
  if (!fresh || /\s/.test(fresh) || fresh.length < TOKEN_MIN_LEN || fresh.indexOf(':') < 0) {
    sendTelegramToChat_(token, chatId, 'That does not look like a BotFather token (expected digits:letters). Paste again, or send /connect to abort.');
    return;
  }
  const check = telegramGetMe_(fresh);
  // Delete the raw secret message first, whatever the result.
  deleteTelegramMessage_(token, chatId, incomingMessageId);
  if (!check.ok) {
    sendTelegramToChat_(token, chatId, 'New token rejected (' + maskSecret_(fresh) + '): ' + check.error + ' Nothing changed.');
    return;
  }
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_BOT_TOKEN, fresh);
  } catch (e) {
    sendTelegramToChat_(token, chatId, 'Could not store the new token. Nothing changed.');
    return;
  }
  clearConv_(chatId);
  // Re-attach using the stored /exec URL (never getUrl() — it returns /dev).
  let webAppUrl = '';
  try {
    webAppUrl = trim_(PropertiesService.getScriptProperties().getProperty(PROP_WEB_APP_URL));
  } catch (e) {
    webAppUrl = '';
  }
  if (webAppUrl) {
    let secret = '';
    try {
      secret = trim_(PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_SECRET));
    } catch (e) {
      secret = '';
    }
    if (secret) {
      const wh = telegramSetWebhook_(fresh, webAppUrl, secret);
      if (!wh.ok) {
        sendTelegramToChat_(token, chatId, 'Token replaced (' + maskSecret_(fresh) + '), but setWebhook failed: ' + wh.error + ' Rerun Deal Watch > Setup in the Sheet.');
        return;
      }
    }
  }
  // Command menu follows the new token (best-effort, same as Setup).
  telegramSetMyCommands_(fresh);
  sendTelegramToChat_(token, chatId, 'Token replaced (' + maskSecret_(fresh) + '). Webhook re-attached. The old token stops working.');
}

// ---------------------------------------------------------------------------
// T6-d: Mini App plumbing (bot-issued token, doGet route, smoke page)
// ---------------------------------------------------------------------------

/**
 * Cache key for one Mini App open token — pure, Never throws.
 */
function appTokenCacheKey_(token) {
  return APP_TOKEN_CACHE_PREFIX + String(token || '');
}

/**
 * Mint a Mini App open token bound to a chat, stored in CacheService with the
 * app TTL. payload is merged into the record for purpose-specific context.
 * Returns { ok, token, error }. Never throws.
 */
function mintAppToken_(chatId, app, payload) {
  const c = trim_(chatId);
  if (!c) {
    return { ok: false, token: '', error: 'Missing chat id.' };
  }
  const token = Utilities.getUuid().replace(/-/g, '');
  const record = {
    chatId: c,
    app: String(app || ''),
    exp: new Date().getTime() + APP_TOKEN_TTL_SECONDS * MS_PER_SECOND
  };
  if (payload) {
    record.payload = payload;
  }
  try {
    CacheService.getScriptCache().put(
      appTokenCacheKey_(token),
      JSON.stringify(record),
      APP_TOKEN_TTL_SECONDS
    );
  } catch (e) {
    // CacheService is best-effort; a failed put means no valid link, not a crash.
    return { ok: false, token: '', error: 'Could not store the token.' };
  }
  return { ok: true, token: token, error: '' };
}

/**
 * Read a Mini App token record, or null when missing/tampered/expired
 * (cache may evict early, so expiry is re-checked). Never throws.
 */
function readAppToken_(token) {
  const t = trim_(token);
  if (!t) {
    return null;
  }
  let raw = null;
  try {
    raw = CacheService.getScriptCache().get(appTokenCacheKey_(t));
  } catch (e) {
    return null;
  }
  if (!raw) {
    return null;
  }
  let rec = null;
  try {
    rec = JSON.parse(raw);
  } catch (e2) {
    return null;
  }
  if (!rec || !rec.chatId) {
    return null;
  }
  if (rec.exp && new Date().getTime() > rec.exp) {
    return null;
  }
  return rec;
}

/**
 * True when the token record belongs to the given chat — pure, Never throws.
 */
function isAppTokenForChat_(rec, chatId) {
  return !!rec && String(rec.chatId) === String(trim_(chatId));
}

/**
 * Build the Mini App open URL (?app=<name>&t=<token>) from the stored /exec
 * URL. Returns '' when webapp_url is missing. Never throws.
 */
function buildMiniAppUrl_(app, token) {
  let base = '';
  try {
    base = trim_(PropertiesService.getScriptProperties().getProperty(PROP_WEB_APP_URL));
  } catch (e) {
    base = '';
  }
  if (!base) {
    return '';
  }
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  return base + sep + APP_PARAM_APP + '=' + encodeURIComponent(String(app || '')) +
    '&' + APP_PARAM_TOKEN + '=' + encodeURIComponent(String(token || ''));
}

/**
 * Serve the Mini App HTML, injecting the view + token as template vars (the
 * page cannot read its own query string inside the Apps Script iframe).
 * Never throws.
 */
function serveMiniApp_(app, token) {
  const tmpl = HtmlService.createTemplateFromFile('MiniApp');
  tmpl.appName = MINI_APP_TITLE;
  tmpl.view = String(app || '');
  tmpl.appToken = String(token || '');
  // Apps Script ignores meta tags written in the HTML file; only addMetaTag
  // reaches the served page, so the mobile viewport must be set here.
  // ALLOWALL drops the default X-Frame-Options so desktop/web Telegram clients
  // (which load the Mini App inside a frame) can display it instead of the
  // browser's xframe-neterror-page; the minted token + owner check is the guard.
  return tmpl.evaluate().setTitle(MINI_APP_TITLE).addMetaTag('viewport', MINI_APP_VIEWPORT)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Minimal HTML error page for a missing/expired/tampered app token — Never throws.
 */
function serveMiniAppError_() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8">' +
    '<body style="font-family:sans-serif;padding:24px">' +
    '<h3>Link expired</h3><p>Open the app again from Telegram.</p></body>'
  ).addMetaTag('viewport', MINI_APP_VIEWPORT)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Mini App entry point (T6-d smoke): echoes a validated token's app so the
 * owner can confirm the page → backend channel works. Returns
 * { ok, app, serverTime } or { ok:false, error }. Never throws.
 */
function appEcho(appToken) {
  const rec = readAppToken_(appToken);
  const owner = getOwnerChatId_();
  if (!rec || (owner && !isAppTokenForChat_(rec, owner))) {
    return { ok: false, error: 'Invalid or expired session.' };
  }
  return { ok: true, app: String(rec.app || ''), serverTime: new Date().toISOString() };
}

/**
 * Sheet menu (temporary, T6-d): mint an open token and send the owner a
 * web_app button that opens the Mini App smoke page. Never throws.
 */
function sendMiniAppTest() {
  const ui = SpreadsheetApp.getUi();
  const token = getStoredBotToken_();
  const owner = getOwnerChatId_();
  if (!token || !owner) {
    ui.alert('Not set up yet. Run Deal Watch > Setup first.');
    return;
  }
  const minted = mintAppToken_(owner, APP_SMOKE, null);
  if (!minted.ok) {
    ui.alert('Could not mint the token: ' + minted.error);
    return;
  }
  const url = buildMiniAppUrl_(APP_SMOKE, minted.token);
  if (!url) {
    ui.alert('Missing webapp_url. Rerun Setup and paste the /exec URL.');
    return;
  }
  const sent = sendTelegramToChat_(
    token,
    owner,
    'Mini App smoke test — tap to open.',
    { inline_keyboard: [[{ text: 'Open Mini App', web_app: { url: url } }]] }
  );
  ui.alert(sent.ok ? 'Sent. Open Telegram and tap the button.' : 'Send failed: ' + sent.error);
}

/**
 * Mint a token for a Mini App view and send them a web_app button to open it.
 * Returns { ok, error }; error never contains the token. Never throws.
 */
function sendMiniAppOpen_(token, chatId, view, text, label) {
  const minted = mintAppToken_(chatId, view, null);
  if (!minted.ok) {
    return { ok: false, error: minted.error };
  }
  const url = buildMiniAppUrl_(view, minted.token);
  if (!url) {
    return { ok: false, error: 'Missing webapp_url. Rerun Setup and paste the /exec URL.' };
  }
  const sent = sendTelegramToChat_(
    token,
    chatId,
    text,
    { inline_keyboard: [[{ text: String(label || 'Open'), web_app: { url: url } }]] }
  );
  return sent && sent.ok ? { ok: true, error: '' } : { ok: false, error: (sent && sent.error) || 'Send failed.' };
}

/**
 * /setai — open the Mini App Settings (OpenRouter key + model). Never throws.
 */
function handleSetAi_(token, chatId) {
  const res = sendMiniAppOpen_(
    token,
    chatId,
    MINI_APP_VIEW_SETTINGS,
    'Manage your OpenRouter key and model in Settings. Suggestions: ' + (isSuggestionEnabled_() ? 'on' : 'off') + '.',
    'Open settings'
  );
  if (!res.ok) {
    sendTelegramToChat_(token, chatId, 'Could not open settings: ' + res.error);
  }
}

// ---------------------------------------------------------------------------
// T6-f/T6-g: Mini App Settings — key + model (token-guarded entries)
// ---------------------------------------------------------------------------

/**
 * Validate a Mini App open token against the owner. Returns the owner chat id
 * (or the record's chat id when no owner is set yet), or '' when invalid.
 * Never throws.
 */
function miniAppOwner_(appToken) {
  const rec = readAppToken_(appToken);
  if (!rec) {
    return '';
  }
  const owner = getOwnerChatId_();
  if (owner && !isAppTokenForChat_(rec, owner)) {
    return '';
  }
  return owner || String(rec.chatId || '');
}

/**
 * Current Settings state for the Mini App: model, whether a key is stored, the
 * masked key, and whether suggestions are on. The secret is never exposed raw.
 * Never throws.
 */
function miniAppState_() {
  const key = getOpenRouterKey_();
  return {
    model: getLlmModel_(),
    hasKey: !!key,
    keyMasked: key ? maskSecret_(key) : '',
    suggestions: isSuggestionEnabled_()
  };
}

/**
 * Mini App entry: current Settings state. Returns { ok, state, error }.
 * Never throws.
 */
function miniAppGetState(appToken) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  return { ok: true, state: miniAppState_(), error: '' };
}

/**
 * Mini App entry: search the cached model list. query narrows by id/name
 * ('' = whole list), freeOnly keeps free models only. Results are capped.
 * Returns { ok, items, state, error }. Never throws.
 */
function miniAppGetModels(appToken, query, freeOnly) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, items: [], state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  const meta = getModelMetaCached_();
  if (!meta.ok) {
    return { ok: false, items: [], state: miniAppState_(), error: meta.error };
  }
  let items = searchModelMeta_(meta.items, query);
  if (freeOnly === true) {
    const free = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].free) {
        free.push(items[i]);
      }
    }
    items = free;
  }
  if (items.length > MINI_APP_MODEL_RESULT_MAX) {
    items = items.slice(0, MINI_APP_MODEL_RESULT_MAX);
  }
  return { ok: true, items: items, state: miniAppState_(), error: '' };
}

/**
 * Mini App entry: store a model id (validated against the cached list when the
 * list is available). Returns { ok, state, error }. Never throws.
 */
function miniAppSetModel(appToken, modelId) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  const id = trim_(modelId);
  if (!id) {
    return { ok: false, state: miniAppState_(), error: 'Pick a model first.' };
  }
  const meta = getModelMetaCached_();
  if (meta.ok) {
    let found = false;
    for (let i = 0; i < meta.items.length; i++) {
      if (meta.items[i].id === id) {
        found = true;
        break;
      }
    }
    if (!found) {
      return { ok: false, state: miniAppState_(), error: 'That model is not in the current list. Search again.' };
    }
  }
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_LLM_MODEL, id);
  } catch (e) {
    return { ok: false, state: miniAppState_(), error: 'Could not store the model. Nothing changed.' };
  }
  return { ok: true, state: miniAppState_(), error: '' };
}

/**
 * Mini App entry: clear the stored model (suggestions turn off). Returns
 * { ok, state, error }. Never throws.
 */
function miniAppClearModel(appToken) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  try {
    PropertiesService.getScriptProperties().deleteProperty(PROP_LLM_MODEL);
  } catch (e) {
    return { ok: false, state: miniAppState_(), error: 'Could not clear the model. Nothing changed.' };
  }
  return { ok: true, state: miniAppState_(), error: '' };
}

/**
 * Mini App entry: validate an OpenRouter key (GET /key) then store it. The key
 * is masked in replies and never echoed raw. Returns { ok, state, error }.
 * Never throws.
 */
function miniAppSetKey(appToken, key) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  const raw = trim_(key);
  if (!raw || /\s/.test(raw)) {
    return { ok: false, state: miniAppState_(), error: 'That does not look like an API key.' };
  }
  const check = openRouterValidateKey_(raw);
  if (!check.ok) {
    return { ok: false, state: miniAppState_(), error: 'Key rejected (' + maskSecret_(raw) + '): ' + check.error };
  }
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_OPENROUTER_KEY, raw);
  } catch (e) {
    return { ok: false, state: miniAppState_(), error: 'Could not store the key. Nothing changed.' };
  }
  return { ok: true, state: miniAppState_(), error: '' };
}

/**
 * Mini App entry: delete the stored OpenRouter key (suggestions turn off).
 * Returns { ok, state, error }. Never throws.
 */
function miniAppDeleteKey(appToken) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  try {
    PropertiesService.getScriptProperties().deleteProperty(PROP_OPENROUTER_KEY);
  } catch (e) {
    return { ok: false, state: miniAppState_(), error: 'Could not remove the key. Nothing changed.' };
  }
  return { ok: true, state: miniAppState_(), error: '' };
}

// ---------------------------------------------------------------------------
// T6-h: Mini App Ideas view (seed -> suggestions -> hand back to chat confirm)
// ---------------------------------------------------------------------------

/**
 * Mini App entry: keyword suggestions for a seed. exclude (array of already
 * shown keywords) switches to the "more ideas" prompt and skips the seed cache.
 * Returns { ok, items, state, error }. Never throws.
 */
function miniAppSuggest(appToken, seed, exclude) {
  if (!miniAppOwner_(appToken)) {
    return { ok: false, items: [], state: miniAppState_(), error: 'Invalid or expired session.' };
  }
  const s = trim_(seed);
  if (!s) {
    return { ok: false, items: [], state: miniAppState_(), error: 'Type a topic first.' };
  }
  if (!isSuggestionEnabled_()) {
    return { ok: false, items: [], state: miniAppState_(), error: 'Suggestions are off. Set an OpenRouter key and model.' };
  }
  const ex = (exclude && exclude.length) ? exclude : null;
  if (!ex) {
    const cached = getCachedSuggestions_(s);
    if (cached) {
      return { ok: true, items: cached, state: miniAppState_(), error: '' };
    }
  }
  const res = callOpenRouter_(
    getOpenRouterKey_(),
    getLlmModel_(),
    s,
    ex ? buildMoreIdeasPrompt_(s, ex) : null
  );
  if (!res.ok) {
    return { ok: false, items: [], state: miniAppState_(), error: res.error };
  }
  if (!ex) {
    putCachedSuggestions_(s, res.items);
  }
  return { ok: true, items: res.items, state: miniAppState_(), error: '' };
}

/**
 * Mini App entry: hand the picked keywords back to the live chat conversation
 * and show the matching confirm prompt there. Rule creation still requires the
 * user's Confirm tap in chat. Returns { ok, error }. Never throws.
 */
function miniAppIdeasAdd(appToken, seed, keywords) {
  const owner = miniAppOwner_(appToken);
  if (!owner) {
    return { ok: false, error: 'Invalid or expired session.' };
  }
  const botToken = getStoredBotToken_();
  if (!botToken) {
    return { ok: false, error: 'Bot is not set up.' };
  }
  const picked = [];
  if (keywords && keywords.length) {
    for (let i = 0; i < keywords.length; i++) {
      const k = trim_(keywords[i]);
      if (k) {
        picked.push(k);
      }
    }
  }
  if (!picked.length) {
    return { ok: false, error: 'Select at least one keyword.' };
  }
  const conv = getConv_(owner);
  const step = conv && conv.step ? String(conv.step) : '';
  if (step !== 'await_keywords' && step !== 'await_dup_keywords' && step !== 'await_edit_keywords') {
    return { ok: false, error: 'Session expired. Send /add in the chat to restart.' };
  }
  const keywordsRaw = picked.join(', ');
  const usedSeed = trim_(seed);
  const mode = modeOfKeywordsStep_(step);
  if (mode === 'add') {
    const sender = trim_(conv.sender);
    setConv_(owner, { step: 'await_confirm', sender: sender, keywordsRaw: keywordsRaw, seed: usedSeed, usedSuggestion: true });
    showAddConfirm_(botToken, owner, sender, keywordsRaw);
    return { ok: true, error: '' };
  }
  if (mode === 'dup') {
    const target = findRuleById_(conv.ruleId);
    if (!target) {
      return { ok: false, error: 'Rule not found. Send /list in the chat to refresh.' };
    }
    setConv_(owner, { step: 'await_dup_confirm', ruleId: target.id, sender: target.sender, keywordsRaw: keywordsRaw, seed: usedSeed, usedSuggestion: true });
    showDupConfirm_(botToken, owner, target, keywordsRaw);
    return { ok: true, error: '' };
  }
  if (mode === 'edit') {
    const target = findRuleById_(conv.ruleId);
    if (!target) {
      return { ok: false, error: 'Rule not found. Send /list in the chat to refresh.' };
    }
    setConv_(owner, { step: 'await_edit_confirm', ruleId: target.id, keywordsRaw: keywordsRaw, seed: usedSeed, usedSuggestion: true });
    showEditConfirm_(botToken, owner, target, keywordsRaw);
    return { ok: true, error: '' };
  }
  return { ok: false, error: 'Session expired. Send /add in the chat to restart.' };
}

// ---------------------------------------------------------------------------
// T6-a: OpenRouter key/model storage + validation — secrets never echoed
// ---------------------------------------------------------------------------

/**
 * Stored OpenRouter API key or '' — Never throws.
 */
function getOpenRouterKey_() {
  try {
    return trim_(PropertiesService.getScriptProperties().getProperty(PROP_OPENROUTER_KEY));
  } catch (e) {
    return '';
  }
}

/**
 * Stored OpenRouter model id or '' — Never throws.
 */
function getLlmModel_() {
  try {
    return trim_(PropertiesService.getScriptProperties().getProperty(PROP_LLM_MODEL));
  } catch (e) {
    return '';
  }
}

/**
 * Model id for user-facing display ('none' when unset) — Never throws.
 */
function currentModelLabel_() {
  return getLlmModel_() || 'none';
}

/**
 * Validate an OpenRouter key via GET /key (Bearer auth). Never logs or echoes
 * the key; errors are redacted. Returns { ok, error }. Never throws.
 */
function openRouterValidateKey_(key) {
  const k = trim_(key);
  if (!k) {
    return { ok: false, error: 'Empty key.' };
  }
  try {
    const resp = UrlFetchApp.fetch(
      OPENROUTER_API_BASE + '/key',
      {
        method: 'get',
        headers: { Authorization: 'Bearer ' + k },
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    if (code === 401 || code === 403) {
      return { ok: false, error: 'rejected (HTTP ' + code + ')' };
    }
    if (code < HTTP_OK_MIN || code >= HTTP_OK_MAX) {
      return { ok: false, error: 'HTTP ' + code };
    }
    return { ok: true, error: '' };
  } catch (e) {
    let msg = e && e.message ? String(e.message) : String(e);
    msg = redactToken_(msg, k);
    return { ok: false, error: truncateDebug_(msg) };
  }
}

// ---------------------------------------------------------------------------
// T6-e: model metadata cache + ordering (picker + reasoning-off decision)
// ---------------------------------------------------------------------------

/**
 * True for dynamic router pseudo-models (openrouter/auto, openrouter/free, …)
 * whose actual model is unknown per request — pure, Never throws.
 */
function isRouterModelId_(id) {
  return String(id || '').indexOf(MODEL_ROUTER_PREFIX) === 0;
}

/**
 * Classify a model's reasoning behaviour from its /models entry: 'mandatory'
 * (always thinks), 'optional' (can be turned off), or 'none'. Pure, Never throws.
 */
function modelReasoningKind_(model) {
  const r = model && model.reasoning;
  if (!r) {
    return MODEL_REASONING_NONE;
  }
  return r.mandatory === true ? MODEL_REASONING_MANDATORY : MODEL_REASONING_OPTIONAL;
}

/**
 * True when both prompt and completion prices are "0" — pure, Never throws.
 */
function isFreeModelPricing_(pricing) {
  const p = pricing || {};
  return String(p.prompt) === '0' && String(p.completion) === '0';
}

/**
 * True when the model outputs text (excludes image/audio-only models) — pure,
 * Never throws.
 */
function hasTextOutput_(architecture) {
  const outs = architecture && architecture.output_modalities;
  return !!(outs && outs.indexOf && outs.indexOf('text') >= 0);
}

/**
 * Slim the public /models entries into the pickable set: drop dynamic routers
 * and non-text models; keep id/name/free/reasoning. Pure, Never throws.
 */
function buildSlimModelMeta_(rawModels) {
  const out = [];
  if (!rawModels || !rawModels.length) {
    return out;
  }
  for (let i = 0; i < rawModels.length; i++) {
    const m = rawModels[i] || {};
    const id = m.id ? String(m.id) : '';
    if (!id || isRouterModelId_(id) || !hasTextOutput_(m.architecture)) {
      continue;
    }
    out.push({
      id: id,
      name: m.name ? String(m.name) : '',
      free: isFreeModelPricing_(m.pricing),
      reasoning: modelReasoningKind_(m)
    });
  }
  return out;
}

/**
 * Sort for display: non-mandatory reasoning first (faster), mandatory last;
 * within a tier free first, then name (fallback id). Returns a new array.
 * Pure, Never throws.
 */
function sortModelMeta_(entries) {
  const list = (entries || []).slice();
  list.sort(function (a, b) {
    const am = a.reasoning === MODEL_REASONING_MANDATORY ? 1 : 0;
    const bm = b.reasoning === MODEL_REASONING_MANDATORY ? 1 : 0;
    if (am !== bm) {
      return am - bm;
    }
    const af = a.free ? 0 : 1;
    const bf = b.free ? 0 : 1;
    if (af !== bf) {
      return af - bf;
    }
    const an = String(a.name || a.id || '').toLowerCase();
    const bn = String(b.name || b.id || '').toLowerCase();
    if (an < bn) {
      return -1;
    }
    if (an > bn) {
      return 1;
    }
    return 0;
  });
  return list;
}

/**
 * Filter + sort for a search box: case-insensitive substring on id or name.
 * Empty query returns the whole sorted list. Pure, Never throws.
 */
function searchModelMeta_(entries, query) {
  const q = trim_(query).toLowerCase();
  const list = entries || [];
  if (!q) {
    return sortModelMeta_(list);
  }
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    const id = String(e.id || '').toLowerCase();
    const name = String(e.name || '').toLowerCase();
    if (id.indexOf(q) >= 0 || name.indexOf(q) >= 0) {
      hits.push(e);
    }
  }
  return sortModelMeta_(hits);
}

/**
 * Fetch the public OpenRouter model list and slim it. Returns the pickable
 * entries, or null when the list cannot be read. Public endpoint (no key, no
 * cost). Never throws.
 */
function fetchModelMeta_() {
  try {
    const resp = UrlFetchApp.fetch(
      OPENROUTER_API_BASE + '/models',
      { method: 'get', muteHttpExceptions: true }
    );
    const code = resp.getResponseCode();
    if (code < HTTP_OK_MIN || code >= HTTP_OK_MAX) {
      return null;
    }
    const data = JSON.parse(resp.getContentText());
    if (!data || !data.data || !data.data.length) {
      return null;
    }
    const items = buildSlimModelMeta_(data.data);
    return items.length ? items : null;
  } catch (e) {
    return null;
  }
}

/**
 * Cached pickable model list (CacheService, 6h; best-effort — refetches on
 * miss or early eviction). Returns { ok, items, error }. Never throws.
 */
function getModelMetaCached_() {
  let raw = null;
  try {
    raw = CacheService.getScriptCache().get(MODEL_META_CACHE_KEY);
  } catch (e) {
    raw = null;
  }
  if (raw) {
    try {
      const cached = JSON.parse(raw);
      if (cached && cached.length) {
        return { ok: true, items: cached, error: '' };
      }
    } catch (e2) {
      // Corrupt cache entry: fall through and refetch.
    }
  }
  const fresh = fetchModelMeta_();
  if (!fresh) {
    return { ok: false, items: [], error: 'Could not read the OpenRouter model list. Try again later.' };
  }
  try {
    CacheService.getScriptCache().put(
      MODEL_META_CACHE_KEY,
      JSON.stringify(fresh),
      MODEL_META_CACHE_TTL_SECONDS
    );
  } catch (e3) {
    // Cache put is best-effort; return the fresh list anyway.
  }
  return { ok: true, items: fresh, error: '' };
}

/**
 * Reasoning kind for one model id from the cached metadata, or '' when the id
 * is unknown. Used to decide whether reasoning can be turned off at call time.
 * Never throws.
 */
function getModelReasoningKind_(id) {
  const want = trim_(id);
  if (!want) {
    return '';
  }
  const meta = getModelMetaCached_();
  if (!meta.ok) {
    return '';
  }
  for (let i = 0; i < meta.items.length; i++) {
    if (meta.items[i].id === want) {
      return meta.items[i].reasoning;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// T6-b: OpenRouter suggestion client (fenced: seed-only, one call, cached 6h)
// ---------------------------------------------------------------------------

/**
 * Build the suggestion prompt from the user seed only. Never includes email
 * content, sender, or rule data. Pure, Never throws.
 */
function buildSuggestionPrompt_(seed) {
  const s = trim_(seed);
  return 'Suggest email watch keywords.\n' +
    'Topic the user cares about: "' + s + '".\n' +
    'Return ' + SUGGESTION_COUNT + ' short keyword or phrase ideas that would appear in promotional emails about this topic.\n' +
    'Rules:\n' +
    '- Output ONLY a comma-separated list of keywords, nothing else.\n' +
    '- Keep each keyword short (1-3 words).\n' +
    '- Include English and Traditional Chinese variants when natural.\n' +
    '- No numbering, no quotes, no explanation.';
}

/**
 * Parse a model reply into clean, deduped keywords (comma/newline separated,
 * list markers and surrounding quotes stripped), capped at SUGGESTION_COUNT.
 * Leading digits are preserved so seeds like "5折" survive. Pure, Never throws.
 */
function parseSuggestions_(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw);
  const parts = text.split(/[\n,;]+/);
  const out = [];
  const seen = {};
  for (let i = 0; i < parts.length; i++) {
    let s = trim_(parts[i]);
    s = s.replace(/^[-\*\u2022]\s+/, '');
    s = s.replace(/^\d+[.)\]]\s+/, '');
    s = s.replace(/^["'`]+/, '');
    s = s.replace(/["'`]+$/, '');
    s = trim_(s);
    if (!s) {
      continue;
    }
    const key = s.toLowerCase();
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    out.push(s);
    if (out.length >= SUGGESTION_COUNT) {
      break;
    }
  }
  return out;
}

/**
 * Cache key for a seed (lowercased, short deterministic hash) — pure, Never throws.
 */
function suggestCacheKey_(seed) {
  const s = trim_(seed).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return 'suggest_' + (h >>> 0).toString(36) + '_' + s.length;
}

/**
 * Cached suggestion list for a seed, or null — Never throws.
 */
function getCachedSuggestions_(seed) {
  try {
    const raw = CacheService.getScriptCache().get(suggestCacheKey_(seed));
    if (!raw) {
      return null;
    }
    const arr = JSON.parse(raw);
    return arr && arr.length ? arr : null;
  } catch (e) {
    return null;
  }
}

/**
 * Store a suggestion list for a seed (~6h) — Never throws (best-effort).
 */
function putCachedSuggestions_(seed, items) {
  try {
    if (items && items.length) {
      CacheService.getScriptCache().put(suggestCacheKey_(seed), JSON.stringify(items), SUGGEST_CACHE_TTL_SECONDS);
    }
  } catch (e) {
    // Caching is best-effort; a miss just costs one more call.
  }
}

/**
 * Map an OpenRouter HTTP code to a short English error — pure, Never throws.
 * '' means success.
 */
function mapOpenRouterError_(code) {
  if (code >= HTTP_OK_MIN && code < HTTP_OK_MAX) {
    return '';
  }
  if (code === 401 || code === 403) {
    return 'OpenRouter rejected the key. Use /setai to replace it.';
  }
  if (code === 402) {
    return 'OpenRouter says out of credit.';
  }
  if (code === 429) {
    return 'OpenRouter rate-limited, try again later.';
  }
  return 'OpenRouter error, try again.';
}

/**
 * Build the /chat/completions request payload. Reasoning is turned off only
 * for models we know allow it (optional/none); mandatory and unknown models
 * omit the field so the model does not reject the request (400). max_tokens is
 * always capped. Reads cached model metadata; Never throws.
 */
function buildChatRequestPayload_(model, prompt) {
  const payload = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: SUGGESTION_MAX_TOKENS
  };
  const kind = getModelReasoningKind_(model);
  if (kind === MODEL_REASONING_OPTIONAL || kind === MODEL_REASONING_NONE) {
    payload.reasoning = { enabled: false, exclude: true };
  }
  return payload;
}

/**
 * One OpenRouter /chat/completions call for the seed only. promptOverride
 * replaces the default seed prompt (used by [More ideas] to exclude repeats).
 * Never logs or echoes the key; errors are mapped to short English. Returns
 * { ok, items, error }. Never throws.
 */
function callOpenRouter_(key, model, seed, promptOverride) {
  const k = trim_(key);
  const m = trim_(model);
  if (!k || !m) {
    return { ok: false, items: [], error: 'Set an OpenRouter key and model first (/setai).' };
  }
  const prompt = promptOverride ? String(promptOverride) : buildSuggestionPrompt_(seed);
  try {
    const resp = UrlFetchApp.fetch(
      OPENROUTER_API_BASE + '/chat/completions',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + k },
        payload: JSON.stringify(buildChatRequestPayload_(m, prompt)),
        muteHttpExceptions: true
      }
    );
    const mapped = mapOpenRouterError_(resp.getResponseCode());
    if (mapped) {
      return { ok: false, items: [], error: mapped };
    }
    let content = '';
    try {
      const data = JSON.parse(resp.getContentText());
      content = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '')
        : '';
    } catch (e2) {
      content = '';
    }
    const items = parseSuggestions_(content);
    if (!items.length) {
      return { ok: false, items: [], error: 'OpenRouter returned no suggestions. Try again.' };
    }
    return { ok: true, items: items, error: '' };
  } catch (e) {
    return { ok: false, items: [], error: 'OpenRouter error, try again.' };
  }
}

// ---------------------------------------------------------------------------
// T6-c: keyword ideas ([Need ideas?] opens the Mini App Ideas view; topic_hint)
// ---------------------------------------------------------------------------

/**
 * True when both key and model are set — suggestions enabled. Never throws.
 */
function isSuggestionEnabled_() {
  return !!getOpenRouterKey_() && !!getLlmModel_();
}

/**
 * Map a keywords-step conv to its mode ('add' | 'dup' | 'edit') — pure, Never throws.
 */
function modeOfKeywordsStep_(step) {
  if (step === 'await_dup_keywords') {
    return 'dup';
  }
  if (step === 'await_edit_keywords') {
    return 'edit';
  }
  return 'add';
}

/**
 * [Need ideas?] web_app button that opens the Mini App Ideas view for this chat,
 * or null when suggestions are off or the URL cannot be built. Mints a fresh
 * open token on every call. Never throws.
 */
function ideaButtonRow_(chatId) {
  if (!isSuggestionEnabled_()) {
    return null;
  }
  const minted = mintAppToken_(chatId, MINI_APP_VIEW_IDEAS, null);
  if (!minted.ok) {
    return null;
  }
  const url = buildMiniAppUrl_(MINI_APP_VIEW_IDEAS, minted.token);
  if (!url) {
    return null;
  }
  return { text: 'Need ideas?', web_app: { url: url } };
}

/**
 * "More ideas" prompt: seed prompt + exclusion of already-shown keywords.
 * Pure, Never throws.
 */
function buildMoreIdeasPrompt_(seed, exclusions) {
  const ex = (exclusions || []).join(', ');
  return buildSuggestionPrompt_(seed) +
    '\n- Do NOT repeat any of these already-suggested keywords: ' + ex + '.';
}

/**
 * Dup-sender keywords prompt (with [Need ideas?] when enabled) — Never throws.
 */
function showDupKeywordsPrompt_(token, chatId, dup) {
  const rows = [];
  const idea = ideaButtonRow_(chatId);
  if (idea) {
    rows.push([idea]);
  }
  if (getLastRule_()) {
    rows.push([{ text: 'Use last keywords', callback_data: 'add:uselast' }]);
  }
  rows.push([{ text: 'Cancel', callback_data: 'add:cancel' }]);
  sendTelegramToChat_(
    token,
    chatId,
    'That sender is already watched (keywords: ' + dup.keywordsRaw + '). Send new keywords to update it, or /cancel.',
    { inline_keyboard: rows }
  );
}

/**
 * Edit-keywords prompt (with [Need ideas?] when enabled) — Never throws.
 */
function showEditKeywordsPrompt_(token, chatId, rule) {
  const rows = [];
  const idea = ideaButtonRow_(chatId);
  if (idea) {
    rows.push([idea]);
  }
  rows.push([{ text: 'Cancel', callback_data: 'add:cancel' }]);
  sendTelegramToChat_(
    token,
    chatId,
    'Editing keywords for ' + rule.sender + ' (current: ' + rule.keywordsRaw + '). Send new keywords, or /cancel.',
    { inline_keyboard: rows }
  );
}

/**
 * Edit-keywords confirm (Q2=a: save requires an explicit tap) — Never throws.
 */
function showEditConfirm_(token, chatId, rule, keywordsRaw) {
  const text = 'Save keywords for ' + rule.sender + '?\nCurrent: ' + rule.keywordsRaw + '\nNew: ' + keywordsRaw + '\nSend different keywords to edit, or /cancel.';
  sendTelegramToChat_(token, chatId, text, {
    inline_keyboard: [[
      { text: 'Save', callback_data: 'add:confirm' },
      { text: 'Cancel', callback_data: 'add:cancel' }
    ]]
  });
}

// ---------------------------------------------------------------------------
// T5-c: rule CRUD Telegram flows (English-first; conv_<chat_id> 10-min TTL)
// ---------------------------------------------------------------------------

/**
 * Start add-rule flow (1/3 sender) — Never throws.
 */
function handleAddStart_(token, chatId) {
  const rules = loadAllRules_();
  if (isRuleLimitReached_(rules)) {
    sendTelegramToChat_(token, chatId, 'Rule limit reached (30 enabled). Disable or delete a rule before adding.');
    return;
  }
  setConv_(chatId, { step: 'await_sender' });
  sendTelegramToChat_(
    token,
    chatId,
    'Add rule (1/3): send the sender - a domain (xxx.com) or full email (abc@xxx.com). Send /cancel to abort.',
    { inline_keyboard: [[{ text: 'Cancel', callback_data: 'add:cancel' }]] }
  );
}

/**
 * Send one /list page as a new message — Never throws.
 */
function handleList_(token, chatId, page) {
  showListPage_(token, chatId, page, null);
}

/**
 * Clamp a list page into range — pure, Never throws.
 */
function clampListPage_(page, totalPages) {
  let p = parseInt(String(page), 10);
  if (!(p >= 0)) {
    p = 0;
  }
  if (p > totalPages - 1) {
    p = totalPages - 1;
  }
  if (p < 0) {
    p = 0;
  }
  return p;
}

/**
 * Build list page text + keyboard — pure, Never throws.
 */
function buildListPage_(rules, page) {
  const total = rules ? rules.length : 0;
  if (!total) {
    return { text: 'No rules yet. Send /add to create one.', keyboard: null, totalPages: 1, page: 0 };
  }
  let totalPages = Math.ceil(total / LIST_PAGE_SIZE);
  if (!(totalPages > 0)) {
    totalPages = 1;
  }
  const p = clampListPage_(page, totalPages);
  const start = p * LIST_PAGE_SIZE;
  const end = Math.min(start + LIST_PAGE_SIZE, total);
  const lines = ['Rules (page ' + (p + 1) + '/' + totalPages + '):'];
  const keyboard = [];
  let row = [];
  for (let i = start; i < end; i++) {
    const n = i - start + 1;
    const r = rules[i];
    lines.push(n + '. ' + r.sender + ' - ' + r.keywordsRaw + ' [' + (r.enabled ? 'ON' : 'OFF') + ']');
    row.push({ text: String(n), callback_data: 'rule:view:' + r.id });
    if (row.length >= LIST_BUTTONS_PER_ROW) {
      keyboard.push(row);
      row = [];
    }
  }
  if (row.length) {
    keyboard.push(row);
  }
  const nav = [];
  if (p > 0) {
    nav.push({ text: 'Prev', callback_data: 'rule:list:' + (p - 1) });
  }
  if (p < totalPages - 1) {
    nav.push({ text: 'Next', callback_data: 'rule:list:' + (p + 1) });
  }
  if (nav.length) {
    keyboard.push(nav);
  }
  return { text: lines.join('\n'), keyboard: keyboard.length ? { inline_keyboard: keyboard } : null, totalPages: totalPages, page: p };
}

/**
 * Show one /list page (new message, or edit in place when messageId given) — Never throws.
 */
function showListPage_(token, chatId, page, messageId) {
  const rules = loadAllRules_();
  const built = buildListPage_(rules, page);
  if (messageId) {
    editTelegramMessageText_(token, chatId, messageId, built.text, built.keyboard);
  } else {
    sendTelegramToChat_(token, chatId, built.text, built.keyboard);
  }
}

/**
 * Build rule detail text + keyboard — pure, Never throws.
 */
function buildRuleDetail_(rule) {
  const text = 'Rule:\nSender: ' + rule.sender + '\nKeywords: ' + rule.keywordsRaw + '\nStatus: ' + (rule.enabled ? 'Enabled' : 'Disabled') + '\nUpdated: ' + (rule.updatedAt || '-');
  const keyboard = {
    inline_keyboard: [
      [{ text: rule.enabled ? 'Disable' : 'Enable', callback_data: 'rule:toggle:' + rule.id }],
      [
        { text: 'Edit keywords', callback_data: 'rule:ekey:' + rule.id },
        { text: 'Edit sender', callback_data: 'rule:esender:' + rule.id }
      ],
      [
        { text: 'Delete', callback_data: 'rule:del:' + rule.id },
        { text: 'Back to list', callback_data: 'rule:back:0' }
      ]
    ]
  };
  return { text: text, keyboard: keyboard };
}

/**
 * Send one rule detail as a new message — Never throws.
 */
function sendRuleDetail_(token, chatId, id) {
  const rule = findRuleById_(id);
  if (!rule) {
    sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
    return;
  }
  const built = buildRuleDetail_(rule);
  sendTelegramToChat_(token, chatId, built.text, built.keyboard);
}

/**
 * Keywords prompt (2/3) with [Use last keywords] when a prior rule exists — Never throws.
 */
function showAddKeywordsPrompt_(token, chatId, sender) {
  const text = 'Add rule (2/3) for ' + sender + ': send keywords, comma-separated (OR). Example: air, 5折, "exact phrase". Send /cancel to abort.';
  const rows = [];
  const idea = ideaButtonRow_(chatId);
  if (idea) {
    rows.push([idea]);
  }
  if (getLastRule_()) {
    rows.push([{ text: 'Use last keywords', callback_data: 'add:uselast' }]);
  }
  rows.push([{ text: 'Cancel', callback_data: 'add:cancel' }]);
  sendTelegramToChat_(token, chatId, text, { inline_keyboard: rows });
}

/**
 * Show add confirm (3/3) for a new sender — Never throws.
 */
function showAddConfirm_(token, chatId, sender, keywordsRaw) {
  const text = 'Add rule (3/3):\nSender: ' + sender + '\nKeywords: ' + keywordsRaw + '\nConfirm? Or send new keywords to edit before confirming.';
  sendTelegramToChat_(
    token,
    chatId,
    text,
    { inline_keyboard: [[{ text: 'Confirm', callback_data: 'add:confirm' }, { text: 'Cancel', callback_data: 'add:cancel' }]] }
  );
}

/**
 * Show update confirm for a duplicate sender — Never throws.
 */
function showDupConfirm_(token, chatId, rule, keywordsRaw) {
  const text = 'That sender is already watched:\nSender: ' + rule.sender + '\nKeywords: ' + rule.keywordsRaw + ' -> ' + keywordsRaw + '\nUpdate it? Or send different keywords, or /cancel.';
  sendTelegramToChat_(
    token,
    chatId,
    text,
    { inline_keyboard: [[{ text: 'Confirm update', callback_data: 'add:confirm' }, { text: 'Cancel', callback_data: 'add:cancel' }]] }
  );
}

/**
 * Route non-command text for pending add/edit conversations — Never throws.
 */
function handleRuleConv_(token, chatId, text, conv) {
  const step = conv && conv.step ? String(conv.step) : '';
  if (step === 'await_sender') {
    const sender = trim_(text);
    if (!isValidSender_(sender)) {
      sendTelegramToChat_(token, chatId, 'That sender does not look like a domain or full email. Example: xxx.com or abc@xxx.com. Try again, or /cancel.', cancelKeyboard_());
      return;
    }
    const dup = findRuleBySender_(sender);
    if (dup) {
      setConv_(chatId, { step: 'await_dup_keywords', ruleId: dup.id, sender: dup.sender });
      showDupKeywordsPrompt_(token, chatId, dup);
      return;
    }
    setConv_(chatId, { step: 'await_keywords', sender: sender });
    showAddKeywordsPrompt_(token, chatId, sender);
    return;
  }
  if (step === 'await_keywords' || step === 'await_confirm') {
    if (!hasKeywords_(text)) {
      sendTelegramToChat_(token, chatId, 'Keywords cannot be empty. Send comma-separated keywords, or /cancel.', cancelKeyboard_());
      return;
    }
    const sender = trim_(conv.sender);
    if (!isValidSender_(sender)) {
      // Corrupt/expired conv (sender lost) — restart instead of writing a bad row.
      clearConv_(chatId);
      sendTelegramToChat_(token, chatId, 'Session expired. Send /add to restart.');
      return;
    }
    const keywordsRaw = trim_(text);
    setConv_(chatId, { step: 'await_confirm', sender: sender, keywordsRaw: keywordsRaw });
    showAddConfirm_(token, chatId, sender, keywordsRaw);
    return;
  }
  if (step === 'await_dup_keywords' || step === 'await_dup_confirm') {
    if (!hasKeywords_(text)) {
      sendTelegramToChat_(token, chatId, 'Keywords cannot be empty. Send comma-separated keywords, or /cancel.', cancelKeyboard_());
      return;
    }
    const target = findRuleById_(conv.ruleId);
    if (!target) {
      clearConv_(chatId);
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    const keywordsRaw = trim_(text);
    setConv_(chatId, { step: 'await_dup_confirm', ruleId: target.id, sender: target.sender, keywordsRaw: keywordsRaw });
    showDupConfirm_(token, chatId, target, keywordsRaw);
    return;
  }
  if (step === 'await_edit_keywords' || step === 'await_edit_confirm') {
    if (!hasKeywords_(text)) {
      sendTelegramToChat_(token, chatId, 'Keywords cannot be empty. Send comma-separated keywords, or /cancel.', cancelKeyboard_());
      return;
    }
    const target = findRuleById_(conv.ruleId);
    if (!target) {
      clearConv_(chatId);
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    const keywordsRaw = trim_(text);
    setConv_(chatId, { step: 'await_edit_confirm', ruleId: target.id, keywordsRaw: keywordsRaw });
    showEditConfirm_(token, chatId, target, keywordsRaw);
    return;
  }
  if (step === 'await_edit_sender') {
    const sender = trim_(text);
    if (!isValidSender_(sender)) {
      sendTelegramToChat_(token, chatId, 'That sender does not look like a domain or full email. Example: xxx.com or abc@xxx.com. Try again, or /cancel.', cancelKeyboard_());
      return;
    }
    const target = findRuleById_(conv.ruleId);
    if (!target) {
      clearConv_(chatId);
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    const clash = findRuleBySender_(sender);
    if (clash && String(clash.id) !== String(target.id)) {
      sendTelegramToChat_(token, chatId, 'That sender is already watched by another rule. Pick a different sender, or /cancel.', cancelKeyboard_());
      return;
    }
    const res = updateRuleById_(target.id, { sender: sender });
    clearConv_(chatId);
    if (res.ok) {
      sendTelegramToChat_(token, chatId, 'Rule updated (' + sender + ').');
    } else {
      sendTelegramToChat_(token, chatId, 'Could not update the rule: ' + res.error + ' Send /list to retry.');
    }
    return;
  }
  // Expired or corrupt step — fail open with guidance, never silent.
  clearConv_(chatId);
  sendTelegramToChat_(token, chatId, 'Session expired. Send /add to restart.');
}

/**
 * Rule/add callback sub-router (called from handleCallback_) — Never throws.
 */
function handleRuleCallback_(token, chatId, data, messageId, callbackId) {
  const d = String(data || '');
  if (d === 'add:cancel') {
    clearConv_(chatId);
    answerTelegramCallback_(token, callbackId, 'Cancelled');
    if (messageId) {
      editTelegramMessageText_(token, chatId, messageId, 'Cancelled. Nothing changed.');
    } else {
      sendTelegramToChat_(token, chatId, 'Cancelled. Nothing changed.');
    }
    return;
  }
  if (d === 'add:uselast') {
    const conv = getConv_(chatId);
    const last = getLastRule_();
    if (!last) {
      answerTelegramCallback_(token, callbackId, 'No prior rule');
      sendTelegramToChat_(token, chatId, 'No prior rule yet. Send keywords, or /cancel.', cancelKeyboard_());
      return;
    }
    if (!conv || (conv.step !== 'await_keywords' && conv.step !== 'await_dup_keywords')) {
      answerTelegramCallback_(token, callbackId, 'Expired');
      sendTelegramToChat_(token, chatId, 'Session expired. Send /add to restart.');
      return;
    }
    answerTelegramCallback_(token, callbackId, 'Filled');
    if (conv.step === 'await_dup_keywords') {
      const target = findRuleById_(conv.ruleId);
      if (!target) {
        clearConv_(chatId);
        sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
        return;
      }
      setConv_(chatId, { step: 'await_dup_confirm', ruleId: target.id, sender: target.sender, keywordsRaw: last.keywordsRaw });
      showDupConfirm_(token, chatId, target, last.keywordsRaw);
    } else {
      const sender = trim_(conv.sender);
      setConv_(chatId, { step: 'await_confirm', sender: sender, keywordsRaw: last.keywordsRaw });
      showAddConfirm_(token, chatId, sender, last.keywordsRaw);
    }
    return;
  }
  if (d === 'add:confirm') {
    const conv = getConv_(chatId);
    if (!conv || (conv.step !== 'await_confirm' && conv.step !== 'await_dup_confirm' && conv.step !== 'await_edit_confirm')) {
      answerTelegramCallback_(token, callbackId, 'Expired');
      sendTelegramToChat_(token, chatId, 'Session expired. Send /add to restart.');
      return;
    }
    // topic_hint is the seed, written only when suggestions were actually used.
    const hint = (conv.usedSuggestion && conv.seed) ? String(conv.seed) : undefined;
    if (conv.step === 'await_edit_confirm') {
      const target = findRuleById_(conv.ruleId);
      if (!target) {
        clearConv_(chatId);
        answerTelegramCallback_(token, callbackId, 'Not found');
        sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
        return;
      }
      const fields = { keywordsRaw: conv.keywordsRaw };
      if (hint !== undefined) {
        fields.topicHint = hint;
      }
      const res = updateRuleById_(target.id, fields);
      clearConv_(chatId);
      if (res.ok) {
        answerTelegramCallback_(token, callbackId, 'Updated');
        sendTelegramToChat_(token, chatId, 'Rule updated (' + target.sender + ').');
      } else {
        answerTelegramCallback_(token, callbackId, 'Failed');
        sendTelegramToChat_(token, chatId, 'Could not update the rule: ' + res.error + ' Send /list to retry.');
      }
      return;
    }
    if (conv.step === 'await_dup_confirm') {
      const target = findRuleById_(conv.ruleId);
      if (!target) {
        clearConv_(chatId);
        answerTelegramCallback_(token, callbackId, 'Not found');
        sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
        return;
      }
      const fields = { keywordsRaw: conv.keywordsRaw };
      if (hint !== undefined) {
        fields.topicHint = hint;
      }
      const res = updateRuleById_(target.id, fields);
      clearConv_(chatId);
      if (res.ok) {
        answerTelegramCallback_(token, callbackId, 'Updated');
        sendTelegramToChat_(token, chatId, 'Rule updated (' + target.sender + ').');
      } else {
        answerTelegramCallback_(token, callbackId, 'Failed');
        sendTelegramToChat_(token, chatId, 'Could not update the rule: ' + res.error + ' Send /list to retry.');
      }
      return;
    }
    // New-rule confirm: re-check the 30-enabled cap (race with other writes).
    const rules = loadAllRules_();
    if (isRuleLimitReached_(rules)) {
      clearConv_(chatId);
      answerTelegramCallback_(token, callbackId, 'Limit reached');
      sendTelegramToChat_(token, chatId, 'Rule limit reached (30 enabled). Disable or delete a rule before adding.');
      return;
    }
    // Re-check sender shape + duplicate (race/corrupt conv): never write a bad row.
    if (!isValidSender_(trim_(conv.sender)) || !hasKeywords_(conv.keywordsRaw)) {
      clearConv_(chatId);
      answerTelegramCallback_(token, callbackId, 'Expired');
      sendTelegramToChat_(token, chatId, 'Session expired. Send /add to restart.');
      return;
    }
    // Re-check duplicate (race): fall into the update path when taken.
    const dup = findRuleBySender_(conv.sender);
    if (dup) {
      const dupFields = { keywordsRaw: conv.keywordsRaw };
      if (hint !== undefined) {
        dupFields.topicHint = hint;
      }
      const res = updateRuleById_(dup.id, dupFields);
      clearConv_(chatId);
      if (res.ok) {
        answerTelegramCallback_(token, callbackId, 'Updated');
        sendTelegramToChat_(token, chatId, 'Rule updated (' + dup.sender + ').');
      } else {
        answerTelegramCallback_(token, callbackId, 'Failed');
        sendTelegramToChat_(token, chatId, 'Could not update the rule: ' + res.error + ' Send /list to retry.');
      }
      return;
    }
    const res = appendRule_(trim_(conv.sender), trim_(conv.keywordsRaw), hint === undefined ? '' : hint);
    const senderEcho = trim_(conv.sender);
    clearConv_(chatId);
    if (res.ok) {
      answerTelegramCallback_(token, callbackId, 'Added');
      sendTelegramToChat_(token, chatId, 'Rule added (' + senderEcho + '). It is enabled. Use /list to manage.');
    } else {
      answerTelegramCallback_(token, callbackId, 'Failed');
      sendTelegramToChat_(token, chatId, 'Could not save the rule: ' + res.error);
    }
    return;
  }
  if (d.indexOf('rule:list:') === 0) {
    const page = parseInt(d.substring('rule:list:'.length), 10);
    answerTelegramCallback_(token, callbackId, 'Page');
    showListPage_(token, chatId, page, messageId);
    return;
  }
  if (d.indexOf('rule:view:') === 0) {
    const id = trim_(d.substring('rule:view:'.length));
    answerTelegramCallback_(token, callbackId, 'Opened');
    sendRuleDetail_(token, chatId, id);
    return;
  }
  if (d.indexOf('rule:toggle:') === 0) {
    const id = trim_(d.substring('rule:toggle:'.length));
    const rule = findRuleById_(id);
    if (!rule) {
      answerTelegramCallback_(token, callbackId, 'Not found');
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    if (!rule.enabled && isRuleLimitReached_(loadAllRules_())) {
      answerTelegramCallback_(token, callbackId, 'Limit reached');
      sendTelegramToChat_(token, chatId, 'Rule limit reached (30 enabled). Disable or delete a rule before enabling.');
      return;
    }
    const res = updateRuleById_(rule.id, { enabled: !rule.enabled });
    if (!res.ok) {
      answerTelegramCallback_(token, callbackId, 'Failed');
      sendTelegramToChat_(token, chatId, 'Could not update the rule: ' + res.error);
      return;
    }
    answerTelegramCallback_(token, callbackId, rule.enabled ? 'Disabled' : 'Enabled');
    const updated = findRuleById_(rule.id);
    const fallback = { id: rule.id, sender: rule.sender, keywordsRaw: rule.keywordsRaw, enabled: !rule.enabled, updatedAt: rule.updatedAt };
    const built = buildRuleDetail_(updated || fallback);
    if (messageId) {
      editTelegramMessageText_(token, chatId, messageId, built.text, built.keyboard);
    } else {
      sendTelegramToChat_(token, chatId, built.text, built.keyboard);
    }
    return;
  }
  if (d.indexOf('rule:ekey:') === 0) {
    const id = trim_(d.substring('rule:ekey:'.length));
    const rule = findRuleById_(id);
    if (!rule) {
      answerTelegramCallback_(token, callbackId, 'Not found');
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    setConv_(chatId, { step: 'await_edit_keywords', ruleId: rule.id });
    answerTelegramCallback_(token, callbackId, 'Send keywords');
    showEditKeywordsPrompt_(token, chatId, rule);
    return;
  }
  if (d.indexOf('rule:esender:') === 0) {
    const id = trim_(d.substring('rule:esender:'.length));
    const rule = findRuleById_(id);
    if (!rule) {
      answerTelegramCallback_(token, callbackId, 'Not found');
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    setConv_(chatId, { step: 'await_edit_sender', ruleId: rule.id });
    answerTelegramCallback_(token, callbackId, 'Send sender');
    sendTelegramToChat_(token, chatId, 'Editing sender (current: ' + rule.sender + '). Send a domain or full email, or /cancel.', { inline_keyboard: [[{ text: 'Cancel', callback_data: 'add:cancel' }]] });
    return;
  }
  if (d.indexOf('rule:delyes:') === 0) {
    const id = trim_(d.substring('rule:delyes:'.length));
    const res = deleteRuleById_(id);
    if (!res.ok) {
      answerTelegramCallback_(token, callbackId, 'Not found');
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    answerTelegramCallback_(token, callbackId, 'Deleted');
    const text = 'Rule deleted (' + res.sender + '). Log rows are kept for history.';
    if (messageId) {
      editTelegramMessageText_(token, chatId, messageId, text);
    } else {
      sendTelegramToChat_(token, chatId, text);
    }
    return;
  }
  if (d.indexOf('rule:delno:') === 0) {
    const id = trim_(d.substring('rule:delno:'.length));
    const rule = findRuleById_(id);
    answerTelegramCallback_(token, callbackId, 'Cancelled');
    if (!rule) {
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    const built = buildRuleDetail_(rule);
    if (messageId) {
      editTelegramMessageText_(token, chatId, messageId, built.text, built.keyboard);
    } else {
      sendTelegramToChat_(token, chatId, built.text, built.keyboard);
    }
    return;
  }
  if (d.indexOf('rule:del:') === 0) {
    const id = trim_(d.substring('rule:del:'.length));
    const rule = findRuleById_(id);
    if (!rule) {
      answerTelegramCallback_(token, callbackId, 'Not found');
      sendTelegramToChat_(token, chatId, 'Rule not found. It may have been deleted. Send /list to refresh.');
      return;
    }
    answerTelegramCallback_(token, callbackId, 'Confirm delete');
    const text = 'Delete rule ' + rule.sender + '? Log rows are kept. Confirm?';
    const keyboard = { inline_keyboard: [[{ text: 'Yes, delete', callback_data: 'rule:delyes:' + rule.id }, { text: 'Cancel', callback_data: 'rule:delno:' + rule.id }]] };
    if (messageId) {
      editTelegramMessageText_(token, chatId, messageId, text, keyboard);
    } else {
      sendTelegramToChat_(token, chatId, text, keyboard);
    }
    return;
  }
  if (d.indexOf('rule:back:') === 0) {
    const page = parseInt(d.substring('rule:back:'.length), 10);
    answerTelegramCallback_(token, callbackId, 'Back');
    showListPage_(token, chatId, page, null);
    return;
  }
  // Silent: unknown rule/add callback — stay silent (matches existing convention).
}

/**
 * Set the bot command menu (Telegram Menu button) so the owner never types.
 * Commands are per-bot; call after setWebhook (Setup) and after token
 * replace (/connect). Best-effort: callers stay silent on failure because
 * typed commands keep working and the next Setup rerun retries.
 * Returns { ok, error }; error never contains the token. Never throws.
 */
function telegramSetMyCommands_(token) {
  const t = trim_(token);
  if (!t) {
    return { ok: false, error: 'Missing bot_token.' };
  }
  const commands = [
    { command: 'list', description: 'Show rules' },
    { command: 'add', description: 'Add a rule' },
    { command: 'interval', description: 'Polling interval' },
    { command: 'status', description: 'Watcher status' },
    { command: 'help', description: 'Command help' },
    { command: 'setai', description: 'OpenRouter key + model for keyword ideas' },
    { command: 'transfer', description: 'Move to this account' },
    { command: 'connect', description: 'Replace bot token' }
  ];
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'setMyCommands'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ commands: commands }),
        muteHttpExceptions: true
      }
    );
    const mapped = mapSendError_(resp.getResponseCode(), resp.getContentText());
    if (!mapped) {
      return { ok: true, error: '' };
    }
    return { ok: false, error: mapped };
  } catch (e) {
    let msg = e && e.message ? String(e.message) : String(e);
    msg = redactToken_(msg, t);
    return { ok: false, error: truncateDebug_(msg) };
  }
}

/**
 * Human label for a poll interval — pure, Never throws.
 */
function formatIntervalLabel_(minutes) {
  const n = parseInt(String(minutes), 10);
  if (n === 120) {
    return '2 hours';
  }
  if (n === 360) {
    return '6 hours';
  }
  if (n === 720) {
    return '12 hours';
  }
  if (n === 30 || n === 60 || n === 15) {
    return n + ' min';
  }
  return String(minutes);
}

/**
 * Short button label for an interval option, marked when current — pure, Never throws.
 */
function formatIntervalButton_(minutes, current) {
  const n = parseInt(String(minutes), 10);
  const short = n === 120 ? '2hr' : n === 360 ? '6hr' : n === 720 ? '12hr' : n + 'min';
  return short + (n === current ? ' (current)' : '');
}

/**
 * Show interval options with the current one marked — Never throws.
 */
function handleInterval_(token, chatId) {
  const current = getPollIntervalMinutes();
  sendTelegramToChat_(
    token,
    chatId,
    'Polling interval (current: every ' + formatIntervalLabel_(current) + '). Pick one, or Cancel:',
    {
      inline_keyboard: [
        [
          { text: formatIntervalButton_(15, current), callback_data: 'interval:15' },
          { text: formatIntervalButton_(30, current), callback_data: 'interval:30' }
        ],
        [
          { text: formatIntervalButton_(60, current), callback_data: 'interval:60' },
          { text: formatIntervalButton_(120, current), callback_data: 'interval:120' }
        ],
        [
          { text: formatIntervalButton_(360, current), callback_data: 'interval:360' },
          { text: formatIntervalButton_(720, current), callback_data: 'interval:720' }
        ],
        [{ text: 'Cancel', callback_data: 'interval:cancel' }]
      ]
    }
  );
}

/**
 * Apply an interval tap (rebuilds the trigger via setPollIntervalMinutes_) — Never throws.
 */
function handleIntervalCallback_(token, chatId, minutesText, messageId, callbackId) {
  if (trim_(minutesText) === 'cancel') {
    // No conv state for interval — Cancel just drops the buttons, never silent.
    answerTelegramCallback_(token, callbackId, 'Cancelled');
    if (messageId) {
      editTelegramMessageText_(token, chatId, messageId, 'Cancelled. Nothing changed.');
    } else {
      sendTelegramToChat_(token, chatId, 'Cancelled. Nothing changed.');
    }
    return;
  }
  const n = parseInt(String(minutesText), 10);
  let allowed = false;
  for (let i = 0; i < ALLOWED_INTERVAL_MINUTES.length; i++) {
    if (n === ALLOWED_INTERVAL_MINUTES[i]) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    // Silent: unknown interval value — stay silent (matches existing convention).
    return;
  }
  let applied = 0;
  try {
    applied = setPollIntervalMinutes(n);
  } catch (e) {
    answerTelegramCallback_(token, callbackId, 'Failed');
    sendTelegramToChat_(token, chatId, 'Could not update the trigger. Rerun Deal Watch > Setup in the Sheet, or try again.');
    return;
  }
  answerTelegramCallback_(token, callbackId, 'Set');
  const text = 'Polling interval set to every ' + formatIntervalLabel_(applied) + '. The next run follows the new schedule.';
  if (messageId) {
    editTelegramMessageText_(token, chatId, messageId, text);
  } else {
    sendTelegramToChat_(token, chatId, text);
  }
}

/**
 * Last Runs row summary ({ start, end, found, sent }) — Never throws (null when none).
 */
function readLastRunsSummary_() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RUNS);
    if (!sheet || sheet.getLastRow() < 2) {
      return null;
    }
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, HEADERS_RUNS.length).getValues()[0];
    const startIdx = getColumnIndex_(headers, 'start', 0);
    const endIdx = getColumnIndex_(headers, 'end', 1);
    const foundIdx = getColumnIndex_(headers, 'found', 2);
    const sentIdx = getRunsHeaderIndex_(headers).sentIdx;
    const row = sheet.getRange(lastRow, 1, 1, HEADERS_RUNS.length).getValues()[0];
    const stamp = row[endIdx] || row[startIdx];
    return {
      when: formatSheetStamp_(stamp),
      found: String(row[foundIdx] === null || row[foundIdx] === undefined ? '' : row[foundIdx]),
      sent: String(row[sentIdx] === null || row[sentIdx] === undefined ? '' : row[sentIdx])
    };
  } catch (e) {
    return null;
  }
}

/**
 * Show watcher status (interval + rules + last run + error) — Never throws.
 */
function handleStatus_(token, chatId) {
  const interval = getPollIntervalMinutes();
  const rules = loadAllRules_();
  let enabled = 0;
  for (let i = 0; i < rules.length; i++) {
    if (rules[i] && rules[i].enabled) {
      enabled++;
    }
  }
  const last = readLastRunsSummary_();
  const pending = trim_(getPendingError_());
  const lines = [
    'Status:',
    'Interval: every ' + formatIntervalLabel_(interval),
    'Rules: ' + rules.length + ' (' + enabled + ' enabled)',
    'Last run: ' + (last && last.when ? last.when + ' (found ' + (last.found || '0') + ', sent ' + (last.sent || '0') + ')' : 'none yet'),
    'Suggestions: ' + (isSuggestionEnabled_() ? 'on' : 'off'),
    'Model: ' + currentModelLabel_(),
    'Error: ' + (pending || 'none')
  ];
  sendTelegramToChat_(token, chatId, lines.join('\n'));
}

/**
 * Show command help — Never throws.
 */
function handleHelp_(token, chatId) {
  sendTelegramToChat_(
    token,
    chatId,
    'Deal Watch commands:\n' +
    '/list - show rules (10 per page)\n' +
    '/add - add a rule\n' +
    '/interval - polling interval\n' +
    '/status - watcher status\n' +
    '/help - this help\n' +
    '/setai - OpenRouter key + model (keyword ideas)\n' +
    '/transfer - move the watcher to this account\n' +
    '/connect - replace the bot token\n' +
    'One digest per run; silence means no matches.'
  );
}

/**
 * Collect merged error parts for the run — pure, Never throws.
 */
function collectWatchErrorParts_(pendingBefore, currentError, jam) {
  const errorParts = [];
  if (pendingBefore) {
    errorParts.push('Previous failure: ' + pendingBefore);
  }
  if (currentError) {
    errorParts.push(currentError);
  }
  if (jam && jam.alert) {
    errorParts.push('Telegram queue jammed (' + jam.pending + ' pending).');
  }
  return errorParts;
}

/**
 * True when the run has nothing to send — pure, Never throws.
 */
function hasNothingToSend_(digest, errorParts) {
  return !digest && !(errorParts && errorParts.length);
}

/**
 * Record a successful merged send — Never throws.
 */
function handleWatchSendSuccess_(toSend) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(PROP_LAST_ERROR);
    props.setProperty(PROP_CONSECUTIVE_FAILURES, '0');
  } catch (e) {
    // Ignore: send already succeeded.
  }
  updateLastRunsRow_(1, '');
  return toSend;
}

/**
 * Record a failed merged send — Never throws.
 */
function handleWatchSendFailure_(reason) {
  const n = getConsecutiveFailures_() + 1;
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(PROP_CONSECUTIVE_FAILURES, String(n));
    if (n <= MAX_CONSECUTIVE_FAILURES) {
      const stamp = formatRunDate_(new Date());
      const entry = ((stamp ? stamp + ' ' : '') + reason).substring(0, ERROR_ENTRY_MAX_LEN);
      props.setProperty(PROP_LAST_ERROR, entry);
    } else {
      // Stop retrying stale backlog; polling continues, Runs keeps the audit.
      props.deleteProperty(PROP_LAST_ERROR);
    }
  } catch (e) {
    // Ignore: Runs still records the failure below.
  }
  updateLastRunsRow_(0, ('Send failed: ' + reason).substring(0, ERROR_ENTRY_MAX_LEN));
  // Silent: send failed — digest stays unsent, error rides next run.
  return '';
}

/**
 * Time-trigger entry point: poll -> one merged send -> Runs.sent update.
 * Silence ("" digest + no errors) sends nothing and returns "".
 * Returns the text sent, or "" when nothing was sent. Never throws.
 */
function runWatchAndNotify() {
  try {
    const pendingBefore = trim_(getPendingError_());
    const digest = runWatchOnce();
    const currentError = trim_(readLastRunsError_());
    // Queue-jam watchdog (early warning only; the clear itself needs an
    // owner tap on the alert buttons). The audit line rides the merged
    // message; the buttons ride a separate control message.
    const jam = checkQueueJam_();
    if (jam.alert) {
      try {
        const jamProps = PropertiesService.getScriptProperties();
        const jamToken = trim_(jamProps.getProperty(PROP_BOT_TOKEN));
        const jamOwner = trim_(jamProps.getProperty(PROP_OWNER_CHAT_ID));
        if (jamToken && jamOwner) {
          sendQueueJamAlert_(jamToken, jamOwner, jam.pending);
        }
      } catch (eJam) {
        // Button send is best-effort; the audit line above still rides the
        // merged message when the digest send succeeds.
      }
    }
    const errorParts = collectWatchErrorParts_(pendingBefore, currentError, jam);
    if (hasNothingToSend_(digest, errorParts)) {
      // Silent: zero-match with no pending/current/jam errors — nothing to send.
      return '';
    }
    const toSend = buildMergedMessage_(digest, errorParts);
    if (!toSend) {
      // Silent: merged message collapsed to empty — nothing to send.
      return '';
    }
    const result = sendTelegramMessage_(toSend);
    if (result && result.ok) {
      return handleWatchSendSuccess_(toSend);
    }
    const reason = result && result.error ? String(result.error) : 'Send failed.';
    return handleWatchSendFailure_(reason);
  } catch (e) {
    return '';
  }
}
