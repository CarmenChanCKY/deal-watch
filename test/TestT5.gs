/**
 * Deal Watch — T5 reusable acceptance runner (TEMPORARY test helper).
 *
 * HOW TO USE (see T5-TestingPlan.md in this folder):
 * 1. Paste this file into the bound Apps Script editor as an extra file.
 * 2. Select runAllT5Checks in the function dropdown and Run.
 * 3. Read PASS/FAIL/SKIP lines under Executions (clock icon) > latest run > Logs.
 * 4. For the paging eyeball: run seedT5PagingRules once, check Telegram,
 *    then run cleanupT5TestRules.
 * 5. Delete this file from the editor when done. The repo copy in test/
 *    stays the source of truth for the next run. Never ship it as part of
 *    the template (test/ is not pushed to Apps Script).
 *
 * SIDE EFFECTS (expected; removed by cleanupT5TestRules + plan Cleanup):
 * - appendRule_/updateRuleById_/deleteRuleById_ write real Rules rows and
 *   rule_<id> cache keys on the TEST copy (round-trip row is deleted by the
 *   runner itself; paging seeds stay until cleanupT5TestRules).
 * - No Telegram sends, no Gmail reads, no new ScriptProperties keys.
 * Work only in a TEST copy, never the live Sheet.
 */

// ---------------------------------------------------------------------------
// Mini assert framework (t5-prefixed names avoid collisions with Code.gs)
// ---------------------------------------------------------------------------

const T5R = { pass: 0, fail: 0, failures: [] };

function t5Check_(box, cond, detail) {
  if (cond) {
    T5R.pass++;
    Logger.log('PASS [' + box + ']');
  } else {
    T5R.fail++;
    T5R.failures.push(box);
    Logger.log('FAIL [' + box + ']' + (detail ? ' — ' + detail : ''));
  }
}

function t5Section_(title) {
  Logger.log('--- ' + title + ' ---');
}

function t5Summary_() {
  Logger.log('=== T5 summary: ' + T5R.pass + ' passed, ' + T5R.fail + ' failed ===');
  if (T5R.failures.length) {
    Logger.log('Failed boxes: ' + T5R.failures.join(', '));
  }
}

// ---------------------------------------------------------------------------
// T5-c — pure matching / layout helpers (no IO)
// ---------------------------------------------------------------------------

function t5cPure_() {
  t5Section_('T5-c pure');

  t5Check_(
    'T5-c same sender +tag',
    isSameSender_('Abc+sale@XXX.com', 'abc@xxx.com') === true
  );
  t5Check_(
    'T5-c same sender case domain',
    isSameSender_('XXX.com', 'xxx.com') === true
  );
  t5Check_(
    'T5-c different senders',
    isSameSender_('a@x.com', 'b@x.com') === false
  );
  t5Check_(
    'T5-c email vs domain not same',
    isSameSender_('a@x.com', 'x.com') === false
  );

  t5Check_('T5-c keywords ok', hasKeywords_('air, 5折') === true);
  t5Check_('T5-c keywords empty', hasKeywords_('') === false);
  t5Check_('T5-c keywords commas only', hasKeywords_(' , , ') === false);

  const full = [];
  for (let i = 0; i < 30; i++) {
    full.push({ enabled: true });
  }
  t5Check_('T5-c limit at 30', isRuleLimitReached_(full) === true);
  const room = full.slice(0, 29);
  room.push({ enabled: false });
  t5Check_('T5-c limit below 30', isRuleLimitReached_(room) === false);
  t5Check_('T5-c limit empty', isRuleLimitReached_([]) === false);

  t5Check_('T5-c clamp high', clampListPage_(5, 3) === 2);
  t5Check_('T5-c clamp low', clampListPage_(-1, 3) === 0);
  t5Check_('T5-c clamp NaN', clampListPage_('abc', 3) === 0);

  t5Check_('T5-c interval label 15', formatIntervalLabel_(15) === '15 min');
  t5Check_('T5-c interval label 120', formatIntervalLabel_(120) === '2 hours');
  t5Check_('T5-c interval label 720', formatIntervalLabel_(720) === '12 hours');
  t5Check_('T5-c interval button current', formatIntervalButton_(15, 15) === '15min (current)');
  t5Check_('T5-c interval button plain', formatIntervalButton_(30, 15) === '30min');
  t5Check_('T5-c interval button 2hr', formatIntervalButton_(120, 15) === '2hr');
}

// ---------------------------------------------------------------------------
// T5-c — list + detail layout (pure, fake rows)
// ---------------------------------------------------------------------------

function t5cFakeRules_(count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const id = String(900 + i);
    out.push({
      id: id,
      sender: 'p' + (i < 10 ? '0' + i : i) + '.example.com',
      keywordsRaw: 'air',
      enabled: i % 2 === 1,
      updatedAt: '2026-10-15 10:00'
    });
  }
  return out;
}

