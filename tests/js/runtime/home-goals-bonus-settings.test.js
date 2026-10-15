'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {fixture, load, deferred, settle} = require('./home-friends-native-app-fixture.cjs');
const INCLUDE = 'Include random album from Album Tops', DRAW = 'Add weekly bonus album';
const TOP = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333', GOAL = '44444444-4444-4444-8444-444444444444';
const CYCLE = '55555555-5555-4555-8555-555555555555', ALBUM = '66666666-6666-4666-8666-666666666666';
const fields = ['enabled', 'source_mode', 'selected_top_refs', 'preferred_top_refs', 'album_mode', 'unfinished_policy'];
const values = settings => Object.fromEntries(fields.map(key => [key, settings[key]]));
const defaults = () => ({enabled:false, source_mode:'all_active', selected_top_refs:[], preferred_top_refs:[], album_mode:'next', unfinished_policy:'carry',
  settings_revision:'1', selection_algorithm:'active-top-weighted-v1', normal_top_weight:1, preferred_top_weight:3});
const top = (ref = TOP, title = 'Readable private Top', active = true, readable = true) => ({top_ref:ref, title, description:'', revision:'1', visibility:'private',
  allowed_actions:{can_read:readable}, top_viewer_overlay:{activity:{active, activity_revision:'1'}}});
