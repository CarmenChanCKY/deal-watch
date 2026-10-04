/**
 * Deal Watch — T4 reusable acceptance runner (TEMPORARY test helper).
 *
 * HOW TO USE (see T4-TestingPlan.md in this folder):
 * 1. Paste this file into the bound Apps Script editor as an extra file.
 * 2. Select runAllT4Checks in the function dropdown and Run.
 * 3. Read PASS/FAIL/SKIP lines under Executions (clock icon) > latest run > Logs.
 * 4. Delete this file from the editor when done. The repo copy in test/
 *    stays the source of truth for the next run. Never ship it as part of
 *    the template (test/ is not pushed to Apps Script).
 *
 * SIDE EFFECTS (expected; removed by the T4-TestingPlan.md Cleanup step):
 * - ensureTrigger()/setPollIntervalMinutes() create a real time trigger.
 * - runWatchAndNotify() appends real Runs rows.
 * - Script Properties poll_interval_minutes / last_error /
 *   consecutive_send_failures are written.
 * All merge-shape checks are pure (no IO). The missing-token probe makes
 * no network call. Work only in a TEST copy, never the live Sheet.
 */

// ---------------------------------------------------------------------------
// Mini assert framework (t4-prefixed names avoid collisions with Code.gs)
// ---------------------------------------------------------------------------

const T4R = { pass: 0, fail: 0, failures: [] };

function t4Check_(box, cond, detail) {
  if (cond) {
    T4R.pass++;
    Logger.log('PASS [' + box + ']');
  } else {
    T4R.fail++;
    T4R.failures.push(box);
    Logger.log('FAIL [' + box + ']' + (detail ? ' — ' + detail : ''));
  }
}

function t4Skip_(box, reason) {
  Logger.log('SKIP [' + box + '] — ' + reason);
}

function t4Section_(title) {
  Logger.log('--- ' + title + ' ---');
}

function t4Summary_() {
  Logger.log('=== T4 summary: ' + T4R.pass + ' passed, ' + T4R.fail + ' failed ===');
  if (T4R.failures.length) {
    Logger.log('Failed boxes: ' + T4R.failures.join(', '));
  }
}

function t4GetSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

/**
 * Data-row count (excludes the header). 0 when the sheet is missing/empty.
 */
function t4DataRowCount_(name) {
  const sh = t4GetSheet_(name);
  if (!sh || sh.getLastRow() < 2) {
    return 0;
  }
  return sh.getLastRow() - 1;
}

/**
 * { sent, error } of the newest Runs row; null when no data rows exist.
 * Columns follow HEADERS_RUNS: sent is 4th, error is 5th.
 */
function t4LastRuns_() {
  const sh = t4GetSheet_(SHEET_RUNS);
  if (!sh || sh.getLastRow() < 2) {
    return null;
  }
  const lastRow = sh.getLastRow();
  return {
    sent: Number(sh.getRange(lastRow, 4).getValue()),
    error: String(sh.getRange(lastRow, 5).getValue() || '')
  };
}

