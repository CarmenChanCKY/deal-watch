/**
 * Deal Watch — T3-a core helpers (bound Apps Script).
 *
 * Scope (per user-confirmed T3 slice):
 * - ensureSchema() + normalization + sender/keyword matching + interval helper.
 * - No Gmail search, no digest assembly/sending, no trigger management here.
 *   Those arrive in T3-b (polling) / T3-c (digest + Log/Runs) / T4 (trigger + send).
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Idempotent schema provisioning: creates Rules/Log/Runs with headers when
 * missing, then hides them. Never writes example rows; never overwrites data.
 * Safe to call on every startup (open trigger / Setup rerun).
 */
function ensureSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeaders_(ss, SHEET_RULES, HEADERS_RULES);
  ensureSheetWithHeaders_(ss, SHEET_LOG, HEADERS_LOG);
  ensureSheetWithHeaders_(ss, SHEET_RUNS, HEADERS_RUNS);
}

function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  // Keep the DB out of the daily UI; users manage rules via Telegram only.
  if (!sheet.isSheetHidden()) {
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

    if (code === 0x3000) {
      // Full-width space
      // change to half-width space
      converted += ' ';
    } else if (code >= 0xFF01 && code <= 0xFF5E) {
      // Full-width character
      // change to half-width character
      converted += String.fromCharCode(code - 0xFEE0);
    } else {
      converted += out.charAt(i);
    }
  }
  return converted.toLowerCase().replace(/^\s+|\s+$/g, '');
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
  return String(candidate).replace(/^\s+|\s+$/g, '');
}

/**
 * Normalize a sender email: lower + trim + strip "+tag" from the local part.
 * Example: "Abc+sale@XXX.com" -> "abc@xxx.com".
 * Gmail dot handling is out of scope (dots are left untouched).
 */
function normalizeSenderEmail(email) {
  let s = String(email === null || email === undefined ? '' : email);
  s = s.replace(/^\s+|\s+$/g, '').toLowerCase();
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
  const rule = String(ruleSender || '').replace(/^\s+|\s+$/g, '').toLowerCase();
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
    const item = parts[i].replace(/^\s+|\s+$/g, '');
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
    const n = parseInt(String(raw).replace(/^\s+|\s+$/g, ''), 10);
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
