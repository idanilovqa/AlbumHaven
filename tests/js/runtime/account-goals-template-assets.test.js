'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {fixture, templateAssets, read, value, searchValue, evidenceValue, STAMP, CSRF, GOAL, ALBUM, CYCLE, GROUP} = require('./account-goals-template-fixture.cjs');
const CLASSIC = ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/alert-components.js',
  'runtime/album-artbox.js', 'runtime/gallery-main-components.js', 'runtime/gallery-card-component.js',
  'runtime/in-page-tabs.js', 'runtime/trigger-anchor.js', 'runtime/library-settings.js',
  'runtime/browser-dialog-helpers.js', 'runtime/session-csrf-fetch.js', 'runtime/private-ui-transport.js']
  .map(file => `music_app/static/js/${file}`);
const header = (call, name) => new Headers(call.options.headers).get(name);
const writes = h => h.calls.filter(call => call.options.method === 'POST');
function required(h, name, root) {const button = h.named(name, root); assert.ok(button, `Visible button ${name} exists.`); return button;}
function menu(h, name) {const result = h.document.querySelector(`[role="menu"][aria-label="${name}"]`); assert.ok(result); return result;}

test('account template composition has the exact protected DOM extraction and ordered standalone classic assets', () => {
  const original = read('tests/js/runtime/native-home-harness.cjs').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(original).digest('hex'), 'a3a6902dc55ea75f3e45048a952a4e1b0633717427d7892966a03cc76214e264');
  const sentinels = "    openTrackModal: forbidden('openTrackModal'), playAlbum: forbidden('playAlbum'),\n"
    + "    scheduleBrowserAnimationFrame: forbidden('scheduleBrowserAnimationFrame'), scheduleBrowserTimeout: forbidden('scheduleBrowserTimeout'),\n";
  const begin = original.indexOf("  const files = ['js/button-component.js'");
  const end = original.indexOf('  const event = ', begin);
  assert.ok(begin >= 0 && end > begin); assert.equal(original.split(sentinels).length, 2);
  const copied = original.replace(sentinels, '').replace(original.slice(begin, end), '');
  assert.equal(read('tests/js/runtime/account-goals-dom-platform.cjs').replace(/\r\n/g, '\n'), copied,
    'Only the four application sentinels and eager loading block are omitted; protected source stays byte-identical.');
  assert.deepEqual(templateAssets().classic, CLASSIC);
});

test('exact account template assets mount empty Goals through the actual entry and its native components', async t => {
  const h = await fixture(t);
  assert.deepEqual(h.loaded, CLASSIC);
  assert.equal(h.host.querySelector('.home-profile__name h1').textContent, 'member.one');
  assert.equal(h.host.querySelector('[role="tab"]').textContent, 'Goals');
  assert.equal(h.host.querySelector('[role="tab"]').getAttribute('aria-selected'), 'true');
  assert.equal(h.host.querySelector('[role="tabpanel"]').id, 'account-home-goals');
  assert.ok(required(h, 'Start')); assert.equal(h.named('Reset'), undefined); assert.equal(h.named('Add'), undefined);
  assert.match(h.host.textContent, /The goals were not set/);
  assert.deepEqual(h.calls.map(call => call.route), ['/account/goals']);
  assert.equal(header(h.calls[0], 'X-AlbumHaven-Account-Context'), STAMP);
  for (const name of ['state', 'NavigationTree', 'UnfoldingActionButton', 'buildCompactDataTable', 'buildAlbumDetailsHeaderHtml',
    'openTrackModal', 'playAlbum', 'scheduleBrowserAnimationFrame', 'scheduleBrowserTimeout']) {
    assert.equal(h.lookup(name), undefined, `${name} is not injected to hide a missing template dependency.`);
  }
  assert.equal(h.document.getElementById('app-shell'), null);
});

test('populated Goals uses the exact template Choice and GalleryCard dependencies with local period selection', async t => {
  const h = await fixture(t, {full: true});
  assert.deepEqual(h.loaded, CLASSIC);
  const pageHeader = h.host.querySelector('.home-friends__page-header');
  for (const name of ['Reset', 'Add', 'Period: 1 week']) assert.ok(pageHeader.contains(required(h, name)));
  assert.equal(h.named('Start'), undefined);
  assert.match(h.host.querySelector('.album-card').textContent, /Stored private album/);
  assert.equal(h.host.querySelector('.album-card').dataset.galleryCardInteraction, 'none');
  h.click(required(h, 'Period: 1 week'));
  const choice = menu(h, 'Period');
  assert.deepEqual(choice.querySelectorAll('[role="menuitemradio"]').map(button => button.textContent.trim()), ['1 week', '1 month', '6 months', 'This year']);
  assert.equal(required(h, '1 week', choice).getAttribute('aria-checked'), 'true');
  h.click(required(h, '1 month', choice)); await h.flush();
  assert.ok(required(h, 'Period: 1 month')); assert.equal(h.document.querySelector('[role="menu"]'), null);
  assert.equal(h.calls.length, 1, 'Period selection does not ask a missing library provider for data.');
  assert.deepEqual(writes(h), []);
});