const page = (tops = [], next_cursor = null) => ({tops, next_cursor, allowed_actions:{can_read:true}});
function aggregate(bonus) {
  const populated = bonus.bonus?.present === true, started = bonus.cycle_id !== null;
  const periods = Object.fromEntries(['week','month','six-months','year'].map(period => [period, {
    top_ref:started ? GOAL : null, period, cycle:period === 'week' && started ? {cycle_id:CYCLE, started_at:'2026-10-14T00:00:00Z',
      start_date:'2026-10-14', due_date:'2026-10-21', timezone_name:'UTC'} : null,
    album_refs:period === 'week' && populated ? [ALBUM] : [], manual_completed_at:period === 'week' && populated ? {[ALBUM]:null} : {},
    total:period === 'week' && populated ? 1 : 0, completed:0,
  }]));
  return {goal_ref:started ? GOAL : null, revision:started ? '2' : '1', periods, albums:populated ? [{catalog_ref:ALBUM,
    title:'Captured bonus', artist_display:'Artist', first_release_date:null, primary_type:null}] : [],
    allowed_actions:{can_read:true, can_add:true, can_reset:true, can_complete:true, can_remove:true}};
}
async function mounted(t, options = {}) {
  const h = fixture(t), {createGoalsProvider} = await load('goals-provider.mjs'), {createGoalsController} = await load('goals-model.mjs');
  const {mountGoalBonusSettings, mountGoalBonusSwitch} = await load('goals-bonus-settings.mjs'), {openNativeDialog} = await load('native-dialog.mjs');
  const {createAlbumTopBackendProviders} = await import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/album-tops/backend-providers.mjs')).href);
  const requests = [], sourceRequests = [], saves = [], draws = [], drawTasks = [], listeners = new Set(), pages = [...(options.pages || [page([top()])])];
  let settings = {...defaults(), ...options.settings}, bonus = options.bonus || {cycle_id:null, bonus:null, manual_count:0};
  let data = aggregate(bonus), context = 'a'.repeat(64), live = true, sourceLive = options.sources === true, dialog, child, expected, key = 0;
  const sourceScope = 'goals-bonus-dialog-test';
  t.after(async () => {await Promise.allSettled(drawTasks);});
  const wire = {context:() => context, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, async request(route, opts) {
    requests.push({route, options:opts}); let result;
    if (opts.method !== 'POST') result = route === '/account/goals' ? data : route === '/account/goals/bonus-settings' ? settings : route === '/account/goals/bonus' ? bonus : undefined;
    else if (route === '/account/goals/bonus-settings') {
      const proposed = values(opts.body), changed = JSON.stringify(proposed) !== JSON.stringify(values(settings));
      settings = {...settings, ...proposed, settings_revision:String(BigInt(settings.settings_revision) + (changed ? 1n : 0n))};
      result = {ok:true, action:'bonus_settings', request_key:opts.body.request_key, changed, settings};
    } else if (route === '/account/goals/bonus/draw') result = {ok:true, action:'bonus_draw', request_key:opts.body.request_key, changed:false,
      reason:'no_eligible_source', goal_ref:data.goal_ref, revision:data.revision, period:'week', cycle_id:bonus.cycle_id, catalog_ref:null};
    assert.notEqual(result, undefined, `Unexpected Goals transport call ${route}`);
    return {status:'ready', context_ref:context, data:result};
  }};
  const provider = h.own(createGoalsProvider(wire));
  const controller = h.own(createGoalsController({provider, timezone:'UTC', canDrawBonus:() => sourceLive,
    requestKey:() => `99999999-9999-4999-8999-${String(++key).padStart(12, '0')}`}));
  const sourceProvider = h.own(createAlbumTopBackendProviders({acceptsScope:scope => sourceLive && scope === sourceScope,
    transport:{context:() => sourceLive ? 'library-context' : null, async request(route, opts) {
      sourceRequests.push({route, options:opts}); const item = pages.shift(); assert.notEqual(item, undefined, `Unexpected source call ${route}`);
      const result = await (typeof item === 'function' ? item(route, opts) : item); if (result instanceof Error) throw result;
      return {status:'ready', context_ref:'library-context', data:result};
    }}}));
  h.runtime.switchHtml = config => h.c.buildGallerySwitchHtml(config);
  await controller.loadBonus(); await settle();
  const opener = h.add('open-bonus-settings', 'button'); opener.textContent = 'Bonus settings';
  function open() {
    const snapshot = controller.getSnapshot(); expected = Object.freeze({data:snapshot.data, settings:snapshot.settings, bonus:snapshot.bonus, period:snapshot.period});
    dialog = h.own(openNativeDialog(h.runtime, {title:'Bonus album settings', returnFocus:() => opener}, {
      fallbackHost:h.host, mount(host, close) {
        child = mountGoalBonusSettings(host, h.runtime, {controller, expected, proposedEnabled:options.proposedEnabled,
          sourceProvider:options.sources ? sourceProvider : undefined, sourceScope:options.sources ? sourceScope : undefined,
          sourceCurrent:() => sourceLive, isCurrent:() => live,
          onClose:next => close(next),
          onSave:(proposed, captured) => {saves.push({proposed, captured}); close({restoreFocus:false}); return controller.saveBonusSettings(proposed, captured);},
          onDraw:captured => {draws.push(captured); close({restoreFocus:false}); const task=controller.drawBonus(captured);drawTasks.push(task);return task;},
        }); return child;
      },
    })); h.drain(); return dialog;
  }
  return {...h, controller, provider, sourceProvider, mountGoalBonusSwitch, requests, sourceRequests, saves, draws, drawTasks, pages, opener, open,
    get child() {return child;}, get expected() {return expected;}, get settings() {return settings;},
    loseSources() {sourceLive = false; child?.updateSource({sourceProvider, sourceScope, sourceCurrent:() => sourceLive});},
    changeContext() {context = 'b'.repeat(64); for (const fn of [...listeners]) fn();},
    retire() {live = false; child?.updateSource({sourceProvider, sourceScope, sourceCurrent:() => sourceLive});},
    posts:() => requests.filter(item => item.options.method === 'POST'),
  };
}
function check(h, label, checked) {const input = h.form.querySelector(`[aria-label="${label}"]`); assert.ok(input); input.checked = checked; input.dispatchEvent(new h.c.Event('change', {bubbles:true})); return input;}
function choose(h, prefix, label) {
  const trigger = h.form.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || '').startsWith(`${prefix}:`));
  assert.ok(trigger); h.click(trigger); h.drain();
  const item = h.document.querySelectorAll('[role="menuitemradio"]').find(node => node.textContent.trim() === label);
  assert.ok(item, `canonical choice contains ${label}`); h.click(item); h.drain();
}
const sourceTrigger = h => h.form.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || '').startsWith('Sources:'));

