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
    const s = value.replace(/^\s+|\s+$/g, '').toLowerCase();
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
  const s = String(sender === null || sender === undefined ? '' : sender).replace(/^\s+|\s+$/g, '');
  if (!s || s.length > 254) {
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
    const key = String(headers[c]).replace(/^\s+|\s+$/g, '').toLowerCase();
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
    const sender = String(row[senderIdx] === null || row[senderIdx] === undefined ? '' : row[senderIdx]).replace(/^\s+|\s+$/g, '');
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
    const sender = String(rules[i].sender || '').replace(/^\s+|\s+$/g, '');
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
      if (invalidSamples.length < 3) {
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
  let msgIdx = -1;
  for (let c = 0; c < values[0].length; c++) {
    if (String(values[0][c]).replace(/^\s+|\s+$/g, '').toLowerCase() === 'message_id') {
      msgIdx = c;
      break;
    }
  }
  if (msgIdx < 0) {
    return seen;
  }
  for (let r = 1; r < values.length; r++) {
    const id = String(values[r][msgIdx] === null || values[r][msgIdx] === undefined ? '' : values[r][msgIdx]).replace(/^\s+|\s+$/g, '');
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
      const candidates = [];
      for (let r = 0; r < rules.length; r++) {
        if (!isValidSender_(rules[r].sender)) {
          continue;
        }
        if (senderMatches(rules[r].sender, fromHeader)) {
          candidates.push(rules[r]);
        }
      }
      if (!candidates.length) {
        continue;
      }
      const plainBody = msg.getPlainBody();
      const subject = msg.getSubject();
      const haystack = buildNormalizedHaystack(subject, plainBody);
      const seenKw = {};
      const matchedKeywords = [];
      const ruleIds = [];
      const senders = [];
      for (let c = 0; c < candidates.length; c++) {
        const hits = matchKeywordsInText(haystack, candidates[c].keywords);
        if (hits.length) {
          ruleIds.push(candidates[c].id);
          senders.push(candidates[c].sender);
          for (let h = 0; h < hits.length; h++) {
            if (!seenKw[hits[h].text]) {
              seenKw[hits[h].text] = true;
              matchedKeywords.push(hits[h].display);
            }
          }
        }
      }
      if (matchedKeywords.length) {
        matches.push({
          threadId: threadId,
          messageId: messageId,
          from: fromHeader,
          fromEmail: normalizeSenderEmail(extractEmail(fromHeader)),
          subject: subject,
          date: msg.getDate(),
          matchedKeywords: matchedKeywords,
          ruleIds: ruleIds,
          senders: senders
        });
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
