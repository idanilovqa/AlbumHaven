const test = require('node:test');
const assert = require('node:assert/strict');
const {createNotificationDrawerHarness} = require('./notification-drawer-harness.cjs');

const request = (id, createdAt = null, extra = {}) => ({id, title: `Person ${id}`, byline: '@member', createdAt, ...extra});
const register = (h, options = {}) => h.context.AlbumHavenNotifications.registerSource({name: 'friend-requests', scopeKey: 'account:library',
  isCurrent: () => true, onOpen() {}, ...options});
const keys = body => body.children.map(node => node.dataset.notificationKey);

test('native list interleaves cover tasks and requests by supplied dates; undated order stays stable', () => {
  const h = createNotificationDrawerHarness(), source = register(h);
  h.context.state.coverLookup.tasks = [{id: 'cover', album: 'Album', status: 'running', created_at: '2026-10-02T12:00:00Z'}];
  source.replace([request('older', '2026-10-01T12:00:00Z'), request('newer', '2026-10-03T12:00:00Z'), request('undated')]);
  assert.deepEqual(keys(h.bodyElement), ['["friend-requests","account:library","newer"]', 'cover-lookup:cover',
    '["friend-requests","account:library","older"]', '["friend-requests","account:library","undated"]']);
  assert.equal(h.badgeElement.textContent, '4'); assert.equal(h.clearElement.disabled, true);
  const before = keys(h.bodyElement);
  source.replace([request('undated'), request('newer', '2026-10-03T12:00:00Z'), request('older', '2026-10-01T12:00:00Z')]);
  assert.deepEqual(keys(h.bodyElement), before);
  assert.equal(h.bodyElement.querySelectorAll('.cover-lookup-task-type').length, 4);
});

test('request activation rechecks scope and the latest record; disposal cannot revive or remove a replacement source', () => {
  const h = createNotificationDrawerHarness(), calls = []; let current = true;
  const first = register(h, {isCurrent: () => current, onOpen: (...args) => calls.push(args)});
  first.replace([request('one')]); const opener = h.bodyElement.querySelector('[data-open-request-notification]');
  h.click(opener); assert.equal(calls[0][0], 'one'); assert.equal(calls[0][1].parentSurface, '#cover-lookup-drawer');
  assert.equal(calls[0][1].returnFocus(), opener);
  current = false; h.click(opener); assert.equal(calls.length, 1); assert.equal(opener.isConnected, false);
  const second = register(h, {onOpen: (...args) => calls.push(args)}); second.replace([request('two')]);
  first.dispose(); assert.equal(first.replace([request('stale')]), false);
  assert.match(h.bodyElement.textContent, /Person two/); assert.doesNotMatch(h.bodyElement.textContent, /Person stale/);
  h.click(h.bodyElement.querySelector('[data-open-request-notification]')); assert.equal(calls[1][0], 'two');
  second.dispose(); assert.equal(h.bodyElement.textContent, 'No notifications'); assert.equal(h.badgeElement.hidden, true);
});

test('text selection retains existing text nodes while removed requests and obsolete cover Cancel retire immediately', async () => {
  const h = createNotificationDrawerHarness(), source = register(h);
  h.context.state.coverLookup.tasks = [{id: 'cover', album: 'Selected Album', status: 'running'}];
  source.replace([request('one')]);
  const title = h.bodyElement.querySelector('[data-open-cover-lookup-task] .cover-lookup-task-title');
  h.context.getSelection = () => ({isCollapsed: false, rangeCount: 1, anchorNode: title.firstChild, focusNode: title.firstChild});
  h.context.state.coverLookup.tasks[0].status = 'completed'; h.context.state.coverLookup.tasks[0].album = 'Updated Album';
  source.replace([]);
  assert.equal(title.textContent, 'Selected Album'); assert.equal(title.isConnected, true);
  assert.equal(h.bodyElement.querySelector('[data-cancel-cover-lookup-task]'), null);
  assert.equal(h.bodyElement.querySelector('[data-open-request-notification]'), null);
  assert.ok(h.bodyElement.querySelector('[data-clear-cover-lookup-task]'));
  h.context.getSelection = () => ({isCollapsed: true, rangeCount: 0});
  h.document.dispatchEvent(new h.context.Event('selectionchange')); await Promise.resolve();
  assert.equal(title.textContent, 'Updated Album');
});

test('unchanged request controls retain identity and removed focused rows use native Close', () => {
  const h = createNotificationDrawerHarness(), source = register(h);
  source.replace([request('one')]); const opener = h.bodyElement.querySelector('[data-open-request-notification]'); opener.focus();
  source.replace([request('one', null, {byline: '@updated'})]);
  assert.equal(h.bodyElement.querySelector('[data-open-request-notification]'), opener);
  assert.equal(h.document.activeElement, opener);
  source.replace([]); assert.equal(h.document.activeElement, h.document.querySelector('[data-close-cover-lookup-drawer]'));
});