test('template Start dialog performs explicit search, candidate selection and verified evidence preview without hidden helper assets', async t => {
  const h = await fixture(t), start = required(h, 'Start');
  start.focus(); h.click(start); await h.flush();
  assert.equal(h.form.hidden, false); assert.equal(h.document.getElementById('app-form-title').textContent, 'Add albums to Goals');
  assert.equal(h.host.querySelector('[role="alert"]')?.textContent || '', '');
  const form = h.form.querySelector('form[aria-label="Search albums for Goals"]'); assert.ok(form);
  const title = form.querySelector('input[aria-label="Album title"]'), artist = form.querySelector('input[aria-label="Artist (optional)"]');
  assert.ok(title && artist); assert.equal(required(h, 'Search', form).disabled, true);
  h.input(title, ' Candidate title '); h.input(artist, ' Private artist '); await h.flush();
  assert.equal(h.calls.length, 1, 'Typing never issues an implicit provider search.');
  assert.equal(required(h, 'Search', form).disabled, false);
  const search = h.deferred('/account/goals/remote-search');
  h.submit(form); await h.flush();
  assert.equal(h.calls.length, 2); assert.equal(required(h, 'Add', h.form).disabled, true);
  assert.match(h.form.textContent, /Searching albums/);
  assert.deepEqual(JSON.parse(h.calls[1].options.body), {title: 'Candidate title', artist: 'Private artist'});
  assert.equal(header(h.calls[1], 'X-AlbumHaven-Account-Context'), STAMP);
  assert.equal(header(h.calls[1], 'X-Album-Haven-CSRF'), CSRF, 'The actual template CSRF wrapper participates.');
  search.resolve(searchValue()); await h.flush();
  const candidate = required(h, 'Candidate title — Private artist', h.form);
  assert.equal(required(h, 'Add', h.form).disabled, true, 'Search results never manufacture evidence.');
  assert.equal(h.form.querySelector('[aria-label="Verified album preview"]').textContent, '');
  const evidence = h.deferred('/account/goals/remote-evidence');
  h.click(candidate); await h.flush();
  assert.equal(h.calls.length, 3); assert.match(h.form.textContent, /Verifying album/);
  assert.deepEqual(JSON.parse(h.calls[2].options.body), {release_group_id: GROUP});
  assert.equal(required(h, 'Add', h.form).disabled, true);
  evidence.resolve(evidenceValue()); await h.flush();
  const preview = h.form.querySelector('[aria-label="Verified album preview"]');
  assert.match(preview.textContent, /Verified exact title/); assert.doesNotMatch(preview.textContent, /Candidate title/);
  assert.ok(preview.querySelector('.album-card')); assert.equal(required(h, 'Add', h.form).disabled, false);
  assert.deepEqual(writes(h).map(call => call.route), ['/account/goals/remote-search', '/account/goals/remote-evidence']);
  h.click(required(h, 'Cancel', h.form)); await h.flush();
  assert.equal(h.form.hidden, true); assert.equal(h.document.getElementById('app-form-content').textContent, '');
  assert.equal(h.document.activeElement, start);
});

test('template manual action-menu fallback completes a stored album and exposes removal without library helpers', async t => {
  const h = await fixture(t, {full: true});
  const trigger = required(h, 'Goal album actions'); h.click(trigger);
  const actions = menu(h, 'Goal album actions');
  assert.deepEqual(actions.querySelectorAll('[role="menuitem"]').map(button => button.textContent.trim()), ['Mark completed', 'Remove from goals']);
  const completed = value({full: true, completed: true, revision: '3'}); h.setData(completed);
  h.enqueue('/account/goals/completion', options => {
    const command = JSON.parse(options.body);
    assert.equal(command.catalog_ref, ALBUM); assert.equal(command.completed, true);
    assert.equal(command.period, 'week'); assert.equal(command.revision, '2'); assert.equal(command.expected_cycle_id, CYCLE);
    return {ok: true, action: 'completion', request_key: command.request_key, changed: true, reason: '',
      goal_ref: GOAL, revision: '3', period: 'week', cycle_id: CYCLE, catalog_ref: ALBUM};
  });
  h.click(required(h, 'Mark completed', actions)); await h.flush();
  assert.deepEqual(h.calls.map(call => call.route), ['/account/goals', '/account/goals/completion', '/account/goals']);
  assert.equal(header(h.calls[1], 'X-Album-Haven-CSRF'), CSRF);
  assert.equal(h.host.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '1');
  assert.equal(h.named('Retry'), undefined);
  h.click(required(h, 'Goal album actions'));
  const updated = menu(h, 'Goal album actions');
  assert.deepEqual(updated.querySelectorAll('[role="menuitem"]').map(button => button.textContent.trim()), ['Clear completion', 'Remove from goals']);
  // The row context-menu fallback uses the same actual owner and account routes.
  h.document.body.dispatchEvent(new h.c.Event('pointerdown')); assert.equal(h.document.querySelector('[role="menu"]'), null);
  const row = h.host.querySelector('[data-goal-album-ref]'), event = new h.c.Event('contextmenu', {cancelable: true});
  row.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  assert.ok(required(h, 'Remove from goals', menu(h, 'Goal album actions')));
  assert.equal(writes(h).length, 1, 'Inspecting fallback actions does not submit another mutation.');
});

test('template dialog teardown aborts pending evidence and ignores its settled late result', async t => {
  const h = await fixture(t); h.click(required(h, 'Start')); await h.flush();
  const form = h.form.querySelector('form[aria-label="Search albums for Goals"]');
  h.input(form.querySelector('[aria-label="Album title"]'), 'Candidate title');
  h.enqueue('/account/goals/remote-search', searchValue()); h.submit(form); await h.flush();
  const evidence = h.deferred('/account/goals/remote-evidence');
  h.click(required(h, 'Candidate title — Private artist', h.form)); await h.flush();
  const request = h.calls.at(-1); assert.equal(request.route, '/account/goals/remote-evidence');
  h.owner.dispose(); assert.equal(request.options.signal.aborted, true); assert.equal(h.form.hidden, true);
  evidence.resolve(evidenceValue()); await h.flush();
  assert.equal(h.document.getElementById('app-form-content').textContent, '');
  assert.doesNotMatch(h.host.textContent, /member\.one|Verified exact title|Candidate title/);
  assert.equal(h.calls.filter(call => call.route === '/account/goals/add').length, 0);
});
