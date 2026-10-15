const test = require('node:test');
const assert = require('node:assert/strict');
const {button, plain, deferred, settle, nativeRuntime, loadOwners, sessionOwner, click} = require('./runtime/album-tops-sharing-harness.cjs');
const {createNotificationDrawerHarness} = require('./runtime/notification-drawer-harness.cjs');
test.before(loadOwners);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), COPY = id(2), OTHER = id(3), REQUEST = id(4), ACCOUNT = id(5), SCOPE = 'copy-native:actor:library';
const BROWSE = 'library.browse.read';
const top = (ref = TOP) => ({top_ref: ref, title: ref === COPY ? 'My copy' : 'Shared Top', description: 'Subtitle',
  revision: ref === COPY ? '1' : '7', visibility: ref === COPY ? 'private' : 'server_shared', items: [],
  allowed_actions: {[BROWSE]: true, can_read: true, can_copy: true, can_edit: true, can_view_sharing: true, can_share: true}});
const row = () => ({request_ref: REQUEST, top_ref: TOP, title: 'Pending Top access', account_ref: ACCOUNT,
  display_name: 'Reader', username_display: 'reader', created_at: '2026-10-09T00:00:00Z'});
async function fixture(t, {surface = 'album_tops', notifications = false, holdRefresh = false, write, feedRead} = {}) {
  const native = nativeRuntime(t), drawer = createNotificationDrawerHarness();
  const reads = [], writes = [], navigations = [], sourceConfigs = [], listeners = new Set(), registryListeners = new Set(), result = deferred(), refreshed = deferred();
  const notificationRegistry = {registerSource(config) {sourceConfigs.push(config); return drawer.context.AlbumHavenNotifications.registerSource(config);}};
  let posted = false, feed = [row()], feedError = null, disposed = 0, registry = notifications ? notificationRegistry : null;
  let shell = Object.freeze({scopeKey: SCOPE, authenticated: true, inLibrary: true, active: surface === 'album_tops',
    visible: surface === 'album_tops', topRef: surface === 'album_tops' ? TOP : null,
    sidebarMode: surface === 'album_tops' ? 'album_tops' : 'albums', viewVersion: 1, viewRequestId: 10});
  const runtime = {...native.runtime, snapshot: () => shell,
    subscribe(callback) {listeners.add(callback); return () => listeners.delete(callback);},
    acceptsPrivateScope: scope => shell.authenticated && shell.inLibrary && scope === shell.scopeKey,
    notificationRegistry: () => registry,
    subscribeNotificationRegistry(callback) {registryListeners.add(callback); return () => registryListeners.delete(callback);},
    navigate(value) {const pending = deferred(); navigations.push({...value, pending}); return pending.promise;}};
  const providers = {
    list: () => posted && holdRefresh ? refreshed.promise : {tops: [top()], allowed_actions: {[BROWSE]: true}},
    read: ref => {reads.push(ref); return top(ref);},
    execute(action, command, options) {posted = true; writes.push({action, command: plain(command), options}); return write ? write(action, command, writes.length) : result.promise;},
    readEditRequests: options => {if (feedError) throw feedError; return feedRead ? feedRead(options) : {requests: feed, next_cursor: null};},
    readSharing: () => ({top_ref: TOP, revision: '7', visibility: 'server_shared', can_manage: true,
      can_request_edit: false, can_copy: true, request_status: 'none', pending_requests: feed, next_pending_cursor: null}),
    readAccessGrants: () => ({top_ref: TOP, revision: '7', visibility: 'server_shared', grants: [], next_cursor: null}),
    readAccessCandidates: () => ({top_ref: TOP, revision: '7', candidates: [], next_cursor: null}),
    dispose() {disposed++;},
  };
  Object.assign(native.runtime, runtime);
  const sidebarHost = native.document.createElement('aside'); native.document.body.append(sidebarHost);
  t.after(() => sidebarHost.remove());
  const mounted = sessionOwner(native, {sidebarHost, runtime, providers});
  const session = () => native.host;
  const view = () => native.host.querySelector('.album-tops') || undefined;
  const viewTree = () => {const current = view(); assert.ok(current); return current;};
  const change = patch => {shell = Object.freeze({...shell, ...patch}); for (const callback of listeners) callback();};
  session(); await settle();
  return {...native, drawer, mounted, runtime, providers, reads, writes, navigations, sourceConfigs, listeners, registryListeners, session, view, viewTree,
    change, feed(value) {feed = value;},
    denyNotifications(status) {feedError = status ? Object.assign(new Error('Feed denied'), {status}) : null;}, disposed: () => disposed,
    attachRegistry() {registry = notificationRegistry; for (const callback of registryListeners) callback();},
    acknowledge() {const command = writes.at(-1).command; result.resolve({action: 'copy', request_key: command.request_key,
      top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'});},
    finishRefresh() {refreshed.resolve({tops: [top(), top(COPY)], allowed_actions: {[BROWSE]: true}});},
    acceptNavigation(index = navigations.length - 1) {
      const intent = navigations[index];
      assert.equal(intent.isCurrent(), true);
      change({active: true, visible: true, topRef: intent.top_ref, viewVersion: shell.viewVersion + 1, viewRequestId: shell.viewRequestId + 1});
      intent.pending.resolve(true);
    },
  };
}

test('current native Copy waits for authoritative refresh, opens the fresh private destination once and needs no create-form receipt', async t => {
  const h = await fixture(t, {holdRefresh: true});
  click(button(h.viewTree(), 'Save a copy')); const copying = settle(); h.acknowledge(); await settle(); h.session();
  assert.equal(button(h.viewTree(), 'Save a copy').disabled, true); assert.equal(h.navigations.length, 0);
  h.finishRefresh(); await copying; await settle(); h.session(); h.session();
  assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].top_ref, COPY);
  assert.equal(h.navigations[0].isCurrent(), true);
  assert.equal(h.reads.at(-1), TOP);
  assert.match(h.viewTree().textContent, /Shared Top/, 'copy receipt cannot paint the destination ahead of native navigation');
  await h.mounted.refresh(); h.session();
  assert.equal(h.navigations.length, 1, 'refreshing the actual mounted owner cannot consume the same receipt twice');
  h.acceptNavigation(); await settle(); h.session(); await settle(); h.session();
  assert.equal(h.reads.at(-1), COPY);
  assert.match(h.viewTree().textContent, /My copy/);
  assert.equal(h.navigations.length, 1);
});

for (const change of ['Back', 'Home', 'actor', 'library', 'newer-pending-navigation', 'unmount']) {
  test(`copy completion after ${change} cannot steal the native view`, async t => {
    const h = await fixture(t); click(button(h.viewTree(), 'Save a copy')); const copying = settle();
    if (change === 'Back') {
      click(button(h.viewTree(), 'Back'));
      h.change({topRef: null, viewVersion: 2, viewRequestId: 11});
      h.navigations[0].pending.resolve(true);
    }
    if (change === 'Home') h.change({active: false, visible: false, topRef: null, sidebarMode: 'albums', viewVersion: 2, viewRequestId: 11});
    if (change === 'actor') h.change({scopeKey: 'copy-native:other-actor:library'});
    if (change === 'library') h.change({scopeKey: 'copy-native:actor:other-library'});
    if (change === 'newer-pending-navigation') h.change({viewRequestId: 11});
    if (change === 'unmount') h.mounted.dispose(); else h.session();
    h.acknowledge(); await copying; await settle();
    if (change !== 'unmount') h.session();
    assert.equal(h.navigations.filter(value => value.top_ref === COPY).length, 0);
    if (change === 'unmount') {
      assert.equal(h.disposed(), 1); assert.equal(h.listeners.size, 0); assert.equal(h.registryListeners.size, 0);
      assert.equal(h.writes[0].options.signal.aborted, true);
    }
  });
}

test('uncertain copy replay retains original body/key but cannot gain a new navigation owner after leaving and returning', async t => {
  const h = await fixture(t, {write(action, command, attempt) {
    if (attempt === 1) throw new TypeError('Connection lost after copy submission');
    return {action, request_key: command.request_key, top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'};
  }});
  click(button(h.viewTree(), 'Save a copy')); await settle();
  assert.match(h.viewTree().textContent, /not confirmed|unconfirmed/);
  h.change({active: false, visible: false, topRef: null, sidebarMode: 'albums', viewVersion: 2, viewRequestId: 11}); h.session();
  h.change({active: true, visible: true, topRef: TOP, sidebarMode: 'album_tops', viewVersion: 3, viewRequestId: 12}); h.session(); await settle();
  h.runtime.confirmRetryOriginal = async () => true;
  click(button(h.viewTree(), 'Retry original request')); await settle(); h.session();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1].command, h.writes[0].command);
  assert.equal(h.navigations.length, 0);
});

