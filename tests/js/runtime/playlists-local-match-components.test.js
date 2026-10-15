const test = require('node:test');
const assert = require('node:assert/strict');
const {actionFixture, flush} = require('./playlist-native-actions-fixture.cjs');
let mountDraftLocalMatchContent;
test.before(async () => {
  ({mountDraftLocalMatchContent} = await import('../../../music_app/static/js/playlists/native-draft-local-match.mjs'));
});
const setup = (t, patch) => {
  const env = actionFixture();
  let state = {status: 'ready', selectedKey: '', candidates: [{key: 'safe-choice', title: 'Candidate <title>', artist: 'Candidate artist',
    album_title: 'Candidate album', duration_seconds: 42}], suggestionsComplete: false, ...patch};
  let accepted = 0, closed = 0, loaded = 0, selected = [];
  const controller = {getSnapshot: () => state, blocking: () => ['uncertain', 'accepting'].includes(state.status),
    select(key) {selected.push(key);}, async accept() {accepted++; return true;}, load() {loaded++;}};
  const props = {state, controller, row: {title: 'Original <title>', artist: 'Artist', album_title: 'Album'}, close() {closed++;}};
  const owner = mountDraftLocalMatchContent(env.host, env.runtime, props);
  t.after(() => {owner.dispose(); assert.equal(env.host.childNodes.length, 0); env.host.remove();});
  return {...env, owner, props, replace: () => {state = {...state};}, counts: () => ({accepted, closed, loaded, selected})};
};
test('shared choice and explicit Accept preserve original identity and truthfully label bounded suggestions', t => {
  const f = setup(t, {});
  assert.equal(f.button('Accept match').disabled, true);
  const choice = f.choice('Possible local matches');
  assert.match(choice.getAttribute('aria-label'), /Choose local match/);
  f.click(choice);
  const blank = f.document.querySelector('[role="menu"] [data-foobar-format=""]');
  assert.ok(blank); assert.equal(blank.disabled, true); assert.equal(blank.getAttribute('aria-checked'), 'true');
  f.click(f.document.querySelector('[role="menu"] [data-foobar-format="safe-choice"]'));
  assert.deepEqual(f.counts(), {accepted: 0, closed: 0, loaded: 0, selected: ['safe-choice']});
  const html = f.host.innerHTML;
  assert.match(html, /Original &lt;title&gt;/); assert.match(html, /limited set of local tracks/); assert.match(html, /Choose local match/);
});
test('only an explicit current accept activates matching; stale controls do nothing', async t => {
  const f = setup(t, {selectedKey: 'safe-choice'}), accept = f.button('Accept match');
  assert.equal(accept.disabled, false); f.click(accept); await flush();
  assert.equal(f.counts().accepted, 1); assert.equal(f.counts().closed, 1);
  f.replace(); f.click(accept); await flush(); assert.equal(f.counts().accepted, 1);
  f.owner.dispose(); f.click(accept); await flush(); assert.equal(f.counts().accepted, 1);
});
test('uncertain acceptance exposes exact retry and blocks cancellation or replacement choice', async t => {
  const f = setup(t, {status: 'uncertain', selectedKey: 'safe-choice'});
  assert.equal(f.button('Cancel').disabled, true);
  assert.equal(f.choice('Possible local matches').disabled, true);
  assert.equal(f.button('Check match result').disabled, false);
  f.click(f.button('Cancel')); f.click(f.choice('Possible local matches'));
  assert.equal(f.counts().closed, 0); assert.deepEqual(f.counts().selected, []);
  f.click(f.button('Check match result')); await flush(); assert.equal(f.counts().accepted, 1);
});
test('empty candidates do not assert a confirmed absence or enable acceptance', t => {
  const f = setup(t, {candidates: [], suggestionsComplete: true});
  assert.match(f.host.innerHTML, /No suggested local match was found in the checked tracks/);
  assert.equal(f.button('Accept match').disabled, true);
  // Native owners retain their controls for updates but hide the whole Choice.
  assert.ok(f.choice('Possible local matches').closest('[hidden]'));
});
