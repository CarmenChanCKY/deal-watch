/**
 * Deal Watch — T3 reusable acceptance runner (TEMPORARY test helper).
 *
 * HOW TO USE (see T3-TestingPlan.md in this folder):
 * 1. Paste this file into the bound Apps Script editor as an extra file.
 * 2. Select runAllT3Checks in the function dropdown and Run.
 * 3. Read PASS/FAIL/SKIP lines under Executions (clock icon) > latest run > Logs.
 * 4. Delete this file from the editor when done. The repo copy in test/
 *    stays the source of truth for the next run. Never ship it as part of
 *    the template (test/ is not pushed to Apps Script).
 *
 * SIDE EFFECTS (expected; removed by the T3-TestingPlan.md Cleanup step):
 * - ensureSchema() creates/hides Rules/Log/Runs (idempotent).
 * - runWatchOnce() appends real Log/Runs rows for fresh test mail.
 * - The prune self-check inserts one dummy Log row that the code under
 *   test must delete.
 * All other checks are read-only.
 */

// ---------------------------------------------------------------------------
// Mini assert framework (t3-prefixed names avoid collisions with Code.gs)
// ---------------------------------------------------------------------------

const T3R = { pass: 0, fail: 0, failures: [] };

function t3Check_(box, cond, detail) {
  if (cond) {
    T3R.pass++;
    Logger.log('PASS [' + box + ']');
  } else {
    T3R.fail++;
    T3R.failures.push(box);
    Logger.log('FAIL [' + box + ']' + (detail ? ' — ' + detail : ''));
  }
}

function t3Skip_(box, reason) {
  Logger.log('SKIP [' + box + '] — ' + reason);
}

function t3Section_(title) {
  Logger.log('--- ' + title + ' ---');
}

function t3Summary_() {
  Logger.log('=== T3 summary: ' + T3R.pass + ' passed, ' + T3R.fail + ' failed ===');
  if (T3R.failures.length) {
    Logger.log('Failed boxes: ' + T3R.failures.join(', '));
  }
}

function t3GetSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

/**
 * Data-row count (excludes the header). 0 when the sheet is missing/empty.
 */
function t3DataRowCount_(name) {
  const sh = t3GetSheet_(name);
  if (!sh || sh.getLastRow() < 2) {
    return 0;
  }
  return sh.getLastRow() - 1;
}

function t3IsHidden_(name) {
  const sh = t3GetSheet_(name);
  return !!sh && sh.isSheetHidden();
}

/**
 * True when a message_id exists anywhere in the Log sheet.
 */
function t3LogHasMessageId_(messageId) {
  const sh = t3GetSheet_(SHEET_LOG);
  if (!sh || sh.getLastRow() < 2) {
    return false;
  }
  const values = sh.getDataRange().getValues();
  let msgIdx = -1;
  for (let c = 0; c < values[0].length; c++) {
    if (String(values[0][c]).replace(/^\s+|\s+$/g, '').toLowerCase() === 'message_id') {
      msgIdx = c;
      break;
    }
  }
  if (msgIdx < 0) {
    return false;
  }
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][msgIdx]).replace(/^\s+|\s+$/g, '') === messageId) {
      return true;
    }
  }
  return false;
}

/**
 * `sent` column of the newest Runs row; null when no data rows exist.
 */
function t3LastRunsSent_() {
  const sh = t3GetSheet_(SHEET_RUNS);
  if (!sh || sh.getLastRow() < 2) {
    return null;
  }
  return Number(sh.getRange(sh.getLastRow(), 4).getValue());
}

function t3SameIdSet_(a, b) {
  const ids = function (list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push(list[i].messageId);
    }
    return out.sort().join('|');
  };
  return ids(a) === ids(b);
}

// ---------------------------------------------------------------------------
// T3-a — helpers (pure asserts + ensureSchema idempotency)
// ---------------------------------------------------------------------------