for (const surface of ['home', 'playlists']) test(`mounted global Top notification opens exact native Share from ${surface} without granting`, async t => {
  const h = await fixture(t, {surface, notifications: true});
  assert.equal(h.view(), undefined);
  const opener = h.drawer.bodyElement.querySelector('[data-open-request-notification]'); assert.ok(opener);
  h.drawer.click(opener); await settle();
  assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].top_ref, TOP);
  assert.equal(h.writes.length, 0);
  h.acceptNavigation(); await settle(); h.session(); await settle();
  const current = h.view(); assert.ok(current); assert.equal(h.reads.at(-1), TOP);
  await settle(); assert.equal(h.modal().hidden, false);
  assert.equal(h.calls.owners.at(-1).options.title, 'Share Album Top');
  assert.equal(h.writes.length, 0);
});

test('late native Notifications registry setup registers Top globally and disposal removes only its owned source', async t => {
  const h = await fixture(t, {surface: 'home'});
  assert.equal(h.drawer.bodyElement.querySelector('[data-open-request-notification]'), null);
  h.attachRegistry(); await settle();
  assert.match(h.drawer.bodyElement.textContent, /Pending Top access/);
  h.attachRegistry(); await settle(); assert.equal(h.drawer.bodyElement.children.length, 1);
  const unrelated = h.drawer.context.AlbumHavenNotifications.registerSource({name: 'friend-requests', scopeKey: SCOPE,
    isCurrent: () => true, onOpen() {}});
  unrelated.replace([{id: REQUEST, title: 'Friend remains'}], {status: 'ready'});
  h.mounted.dispose();
  assert.match(h.drawer.bodyElement.textContent, /Friend remains/); assert.doesNotMatch(h.drawer.bodyElement.textContent, /Pending Top access/);
  assert.equal(h.registryListeners.size, 0); unrelated.dispose();
});

