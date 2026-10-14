/**
 * Deal Watch — T3 core (bound Apps Script).
 *
 * Scope (per user-confirmed T3 slices):
 * - T3-a: ensureSchema() + normalization + sender/keyword matching + interval helper.
 * - T3-b: polling + per-message match (no digest, no Log/Runs writes, no send).
 * - T3-c: digest collapse + digest string + Log/Runs writes + 30-day prune (no send).
 * - T4-a: trigger management (ensureTrigger + setPollIntervalMinutes).
 * - T4-b: one merged send + last_error + stop-after-3 (runWatchAndNotify).
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SHEET_HOME = 'Home';

/**
 * Idempotent schema provisioning: creates Rules/Log/Runs with headers when
 * missing, then hides them. Never writes example rows; never overwrites data.
 * Safe to call on every startup (open trigger / Setup rerun).
 * A visible Home sheet is kept because Sheets forbids hiding every sheet.
 */
function ensureSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeaders_(ss, SHEET_RULES, HEADERS_RULES);
  ensureSheetWithHeaders_(ss, SHEET_LOG, HEADERS_LOG);
  ensureSheetWithHeaders_(ss, SHEET_RUNS, HEADERS_RUNS);
  ensureVisibleFrontSheet_(ss);
  hideSheetIfOthersVisible_(ss, SHEET_RULES);
  hideSheetIfOthersVisible_(ss, SHEET_LOG);
  hideSheetIfOthersVisible_(ss, SHEET_RUNS);
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
    let tz = 'Asia/Hong_Kong';
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
//         no suggest, no /setkey — those are T5-c/d and T6).
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
 * Returns { ok, error }; error never contains the token.
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
      return { ok: true, error: '' };
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
 * Replace an inline-button message's text and drop its buttons in one call.
 * Omitting reply_markup clears the inline keyboard, so the buttons cannot
 * be tapped twice. Best-effort: edit failures (too old, not modified) are
 * ignored and never throw from the webhook.
 */
function editTelegramMessageText_(token, chatId, messageId, text) {
  const t = trim_(token);
  if (!t || !chatId || !messageId || !text) {
    return { ok: false, desc: 'skipped' };
  }
  let out = String(text);
  if (out.length > TELEGRAM_MAX_TEXT) {
    out = out.substring(0, TELEGRAM_MAX_TEXT - TELEGRAM_TRUNCATE_RESERVE) + '... (truncated)';
  }
  try {
    const resp = UrlFetchApp.fetch(
      telegramApiUrl_(t, 'editMessageText'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ chat_id: String(chatId), message_id: messageId, text: out }),
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
// Inbound webhook router (T5-a skeleton + T5-b Setup flows)
// ---------------------------------------------------------------------------

/**
 * Browser health check (browsers GET; Telegram POSTs to doPost).
 * No params, no secrets, no logic — proves the deployment is live.
 */
function doGet() {
  try {
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
 * /start, /transfer, /connect (+ callbacks). Rule CRUD (T5-c) and
 * interval/status (T5-d) reply that they arrive next to avoid silent dead
 * ends during the sliced rollout.
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

    // Owner conv continuation first (e.g. /connect awaiting new token).
    const conv = getConv_(chatId);
    if (conv && conv.step === 'await_new_token' && !/^\/\w/.test(text)) {
      handleConnectToken_(token, chatId, text, msg.message_id);
      return telegramOk_();
    }

    if (/^\/start(\s|$)/.test(text)) {
      handleStart_(token, chatId, text);
    } else if (/^\/transfer(\s|$)/.test(text)) {
      handleTransferRequest_(token, chatId);
    } else if (/^\/connect(\s|$)/.test(text)) {
      handleConnectRequest_(token, chatId);
    } else if (/^\/(list|add|rules|interval|status|help|suggest|setkey|setmodel)(\s|$)/.test(text)) {
      sendTelegramToChat_(
        token,
        chatId,
        'Not yet in this slice: rule management (T5-c) and interval/status (T5-d) arrive next. Available now: /transfer, /connect.'
      );
    } else {
      sendTelegramToChat_(
        token,
        chatId,
        'Unknown command. Available now: /transfer, /connect. Buttons arrive with rule management (T5-c).'
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
  sendTelegramToChat_(token, chatId, 'Token replaced (' + maskSecret_(fresh) + '). Webhook re-attached. The old token stops working.');
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