test('Persisted canonical switch keeps its button identity and never changes state on activation', async t => {
  const h = await mounted(t); let proposed = 0;
  const slot = h.add('goals-switch-slot'), props = {id:'home-goals-bonus-switch-test', enabled:false, disabled:false, onClick:() => proposed++};
  const owner = h.own(h.mountGoalBonusSwitch(slot, h.runtime, props)), button = slot.firstElementChild;
  assert.equal(button.getAttribute('role'), 'switch'); assert.equal(button.getAttribute('aria-checked'), 'false');
  assert.equal(button.hasAttribute('data-gallery-source'), false); assert.match(button.textContent, /Include random album from Album Tops/);
  h.click(button); assert.equal(proposed, 1); assert.equal(button.getAttribute('aria-checked'), 'false');
  owner.update({...props, enabled:true}); assert.equal(slot.firstElementChild, button); assert.equal(button.getAttribute('aria-checked'), 'true');
  owner.update({...props, enabled:true, disabled:true}); h.click(button); assert.equal(proposed, 1);
  owner.dispose(); h.click(button); assert.equal(proposed, 1); assert.equal(slot.children.length, 0);
  assert.equal(h.posts().length, 0); assert.equal(h.sourceRequests.length, 0);
});

test('Account-only preferences preserve inaccessible source IDs and save exactly six values without discovery or draw', async t => {
  const h = await mounted(t, {settings:{source_mode:'selected', selected_top_refs:[TOP,HIDDEN], preferred_top_refs:[HIDDEN]}});
  h.open(); await settle(); assert.match(h.form.textContent, /Album Top sources are unavailable without your library/);
  assert.equal(sourceTrigger(h).disabled, true); assert.equal(h.named(DRAW).disabled, true);
  check(h, INCLUDE, true); choose(h, 'Album choice', 'Random unfinished album'); choose(h, 'Unfinished bonus', 'Keep in existing larger periods');
  assert.equal(h.posts().length, 0); assert.equal(h.sourceRequests.length, 0);
  h.click(h.named('Save', h.form)); await settle();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].captured, h.expected);
  assert.deepEqual(Object.keys(h.saves[0].proposed).sort(), [...fields].sort());
  assert.deepEqual(h.saves[0].proposed, {enabled:true, source_mode:'selected', selected_top_refs:[TOP,HIDDEN], preferred_top_refs:[HIDDEN], album_mode:'random', unfinished_policy:'larger_period'});
  assert.equal(h.posts().length, 1); assert.equal(h.posts()[0].route, '/account/goals/bonus-settings'); assert.equal(h.draws.length, 0);
});

test('Proposed enabled state stays local and Cancel writes nothing', async t => {
  const h = await mounted(t, {proposedEnabled:true}); h.open(); await settle();
  assert.equal(h.form.querySelector(`[aria-label="${INCLUDE}"]`).checked, true); assert.equal(h.settings.enabled, false);
  assert.equal(h.named(DRAW).disabled, true); h.click(h.named('Cancel', h.form)); h.drain();
  assert.equal(h.form.hidden, true); assert.equal(h.settings.enabled, false); assert.equal(h.posts().length, 0); assert.equal(h.draws.length, 0);
});

test('Canonical directory pagination is consumed completely while all-active saves an empty selected array', async t => {
  const h = await mounted(t, {sources:true, settings:{enabled:true}, pages:[page([top()], 'second'), page([top(OTHER, 'Second-page Top')])]});
  assert.equal(h.sourceRequests.length, 0); h.open(); await settle(); h.drain();
  assert.equal(h.sourceRequests.length, 2); assert.match(h.sourceRequests[1].route, /cursor=second/);
  assert.match(h.form.textContent, /Second-page Top/); assert.equal(h.posts().length, 0);
  check(h, 'Prefer Second-page Top', true); assert.equal(h.named(DRAW).disabled, true);
  h.click(h.named('Save', h.form)); await settle();
  assert.equal(h.saves[0].proposed.source_mode, 'all_active'); assert.deepEqual(h.saves[0].proposed.selected_top_refs, []);
  assert.deepEqual(h.saves[0].proposed.preferred_top_refs, [OTHER]); assert.equal(h.draws.length, 0);
});