function t3aHelpers_() {
  t3Section_('T3-a helpers');
  t3Check_('T3-a normalize full-width', normalizeText('ＡＢＣ　 ') === 'abc');
  t3Check_('T3-a normalize Chinese passthrough', normalizeText('優惠') === '優惠');
  t3Check_('T3-a sender +tag strip', normalizeSenderEmail('Abc+sale@XXX.com') === 'abc@xxx.com');
  t3Check_('T3-a isEmailSender domain', isEmailSender('nike.com') === false);
  t3Check_('T3-a isEmailSender email', isEmailSender('a@nike.com') === true);
  t3Check_('T3-a domain-contains', senderMatches('nike.com', 'Promo <abc@nike.com>') === true);
  t3Check_('T3-a email-exact +tag', senderMatches('abc@nike.com', 'Abc+sale@NIKE.com') === true);
  t3Check_('T3-a non-match', senderMatches('nike.com', 'hi@adidas.com') === false);
  t3Check_('T3-a empty rule', senderMatches('', 'a@nike.com') === false);

  const pk = parseKeywords('air, "limited edition", ,');
  t3Check_('T3-a parse count', pk.length === 2, 'got ' + pk.length);
  t3Check_(
    'T3-a parse phrase flag',
    pk.length === 2 && pk[0].isPhrase === false && pk[1].isPhrase === true
  );

  const hay = buildNormalizedHaystack('Weekend Stuff', 'AIR fives');
  const hits = matchKeywordsInText(hay, parseKeywords('air, fives, missing'));
  t3Check_('T3-a OR match', hits.length === 2, 'got ' + hits.length);

  const iv = getPollIntervalMinutes();
  t3Check_(
    'T3-a interval allowlist',
    [15, 30, 60, 120, 360, 720].indexOf(iv) !== -1,
    'got ' + iv
  );
  t3Check_('T3-a newer_than 2x', getNewerThanMinutes() === iv * 2);

  const beforeRules = t3DataRowCount_(SHEET_RULES);
  const beforeLog = t3DataRowCount_(SHEET_LOG);
  const beforeRuns = t3DataRowCount_(SHEET_RUNS);
  ensureSchema();
  t3Check_(
    'T3-a ensureSchema idempotent',
    t3DataRowCount_(SHEET_RULES) === beforeRules &&
      t3DataRowCount_(SHEET_LOG) === beforeLog &&
      t3DataRowCount_(SHEET_RUNS) === beforeRuns,
    'row counts changed on rerun'
  );
  t3Check_(
    'T3-a sheets hidden',
    t3IsHidden_(SHEET_RULES) && t3IsHidden_(SHEET_LOG) && t3IsHidden_(SHEET_RUNS)
  );
}

// ---------------------------------------------------------------------------
// T3-b — polling + per-message match (read-only; no Log/Runs writes)
// ---------------------------------------------------------------------------