function t5cLayout_() {
  t5Section_('T5-c list/detail layout');

  const empty = buildListPage_([], 0);
  t5Check_('T5-c list empty text', empty.text === 'No rules yet. Send /add to create one.');

  const rules = t5cFakeRules_(11);
  const p0 = buildListPage_(rules, 0);
  t5Check_('T5-c page 1/2', p0.text.indexOf('page 1/2') !== -1, p0.text.split('\n')[0]);
  const kb0 = p0.keyboard ? p0.keyboard.inline_keyboard : [];
  t5Check_('T5-c 2-per-row rows', kb0.length === 6, 'rows=' + kb0.length);
  let pairsOk = true;
  for (let r = 0; r < 5; r++) {
    if (!kb0[r] || kb0[r].length !== 2) {
      pairsOk = false;
    }
  }
  t5Check_('T5-c rows hold 2', pairsOk === true);
  t5Check_(
    'T5-c nav Next only',
    kb0.length === 6 && kb0[5].length === 1 && kb0[5][0].callback_data === 'rule:list:1',
    JSON.stringify(kb0[5] || [])
  );

  const p1 = buildListPage_(rules, 1);
  t5Check_('T5-c page 2/2', p1.text.indexOf('page 2/2') !== -1, p1.text.split('\n')[0]);
  const kb1 = p1.keyboard ? p1.keyboard.inline_keyboard : [];
  t5Check_(
    'T5-c last page view+Prev',
    kb1.length === 2 &&
      kb1[0].length === 1 && kb1[0][0].callback_data === 'rule:view:911' &&
      kb1[1].length === 1 && kb1[1][0].callback_data === 'rule:list:0',
    JSON.stringify(kb1)
  );

  const on = { id: '7', sender: 'x.com', keywordsRaw: 'air', enabled: true, updatedAt: '' };
  const builtOn = buildRuleDetail_(on);
  t5Check_('T5-c detail Enabled', builtOn.text.indexOf('Enabled') !== -1);
  t5Check_(
    'T5-c detail Disable btn',
    builtOn.keyboard.inline_keyboard[0][0].text === 'Disable' &&
      builtOn.keyboard.inline_keyboard[0][0].callback_data === 'rule:toggle:7'
  );
  const off = { id: '7', sender: 'x.com', keywordsRaw: 'air', enabled: false, updatedAt: '' };
  t5Check_(
    'T5-c detail Enable btn',
    buildRuleDetail_(off).keyboard.inline_keyboard[0][0].text === 'Enable'
  );
}

// ---------------------------------------------------------------------------
// T5-c — Sheet round-trip on the TEST copy (row deleted by the runner)
// ---------------------------------------------------------------------------

function t5cRoundTrip_() {
  t5Section_('T5-c Sheet round-trip (live, self-cleaning)');

  const added = appendRule_('t5test.example.com', 'air, testkw');
  if (!added.ok) {
    t5Check_('T5-c append', false, added.error + ' — is Rules provisioned? run ensureSchema first');
    return;
  }
  t5Check_('T5-c append', true);

  const found = findRuleById_(added.id);
  t5Check_('T5-c find by id', !!found && found.sender === 't5test.example.com');

  const dup = findRuleBySender_('T5TEST.EXAMPLE.COM');
  t5Check_('T5-c find by sender', !!dup && String(dup.id) === String(added.id));

  const upd = updateRuleById_(added.id, { keywordsRaw: 'air2' });
  const after = findRuleById_(added.id);
  t5Check_('T5-c update', upd.ok && !!after && after.keywordsRaw === 'air2', upd.error);

  const del = deleteRuleById_(added.id);
  t5Check_('T5-c delete', del.ok && findRuleById_(added.id) === null, del.error);

  let cacheGone = false;
  try {
    cacheGone = PropertiesService.getScriptProperties().getProperty('rule_' + added.id) === null;
  } catch (e) {
    cacheGone = false;
  }
  t5Check_('T5-c cache cleaned', cacheGone === true);
}

// ---------------------------------------------------------------------------
// Paging seeds for the manual Telegram eyeball (kept until cleanup)
// ---------------------------------------------------------------------------

/**
 * Create 11 temp rules (t5page01..11) for the /list Prev/Next eyeball.
 * Run once from the dropdown, check Telegram, then run cleanupT5TestRules.
 */
function seedT5PagingRules() {
  let made = 0;
  for (let i = 1; i <= 11; i++) {
    const sender = 't5page' + (i < 10 ? '0' + i : i) + '.example.com';
    if (findRuleBySender_(sender)) {
      continue;
    }
    const res = appendRule_(sender, 't5seed');
    if (res.ok) {
      made++;
    } else {
      Logger.log('SEED FAIL [' + sender + '] — ' + res.error);
    }
  }
  Logger.log('seedT5PagingRules: created ' + made + ' temp rules (delete with cleanupT5TestRules).');
}

/**
 * Delete all runner-made temp rules (t5page* + t5test*) with cache keys.
 * Run from the dropdown as the T5-TestingPlan.md Cleanup step.
 */
function cleanupT5TestRules() {
  const rules = loadAllRules_();
  let removed = 0;
  for (let i = 0; i < rules.length; i++) {
    const s = String(rules[i].sender || '');
    if (s.indexOf('t5page') === 0 || s === 't5test.example.com') {
      const res = deleteRuleById_(rules[i].id);
      if (res.ok) {
        removed++;
      } else {
        Logger.log('CLEANUP FAIL [' + s + '] — ' + res.error);
      }
    }
  }
  Logger.log('cleanupT5TestRules: removed ' + removed + ' temp rules.');
}

// ---------------------------------------------------------------------------
// Main entry: select runAllT5Checks in the function dropdown and Run.
// ---------------------------------------------------------------------------

function runAllT5Checks() {
  T5R.pass = 0;
  T5R.fail = 0;
  T5R.failures = [];
  Logger.log('=== Deal Watch T5 acceptance — see T5-TestingPlan.md (this folder) ===');
  t5cPure_();
  t5cLayout_();
  t5cRoundTrip_();
  t5Summary_();
  Logger.log('NOTE: the round-trip row deleted itself; paging seeds (if any) stay until cleanupT5TestRules — finish with the T5-TestingPlan.md Cleanup step.');
}