test('Selected-mode preferred choices stay a subset and unavailable saved references are not silently pruned', async t => {
  const h = await mounted(t, {sources:true, settings:{source_mode:'selected', selected_top_refs:[HIDDEN], preferred_top_refs:[HIDDEN]},
    pages:[page([top(), top(OTHER, 'Inactive private title', false)])]}); h.open(); await settle();
  assert.doesNotMatch(h.form.textContent, /Inactive private title/); assert.match(h.form.textContent, /Unavailable saved Top 1/);
  assert.equal(h.form.querySelector('[aria-label="Prefer Readable private Top"]').disabled, true);
  check(h, 'Include Readable private Top', true); check(h, 'Prefer Readable private Top', true);
  check(h, 'Include Readable private Top', false); h.click(h.named('Save', h.form)); await settle();
  assert.deepEqual(h.saves[0].proposed.selected_top_refs, [HIDDEN]); assert.deepEqual(h.saves[0].proposed.preferred_top_refs, [HIDDEN]);
});

test('Changing all-active to selected preserves preferred unavailable IDs rather than erasing them', async t => {
  const h = await mounted(t, {sources:true, settings:{preferred_top_refs:[HIDDEN]}}); h.open(); await settle();
  choose(h, 'Sources', 'Selected Tops'); h.click(h.named('Save', h.form)); await settle();
  assert.equal(h.saves[0].proposed.source_mode, 'selected'); assert.deepEqual(h.saves[0].proposed.selected_top_refs, [HIDDEN]);
  assert.deepEqual(h.saves[0].proposed.preferred_top_refs, [HIDDEN]);
});

for (const mode of ['all_active', 'selected']) test(`100 ${mode} preferred refs cannot admit a 101st choice through retained input events`, async t => {
  const refs = Array.from({length:100}, (_, index) => `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`);
  const h = await mounted(t, {sources:true, settings:{source_mode:mode, selected_top_refs:mode === 'selected' ? refs : [], preferred_top_refs:refs}});
  h.open(); await settle(); const candidate = h.form.querySelector('[aria-label="Prefer Readable private Top"]');
  assert.equal(candidate.disabled, true); check(h, 'Prefer Readable private Top', true);
  if (mode === 'selected') {const selected = h.form.querySelector('[aria-label="Include Readable private Top"]'); assert.equal(selected.disabled, true); check(h, 'Include Readable private Top', true);}
  h.click(h.named('Save', h.form)); await settle(); assert.equal(h.saves[0].proposed.preferred_top_refs.length, 100);
  assert.equal(h.saves[0].proposed.preferred_top_refs.includes(TOP), false);
  assert.deepEqual(h.saves[0].proposed.selected_top_refs, mode === 'selected' ? refs : []);
});

test('Directory failure hides private errors and preserves saved sources while unrelated settings remain writable', async t => {
  const h = await mounted(t, {sources:true, settings:{source_mode:'selected', selected_top_refs:[HIDDEN], preferred_top_refs:[HIDDEN]},
    pages:[new Error('private transport token and title')]}); h.open(); await settle();
  assert.match(h.form.textContent, /Album Top sources could not be loaded/); assert.doesNotMatch(h.form.textContent, /private transport token/);
  assert.equal(sourceTrigger(h).disabled, true); assert.equal(h.named(DRAW).disabled, true); assert.equal(h.controller.getSnapshot().status, 'ready');
  choose(h, 'Album choice', 'Random unfinished album'); h.click(h.named('Save', h.form)); await settle();
  assert.deepEqual(h.saves[0].proposed.selected_top_refs, [HIDDEN]); assert.deepEqual(h.saves[0].proposed.preferred_top_refs, [HIDDEN]);
  assert.equal(h.saves[0].proposed.album_mode, 'random'); assert.equal(h.sourceRequests.length, 1);
});

