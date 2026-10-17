/**
 * Deal Watch — T6 reusable acceptance runner (TEMPORARY test helper).
 *
 * HOW TO USE (see T6-TestingPlan.md in this folder):
 * 1. Paste this file into the bound Apps Script editor as an extra file.
 * 2. Select runAllT6Checks in the function dropdown and Run.
 * 3. Read PASS/FAIL lines under Executions (clock icon) > latest run > Logs.
 * 4. Delete this file from the editor when done. The repo copy in test/
 *    stays the source of truth for the next run. Never ship it as part of
 *    the template (test/ is not pushed to Apps Script).
 *
 * SIDE EFFECTS (expected; removed by the runner itself):
 * - One self-cleaning Rules round-trip row (t6test.example.com) that also
 *   exercises appendRule_ topicHint + updateRuleById_ topicHint, then deletes
 *   itself (and its rule_<id> cache key).
 * - No Telegram sends, no Gmail reads, no OpenRouter calls, no new
 *   ScriptProperties keys. Work only in a TEST copy, never the live Sheet.
 */

// ---------------------------------------------------------------------------
// Mini assert framework (t6-prefixed names avoid collisions with Code.gs)
// ---------------------------------------------------------------------------

const T6R = { pass: 0, fail: 0, failures: [] };

function t6Check_(box, cond, detail) {
  if (cond) {
    T6R.pass++;
    Logger.log('PASS [' + box + ']');
  } else {
    T6R.fail++;
    T6R.failures.push(box);
    Logger.log('FAIL [' + box + ']' + (detail ? ' — ' + detail : ''));
  }
}

function t6Section_(title) {
  Logger.log('--- ' + title + ' ---');
}

function t6Summary_() {
  Logger.log('=== T6 summary: ' + T6R.pass + ' passed, ' + T6R.fail + ' failed ===');
  if (T6R.failures.length) {
    Logger.log('Failed boxes: ' + T6R.failures.join(', '));
  }
}

// ---------------------------------------------------------------------------
// T6-b — suggestion prompt / parse / cache key / error mapping (pure)
// ---------------------------------------------------------------------------

function t6bPure_() {
  t6Section_('T6-b pure');

  const p = buildSuggestionPrompt_('sneaker');
  t6Check_('T6-b prompt has seed', p.indexOf('sneaker') !== -1);
  t6Check_('T6-b prompt no @ (no email)', p.indexOf('@') === -1);
  t6Check_('T6-b prompt asks comma list', p.indexOf('comma-separated') !== -1);

  const mp = buildMoreIdeasPrompt_('sneaker', ['restock', '補貨']);
  t6Check_(
    'T6-b more prompt seed + exclusions',
    mp.indexOf('sneaker') !== -1 && mp.indexOf('restock') !== -1 && mp.indexOf('補貨') !== -1 && mp.indexOf('Do NOT repeat') !== -1
  );

  const r1 = parseSuggestions_('air, 5折, SALE, air, 優惠');
  t6Check_('T6-b parse dedup', r1.length === 4 && r1[0] === 'air' && r1[1] === '5折', JSON.stringify(r1));

  const r2 = parseSuggestions_('1. first\n2. second\n3. third\n4. fourth\n5. fifth\n6. sixth');
  t6Check_('T6-b parse cap 5 + marker strip', r2.length === 5 && r2[0] === 'first', JSON.stringify(r2));

  const r3 = parseSuggestions_('- restock\n* 補貨\n"exact phrase"');
  t6Check_('T6-b parse bullets + quotes', r3.length === 3 && r3[0] === 'restock' && r3[2] === 'exact phrase', JSON.stringify(r3));

  t6Check_('T6-b parse empty', parseSuggestions_('').length === 0);
  t6Check_('T6-b parse leading digit kept', parseSuggestions_('5折').length === 1 && parseSuggestions_('5折')[0] === '5折');

  t6Check_('T6-b cache key case-insensitive', suggestCacheKey_('Sneaker') === suggestCacheKey_('sneaker'));
  t6Check_('T6-b cache key differs', suggestCacheKey_('a') !== suggestCacheKey_('b'));
  t6Check_('T6-b cache key prefix', suggestCacheKey_('x').indexOf('suggest_') === 0);

  t6Check_('T6-b err 200 empty', mapOpenRouterError_(200) === '');
  t6Check_('T6-b err 401', mapOpenRouterError_(401).indexOf('rejected the key') !== -1);
  t6Check_('T6-b err 403', mapOpenRouterError_(403).indexOf('rejected the key') !== -1);
  t6Check_('T6-b err 402', mapOpenRouterError_(402).indexOf('out of credit') !== -1);
  t6Check_('T6-b err 429', mapOpenRouterError_(429).indexOf('rate-limited') !== -1);
  t6Check_('T6-b err 500', mapOpenRouterError_(500) === 'OpenRouter error, try again.');

  const missKey = callOpenRouter_('', '', 'sneaker');
  t6Check_('T6-b missing key/model guard', missKey.ok === false && missKey.error.indexOf('Set an OpenRouter key') !== -1);
  const missModel = callOpenRouter_('k', '', 'sneaker');
  t6Check_('T6-b missing model guard', missModel.ok === false);
}

