const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle} = require('./home-friends-native-app-fixture.cjs');

function assertError(host, message) {
  const alerts = host.querySelectorAll('[role="alert"]');
  assert.equal(alerts.length, 1, 'actual owner retains exactly one error slot');
  assert.equal(alerts[0].textContent, message);
  assert.equal(alerts[0].hidden, !message, 'only a nonempty current error is exposed');
  assert.equal(alerts.filter(node => !node.closest('[hidden]')).length, message ? 1 : 0);
}
async function headerFixture(t) {
  const h = fixture(t), {mountQueueHeader} = await load('queue.mjs');
  let scopeKey = 'scope:one', action = () => undefined;
  const value = {enabled: true, revision: 1, entries: [{id: 'pending', sourceReadable: true}]};
  const api = {setEnabled: () => action(), clear: () => action()};
  h.runtime.snapshot = () => ({scopeKey}); h.runtime.confirm = () => Promise.resolve(true);
  const owner = h.own(mountQueueHeader(h.host, h.runtime, {api, value}));
  return {h, owner, api, value, action: next => {action = next;},
    toggle() {const button = h.named('Deactivate queue', h.host); assert.ok(button); h.click(button);},
    replace() {const next = {...api}; owner.update({api: next, value}); return next;},
    scope() {scopeKey = 'scope:two';}};
}
for (const kind of ['throw', 'reject']) test(`Queue native header exposes current ${kind} errors and hides them on API replacement`, async t => {
  const f = await headerFixture(t); assertError(f.h.host, '');
  f.action(() => {if (kind === 'throw') throw new Error('current'); return Promise.reject(new Error('current'));});
  f.toggle(); await settle(); assertError(f.h.host, 'Queue could not be changed.');
  f.replace(); assertError(f.h.host, '');
  f.toggle(); await settle(); assertError(f.h.host, 'Queue could not be changed.');
});
for (const retirement of ['replace', 'dispose']) test(`Queue native header ${retirement} blocks late error publication`, async t => {
  const f = await headerFixture(t), pending = deferred(); f.action(() => pending.promise); f.toggle();
  assertError(f.h.host, '');
  if (retirement === 'replace') f.replace();
  else f.owner.dispose();
  pending.reject(new Error('retired')); await settle();
  if (retirement === 'replace') assertError(f.h.host, '');
  else assert.equal(f.h.host.querySelectorAll('[role="alert"]').length, 0);
});
test('Queue native header old rejection cannot replace a current replacement error', async t => {
  const f = await headerFixture(t), pending = deferred(); f.action(() => pending.promise); f.toggle(); f.replace();
  f.action(() => {throw new Error('new owner');}); f.toggle(); assertError(f.h.host, 'Queue could not be changed.');
  const currentText = f.h.host.querySelector('[role="alert"]').firstChild;
  pending.reject(new Error('old owner')); await settle(); assertError(f.h.host, 'Queue could not be changed.');
  assert.equal(f.h.host.querySelector('[role="alert"]').firstChild, currentText, 'stale rejection must not rewrite current error DOM');
});
test('Queue native header scope change still fences confirmation before queue mutation', async t => {
  const f = await headerFixture(t), confirmation = deferred(); let calls = 0;
  f.h.runtime.confirm = () => confirmation.promise; f.action(() => {calls++; throw new Error('must not run');});
  f.h.click(f.h.named('Clear queue', f.h.host)); f.scope(); confirmation.resolve(true); await settle();
  assert.equal(calls, 0); assertError(f.h.host, '');
});

async function panelFixture(t) {
  const h = fixture(t), {mountQueuePanel} = await load('queue.mjs');
  let action = () => undefined, scopeKey = 'scope:one';
  const refreshes = [], plays = [];
  const value = {enabled: true, revision: 1, entries: [{id:'one', title:'One', sourceReadable:true, canPlay:true}]};
  const api = {getSnapshot: () => value, subscribe: () => () => {}, timingOptions: () => [],
    refresh: options => {refreshes.push(options);}, play: (id, options) => {plays.push({id, options}); return action();}};
  h.runtime.snapshot = () => ({scopeKey});
  let currentApi = api;
  const props = () => ({api: currentApi, value, scopeKey});
  const owner = h.own(mountQueuePanel(h.host, h.runtime, props()));
  return {h, owner, refreshes, plays, action: next => {action = next;},
    play() {const button = h.host.querySelector('[data-queue-play="one"]'); assert.ok(button); h.click(button);},
    reset(kind) {if (kind === 'scope') scopeKey = 'scope:two'; else currentApi = {...api}; owner.update(props());},
    repaint() {owner.update(props());}};
}
for (const kind of ['throw', 'reject']) test(`Queue native panel exposes current ${kind} errors without exposing an initial placeholder`, async t => {
  const f = await panelFixture(t); assertError(f.h.host, '');
  f.action(() => {if (kind === 'throw') throw new Error('current'); return Promise.reject(new Error('current'));});
  f.play(); await settle(); assertError(f.h.host, 'This Queue action is unavailable.');
  f.repaint(); assertError(f.h.host, 'This Queue action is unavailable.');
});
for (const reset of ['scope', 'api']) test(`Queue native panel ${reset} reset clears error and permits new current errors`, async t => {
  const f = await panelFixture(t); f.action(() => {throw new Error('current');});
  f.play(); assertError(f.h.host, 'This Queue action is unavailable.');
  const previous = f.plays[0].options; f.reset(reset); assertError(f.h.host, '');
  assert.equal(previous.signal.aborted, true); assert.equal(previous.isCurrent(), false);
  assert.equal(f.refreshes[0].signal.aborted, true); assert.equal(f.refreshes.length, 2);
  f.play(); assertError(f.h.host, 'This Queue action is unavailable.');
});
for (const retirement of ['scope', 'api', 'dispose']) test(`Queue native panel ${retirement} fences a late rejected operation`, async t => {
  const f = await panelFixture(t), pending = deferred(); f.action(() => pending.promise); f.play();
  const previous = f.plays[0].options;
  if (retirement === 'dispose') f.owner.dispose(); else f.reset(retirement);
  assert.equal(previous.signal.aborted, true); assert.equal(previous.isCurrent(), false);
  pending.reject(new Error('retired')); await settle();
  if (retirement === 'dispose') assert.equal(f.h.host.querySelectorAll('[role="alert"]').length, 0);
  else assertError(f.h.host, '');
});
test('Queue native panel late rejection cannot overwrite a replacement current error', async t => {
  const f = await panelFixture(t), pending = deferred(); f.action(() => pending.promise); f.play(); f.reset('scope');
  f.action(() => {throw new Error('current');}); f.play(); assertError(f.h.host, 'This Queue action is unavailable.');
  const currentText = f.h.host.querySelector('[role="alert"]').firstChild;
  pending.reject(new Error('retired')); await settle(); assertError(f.h.host, 'This Queue action is unavailable.');
  assert.equal(f.h.host.querySelector('[role="alert"]').firstChild, currentText, 'stale rejection must not rewrite current error DOM');
});