for (const replacement of ['newer-view', 'actor', 'library', 'request-retired', 'unmount']) {
  test(`pending notification navigation cannot open Share after ${replacement}`, async t => {
    const h = await fixture(t, {surface: 'home', notifications: true});
    h.drawer.click(h.drawer.bodyElement.querySelector('[data-open-request-notification]')); await settle();
    const intent = h.navigations[0]; assert.ok(intent);
    if (replacement === 'actor' || replacement === 'library') h.change({scopeKey: `${replacement}:replacement`});
    if (replacement === 'request-retired') {
      h.feed([]);
      h.drawer.context.state.coverLookup.drawerOpen = false; h.drawer.render();
      h.drawer.context.state.coverLookup.drawerOpen = true; h.drawer.render(); await settle();
    }
    if (replacement === 'unmount') h.mounted.dispose();
    if (replacement === 'newer-view') {
      h.change({active: true, visible: true, topRef: OTHER, sidebarMode: 'album_tops', viewVersion: 9, viewRequestId: 19});
      // The real native navigator rejects a superseded request; model its result.
      intent.pending.resolve(false);
    } else intent.pending.resolve(true);
    await settle();
    if (replacement !== 'unmount') {
      h.session(); await settle();
      const current = h.view();
      assert.equal(h.modal().hidden, true, 'retired notification cannot acquire native Share');
      if (current) assert.equal(button(h.content(), 'Save visibility'), undefined);
    }
    assert.equal(h.writes.length, 0);
  });
}


test('global notification denial retires Top authority and preserves blocked exact copy recovery until fresh authorization', async t => {
  const h = await fixture(t, {notifications: true, write() {throw new TypeError('Copy result lost');}});
  click(button(h.viewTree(), 'Save a copy')); await settle();
  const command = plain(h.writes[0].command);
  assert.ok(button(h.viewTree(), 'Retry original request'));
  h.denyNotifications(403);
  h.drawer.context.state.coverLookup.drawerOpen = false; h.drawer.render();
  h.drawer.context.state.coverLookup.drawerOpen = true; h.drawer.render(); await settle();
  assert.match(h.viewTree().textContent, /permission|access/i);
  assert.equal(h.native.host.querySelector('.album-card'), null);
  assert.equal(button(h.viewTree(), 'Retry original request'), undefined);
  const hiddenRetry = [...h.host.querySelectorAll('button')].find(node => node.textContent.trim() === 'Retry original request');
  assert.ok(hiddenRetry?.closest('[hidden]')); h.runtime.confirmRetryOriginal = async () => true;
  click(hiddenRetry); await settle(); assert.equal(h.writes.length, 1);
  assert.deepEqual(plain(h.writes[0].command), command);
  assert.equal(h.writes.length, 1);
  h.denyNotifications(null); h.change({viewVersion: 2, viewRequestId: 11}); await settle();
  assert.ok(button(h.viewTree(), 'Retry original request'));
  assert.deepEqual(plain(h.writes[0].command), command);
  click(button(h.viewTree(), 'Retry original request')); await settle();
  assert.equal(h.writes.length, 2); assert.deepEqual(plain(h.writes[1].command), command);
});


