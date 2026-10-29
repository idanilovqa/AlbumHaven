'use strict';
const {bonusReadFixture}=require('./goals-bonus-read-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle, plain} = require('./home-friends-native-app-fixture.cjs');
const goal = '11111111-1111-4111-8111-111111111111', album = '22222222-2222-4222-8222-222222222222', cycle = '33333333-3333-4333-8333-333333333333';
function value(populated = false) {
  const periods = Object.fromEntries(['week','month','six-months','year'].map(period => [period, {
    top_ref: populated ? goal : null, period, cycle: populated ? {cycle_id: cycle, started_at: '2026-12-01T00:00:00Z',
      start_date: '2026-12-01', due_date: '2027-01-01', timezone_name: 'UTC'} : null,
    album_refs: populated ? [album] : [], manual_completed_at: populated ? {[album]: null} : {}, total: populated ? 1 : 0, completed: 0, percent: 0,
  }]));
  return {goal_ref: populated ? goal : null, revision: populated ? '2' : '1', periods, albums: populated ? [{catalog_ref: album,
    title: 'Remote Album', artist_display: 'Artist', first_release_date: null, primary_type: null}] : [],
    allowed_actions: {can_read: true, can_add: true, can_reset: true}};
}
function transport(initial,t) {
  let context = 'a'.repeat(64), data = initial, pending = null;
  const listeners = new Set(), requests = [], bonusReads=bonusReadFixture(t,()=>data);
  return {requests, bonusReads, listeners, context: () => context,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async request(path, options) {const bonus=bonusReads.dispatch(path,options);if(bonus.handled)return {status:"ready",context_ref:context,data:bonus.data};requests.push({path, options});
      if(path==='/account/goals/weekly-settings' && options.method!=='POST') return {status:'ready',context_ref:context,data:{settings_revision:'1',genres:[],playthroughs:[],settings:{manual_count:5,suggestion_count:1,filters:[],sources:['tops','playthroughs'],prefer_preferences:true,discover:false,selection:'random',prefer_nearly_finished:false,preferred_playthrough_refs:[]}}};
      if(path==='/account/goals/weekly-preview') return {status:'ready',context_ref:context,data:{albums:[],summary:[]}};
      const result = pending ? await pending.promise : data;
      if (options.isCurrent && !options.isCurrent()) throw Object.assign(new Error('retired'), {name: 'AbortError'});
      return {status: 'ready', context_ref: context, data: result};},
    change() {context = 'b'.repeat(64); for (const fn of [...listeners]) fn();},
    defer(next) {pending = next;}, set(next) {data = next; pending = null;},
  };
}
async function mounted(t, data) {
  const h = fixture(t), {mountGoalsPanel} = await load('goals.mjs');
  const header = {actions: h.add('goals-actions'), content: h.add('goals-content')}, wire = transport(data,t);
  const owner = h.own(mountGoalsPanel(h.host, h.runtime, {transport: wire, header, isCurrent: () => true}));
  await wire.bonusReads.ready;await settle(); h.drain();wire.bonusReads.assertInitial(); return {...h, header, wire, owner};
}

function actionable(completed = false) {
  const data = value(true); data.allowed_actions.can_complete = true; data.allowed_actions.can_remove = true;
  if (completed) for (const selected of Object.values(data.periods)) {
    selected.manual_completed_at[album] = '2026-12-02T00:00:00Z'; selected.completed = 1; selected.percent = 100;
  }
  return data;
}
function pendingWrite(t, h) {
  const wait = deferred();
  t.after(async () => {
    try {h.owner.dispose();} finally {wait.resolve(value(true));}
    await wait.promise; await settle();
  });
  return wait;
}
function menuItems(h) {return h.document.querySelectorAll('[role="menuitem"]').filter(node => !node.closest('[hidden]'));}

test('Goal album actions use the canonical action menu with exact Goals wording and no unsupported operations', async t => {
  const h = await mounted(t, actionable());
  const trigger = h.named('Goal album actions'); assert.ok(trigger); assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  h.click(trigger);
  assert.deepEqual(menuItems(h).map(node => node.textContent.trim()), ['Mark completed', 'Remove from goals']);
  assert.doesNotMatch(h.document.body.textContent, /this Top|Move up|Move down|Play Top|Share Goals/);
  assert.equal(h.host.querySelector('.album-card').getAttribute('data-gallery-card-interaction'), 'none');
  assert.equal(h.host.querySelector('img'), null);
});

for (const [completed, label] of [[false, 'Mark completed'], [true, 'Clear completion']]) test(`Actual ${label} sends exact selected-period command without optimistic success`, async t => {
  const h = await mounted(t, actionable(completed)), wait = pendingWrite(t, h);
  h.click(h.named('Goal album actions')); const action = h.named(label); assert.ok(action);
  h.wire.defer(wait); h.click(action); h.click(action); await settle();
  const writes = h.wire.requests.filter(row => row.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/account/goals/completion');
  const command = writes[0].options.body;
  assert.deepEqual(Object.keys(command).sort(), ['catalog_ref','completed','expected_cycle_id','period','request_key','revision'].sort());
  assert.equal(command.catalog_ref, album); assert.equal(command.completed, !completed); assert.equal(command.period, 'week');
  assert.equal(command.revision, '2'); assert.equal(command.expected_cycle_id, cycle);
  assert.equal(h.header.content.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), completed ? '1' : '0');
  assert.ok(h.host.querySelector('[data-goal-album-ref]'));
  h.owner.dispose(); wait.resolve(value(true)); await settle();
});

test('Actual remove sends selected year membership only and retains the card until authorized refresh', async t => {
  const h = await mounted(t, actionable()), wait = pendingWrite(t, h);
  h.click(h.named('Period: 1 week'));
  h.click(h.document.querySelectorAll('[role="menuitemradio"]').find(node => /This year/.test(node.textContent)));
  h.click(h.named('Goal album actions')); h.wire.defer(wait); h.click(h.named('Remove from goals')); await settle();
  const writes = h.wire.requests.filter(row => row.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/account/goals/remove');
  const command = writes[0].options.body;
  assert.deepEqual(Object.keys(command).sort(), ['catalog_ref','expected_cycle_id','period','request_key','revision'].sort());
  assert.equal(command.period, 'year'); assert.equal(command.catalog_ref, album); assert.equal(command.expected_cycle_id, cycle);
  assert.ok(h.host.querySelector('[data-goal-album-ref]'));
  h.owner.dispose(); wait.resolve(value(true)); await settle();
});

for (const reason of ['context','period','dispose']) test(`Retained Goals menu action cannot write after ${reason} retirement`, async t => {
  const h = await mounted(t, actionable()); h.click(h.named('Goal album actions'));
  const action = h.named('Remove from goals'); assert.ok(action);
  if (reason === 'context') h.wire.change();
  else if (reason === 'dispose') h.owner.dispose();
  else {
    h.click(h.named('Period: 1 week'));
    h.click(h.document.querySelectorAll('[role="menuitemradio"]').find(node => /This year/.test(node.textContent)));
  }
  await settle(); h.click(action); await settle();
  assert.equal(h.wire.requests.filter(row => row.options.method === 'POST').length, 0);
  assert.equal(menuItems(h).length, 0);
});

for (const flags of [{can_complete:false,can_remove:false},{can_complete:true,can_remove:false},{can_complete:false,can_remove:true}]) test(`Goals row actions respect exact grants ${JSON.stringify(flags)}`, async t => {
  const data=actionable(); Object.assign(data.allowed_actions, flags); const h=await mounted(t,data);
  const trigger=h.named('Goal album actions');
  if (!flags.can_complete && !flags.can_remove) {assert.equal(trigger,undefined); assert.equal(h.host.querySelector('.album-card button'),null);}
  else {h.click(trigger); assert.deepEqual(menuItems(h).map(node=>node.textContent.trim()), flags.can_complete?['Mark completed']:['Remove from goals']);}
  assert.equal(h.wire.requests.filter(row=>row.options.method==='POST').length,0);
});

test('Actual right-click opens canonical Goals actions and unchanged render retains the trigger', async t => {
  const h=await mounted(t,actionable()), trigger=h.named('Goal album actions');
  h.owner.update(); assert.equal(h.named('Goal album actions'),trigger);
  const event=new h.c.Event('contextmenu',{bubbles:true}); h.host.querySelector('[data-goal-album-ref]').dispatchEvent(event);
  assert.equal(event.defaultPrevented,true); assert.deepEqual(menuItems(h).map(node=>node.textContent.trim()),['Mark completed','Remove from goals']);
  h.owner.dispose(); assert.equal(menuItems(h).length,0); assert.equal(h.wire.listeners.size,0);
});

test('Canonical menu acquisition cannot survive reentrant authority replacement', async t => {
  const h=await mounted(t,actionable()), open=h.runtime.openChoice;
  h.runtime.openChoice=(anchor,options)=>{const owner=open(anchor,options); h.wire.change(); return owner;};
  h.click(h.named('Goal album actions')); await settle();
  assert.equal(menuItems(h).length,0); assert.equal(h.host.querySelector('[data-goal-album-ref]'),null);
  assert.equal(h.wire.requests.filter(row=>row.options.method==='POST').length,0);
});

test('Canonical row-control acquisition cannot revive private state after authority replacement', async t => {
  const h=fixture(t), {mountGoalsPanel}=await load('goals.mjs'), wire=transport(actionable(),t);
  const header={actions:h.add('goals-actions'),content:h.add('goals-content')}, render=h.runtime.actionHtml;
  let changed=false;
  h.runtime.actionHtml=options=>{if(options.label==='Goal album actions'&&!changed){changed=true;wire.change();}return render(options);};
  h.own(mountGoalsPanel(h.host,h.runtime,{transport:wire,header,isCurrent:()=>true})); await wire.bonusReads.ready;await settle(); h.drain();
  assert.equal(changed,true); assert.equal(h.host.querySelector('[data-goal-album-ref]'),null);
  assert.equal(h.named('Goal album actions'),undefined); assert.equal(header.content.querySelector('[role="progressbar"]'),null);
  assert.equal(wire.requests.length,1);
});

test('Replacing the canonical card renderer retires the old menu anchor and its saved action', async t => {
  const h=await mounted(t,actionable()); h.click(h.named('Goal album actions'));
  const action=h.named('Remove from goals'), render=h.runtime.galleryCardHtml;
  h.runtime.galleryCardHtml=options=>render(options); h.owner.update();
  assert.equal(menuItems(h).length,0); h.click(action); await settle();
  assert.equal(h.wire.requests.filter(row=>row.options.method==='POST').length,0);
  assert.ok(h.named('Goal album actions'));
});

test('Throwing canonical menu retirement cannot stop private Goals clearing', async t => {
  const h=await mounted(t,actionable()), open=h.runtime.openChoice; let closes=0;
  h.runtime.openChoice=(anchor,options)=>{const actual=open(anchor,options);return {...actual,close(options){closes++;actual.close(options);throw new Error('after canonical close');}};};
  h.click(h.named('Goal album actions')); const action=h.named('Remove from goals'); assert.ok(action);
  h.wire.change(); await settle();
  assert.equal(closes,1); assert.equal(menuItems(h).length,0);
  assert.equal(h.host.querySelector('[data-goal-album-ref]'),null); assert.doesNotMatch(h.host.textContent,/Remote Album/);
  assert.equal(h.header.content.querySelector('[role="progressbar"]'),null);
  h.click(action); assert.equal(h.wire.requests.filter(row=>row.options.method==='POST').length,0);
  h.owner.dispose(); assert.equal(closes,1);
});

test('Throwing row-control disposal detaches every private card and never disposes the retired owner twice', async t => {
  const data=actionable(), second='44444444-4444-4444-8444-444444444444';
  data.albums.push({...data.albums[0],catalog_ref:second,title:'Second private album'});
  for(const selected of Object.values(data.periods)){selected.album_refs.push(second);selected.total=2;selected.manual_completed_at[second]=null;}
  const h=await mounted(t,data), rows=h.host.querySelectorAll('[data-goal-album-ref]'); assert.equal(rows.length,2);
  const action=h.named('Goal album actions'), actual=rows[0].goalActionOwner, dispose=actual.dispose.bind(actual); let disposals=0;
  actual.dispose=()=>{disposals++;dispose();throw new Error('after canonical row disposal');};
  h.wire.change(); await settle();
  assert.equal(disposals,1); assert.equal(h.host.querySelectorAll('[data-goal-album-ref]').length,0);
  assert.doesNotMatch(h.host.textContent,/Remote Album|Second private album/);
  assert.equal(h.header.content.querySelector('[role="progressbar"]'),null);
  h.click(action); assert.equal(h.wire.requests.filter(row=>row.options.method==='POST').length,0);
  h.owner.dispose(); assert.equal(disposals,1); assert.equal(h.wire.listeners.size,0);
});

test('library-only rating progress does not expose fake manual Top completion',async t=>{
  const data=actionable();data.albums[0].completion_mode='rating';
  for(const selected of Object.values(data.periods)){selected.rated_at={[album]:'2026-12-02T00:00:00Z'};selected.completed=1;}
  const h=await mounted(t,data);h.click(h.named('Goal album actions'));
  assert.deepEqual(menuItems(h).map(node=>node.textContent.trim()),['Remove from goals']);
  assert.match(h.host.textContent,/Rated · Goal progress counted/);
  assert.doesNotMatch(h.host.textContent,/Mark completed|Clear completion/);
});
test('rating timestamp and manual completion count once in Goals projection',async()=>{
  const {normalizeGoals}=await load('goals-provider.mjs'), data=actionable(true);data.albums[0].completion_mode='rating';
  for(const selected of Object.values(data.periods)){selected.rated_at={[album]:'2026-12-02T00:00:00Z'};selected.completed=1;}
  const result=normalizeGoals(data);assert.equal(result.periods.week.completed,1);assert.equal(result.albums[0].completion_mode,'rating');
  data.periods.week.rated_at[goal]='2026-12-02T00:00:00Z';assert.throws(()=>normalizeGoals(data));
});

test('actual Goals header settings icon opens weekly modal without opt-in or implicit admissions',async t=>{
  const h=await mounted(t,actionable()),button=h.named('Weekly Goals settings');assert.ok(button);assert.equal(h.header.actions.contains(button),true);
  assert.equal(button.textContent.trim(),'');h.click(button);await settle();h.drain();
  assert.match(h.form.textContent,/Weekly Goals settings/);assert.ok(h.named('Add suggestions',h.form));
  assert.equal(h.form.querySelector('input[aria-label="Your picks"]').value,'5');
  assert.equal(h.wire.requests.some(row=>row.path==='/account/goals/weekly-draw'),false);
  h.click(h.named('Cancel',h.form));assert.equal(h.form.hidden,true);
});

test('selected-period rating provenance overrides a manual album-level fallback',async t=>{
  const data=actionable();data.albums[0].completion_mode='manual';data.periods.week.completion_modes={[album]:'rating'};
  const h=await mounted(t,data);h.click(h.named('Goal album actions'));
  assert.deepEqual(menuItems(h).map(node=>node.textContent.trim()),['Remove from goals']);
  assert.match(h.host.textContent,/Rate in your library to advance Goals/);
});