test('Source-only loss clears titles, rolls back unsaved source edits, and keeps independent preference edits', async t => {
  const h = await mounted(t, {sources:true, settings:{enabled:true, source_mode:'selected', selected_top_refs:[HIDDEN], preferred_top_refs:[HIDDEN]}});
  h.open(); await settle(); check(h, 'Include Readable private Top', true); check(h, 'Prefer Readable private Top', true);
  choose(h, 'Album choice', 'Random unfinished album'); const snapshot = h.controller.getSnapshot(); h.loseSources();
  assert.equal(h.controller.getSnapshot(), snapshot); assert.doesNotMatch(h.form.textContent, /Readable private Top/);
  assert.equal(sourceTrigger(h).disabled, true); assert.equal(h.named(DRAW).disabled, true);
  h.click(h.named('Save', h.form)); await settle(); assert.deepEqual(h.saves[0].proposed.selected_top_refs, [HIDDEN]);
  assert.deepEqual(h.saves[0].proposed.preferred_top_refs, [HIDDEN]); assert.equal(h.saves[0].proposed.album_mode, 'random');
});

for (const reason of ['cancel', 'source', 'context', 'period', 'dispose']) test(`Pending source request aborts on ${reason} and late titles cannot return`, async t => {
  const wait = deferred(); t.after(() => wait.resolve(page([top()])));
  const h = await mounted(t, {sources:true, pages:[() => wait.promise]}); h.open(); await settle();
  const request = h.sourceRequests[0]; assert.ok(request);
  if (reason === 'cancel') h.click(h.named('Cancel', h.form));
  else if (reason === 'source') h.loseSources(); else if (reason === 'context') h.changeContext();
  else if (reason === 'period') h.controller.selectPeriod('year'); else h.child.dispose();
  assert.equal(request.options.signal.aborted, true); wait.resolve(page([top()])); await settle(); h.drain();
  assert.doesNotMatch(h.document.body.textContent, /Readable private Top/); assert.equal(h.posts().length, 0);
});

for (const reason of ['context', 'period', 'disposed-child', 'host-currentness']) test(`Retained Save and draw controls fail closed after ${reason}`, async t => {
  const h = await mounted(t, {sources:true, settings:{enabled:true}}); h.open(); await settle();
  const save = h.named('Save', h.form), draw = h.named(DRAW, h.form);
  if (reason === 'context') h.changeContext(); else if (reason === 'period') h.controller.selectPeriod('year');
  else if (reason === 'disposed-child') h.child.dispose(); else h.retire();
  h.click(save); h.click(draw); await settle(); assert.equal(h.posts().length, 0); assert.equal(h.saves.length, 0); assert.equal(h.draws.length, 0);
});

test('Explicit weekly draw is separate, deduplicated, and may use an unstarted null Goal from a larger-period view', async t => {
  const h = await mounted(t, {sources:true, settings:{enabled:true}}); h.controller.selectPeriod('year'); h.open(); await settle();
  assert.equal(h.posts().length, 0); const draw = h.named(DRAW, h.form); assert.equal(draw.disabled, false);
  h.click(draw); h.click(draw); await h.drawTasks[0];await settle();
  assert.equal(h.draws.length, 1); assert.equal(h.saves.length, 0); assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].route, '/account/goals/bonus/draw'); assert.equal(h.posts()[0].options.body.expected_cycle_id, null);
  assert.equal(h.posts()[0].options.body.revision, '1'); assert.equal('period' in h.posts()[0].options.body, false);
  assert.deepEqual(h.controller.getSnapshot().outcome, {action:'bonus_draw', changed:false, reason:'no_eligible_source'});
  assert.equal(h.sourceRequests.length, 1);
});