test('same-scope hidden/settings transition retires Top notifications, aborts feeds and refreshes upon return to Home', async t => {
  const pending = deferred(), reads = []; let phase = 'initial';
  const h = await fixture(t, {surface: 'home', notifications: true, feedRead(options) {
    reads.push(options);
    return phase === 'pending' ? pending.promise : {requests: [{...row(), title: phase === 'return' ? 'Fresh return request' : 'Original request'}], next_cursor: null};
  }});
  const retiredOpener = h.drawer.bodyElement.querySelector('[data-open-request-notification]'), retiredSource = h.sourceConfigs[0]; assert.ok(retiredOpener);
  phase = 'pending';
  h.drawer.context.state.coverLookup.drawerOpen = false; h.drawer.render();
  h.drawer.context.state.coverLookup.drawerOpen = true; h.drawer.render(); await settle();
  assert.equal(reads.length, 2); assert.equal(reads[1].signal.aborted, false);
  h.change({inLibrary: false, visible: false}); h.session();
  assert.equal(reads[1].signal.aborted, true);
  assert.equal(h.drawer.bodyElement.querySelector('[data-open-request-notification]'), null);
  h.drawer.click(retiredOpener); await settle(); assert.equal(h.navigations.length, 0);
  phase = 'return'; h.change({inLibrary: true}); h.session(); await settle();
  assert.equal(reads.length, 3); assert.equal(reads[2].signal.aborted, false);
  assert.match(h.drawer.bodyElement.textContent, /Fresh return request/);
  pending.resolve({requests: [{...row(), title: 'Late retired private request'}], next_cursor: null}); await settle();
  assert.doesNotMatch(h.drawer.bodyElement.textContent, /Late retired/);
  assert.equal(retiredSource.onOpen(REQUEST), false); assert.equal(retiredSource.isCurrent(), false);
  h.drawer.click(h.drawer.bodyElement.querySelector('[data-open-request-notification]')); await settle();
  assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].top_ref, TOP);
});

// Authored titles belong to the exported command/controller boundary. The native
// header has no title editor for Copy, so the mounted scenarios above use its
// actual action while these preserve the original exact authored payloads.
for (const title of ['Exact authored title', 'Preserved pending copy']) {
  test(`real controller preserves authored copy payload across ${title === 'Preserved pending copy' ? 'denial' : 'navigation'} recovery: ${title}`, async t => {
    const {createAlbumTopController} = await import('../../music_app/static/js/album-tops/model.mjs');
    const writes = []; let attempts = 0;
    const controller = createAlbumTopController({requestKey: () => id(90), providers: {
      list: () => ({tops: [top()], allowed_actions: {[BROWSE]: true}}), read: ref => top(ref),
      execute(action, command) {
        writes.push(plain(command)); if (++attempts === 1) throw new TypeError('Copy result lost');
        return {action, request_key: command.request_key, top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'};
      },
    }});
    t.after(() => controller.dispose()); controller.setScope(SCOPE); await controller.load(); await controller.open(TOP);
    assert.equal(controller.getSnapshot().detail.data.visibility, 'server_shared');
    await controller.mutate('copy', {title});
    const command = plain(controller.getSnapshot().mutation.command);
    assert.equal(command.title, title); assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(controller.canRetryMutation(), true);
    if (title === 'Preserved pending copy') {
      controller.observeDenial(SCOPE, Object.assign(new Error('Feed denied'), {status: 403}));
      assert.equal(controller.getSnapshot().detail.status, 'denied');
      assert.equal(controller.getSnapshot().directory.data, null);
      assert.equal(controller.canRetryMutation(), false); assert.equal(await controller.retryMutation(), false);
      assert.equal(writes.length, 1); assert.deepEqual(plain(controller.getSnapshot().mutation.command), command);
    } else {await controller.open(null);}
    await controller.open(TOP); assert.equal(controller.canRetryMutation(), true);
    assert.deepEqual(plain(controller.getSnapshot().mutation.command), command);
    assert.equal(await controller.retryMutation(), true); assert.deepEqual(writes, [command, command]);
    await controller.open(COPY); assert.equal(controller.getSnapshot().detail.data.visibility, 'private');
  });
}