test('native Retry and Delete controls keep identity and focus while unrelated cards and task facts update', () => {
  for (const attribute of ['data-retry-cover-lookup-task', 'data-clear-cover-lookup-task']) {
    const h = createNotificationDrawerHarness(), source = register(h);
    const task = {id: 'failed', album: 'Album', status: 'failed', album_payload: {key: 'album'}};
    h.context.state.coverLookup.tasks = [task]; h.render();
    const button = h.bodyElement.querySelector(`[${attribute}]`); button.focus();
    task.album = 'Updated album'; source.replace([request('one')]);
    assert.equal(h.bodyElement.querySelector(`[${attribute}]`), button);
    assert.equal(h.document.activeElement, button); assert.match(h.bodyElement.textContent, /Updated album/);
  }
});

test('elapsed timer preserves selected text and resumes through the same native list', async () => {
  const h = createNotificationDrawerHarness(); let elapsed = 'Elapsed 1s';
  h.context.formatCoverLookupTaskElapsedLabel = () => elapsed;
  h.context.state.coverLookup.tasks = [{id: 'running', album: 'Album', status: 'running'}]; h.render();
  const label = h.bodyElement.querySelector('[data-cover-lookup-task-elapsed]'), text = label.firstChild;
  h.context.getSelection = () => ({isCollapsed: false, rangeCount: 1, anchorNode: text, focusNode: text});
  elapsed = 'Elapsed 2s'; h.intervalCalls[0].callback(); assert.equal(label.firstChild, text); assert.equal(label.textContent, 'Elapsed 1s');
  h.context.getSelection = () => ({isCollapsed: true, rangeCount: 0});
  h.document.dispatchEvent(new h.context.Event('selectionchange')); await Promise.resolve();
  assert.equal(label.textContent, 'Elapsed 2s');
});

test('unknown source states use shared alerts, never badges or fabricated notifications', () => {
  const h = createNotificationDrawerHarness(), source = register(h);
  for (const [status, text] of [['loading', /Loading friend requests/], ['error', /could not be loaded/],
    ['denied', /do not have access/], ['unavailable', /are unavailable/]]) {
    source.replace([], {status});
    assert.match(h.bodyElement.textContent, text); assert.ok(h.bodyElement.querySelector('.on-page-alert'));
    assert.equal(h.badgeElement.hidden, true); assert.equal(h.bodyElement.querySelector('[data-open-request-notification]'), null);
  }
  source.replace([], {status: 'empty'}); assert.equal(h.bodyElement.textContent, 'No notifications');
});

test('explicit drawer openings refresh sources once; re-renders and old failed reads cannot overwrite current records', async () => {
  const h = createNotificationDrawerHarness(); h.context.state.coverLookup.drawerOpen = false; h.render();
  let shows = 0, reject;
  const source = register(h, {onShow() {shows++; return new Promise((_resolve, fail) => {reject = fail;});}});
  h.context.state.coverLookup.drawerOpen = true; h.render(); h.render(); assert.equal(shows, 1);
  source.replace([request('new')]); reject(new Error('Older refresh failed')); await Promise.resolve();
  assert.match(h.bodyElement.textContent, /Person new/); assert.equal(h.bodyElement.querySelector('.on-page-alert'), null);
  h.context.state.coverLookup.drawerOpen = false; h.render(); h.context.state.coverLookup.drawerOpen = true; h.render();
  assert.equal(shows, 2); assert.equal(h.intervalCalls.length, 0);
});

test('Clear completed changes only cover tasks and preserves current requests and their focus', async () => {
  const calls = [], h = createNotificationDrawerHarness({fetch: async (url, options) => {calls.push({url, options}); return {ok: true, json: async () => ({ok: true, tasks: []})};}});
  const source = register(h); h.context.state.coverLookup.tasks = [{id: 'completed', album: 'Cover', status: 'completed'}];
  source.replace([request('one')]); const opener = h.bodyElement.querySelector('[data-open-request-notification]'); opener.focus();
  await h.context.clearCompletedCoverLookupTasks();
  assert.deepEqual(JSON.parse(calls[0].options.body), {task_ids: ['completed']});
  assert.equal(h.bodyElement.querySelector('[data-open-request-notification]'), opener);
  assert.equal(h.document.activeElement, opener); assert.equal(h.badgeElement.textContent, '1');
  assert.equal(h.clearElement.disabled, true); assert.equal(calls.length, 1);
});

test('request facts are escaped, unsafe avatars stay absent, and request identity cannot collide with status', () => {
  const h = createNotificationDrawerHarness(), source = register(h);
  source.replace([request('status', null, {title: '<script>name</script>', avatarUrl: '/\\untrusted.test/image'})], {status: 'loading'});
  assert.equal(h.bodyElement.querySelector('script'), null); assert.equal(h.bodyElement.querySelector('img'), null);
  assert.equal(h.bodyElement.children.length, 2); assert.equal(new Set(keys(h.bodyElement)).size, 2);
});
