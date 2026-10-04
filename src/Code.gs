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
      g = {
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
      groups[m.threadId] = g;
      order.push(m.threadId);
    }
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
      const sKey = String(snd[s]).replace(/^\s+|\s+$/g, '').toLowerCase();
      if (!sKey || g.senderSeen[sKey]) {
        continue;
      }
      g.senderSeen[sKey] = true;
      g.senders.push(snd[s]);
    }
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
    const subject = String(g.subject === null || g.subject === undefined ? '' : g.subject).replace(/^\s+|\s+$/g, '') || '(no subject)';
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
    const cutoff = base.getTime() - days * 24 * 60 * 60 * 1000;
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
    if (!sheet || sheet.getLastRow() < 2) {
      return 0;
    }
    const values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return 0;
    }
    let tsIdx = 0;
    for (let c = 0; c < values[0].length; c++) {
      if (String(values[0][c]).replace(/^\s+|\s+$/g, '').toLowerCase() === 'timestamp') {
        tsIdx = c;
        break;
      }
    }
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
// - Handler is runWatchAndNotify() (T4-b adds send; T4-a stub just polls).
// - 15/30/60 use everyMinutes(n); 120/360/720 use everyHours(2/6/12).

const TRIGGER_HANDLER = 'runWatchAndNotify';

/**
 * Store a poll interval and rebuild the trigger.
 * Valid = one of ALLOWED_INTERVAL_MINUTES; anything else is ignored
 * (no store, no trigger change) and the current effective value is returned.
 * Returns the effective interval in minutes.
 */
function setPollIntervalMinutes(minutes) {
  const n = parseInt(String(minutes).replace(/^\s+|\s+$/g, ''), 10);
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
  PropertiesService.getScriptProperties().setProperty(PROP_POLL_INTERVAL, String(n));
  ensureTrigger();
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
    builder.everyMinutes(60).create();
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
    token = String(props.getProperty(PROP_BOT_TOKEN) || '').replace(/^\s+|\s+$/g, '');
    chatId = String(props.getProperty(PROP_OWNER_CHAT_ID) || '').replace(/^\s+|\s+$/g, '');
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
      'https://api.telegram.org/bot' + token + '/sendMessage',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ chat_id: chatId, text: text }),
        muteHttpExceptions: true
      }
    );
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      return { ok: false, error: 'Telegram HTTP ' + code + '.' };
    }
    let body = '';
    try {
      body = resp.getContentText();
    } catch (e2) {
      body = '';
    }
    try {
      const data = JSON.parse(body);
      if (data && data.ok === true) {
        return { ok: true, error: '' };
      }
      const desc = data && data.description ? String(data.description).substring(0, 200) : 'unknown error';
      return { ok: false, error: 'Telegram rejected send: ' + desc };
    } catch (e3) {
      return { ok: false, error: 'Telegram bad response (HTTP ' + code + ').' };
    }
  } catch (e) {
    // UrlFetchApp messages can echo the request URL, which contains the
    // token — never return it raw. Redact before surfacing.
    let msg = e && e.message ? String(e.message) : String(e);
    if (token) {
      msg = msg.split(token).join('[redacted]');
    }
    return { ok: false, error: 'Send exception: ' + msg.substring(0, 200) };
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
    let errIdx = HEADERS_RUNS.length - 1;
    for (let c = 0; c < headers.length; c++) {
      if (String(headers[c]).replace(/^\s+|\s+$/g, '').toLowerCase() === 'error') {
        errIdx = c;
        break;
      }
    }
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
    let sentIdx = HEADERS_RUNS.length - 2;
    let errIdx = HEADERS_RUNS.length - 1;
    for (let c = 0; c < headers.length; c++) {
      const key = String(headers[c]).replace(/^\s+|\s+$/g, '').toLowerCase();
      if (key === 'sent') {
        sentIdx = c;
      } else if (key === 'error') {
        errIdx = c;
      }
    }
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
      const e = String(errorParts[i] === null || errorParts[i] === undefined ? '' : errorParts[i]).replace(/^\s+|\s+$/g, '');
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
    out = out.substring(0, TELEGRAM_MAX_TEXT - 20) + '... (truncated)';
  }
  return out;
}

/**
 * Time-trigger entry point: poll -> one merged send -> Runs.sent update.
 * Silence ("" digest + no errors) sends nothing and returns "".
 * Returns the text sent, or "" when nothing was sent. Never throws.
 */
function runWatchAndNotify() {
  try {
    const pendingBefore = getPendingError_().replace(/^\s+|\s+$/g, '');
    const digest = runWatchOnce();
    const currentError = readLastRunsError_().replace(/^\s+|\s+$/g, '');
    const errorParts = [];
    if (pendingBefore) {
      errorParts.push('Previous failure: ' + pendingBefore);
    }
    if (currentError) {
      errorParts.push(currentError);
    }
    if (!digest && !errorParts.length) {
      return '';
    }
    const toSend = buildMergedMessage_(digest, errorParts);
    if (!toSend) {
      return '';
    }
    const result = sendTelegramMessage_(toSend);
    if (result && result.ok) {
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
    const reason = result && result.error ? String(result.error) : 'Send failed.';
    const n = getConsecutiveFailures_() + 1;
    try {
      const props = PropertiesService.getScriptProperties();
      props.setProperty(PROP_CONSECUTIVE_FAILURES, String(n));
      if (n <= MAX_CONSECUTIVE_FAILURES) {
        const stamp = formatRunDate_(new Date());
        const entry = ((stamp ? stamp + ' ' : '') + reason).substring(0, 500);
        props.setProperty(PROP_LAST_ERROR, entry);
      } else {
        // Stop retrying stale backlog; polling continues, Runs keeps the audit.
        props.deleteProperty(PROP_LAST_ERROR);
      }
    } catch (e) {
      // Ignore: Runs still records the failure below.
    }
    updateLastRunsRow_(0, ('Send failed: ' + reason).substring(0, 500));
    return '';
  } catch (e) {
    return '';
  }
}