function t3bPolling_() {
  t3Section_('T3-b polling');
  const rules = loadEnabledRules();
  const senders = [];
  for (let i = 0; i < rules.length; i++) {
    senders.push(String(rules[i].sender).toLowerCase());
  }
  Logger.log('INFO enabled rules (' + rules.length + '): ' + senders.join(' | '));
  const defaultPrep = senders.indexOf('gmail.com') !== -1;
  if (defaultPrep) {
    t3Check_('T3-b rules loaded', rules.length === 3, 'got ' + rules.length);
  } else {
    t3Check_('T3-b rules loaded', rules.length >= 1, 'got ' + rules.length);
  }
  t3Check_('T3-b disabled skipped', senders.indexOf('example.com') === -1);
  t3Check_('T3-b empty-keywords skipped', senders.indexOf('empty-test.com') === -1);

  const built = buildGmailQueries(rules, getNewerThanMinutes());
  Logger.log('INFO queries: ' + built.queries.join(' ;; '));
  t3Check_(
    'T3-b queries batched 1-2',
    built.queries.length >= 1 && built.queries.length <= 2,
    'got ' + built.queries.length
  );
  let shapeOk = built.queries.length > 0;
  for (let i = 0; i < built.queries.length; i++) {
    if (built.queries[i].indexOf('from:{') !== 0 || !/newer_than:\d+m$/.test(built.queries[i])) {
      shapeOk = false;
    }
  }
  t3Check_('T3-b query shape', shapeOk);

  let prepHasInvalid = false;
  for (let i = 0; i < rules.length; i++) {
    if (!isValidSender_(rules[i].sender)) {
      prepHasInvalid = true;
    }
  }
  if (prepHasInvalid) {
    t3Check_(
      'T3-b invalid skipped+counted',
      built.invalidSkipped >= 1,
      'invalidSkipped=' + built.invalidSkipped
    );
  } else {
    t3Skip_('T3-b invalid skipped+counted', 'prep has no invalid-sender rule (720-fallback path?)');
  }
  t3Check_('T3-b no defensive truncate', built.truncated === false, 'truncated with ' + built.validSenders + ' senders');

  const p1 = pollNewMatches();
  Logger.log('INFO threadsScanned=' + p1.threadsScanned + ' matches=' + p1.matches.length + ' error="' + p1.error + '"');
  for (let i = 0; i < p1.matches.length; i++) {
    Logger.log('INFO match: from=' + p1.matches[i].fromEmail + ' kws=' + p1.matches[i].matchedKeywords.join(', '));
  }
  t3Check_('T3-b threads scanned', p1.threadsScanned > 0, 'is the test mail fresh (inside newer_than window)?');
  t3Check_('T3-b matches found', p1.matches.length > 0, 'is the test mail fresh (inside newer_than window)?');

  let union = false;
  for (let i = 0; i < p1.matches.length; i++) {
    if (p1.matches[i].matchedKeywords.length >= 2) {
      union = true;
    }
  }
  if (defaultPrep && p1.matches.length) {
    t3Check_('T3-b keyword union', union, 'one mail should union keywords across the domain + email rules');
  } else {
    t3Skip_('T3-b keyword union', 'needs the default T3-TestingPlan.md prep (gmail.com + full-email rules on one mail)');
  }

  const own = getOwnEmail_();
  if (own) {
    let ownLeak = false;
    for (let i = 0; i < p1.matches.length; i++) {
      if (p1.matches[i].fromEmail === own) {
        ownLeak = true;
      }
    }
    t3Check_('T3-b own-sent ignored', !ownLeak);
  } else {
    t3Skip_('T3-b own-sent ignored', 'own email unavailable — filtering disabled by design');
  }

  if (prepHasInvalid) {
    t3Check_('T3-b invalid in error', p1.error.indexOf('invalid') !== -1, 'error="' + p1.error + '"');
  } else {
    t3Skip_('T3-b invalid in error', 'prep has no invalid-sender rule');
  }

  const p2 = pollNewMatches();
  t3Check_('T3-b repeat stable pre-log', t3SameIdSet_(p1.matches, p2.matches));
}

// ---------------------------------------------------------------------------
// T3-c — digest + writes (Log/Runs writes expected; cleaned in Cleanup)
// ---------------------------------------------------------------------------