for (const present of [false, true]) test(`Captured weekly bonus present=${present} never offers another draw`, async t => {
  const h = await mounted(t, {sources:true, settings:{enabled:true}, bonus:{cycle_id:CYCLE, bonus:{catalog_ref:ALBUM, present}, manual_count:0}});
  h.open(); await settle(); assert.equal(h.named(DRAW).disabled, true);
  assert.match(h.form.textContent, present ? /already has a captured bonus album/ : /cannot be drawn again in this cycle/);
  h.click(h.named(DRAW)); assert.equal(h.posts().length, 0);
});

test('Proposed enabling never authorizes draw from an unsaved setting', async t => {
  const h = await mounted(t, {sources:true, proposedEnabled:true}); h.open(); await settle();
  assert.equal(h.named(DRAW).disabled, true); h.click(h.named(DRAW)); assert.equal(h.posts().length, 0);
  h.click(h.named('Save', h.form)); await settle(); assert.equal(h.posts().length, 1); assert.equal(h.draws.length, 0);
});

test('Source loss during canonical Save rendering cannot persist an earlier unverified local source draft', async t => {
  const h = await mounted(t, {sources:true, settings:{source_mode:'selected', selected_top_refs:[HIDDEN], preferred_top_refs:[HIDDEN]}});
  h.open(); await settle(); check(h, 'Include Readable private Top', true); choose(h, 'Album choice', 'Random unfinished album');
  const original = h.runtime.buttonHtml; let revoked = false;
  h.runtime.buttonHtml = options => {if (!revoked && options.label === 'Save' && options.disabled) {revoked = true; h.loseSources();} return original(options);};
  h.click(h.named('Save', h.form)); await settle(); assert.equal(revoked, true); assert.equal(h.saves.length, 1);
  assert.deepEqual(h.saves[0].proposed.selected_top_refs, [HIDDEN]); assert.deepEqual(h.saves[0].proposed.preferred_top_refs, [HIDDEN]);
  assert.equal(h.saves[0].proposed.album_mode, 'random');
});

test('Canonical render reentry cannot delegate draw after source loss', async t => {
  const h = await mounted(t, {sources:true, settings:{enabled:true}}); h.open(); await settle();
  const original = h.runtime.buttonHtml; let revoked = false;
  h.runtime.buttonHtml = options => {if (!revoked && options.label === 'Save' && options.disabled) {revoked = true; h.loseSources();} return original(options);};
  h.click(h.named(DRAW, h.form)); await settle(); assert.equal(revoked, true); assert.equal(h.draws.length, 0); assert.equal(h.posts().length, 0);
  assert.doesNotMatch(h.form.textContent, /Readable private Top/);
});

test('Native Cancel closes the choice owner, aborts sources, and restores the parent focus target', async t => {
  const h = await mounted(t); h.opener.focus(); h.open(); await settle();
  h.click(h.named('Album choice: Next unfinished in Top order', h.form)); h.drain();
  assert.ok(h.document.querySelector('[role="menuitemradio"]')); h.click(h.named('Cancel', h.form)); h.drain();
  assert.equal(h.form.hidden, true); assert.equal(h.document.querySelector('[role="menuitemradio"]'), null);
  assert.equal(h.document.activeElement, h.opener); assert.equal(h.posts().length, 0);
});

test('A newly loaded settings identity invalidates the original dialog before retained Save can run', async t => {
  const h = await mounted(t); h.open(); await settle(); const save = h.named('Save', h.form);
  await h.controller.loadBonus(); await settle(); h.click(save);
  assert.equal(h.form.hidden, true); assert.equal(h.saves.length, 0); assert.equal(h.posts().length, 0);
});

test('Same-source currentness refresh does not abandon an in-flight directory request', async t => {
  const wait = deferred(); t.after(() => wait.resolve(page([top()])));
  const h = await mounted(t, {sources:true, pages:[() => wait.promise]}); h.open(); await settle();
  h.child.updateSource({sourceProvider:h.sourceProvider, sourceScope:'goals-bonus-dialog-test', sourceCurrent:() => true});
  wait.resolve(page([top()])); await settle(); assert.match(h.form.textContent, /Readable private Top/);
  assert.equal(sourceTrigger(h).disabled, false); assert.equal(h.sourceRequests.length, 1);
});