function t4GetProp_(key) {
  try {
    return PropertiesService.getScriptProperties().getProperty(key);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T4-a — trigger management (creates a real trigger; Cleanup deletes it)
// ---------------------------------------------------------------------------

function t4aTrigger_() {
  t4Section_('T4-a trigger');
  ensureTrigger();
  const c1 = countWatchTriggers_();
  ensureTrigger();
  const c2 = countWatchTriggers_();
  t4Check_('T4-a one trigger', c1 === 1, 'got ' + c1 + ' (see the Triggers clock icon)');
  t4Check_('T4-a idempotent rerun', c2 === 1, 'got ' + c2);

  const set60 = setPollIntervalMinutes(60);
  t4Check_(
    'T4-a set 60',
    set60 === 60 && getPollIntervalMinutes() === 60,
    'got ' + set60
  );
  t4Check_('T4-a still one trigger', countWatchTriggers_() === 1);

  const bad = setPollIntervalMinutes(999);
  t4Check_(
    'T4-a invalid ignored',
    bad === 60 && getPollIntervalMinutes() === 60,
    'got ' + bad
  );

  const back = setPollIntervalMinutes(15);
  t4Check_(
    'T4-a restore 15',
    back === 15 && getPollIntervalMinutes() === 15,
    'got ' + back
  );
}

// ---------------------------------------------------------------------------
// T4-b — merged message shape (pure, no IO)
// ---------------------------------------------------------------------------

function t4bMerge_() {
  t4Section_('T4-b merged message (pure)');
  t4Check_('T4-b silence', buildMergedMessage_('', []) === '');
  t4Check_(
    'T4-b digest only',
    buildMergedMessage_('Deal Watch: 1 thread matched', []) === 'Deal Watch: 1 thread matched'
  );

  const noteOnly = buildMergedMessage_('', ['Missing bot_token (Setup incomplete).']);
  t4Check_(
    'T4-b note only',
    noteOnly.indexOf('Deal Watch note:') === 0 && noteOnly.indexOf('Missing bot_token') !== -1,
    noteOnly
  );

  const merged = buildMergedMessage_('Deal Watch: 1 thread matched', ['Skipped 1 invalid sender.']);
  t4Check_(
    'T4-b merged shape',
    merged.indexOf('Deal Watch: 1 thread') === 0 &&
      merged.indexOf('Watcher note:') !== -1 &&
      merged.indexOf('Skipped 1') !== -1,
    merged
  );

  let long = '';
  for (let i = 0; i < 5000; i++) {
    long += 'x';
  }
  const cut = buildMergedMessage_(long, []);
  t4Check_(
    'T4-b truncate 4000',
    cut.length <= 4000 && cut.indexOf('(truncated)') !== -1,
    'len=' + cut.length
  );
}

// ---------------------------------------------------------------------------
// T4-b — send failure + retry (writes real Runs rows by design)
// ---------------------------------------------------------------------------

function t4cSend_() {
  t4Section_('T4-b send + fallback (live)');

  // Safe probe: with no token configured this returns before any network call
  // and never touches the real token. With a token present we skip it.
  const token = t4GetProp_('bot_token');
  if (!token) {
    const probe = sendTelegramMessage_('runner probe — must never send');
    t4Check_(
      'T4-b missing token fails safe',
      !!probe && probe.ok === false && String(probe.error).indexOf('Missing bot_token') !== -1,
      probe ? probe.error : 'no result'
    );
  } else {
    t4Skip_('T4-b missing token fails safe', 'bot_token is configured — skipping so the real token is never touched');
  }

  // The live runs below need something to send. The T4-TestingPlan.md prep
  // rule (invalid sender) guarantees a poll error; a fresh matching mail
  // would also do via a non-empty digest. With neither, the run is silence
  // by design and there is nothing to assert — that means prep was skipped.
  const rules = loadEnabledRules();
  const built = buildGmailQueries(rules, getNewerThanMinutes());
  Logger.log('INFO rules=' + rules.length + ' invalidSkipped=' + built.invalidSkipped + ' queries=' + built.queries.length);

  // Deterministic failure counting: start from a clean slate (test copy only).
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('last_error');
    props.setProperty('consecutive_send_failures', '0');
  } catch (e) {
    // Properties unavailable — the live checks below will show it.
  }

  const runsBefore = t4DataRowCount_(SHEET_RUNS);
  const out1 = runWatchAndNotify();
  const last1 = t4LastRuns_();
  if (!last1 || t4DataRowCount_(SHEET_RUNS) !== runsBefore + 1) {
    t4Check_('T4-b Runs grew by 1', false, 'Runs rows ' + runsBefore + ' -> ' + t4DataRowCount_(SHEET_RUNS));
    return;
  }
  t4Check_('T4-b Runs grew by 1', true);

  if (last1.sent === 1) {
    // Success path: a real bot is configured and Telegram accepted the note.
    t4Check_('T4-b success returns text', out1 !== '', 'empty return on sent=1');
    t4Check_('T4-b success clears last_error', getPendingError_() === '');
    t4Check_('T4-b success resets counter', getConsecutiveFailures_() === 0);
    t4Skip_('T4-b failure backlog', 'send succeeded — failure path needs no token (see T4-TestingPlan.md step 3)');
    t4Skip_('T4-b give-up after 3', 'send succeeded — nothing to give up on');
    return;
  }

  if (!last1.error || last1.error.indexOf('Send failed') === -1) {
    // Silence path: no digest and no error, so nothing was attempted.
    t4Check_('T4-b send attempted', false, 'sent=0 with no Send-failed error — silence means prep rule 91 is missing; add it per T4-TestingPlan.md');
    return;
  }

  // Failure path (default: no token configured).
  t4Check_('T4-b sent=0', last1.sent === 0, 'got sent=' + last1.sent);
  t4Check_('T4-b Runs error mentions Send failed', last1.error.indexOf('Send failed') !== -1, last1.error);
  t4Check_('T4-b returns silence on failure', out1 === '', JSON.stringify(out1));
  t4Check_('T4-b last_error set', getPendingError_() !== '');
  t4Check_('T4-b consecutive 1', getConsecutiveFailures_() === 1, 'got ' + getConsecutiveFailures_());

  runWatchAndNotify();
  t4Check_('T4-b consecutive 2', getConsecutiveFailures_() === 2, 'got ' + getConsecutiveFailures_());

  // Give-up path: a backlog already at the limit is dropped on the next
  // failure, while polling (and Runs logging) continues.
  try {
    PropertiesService.getScriptProperties().setProperty('consecutive_send_failures', '3');
  } catch (e) {
    // The check below will report it.
  }
  runWatchAndNotify();
  t4Check_('T4-b give-up counter 4', getConsecutiveFailures_() === 4, 'got ' + getConsecutiveFailures_());
  t4Check_('T4-b give-up drops backlog', getPendingError_() === '');
}

// ---------------------------------------------------------------------------
// Main entry: select runAllT4Checks in the function dropdown and Run.
// ---------------------------------------------------------------------------

function runAllT4Checks() {
  T4R.pass = 0;
  T4R.fail = 0;
  T4R.failures = [];
  Logger.log('=== Deal Watch T4 acceptance — see T4-TestingPlan.md (this folder) ===');
  t4aTrigger_();
  t4bMerge_();
  t4cSend_();
  t4Summary_();
  Logger.log('NOTE: this run created a trigger, wrote Runs rows, and wrote test properties by design — finish with the T4-TestingPlan.md Cleanup step.');
}