// ---------------------------------------------------------------------------
// T6-c — suggestion mode mapping + message-id parsing (pure)
// ---------------------------------------------------------------------------

function t6cPure_() {
  t6Section_('T6-c pure');

  t6Check_('T6-c mode dup', modeOfKeywordsStep_('await_dup_keywords') === 'dup');
  t6Check_('T6-c mode edit', modeOfKeywordsStep_('await_edit_keywords') === 'edit');
  t6Check_('T6-c mode add', modeOfKeywordsStep_('await_keywords') === 'add');
  t6Check_('T6-c mode fallback', modeOfKeywordsStep_('whatever') === 'add');

  t6Check_('T6-c extract message id ok', extractMessageId_(JSON.stringify({ ok: true, result: { message_id: 42 } })) === 42);
  t6Check_('T6-c extract message id not ok', extractMessageId_(JSON.stringify({ ok: false })) === '');
  t6Check_('T6-c extract message id garbage', extractMessageId_('not json') === '');
}

// ---------------------------------------------------------------------------
// T6-e — model metadata slim / ordering / search (pure)
// ---------------------------------------------------------------------------

function t6ePure_() {
  t6Section_('T6-e pure');

  t6Check_('T6-e router auto', isRouterModelId_('openrouter/auto') === true);
  t6Check_('T6-e router free', isRouterModelId_('openrouter/free') === true);
  t6Check_('T6-e not router', isRouterModelId_('openai/gpt-4o-mini') === false);

  t6Check_('T6-e reasoning none', modelReasoningKind_({}) === 'none');
  t6Check_('T6-e reasoning mandatory', modelReasoningKind_({ reasoning: { mandatory: true } }) === 'mandatory');
  t6Check_('T6-e reasoning optional', modelReasoningKind_({ reasoning: { mandatory: false } }) === 'optional');

  t6Check_('T6-e free 0/0', isFreeModelPricing_({ prompt: '0', completion: '0' }) === true);
  t6Check_('T6-e paid', isFreeModelPricing_({ prompt: '0.0000003', completion: '0' }) === false);
  t6Check_('T6-e free missing', isFreeModelPricing_({}) === false);

  t6Check_('T6-e text out', hasTextOutput_({ output_modalities: ['text'] }) === true);
  t6Check_('T6-e audio only', hasTextOutput_({ output_modalities: ['audio'] }) === false);
  t6Check_('T6-e no arch', hasTextOutput_({}) === false);

  const raw = [
    { id: 'openrouter/free', name: 'Free Router', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'google/audio-only', name: 'Audio Only', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
    { id: 'deepseek/r1', name: 'DeepSeek R1', pricing: { prompt: '0.001', completion: '0.002' }, reasoning: { mandatory: true }, architecture: { output_modalities: ['text'] } },
    { id: 'google/gemma:free', name: 'Gemma free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { output_modalities: ['text'] } }
  ];
  const slim = buildSlimModelMeta_(raw);
  t6Check_('T6-e slim drops router + non-text', slim.length === 3, 'len=' + slim.length);
  let hasRouter = false;
  let hasAudioOnly = false;
  for (let i = 0; i < slim.length; i++) {
    if (isRouterModelId_(slim[i].id)) {
      hasRouter = true;
    }
    if (slim[i].id === 'google/audio-only') {
      hasAudioOnly = true;
    }
  }
  t6Check_('T6-e slim no router', hasRouter === false);
  t6Check_('T6-e slim no audio-only', hasAudioOnly === false);

  const order = searchModelMeta_(slim, '');
  t6Check_('T6-e sorted: fast free first', order.length === 3 && order[0].id === 'google/gemma:free', order.length ? order[0].id : 'empty');
  t6Check_('T6-e sorted: mandatory last', order.length === 3 && order[order.length - 1].id === 'deepseek/r1', order.length ? order[order.length - 1].id : 'empty');

  const q = searchModelMeta_(slim, 'gpt');
  t6Check_('T6-e search by name', q.length === 1 && q[0].id === 'openai/gpt-4o-mini');
  t6Check_('T6-e search empty query returns all', searchModelMeta_(slim, '').length === 3);
  t6Check_('T6-e search no match', searchModelMeta_(slim, 'zzz').length === 0);
}

// ---------------------------------------------------------------------------
// T6-f — Mini App model entries: token guard rejects (no writes)
// ---------------------------------------------------------------------------

function t6fGuards_() {
  t6Section_('T6-f guards (no writes)');

  t6Check_('T6-f owner guard empty token', miniAppOwner_('') === '');
  t6Check_('T6-f owner guard bad token', miniAppOwner_('not-a-real-token') === '');
  t6Check_('T6-f getModels rejects bad token', miniAppGetModels('not-a-real-token', '', false).ok === false);
  t6Check_('T6-f setModel rejects bad token', miniAppSetModel('not-a-real-token', 'x').ok === false);
  t6Check_('T6-f clearModel rejects bad token', miniAppClearModel('not-a-real-token').ok === false);
}

// ---------------------------------------------------------------------------
// T6-g — Mini App key entries: token guard rejects (no writes, no network)
// ---------------------------------------------------------------------------

function t6gGuards_() {
  t6Section_('T6-g guards (no writes)');

  t6Check_('T6-g getState rejects bad token', miniAppGetState('not-a-real-token').ok === false);
  t6Check_('T6-g setKey rejects bad token', miniAppSetKey('not-a-real-token', 'sk-or-v1-x').ok === false);
  t6Check_('T6-g deleteKey rejects bad token', miniAppDeleteKey('not-a-real-token').ok === false);
  const st = miniAppState_();
  t6Check_('T6-g state shape', !!st && typeof st.hasKey === 'boolean' && typeof st.suggestions === 'boolean' && typeof st.keyMasked === 'string');
}

// ---------------------------------------------------------------------------
// T6-h — Mini App Ideas entries: token guard rejects (no writes, no network)
// ---------------------------------------------------------------------------

function t6hGuards_() {
  t6Section_('T6-h guards (no writes)');

  t6Check_('T6-h suggest rejects bad token', miniAppSuggest('not-a-real-token', 'sneaker', null).ok === false);
  t6Check_('T6-h ideasAdd rejects bad token', miniAppIdeasAdd('not-a-real-token', 'sneaker', ['air']).ok === false);
}

// ---------------------------------------------------------------------------
// T6 — Sheet round-trip (topic_hint write/preserve) — row deleted by runner
// ---------------------------------------------------------------------------

function t6SheetRoundTrip_() {
  t6Section_('T6 Sheet round-trip (live, self-cleaning)');

  const added = appendRule_('t6test.example.com', 'air', 'sneaker');
  if (!added.ok) {
    t6Check_('T6 append with hint', false, added.error + ' — is Rules provisioned? run ensureSchema first');
    return;
  }
  const found = findRuleById_(added.id);
  t6Check_('T6 append writes topic_hint', !!found && found.topicHint === 'sneaker', found ? found.topicHint : 'null');

  const upd = updateRuleById_(added.id, { keywordsRaw: 'air2' });
  const after = findRuleById_(added.id);
  t6Check_('T6 manual update preserves topic_hint', upd.ok && !!after && after.topicHint === 'sneaker', upd.error);

  const upd2 = updateRuleById_(added.id, { keywordsRaw: 'air2', topicHint: 'newseed' });
  const after2 = findRuleById_(added.id);
  t6Check_('T6 update sets topic_hint', upd2.ok && !!after2 && after2.topicHint === 'newseed');

  const del = deleteRuleById_(added.id);
  t6Check_('T6 delete round-trip row', del.ok && findRuleById_(added.id) === null, del.error);
}

// ---------------------------------------------------------------------------
// Main entry: select runAllT6Checks in the function dropdown and Run.
// ---------------------------------------------------------------------------

function runAllT6Checks() {
  T6R.pass = 0;
  T6R.fail = 0;
  T6R.failures = [];
  Logger.log('=== Deal Watch T6 acceptance — see T6-TestingPlan.md (this folder) ===');
  t6bPure_();
  t6cPure_();
  t6ePure_();
  t6fGuards_();
  t6gGuards_();
  t6hGuards_();
  t6SheetRoundTrip_();
  t6Summary_();
  Logger.log('NOTE: the round-trip row deleted itself; no live OpenRouter calls were made — finish with the T6-TestingPlan.md manual steps + Cleanup.');
}