function t3cDigest_() {
  t3Section_('T3-c digest+writes');

  // Pure collapse/digest checks on synthetic data (no IO).
  const day = new Date('2026-10-01T12:00:00+08:00');
  const collapsed = collapseMatchesByThread([
    { threadId: 't1', messageId: 'm1', from: 'a', fromEmail: 'a@x.com', subject: 'old', date: new Date(day.getTime() - 1000), matchedKeywords: ['air'], ruleIds: ['4'], senders: ['gmail.com'] },
    { threadId: 't1', messageId: 'm2', from: 'a', fromEmail: 'a@x.com', subject: 'new', date: day, matchedKeywords: ['AIR', 'fives'], ruleIds: ['4', '5'], senders: ['gmail.com', 'friend@gmail.com'] }
  ]);
  t3Check_('T3-c collapse one group', collapsed.length === 1, 'got ' + collapsed.length);
  t3Check_(
    'T3-c collapse union dedups case',
    collapsed.length === 1 && collapsed[0].matchedKeywords.length === 2,
    collapsed.length ? 'got ' + collapsed[0].matchedKeywords.join(', ') : 'no group'
  );
  t3Check_(
    'T3-c collapse newest wins',
    collapsed.length === 1 && collapsed[0].subject === 'new'
  );
  t3Check_('T3-c empty digest silence', buildDigestString([]) === '');
  const dg = buildDigestString(collapsed);
  t3Check_(
    'T3-c digest shape',
    dg.indexOf('Deal Watch: 1 thread') === 0 &&
      dg.indexOf('https://mail.google.com/mail/u/0/#inbox/t1') !== -1,
    dg
  );

  // Live run: writes real Log/Runs rows by design.
  const logBefore = t3DataRowCount_(SHEET_LOG);
  const runsBefore = t3DataRowCount_(SHEET_RUNS);
  const digest1 = runWatchOnce();
  if (digest1) {
    Logger.log('INFO digest:\n' + digest1);
    t3Check_('T3-c digest non-empty', true);
    t3Check_(
      'T3-c Log grew',
      t3DataRowCount_(SHEET_LOG) > logBefore,
      'Log rows ' + logBefore + ' -> ' + t3DataRowCount_(SHEET_LOG)
    );
    t3Check_(
      'T3-c Runs row sent=0',
      t3DataRowCount_(SHEET_RUNS) === runsBefore + 1 && t3LastRunsSent_() === 0,
      'Runs rows ' + runsBefore + ' -> ' + t3DataRowCount_(SHEET_RUNS)
    );
    const digest2 = runWatchOnce();
    t3Check_('T3-c silence on repeat', digest2 === '', JSON.stringify(digest2));
  } else {
    // Either a repeat pass (mail already logged) or stale/missing mail.
    if (t3DataRowCount_(SHEET_LOG) > 0) {
      t3Skip_('T3-c digest non-empty/Log grew/silence', 'repeat pass — mail already logged; clear Log test rows for a fresh pass');
    } else {
      t3Check_('T3-c matches exist', false, 'empty digest with empty Log — is the test mail fresh (<30m)?');
    }
  }

  // Prune self-check: insert one expired dummy row; the code must delete it.
  const logSheet = t3GetSheet_(SHEET_LOG);
  if (!logSheet) {
    t3Check_('T3-c prune 30-day', false, 'Log sheet missing');
    return;
  }
  logSheet.appendRow([new Date(Date.now() - 32 * 864e5), 'runner-prune-dummy-id', 'prune@test.com', 'test', 'prune test', 'matched']);
  runWatchOnce();
  t3Check_('T3-c prune 30-day', !t3LogHasMessageId_('runner-prune-dummy-id'));
}

// ---------------------------------------------------------------------------
// T3-d — manifest (only the timezone is readable from code; scopes stay manual)
// ---------------------------------------------------------------------------

function t3dManifest_() {
  t3Section_('T3-d manifest');
  let tz = '';
  try {
    tz = Session.getScriptTimeZone();
  } catch (e) {
    tz = '';
  }
  t3Check_('T3-d timezone Asia/Hong_Kong', tz === 'Asia/Hong_Kong', 'got "' + tz + '"');
  Logger.log('INFO scopes cannot be read from code — verify the 5 scopes manually per T3-TestingPlan.md (Project Settings > Scopes).');
}

// ---------------------------------------------------------------------------
// Main entry: select runAllT3Checks in the function dropdown and Run.
// ---------------------------------------------------------------------------

function runAllT3Checks() {
  T3R.pass = 0;
  T3R.fail = 0;
  T3R.failures = [];
  Logger.log('=== Deal Watch T3 acceptance — see T3-TestingPlan.md (this folder) ===');
  t3aHelpers_();
  t3bPolling_();
  t3cDigest_();
  t3dManifest_();
  t3Summary_();
  Logger.log('NOTE: this run wrote Log/Runs rows by design — finish with the T3-TestingPlan.md Cleanup step.');
}
