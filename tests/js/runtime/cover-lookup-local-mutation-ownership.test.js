const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const clone = value => JSON.parse(JSON.stringify(value));

for (const identity of ['key', 'album_id']) {
  for (const kind of ['local', 'remote', 'delete']) {
    test(`${kind} save ownership separates two lean albums identified by ${identity}`, async () => {
      const h = harness();
      h.context.getAlbumRequestKey = value => value?.album_ref || value?.key || '';
      const a = { ...album('A'), tracks: [], [identity]: identity === 'key' ? 'artist::a' : 101 };
      const b = { ...album('B'), tracks: [], [identity]: identity === 'key' ? 'artist::b' : 102 };
      const start = value => {
        if (kind === 'delete') return h.context.deleteLocalCoverFromLookup(value.cover_ref);
        if (kind === 'local') return h.context.saveLocalCoverFromLookup(`/${value.name}/new.jpg`);
        Object.assign(h.context.state.coverLookup.modal, {
          taskId: `task-${value.name}`, selectedRemoteId: 'candidate',
          possibleMatches: [{ id: 'candidate', url: `https://example.test/${value.name}.jpg` }],
        });
        return h.context.saveRemoteCoverFromLookup();
      };
      await h.open(a);
      const first = start(a);
      assert.equal(h.requests.length, 1);
      h.context.closeCoverLookupModal();
      await h.open(b);
      assert.equal(h.context.isCoverLookupMutationPending(), false, 'a different lean album must remain usable');
      const second = start(b);
      assert.equal(h.requests.length, 2, 'each album owns an independent save');
      const reads = h.galleries.length;
      await h.settle(0);
      await first;
      // Save closes its modal on click (owner decision 2026-11-04); Delete keeps it open.
      if (kind === 'delete') assert.equal(h.context.state.coverLookup.modal.album.name, 'B');
      assert.equal(h.context.isCoverLookupMutationPending(b), true, 'A must not release B');
      assert.equal(h.galleries.length, reads, 'A must not refresh B');
      await h.settle(1);
      await second;
      assert.equal(h.context.isCoverLookupMutationPending(b), false);
    });
  }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const album = name => ({ name, cover_ref: `/${name}/cover.jpg`, cover_revision: `${name}-old`,
  tracks: [{ path: `/${name}/track.mp3`, cover_ref: `/${name}/cover.jpg` }] });

function harness() {
  class Button {
    disabled = false; hidden = false; textContent = ''; attributes = {};
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  const save = new Button(), remove = new Button();
  const overlay = { hidden: true, querySelectorAll: () => [remove] };
  const confirm = { hidden: true, style: {} };
  const requests = [], galleries = [], notifications = [], painted = new Map(), server = new Map();
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    ButtonComponent: require(path.join(runtime, '../button-component.js')),
    state: { coverRefreshTokens: {}, coverLookup: { modal: { pastedImages: [] }, tasks: [], optimisticAlbumCovers: {} } },
    window: {}, HTMLButtonElement: Button, URL, URLSearchParams, console: { log() {}, error() {}, warn() {} },
    deepCloneJson: clone, persistCoverLookupNotificationTasks() {},
    getAlbumPathSignature: value => value?.tracks?.map(track => track.path).join('::') || '',
    buildCoverUrl: value => value, showToast: (...args) => notifications.push(args),
    document: { body: { classList: { add() {}, remove() {} } },
      getElementById: id => ({ 'cover-lookup-modal': overlay, 'cover-lookup-save-remote-button': save,
        'cover-lookup-delete-confirm-modal': confirm, 'track-modal': { hidden: true }, 'utility-modal': { hidden: true } }[id] || null) },
    fetch: (url, options) => {
      const body = JSON.parse(options.body);
      if (url === '/utilities/cover-lookup/gallery') {
        galleries.push(body.album.name);
        return Promise.resolve({ ok: true, json: async () => clone(server.get(body.album.name)) });
      }
      return new Promise((resolve, reject) => requests.push({ url, body, resolve, reject }));
    },
  });
  vm.runInContext(fs.readFileSync(path.join(runtime, 'modal-and-overlay-helpers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(runtime, 'cover-lookup-modal-and-drawer.js'), 'utf8'), context);
  context.renderCoverLookupModal = () => context.syncCoverLookupSaveButton();
  context.ensureCoverLookupPolling = context.stopCoverLookupPollingIfIdle = () => {};
  const loadTasks = context.loadCoverLookupTasks;
  context.loadCoverLookupTasks = async () => {};
  const markSeen = context.markCoverLookupAutomaticImprovementSeen;
  context.markCoverLookupAutomaticImprovementSeen = async () => {};
  context.syncCoverLookupSelectionUi = () => context.syncCoverLookupSaveButton();
  const shown = new Map();
  context.refreshCoverLookupAlbumArtwork = (_original, updated) => updated.forEach((value) => {
    painted.set(value.name, value.cover_revision);
    shown.set(value.name, value.cover_ref || value.remote_cover_url || '');
  });
  const setGallery = (value, suffix = 'fresh') => server.set(value.name, { ok: true,
    active_cover_ref: value.cover_ref, selected_source_cover_ref: value.cover_ref,
    local_covers: [{ candidate_cover_ref: value.cover_ref, is_active: true, cover_revision: value.cover_revision },
      { candidate_cover_ref: `/${value.name}/${suffix}.jpg` }] });
  const open = async value => {
    if (!server.has(value.name)) setGallery(value, 'source');
    await context.openCoverLookupModal(value);
  };
  const settle = async (index, outcome = 'success', includeGallery = true) => {
    const request = requests[index];
    const value = { ...request.body.album, cover_ref: `/${request.body.album.name}/settled.jpg`, cover_revision: `${request.body.album.name}-settled` };
    if (outcome === 'error') request.reject(new Error('Owned local mutation failed'));
    else {
      setGallery(value);
      request.resolve({ ok: true, json: async () => ({ ok: true, updated_albums: [value],
        ...(includeGallery ? { gallery: clone(server.get(value.name)) } : {}) }) });
    }
    return value;
  };
  const draft = name => Object.assign(context.state.coverLookup.modal, {
    pendingLocalRef: `/${name}/draft.jpg`, pendingPastedImageId: `${name}-pasted`, selectedRemoteId: `${name}-remote`,
    remoteSelectionOverrideGeneration: `${name}-generation`, remoteSelectionOverrideCandidateId: `${name}-remote`,
    remoteSelectionOverrideUrl: `https://example.test/${name}`, manualUrlText: `${name} manual draft`,
  });
  const selection = () => {
    const m = context.state.coverLookup.modal;
    return [m.pendingLocalRef, m.pendingPastedImageId, m.selectedRemoteId,
      m.remoteSelectionOverrideGeneration, m.remoteSelectionOverrideCandidateId, m.remoteSelectionOverrideUrl, m.manualUrlText];
  };
  return { context, markSeen, loadTasks, open, settle, draft, selection, save, remove, overlay, confirm, requests, galleries, notifications, painted, shown, server };
}

// BUGFIX-22: an interrupted save leaves the lookup's recorded choice on its task while the album keeps its old
// cover. Save compares a pick with the album's own cover, so that recorded candidate can still be saved.
test('a lookup recorded choice that never reached the album can be saved as its cover', async () => {
  const h = harness();
  const a = album('A');
  const drones = { id: 'muse-drones', url: 'https://i.ytimg.com/vi/drones/maxresdefault.jpg', source: 'youtube',
    art_kind: 'cover' };
  await h.open(a);
  h.context.state.coverLookup.tasks = [{ id: 'task-A', status: 'canceled', selected_candidate_id: drones.id,
    album_payload: a, possible_matches: [drones] }];
  Object.assign(h.context.state.coverLookup.modal, { taskId: 'task-A', possibleMatches: [drones] });
  assert.equal(h.context.state.coverLookup.modal.remoteCover, null, 'the album still shows its local cover');

  h.context.selectRemoteCoverFromLookup(drones.id);
  assert.equal(h.save.disabled, false, 'the recorded choice is not the album cover, so Save is available');

  h.context.markCoverLookupTaskActionTaken = () => {};
  const saving = h.context.saveRemoteCoverFromLookup();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/utilities/cover-lookup/save-remote');
  assert.equal(h.requests[0].body.candidate_id, drones.id);
  assert.equal(h.shown.get('A'), drones.url, 'Album Details and the gallery show the saved choice at once');
  // The server now links the album to that remote cover.
  h.server.set('A', { ok: true, remote_cover: { id: 'saved-remote:drones', url: drones.url },
    local_covers: [{ candidate_cover_ref: a.cover_ref, is_active: false }] });
  h.requests[0].resolve({ ok: true, json: async () => ({ ok: true,
    task: { id: 'task-A', status: 'completed', selected_candidate_id: drones.id } }) });
  await saving;
  assert.deepEqual(h.notifications, []);
  assert.equal(h.shown.get('A'), drones.url);

  // Once that remote cover is the album's own cover, choosing it again has nothing to save.
  await h.open(a);
  assert.equal(h.context.state.coverLookup.modal.remoteCover.url, drones.url);
  Object.assign(h.context.state.coverLookup.modal, { taskId: 'task-A', possibleMatches: [drones] });
  h.context.selectRemoteCoverFromLookup(drones.id);
  assert.equal(h.save.disabled, true);
});

test('lookup identity previews leave the caller hydrated album and its virtual release reference untouched', async () => {
  const h = harness();
  const original = { ...album('A'), id: 7, album_id: 7, key: 'album-a', album_ref: 'edition:album-a',
    preview_only: false, tracks: [{ path: '/A/track.mp3', title: 'Rich track', duration: 180 }] };
  const before = clone(original);
  const richTracks = original.tracks;
  await h.open(original);
  assert.notEqual(h.context.state.coverLookup.modal.album, original);
  h.context.applyCoverLookupGalleryPayload({ album: {
    id: 7, album_id: 7, key: 'album-a', name: 'A', preview_only: true,
    tracks: [{ path: '/A/track.mp3' }],
  } });
  assert.deepEqual(original, before);
  assert.equal(original.tracks, richTracks);
  assert.equal(h.context.state.coverLookup.modal.album.album_ref, 'edition:album-a');
  let requested;
  h.context.usesMobilePageLayout = () => false;
  h.context.openTrackModal = value => { requested = value; };
  h.context.openCoverLookupAlbumDetails();
  assert.equal(requested.preview_only, true, 'the existing details cache owner checks freshness');
  assert.equal(requested.album_ref, 'edition:album-a');
  assert.deepEqual(original, before);
});

test('local cover delete confirmation foregrounds the desktop and mobile Cover Lookup layers', async () => {
  const h = harness();
  await h.open(album('A'));

  h.context.openCoverLookupDeleteConfirm('/A/source.jpg');

  assert.equal(h.confirm.hidden, false);
  assert.ok(
    Number(h.confirm.style.zIndex) > 4550,
    'the confirmation must remain clickable above the mobile Cover Lookup sheet',
  );
});

for (const outcome of ['success', 'success without gallery', 'error']) {
  test(`late local deletion ${outcome} preserves another album's modal`, async () => {
    const h = harness(), a = album('A'), b = album('B');
    await h.open(a);
    const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
    assert.equal(h.requests.length, 1);
    h.context.closeCoverLookupModal();
    await h.open(b);
    h.draft('B');
    const selected = h.selection(), cards = clone(h.context.state.coverLookup.modal.localCovers);
    const reads = h.galleries.length;
    await h.settle(0, outcome === 'error' ? 'error' : 'success', outcome !== 'success without gallery');
    await pending;
    assert.deepEqual(h.selection(), selected);
    assert.deepEqual(clone(h.context.state.coverLookup.modal.localCovers), cards);
    assert.equal(h.context.state.coverLookup.modal.album.name, 'B');
    assert.equal(h.galleries.length, reads, 'A completion must not request B gallery');
    assert.equal(h.painted.get('A'), outcome === 'error' ? 'A-old' : 'A-settled');
    assert.deepEqual(
      h.notifications,
      outcome === 'error' ? [['Owned local mutation failed', 'error', 2800]] : [],
    );
  });
}

for (const mutation of ['save', 'delete']) {
  for (const outcome of ['success', 'error']) {
    test(`${mutation} ${outcome} keeps reopened controls usable and the pending mutation single, then releases its draft`, async () => {
      const h = harness(), a = album('A');
      await h.open(a);
      const pending = mutation === 'save'
        ? h.context.saveLocalCoverFromLookup('/A/source.jpg')
        : h.context.deleteLocalCoverFromLookup(a.cover_ref);
      h.context.closeCoverLookupModal();
      await h.open(clone(a));
      h.draft('A');
      h.context.syncCoverLookupSaveButton();
      const selected = h.selection();
      // BUGFIX-27 (owner approved 2026-11-15): reopening leaves Save and every delete button usable.
      assert.equal(h.save.disabled, false);
      assert.equal(h.remove.disabled, false);
      h.context.openCoverLookupDeleteConfirm('/A/source.jpg');
      assert.equal(h.confirm.hidden, false, 'BUGFIX-27: delete confirmation behaves like before after a reopen');
      h.context.closeCoverLookupDeleteConfirm();
      // The mutation in flight is still the album's only one: repeating it sends nothing.
      const repeated = mutation === 'save'
        ? h.context.saveLocalCoverFromLookup('/A/source.jpg')
        : h.context.deleteLocalCoverFromLookup(a.cover_ref);
      await nextTurn();
      assert.equal(h.requests.length, 1, 'no overlapping same-album mutation may reach the server');
      await repeated;
      const reads = h.galleries.length;
      await h.settle(0, outcome);
      await pending;
      assert.deepEqual(h.selection(), selected);
      assert.equal(h.save.disabled, false);
      assert.equal(h.remove.disabled, false);
      h.context.openCoverLookupDeleteConfirm('/A/source.jpg');
      assert.equal(h.confirm.hidden, false, 'delete confirmation is available after release');
      h.context.closeCoverLookupDeleteConfirm();
      assert.equal(h.galleries.length, reads + 1, 'reopened album gets its own authoritative read');
      assert.equal(h.context.state.coverLookup.modal.album.cover_revision, outcome === 'success' ? 'A-settled' : 'A-old');
      assert.ok(h.context.state.coverLookup.modal.localCovers.some(card => card.candidate_cover_ref === (outcome === 'success' ? '/A/settled.jpg' : '/A/cover.jpg')));
      const next = h.context.saveLocalCoverFromLookup('/A/newer.jpg');
      assert.equal(h.requests.length, 2, 'settlement releases the original claim');
      await h.settle(1);
      await next;
    });
  }
}

for (const outcome of ['success', 'error']) {
  test(`old Save ${outcome} cannot clear a different album's newer pending Save`, async () => {
    const h = harness();
    await h.open(album('A'));
    const first = h.context.saveLocalCoverFromLookup('/A/source.jpg');
    h.context.closeCoverLookupModal();
    assert.equal(h.context.state.coverLookup.modal.saving, false, 'Close releases the finished modal busy state');
    await h.open(album('B'));
    const second = h.context.saveLocalCoverFromLookup('/B/source.jpg');
    assert.equal(h.requests.length, 2, 'independent albums may proceed');
    const optimistic = h.context.state.coverLookup.optimisticAlbumCovers['/B/track.mp3'];
    const token = h.context.state.coverRefreshTokens['/B/source.jpg'];
    await h.settle(0, outcome);
    await first;
    // B's Save already closed its modal on click; A must still not release B.
    assert.equal(h.overlay.hidden, true);
    assert.equal(h.context.isCoverLookupMutationPending(album('B')), true);
    assert.strictEqual(h.context.state.coverLookup.optimisticAlbumCovers['/B/track.mp3'], optimistic);
    assert.equal(h.context.state.coverRefreshTokens['/B/source.jpg'], token);
    await h.settle(1);
    await second;
    assert.equal(h.context.isCoverLookupMutationPending(album('B')), false);
    assert.equal(h.painted.get('B'), 'B-settled');
  });
}

// An answer naming the saved file, as the save routes send it.
function answerSave(h, index, coverRef) {
  h.requests[index].resolve({ ok: true, json: async () => ({ ok: true, selected_cover_ref: coverRef,
    updated_albums: [{ ...album('A'), cover_ref: coverRef, cover_revision: `saved:${coverRef}`,
      tracks: [{ path: '/A/track.mp3', cover_ref: coverRef }] }] }) });
}
const failRequest = (h, index, message = 'Owned save failed') => h.requests[index].reject(new Error(message));
const optimisticRef = h => h.context.state.coverLookup.optimisticAlbumCovers['/A/track.mp3']?.coverRef;
async function saveThenReopen(h, coverRef) {
  const pending = h.context.saveLocalCoverFromLookup(coverRef);
  h.context.closeCoverLookupModal();
  await h.open(album('A'));
  return { pending };
}

for (const outcome of ['success', 'error']) {
  test(`a newer choice after reopening shows at once, is sent after a save that ends in ${outcome}, and wins`, async () => {
    const h = harness();
    await h.open(album('A'));
    const first = await saveThenReopen(h, '/A/first.jpg');
    const second = h.context.saveLocalCoverFromLookup('/A/second.jpg');
    assert.equal(h.shown.get('A'), '/A/second.jpg', 'the newer choice shows at once');
    assert.equal(h.overlay.hidden, true, 'Save still closes at once');
    await nextTurn();
    assert.equal(h.requests.length, 1, 'it waits for the save in flight');
    if (outcome === 'success') answerSave(h, 0, '/A/first.jpg'); else failRequest(h, 0, 'First save failed');
    await first.pending;
    await nextTurn();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].body.source_cover_ref, '/A/second.jpg');
    assert.equal(h.shown.get('A'), '/A/second.jpg', 'the older answer never replaces the newer choice');
    assert.equal(optimisticRef(h), '/A/second.jpg');
    answerSave(h, 1, '/A/second.jpg');
    await second;
    assert.equal(h.shown.get('A'), '/A/second.jpg');
    assert.equal(h.painted.get('A'), 'saved:/A/second.jpg');
    assert.deepEqual(h.notifications.map(([message]) => message), outcome === 'error' ? ['First save failed'] : []);
    assert.equal(h.context.isCoverLookupMutationPending(album('A')), false);
  });

  test(`a failed newer choice rolls back only itself after an older save that ended in ${outcome}`, async () => {
    const h = harness();
    await h.open(album('A'));
    const first = await saveThenReopen(h, '/A/first.jpg');
    const second = h.context.saveLocalCoverFromLookup('/A/second.jpg');
    if (outcome === 'success') answerSave(h, 0, '/A/first.jpg'); else failRequest(h, 0, 'First save failed');
    await first.pending;
    await nextTurn();
    assert.equal(h.requests.length, 2);
    failRequest(h, 1, 'Second save failed');
    await second;
    assert.equal(h.shown.get('A'), outcome === 'success' ? '/A/first.jpg' : '/A/cover.jpg');
    assert.equal(optimisticRef(h), undefined);
    assert.deepEqual(h.notifications.at(-1).slice(0, 2), ['Second save failed', 'error']);
  });
}

test('only the last of several choices waiting on a save is sent', async () => {
  const h = harness();
  await h.open(album('A'));
  const first = await saveThenReopen(h, '/A/first.jpg');
  const second = await saveThenReopen(h, '/A/second.jpg');
  const third = h.context.saveLocalCoverFromLookup('/A/third.jpg');
  answerSave(h, 0, '/A/first.jpg');
  await first.pending;
  await nextTurn();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.source_cover_ref, '/A/third.jpg');
  answerSave(h, 1, '/A/third.jpg');
  await Promise.all([second.pending, third]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.shown.get('A'), '/A/third.jpg');
});

// The drawer as it is really rendered, for album A's finished lookup.
function showDrawer(h, alreadyChosen) {
  const { context } = h;
  const element = () => ({ hidden: false, textContent: '', innerHTML: '', setAttribute() {},
    classList: { contains: () => true, toggle() {} } });
  const body = element();
  const parts = { 'cover-lookup-drawer': element(), 'cover-lookup-drawer-body': body,
    'cover-lookup-drawer-badge': element(), 'cover-lookup-drawer-button': element() };
  const find = context.document.getElementById;
  context.document.getElementById = id => parts[id] || find(id);
  context.window.setInterval = () => 1;
  context.window.clearInterval = () => {};
  context.escapeHtml = value => String(value ?? '');
  context.buildTrackPathSignature = value => value?.tracks?.map(track => track.path).join('\n') || '';
  vm.runInContext(fs.readFileSync(path.join(runtime, 'alert-components.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(runtime, 'cover-lookup-notification-helpers.js'), 'utf8'), context);
  const post = context.fetch;
  context.fetch = (url, options) => (String(url).endsWith('/mark-action-taken')
    ? Promise.resolve({ ok: true }) : post(url, options));
  Object.assign(context.state.coverLookup, { drawerOpen: true, tasksHydrated: true, tasksLoadFailed: false,
    appliedTaskUpdateSignatures: {}, tasks: [{ id: 'task-A', status: 'completed', album: 'A', album_payload: album('A'),
      notification_action_taken: alreadyChosen }] });
  context.renderCoverLookupDrawer();
  return () => body.innerHTML.includes('>Art chosen<');
}

function startChoice(h, kind) {
  const { modal } = h.context.state.coverLookup;
  modal.taskId = 'task-A';
  if (kind === 'pasted') {
    modal.pastedImages = [{ id: 'pasted', data_url: 'data:image/jpeg;base64,AA==', filename: 'pasted.jpg' }];
    return h.context.savePastedCoverFromLookup('pasted');
  }
  if (kind === 'remote') {
    Object.assign(modal, { selectedRemoteId: 'candidate',
      possibleMatches: [{ id: 'candidate', url: 'https://example.test/remote.jpg' }] });
    return h.context.saveRemoteCoverFromLookup();
  }
  return h.context.saveLocalCoverFromLookup('/A/second.jpg');
}

// Owner rule: a save looks saved when the server accepts it. A waiting choice is lost if the page unloads.
for (const kind of ['local', 'pasted', 'remote']) {
  for (const outcome of ['accepted', 'refused']) {
    for (const alreadyChosen of [false, true]) {
      const card = alreadyChosen ? 'a card chosen earlier' : 'an unchosen card';
      test(`a ${kind} choice waiting on a save never says Art chosen on ${card} before it is ${outcome}`, async () => {
        const h = harness();
        await h.open(album('A'));
        const saysChosen = showDrawer(h, alreadyChosen);
        assert.equal(saysChosen(), alreadyChosen, 'the drawer really renders');
        h.context.state.coverLookup.modal.taskId = 'task-A';
        const first = await saveThenReopen(h, '/A/first.jpg');
        const second = startChoice(h, kind);
        await nextTurn();
        assert.equal(h.requests.length, 1, 'the choice waits');
        assert.equal(saysChosen(), false, 'a waiting choice must not look saved');

        answerSave(h, 0, '/A/first.jpg');
        await first.pending;
        await nextTurn();
        assert.equal(h.requests.length, 2);
        assert.equal(saysChosen(), false, 'the older acceptance must not vouch for the newer picture');

        if (outcome === 'refused') failRequest(h, 1, 'Second save failed');
        else {
          h.requests[1].resolve({ ok: true, json: async () => ({ ok: true, selected_cover_ref: '/A/second.jpg',
            notification_action_taken_task_ids: ['task-A'], task: { id: 'task-A', status: 'completed' },
            updated_albums: [{ ...album('A'), cover_ref: '/A/second.jpg', cover_revision: 'second' }] }) });
        }
        await second;
        assert.equal(saysChosen(), true, 'the last save the server accepted is shown without another event');
      });
    }
  }
}

for (const kind of ['local', 'pasted', 'remote']) {
  test(`a lone ${kind} save never says Art chosen before the server accepts it`, async () => {
    const h = harness();
    await h.open(album('A'));
    const saysChosen = showDrawer(h, false);
    const pending = startChoice(h, kind);
    await nextTurn();
    assert.equal(saysChosen(), false);
    failRequest(h, 0, 'Save failed');
    await pending;
    assert.equal(saysChosen(), false);
  });
}

for (const [kind, workerStatus] of [['local', ''], ['pasted', ''], ['remote', 'completed'], ['remote', 'running']]) {
  test(`an accepted ${kind} save${workerStatus ? ` with a ${workerStatus} worker` : ''} gives every earlier Art chosen card of its album back`, async () => {
    const h = harness();
    await h.open(album('A'));
    showDrawer(h, true);
    const { context } = h;
    context.state.coverLookup.tasks.push({ ...context.state.coverLookup.tasks[0], id: 'sibling-A' });
    const chosenCards = () => context.document.getElementById('cover-lookup-drawer-body').innerHTML
      .split('>Art chosen<').length - 1;
    context.renderCoverLookupDrawer();
    assert.equal(chosenCards(), 2);
    const pending = startChoice(h, kind);
    await nextTurn();
    context.renderCoverLookupDrawer();
    assert.equal(chosenCards(), 0, 'both cards show the picture that is not accepted yet');
    // A drawer render replaces only the cards it names, as in the browser.
    const named = new Set();
    const render = context.renderCoverLookupDrawer;
    context.renderCoverLookupDrawer = (options = {}) => {
      if (options.taskIds?.length) options.taskIds.forEach(id => named.add(id));
      else ['task-A', 'sibling-A'].forEach(id => named.add(id));
      return render(options);
    };
    h.requests[0].resolve({ ok: true, json: async () => ({ ok: true, selected_cover_ref: '/A/second.jpg',
      notification_action_taken_task_ids: ['task-A'],
      task: { id: 'task-A', status: workerStatus || 'completed', save_generation: 'save-1' },
      updated_albums: [] }) });
    await pending;
    assert.ok(named.has('sibling-A'), 'the sibling card must be rendered again');
    assert.ok(chosenCards() >= 1, 'the earlier accepted choice is no longer withheld');
  });
}

test('returning to the choice in flight never sends it twice', async () => {
  const h = harness();
  await h.open(album('A'));
  const first = await saveThenReopen(h, '/A/first.jpg');
  const second = await saveThenReopen(h, '/A/second.jpg');
  const again = h.context.saveLocalCoverFromLookup('/A/first.jpg');
  assert.equal(h.shown.get('A'), '/A/first.jpg');
  answerSave(h, 0, '/A/first.jpg');
  await nextTurn();
  assert.equal(h.requests.length, 1);
  await Promise.all([first.pending, second.pending, again]);
  assert.equal(h.shown.get('A'), '/A/first.jpg');
  assert.equal(h.context.isCoverLookupMutationPending(album('A')), false);
});

test('a save chosen during a reopened deletion waits for it and wins', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const deletion = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  h.context.closeCoverLookupModal();
  await h.open(album('A'));
  const save = h.context.saveLocalCoverFromLookup('/A/second.jpg');
  await nextTurn();
  assert.equal(h.requests.length, 1);
  await h.settle(0);
  await deletion;
  await nextTurn();
  assert.equal(h.requests.length, 2);
  assert.equal(h.shown.get('A'), '/A/second.jpg');
  answerSave(h, 1, '/A/second.jpg');
  await save;
  assert.equal(h.shown.get('A'), '/A/second.jpg');
});

for (const outcome of ['success', 'error']) {
  test(`a delete queued behind a save that ends in ${outcome} keeps only its own change`, async () => {
    const h = harness();
    await h.open(album('A'));
    const first = await saveThenReopen(h, '/A/first.jpg');
    h.context.state.coverLookup.modal.album.cover_ref = '/A/first.jpg';
    h.context.state.coverLookup.modal.localCovers = [
      { candidate_cover_ref: '/A/first.jpg' }, { candidate_cover_ref: '/A/fallback.jpg' },
    ];
    const deletion = h.context.deleteLocalCoverFromLookup('/A/first.jpg');
    // The reopened album is the optimistic one, whose current cover is the file being deleted.
    assert.equal(h.shown.get('A'), '/A/fallback.jpg');
    if (outcome === 'success') answerSave(h, 0, '/A/first.jpg'); else failRequest(h, 0, 'First save failed');
    await first.pending;
    await nextTurn();
    // A failed save never made that file current, so deleting it leaves the album's cover alone.
    assert.equal(h.shown.get('A'), outcome === 'success' ? '/A/fallback.jpg' : '/A/cover.jpg');
    assert.equal(h.requests[1].url, '/utilities/cover-lookup/local-delete');
    await h.settle(1);
    await deletion;
    assert.equal(h.shown.get('A'), '/A/settled.jpg');
  });
}

for (const status of ['completed', 'failed']) {
  test(`a choice made during a remote save waits for its worker to be ${status}`, async () => {
    const h = harness();
    await h.open(album('A'));
    const { context } = h;
    context.state.coverLookup.tasks = [{ id: 'task-A', status: 'completed', album_payload: album('A') }];
    context.state.coverLookup.appliedTaskUpdateSignatures = {};
    context.markCoverLookupTaskActionTaken = () => {};
    Object.assign(context.state.coverLookup.modal, {
      taskId: 'task-A', selectedRemoteId: 'candidate',
      possibleMatches: [{ id: 'candidate', url: 'https://example.test/remote.jpg' }],
    });
    const remote = context.saveRemoteCoverFromLookup();
    h.requests[0].resolve({ ok: true, json: async () => ({ ok: true,
      task: { id: 'task-A', status: 'running', save_generation: 'save-1' } }) });
    await remote;
    assert.deepEqual(h.notifications, [], 'the acceptance itself succeeds');
    await h.open(album('A'));
    const local = context.saveLocalCoverFromLookup('/A/second.jpg');
    await nextTurn();
    assert.equal(h.requests.length, 1, 'an accepted remote save can still overwrite a save sent now');
    context.applyCoverLookupTaskUpdates({ id: 'task-A', status, save_generation: 'save-1', message: 'Remote save failed',
      updated_albums: status === 'completed' ? [{ ...album('A'), cover_ref: '/A/remote.jpg' }] : [] });
    await nextTurn();
    assert.equal(h.requests.length, 2);
    assert.equal(h.shown.get('A'), '/A/second.jpg');
    assert.equal(optimisticRef(h), '/A/second.jpg');
    answerSave(h, 1, '/A/second.jpg');
    await local;
    assert.equal(h.shown.get('A'), '/A/second.jpg');
    assert.deepEqual(h.notifications.map(([message]) => message), status === 'failed' ? ['Remote save failed'] : []);
    assert.equal(context.isCoverLookupMutationPending(album('A')), false);
  });
}

test('only a complete list requested after a remote save releases a task that is gone', async () => {
  const h = harness();
  await h.open(album('A'));
  const { context } = h;
  const lists = [];
  const post = context.fetch;
  context.fetch = (url, options) => (String(url).startsWith('/utilities/cover-lookup/tasks')
    ? new Promise(resolve => lists.push(() => resolve({ ok: true, json: async () => ({ ok: true, tasks: [], next_cursor: null, total_count: 0 }) })))
    : post(url, options));
  Object.assign(context.state.coverLookup, { tasks: [], appliedTaskUpdateSignatures: {} });
  for (const name of ['markCoverLookupTaskActionTaken', 'updateCoverLookupNotificationCounts', 'stopCoverLookupPollingIfIdle', 'renderCoverLookupDrawer']) {
    context[name] = () => {};
  }
  context.mergeCoverLookupTasksWithNotifications = tasks => tasks;
  Object.assign(context.state.coverLookup.modal, {
    taskId: 'task-A', selectedRemoteId: 'candidate',
    possibleMatches: [{ id: 'candidate', url: 'https://example.test/remote.jpg' }],
  });
  const requestedBefore = h.loadTasks({ toast: false });
  const remote = context.saveRemoteCoverFromLookup();
  h.requests[0].resolve({ ok: true, json: async () => ({ ok: true,
    task: { id: 'task-A', status: 'running', save_generation: 'save-1' } }) });
  await remote;
  lists.shift()();
  await requestedBefore;
  assert.equal(context.isCoverLookupMutationPending(album('A')), true, 'an older list cannot know the accepted task');
  const requestedAfter = h.loadTasks({ toast: false });
  lists.shift()();
  await requestedAfter;
  assert.equal(context.isCoverLookupMutationPending(album('A')), false, 'a task that is gone cannot hold the album');
});

test('local mutation claim spans image preload and releases after synchronous setup failure', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  let finishPreload;
  h.context.preloadCoverLookupAlbumImage = () => new Promise(resolve => { finishPreload = resolve; });
  const pending = h.context.saveLocalCoverFromLookup('/A/source.jpg');
  await h.settle(0);
  await new Promise(resolve => setImmediate(resolve));
  h.context.closeCoverLookupModal();
  await h.open(clone(a));
  // Owner report 2026-11-15 (8c776ecbf): a delete during a save is queued behind it, not dropped.
  const queuedDelete = h.context.deleteLocalCoverFromLookup('/A/source.jpg');
  assert.equal(h.requests.length, 1, 'the delete waits for the claim that spans the preload');
  finishPreload(true);
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2, 'the queued delete is sent once the save settles');
  assert.equal(h.requests[1].url, '/utilities/cover-lookup/local-delete');
  await h.settle(1);
  await queuedDelete;
  h.context.applyOptimisticLocalCoverSelection = () => { throw new Error('Setup failed'); };
  await h.context.saveLocalCoverFromLookup('/A/newer.jpg');
  assert.equal(h.context.state.coverLookup.modal.saving, false);
  assert.equal(h.context.isCoverLookupMutationPending(), false);
  assert.equal(h.remove.disabled, false);
  assert.equal(h.notifications.at(-1)[1], 'error');
});

test('failed local selection restores the prior inventory selection ledger', async () => {
  const h = harness();
  const a = album('A');
  await h.open(a);
  const previousGallery = clone(h.server.get('A'));

  const pending = h.context.saveLocalCoverFromLookup('/A/source.jpg');
  await h.settle(0, 'error');
  await pending;

  const reconciled = h.context.reconcileCoverLookupLocalInventory(a, previousGallery, false);
  assert.equal(reconciled.selected_source_path, a.cover_path);
});

test('successful local save completes when the authoritative image preload stalls', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  h.context.state.coverLookup.modal.taskId = 'task-a';
  h.context.preloadCoverLookupAlbumImage = () => new Promise(() => {});
  h.context.setTimeout = callback => {
    queueMicrotask(callback);
    return 1;
  };
  h.context.clearTimeout = () => {};
  const acknowledged = [];
  let closeCount = 0;
  h.context.markCoverLookupTaskActionTaken = (taskId, selectedAlbum) => {
    acknowledged.push([taskId, selectedAlbum.name]);
  };
  h.context.renderCoverLookupDrawer = () => {};
  h.context.closeCoverLookupModal = () => { closeCount += 1; };

  const pending = h.context.saveLocalCoverFromLookup('/A/source.jpg');
  const optimisticKey = h.context.getAlbumPathSignature(a);
  const optimisticCover = h.context.state.coverLookup.optimisticAlbumCovers[optimisticKey];
  await h.settle(0);
  const outcome = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setImmediate(() => resolve('pending'))),
  ]);

  assert.equal(outcome, 'settled');
  assert.equal(h.context.state.coverLookup.modal.saving, false);
  assert.equal(h.context.isCoverLookupMutationPending(), false);
  assert.deepEqual(acknowledged, [['task-a', 'A']]);
  assert.equal(closeCount, 1);
  assert.strictEqual(
    h.context.state.coverLookup.optimisticAlbumCovers[optimisticKey],
    optimisticCover,
    'timeout must keep the selected image visible',
  );
});

test('a pre-mutation gallery response cannot restore the deleted cover', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const originalFetch = h.context.fetch;
  let settleGallery;
  h.context.fetch = (url, options) => url === '/utilities/cover-lookup/gallery'
    ? new Promise(resolve => { settleGallery = resolve; }) : originalFetch(url, options);
  const stale = h.context.refreshCoverLookupGallery(false);
  const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  await h.settle(0);
  await pending;
  settleGallery({ ok: true, json: async () => ({ ok: true, local_covers: [{ candidate_cover_ref: '/A/deleted.jpg' }] }) });
  await stale;
  assert.ok(h.context.state.coverLookup.modal.localCovers.some(card => card.candidate_cover_ref === '/A/settled.jpg'));
  assert.ok(!h.context.state.coverLookup.modal.localCovers.some(card => card.candidate_cover_ref === '/A/deleted.jpg'));
});

test('a successful deletion cannot restore the deleted cover as unknown other art', async () => {
  const h = harness(), a = album('A');
  await h.open(a);

  const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  h.requests[0].resolve({ ok: true, json: async () => ({
    ok: true,
    updated_albums: [{ ...a, cover_ref: '/A/settled.jpg', cover_revision: 'A-settled' }],
    gallery: {
      ok: true,
      local_covers: [{ candidate_cover_ref: '/A/settled.jpg', is_active: true }],
      other_art: [{ candidate_cover_ref: a.cover_ref, resolution: 'Unknown' }],
    },
  }) });
  await pending;

  assert.ok(!h.context.state.coverLookup.modal.localCovers.some(card => card.candidate_cover_ref === a.cover_ref));
  assert.ok(!h.context.state.coverLookup.modal.otherArt.some(card => card.candidate_cover_ref === a.cover_ref));
});

test('immediate notification reopen does not restore deleted selected art from lagging inventory', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  const fallback = { ...a, cover_ref: '/A/source.jpg', cover_revision: 'A-fallback' };
  h.server.set('A', {
    ok: true,
    active_cover_ref: a.cover_ref,
    selected_source_cover_ref: a.cover_ref,
    local_covers: [
      { candidate_cover_ref: a.cover_ref, is_active: true },
      { candidate_cover_ref: fallback.cover_ref, is_active: false },
    ],
  });
  h.requests[0].resolve({ ok: true, json: async () => ({
    ok: true,
    updated_albums: [fallback],
    gallery: clone(h.server.get('A')),
  }) });
  await pending;
  h.context.closeCoverLookupModal();

  await h.open(fallback);

  assert.ok(!h.context.state.coverLookup.modal.localCovers.some(card => card.candidate_cover_ref === a.cover_ref));
  assert.equal(h.context.state.coverLookup.modal.activeLocalSelectionRef, fallback.cover_ref);
});

test('closing without reopening settles the local deletion without a new gallery read', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  h.context.closeCoverLookupModal();
  const reads = h.galleries.length;
  await h.settle(0);
  await pending;
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.galleries.length, reads);
  assert.equal(h.painted.get('A'), 'A-settled');
});

test('Save closes immediately while selected-cover deletion applies its fallback', async () => {
  const h = harness(), a = album('A');
  await h.open(a);

  const deletion = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  assert.equal(h.save.disabled, false, 'the optimistic fallback is immediately actionable');

  await h.context.saveCoverFromLookup();

  assert.equal(h.overlay.hidden, true, 'Save closes without waiting for deletion persistence');
  assert.equal(h.requests.length, 1, 'Save does not overlap the in-flight deletion');
  await h.settle(0);
  await deletion;
});

for (const outcome of ['success', 'error']) {
  test(`same-session local deletion ${outcome} settles cards and releases repeat activation`, async () => {
    const h = harness(), a = album('A');
    await h.open(a);
    const originalCards = clone(h.context.state.coverLookup.modal.localCovers);
    const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
    assert.equal(h.remove.disabled, true);
    await h.settle(0, outcome);
    await pending;
    assert.equal(h.remove.disabled, false);
    if (outcome === 'error') assert.deepEqual(clone(h.context.state.coverLookup.modal.localCovers), originalCards);
    else assert.ok(h.context.state.coverLookup.modal.localCovers.some(card => card.candidate_cover_ref === '/A/settled.jpg'));
    const again = h.context.deleteLocalCoverFromLookup('/A/source.jpg');
    assert.equal(h.requests.length, 2);
    await h.settle(1);
    await again;
  });
}

test('a failed deletion keeps a cover selected while it ran', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  h.context.selectLocalCoverFromLookup('/A/next.jpg');
  await h.settle(0, 'error');
  await pending;
  assert.equal(h.context.state.coverLookup.modal.pendingLocalRef, '/A/next.jpg');
  assert.equal(h.save.disabled, false, 'the preserved draft is ready to Save');
});

test('a reopened reconciliation read cannot overwrite a subsequently admitted local save', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const first = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  h.context.closeCoverLookupModal();
  await h.open(clone(a));
  const originalFetch = h.context.fetch;
  let settleGallery;
  h.context.fetch = (url, options) => url === '/utilities/cover-lookup/gallery'
    ? new Promise(resolve => { settleGallery = resolve; }) : originalFetch(url, options);
  await h.settle(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof settleGallery, 'function');
  const second = h.context.saveLocalCoverFromLookup('/A/newer.jpg');
  assert.equal(h.requests.length, 2);
  const optimistic = h.context.state.coverLookup.optimisticAlbumCovers['/A/track.mp3'];
  settleGallery({ ok: true, json: async () => ({ ok: true, local_covers: [{ candidate_cover_ref: '/A/stale.jpg' }] }) });
  await first;
  // Save closed the modal on click; the stale read must not touch the admitted save.
  assert.equal(h.overlay.hidden, true);
  assert.notDeepEqual(clone(h.context.state.coverLookup.modal.localCovers || []), [{ path: '/A/stale.jpg' }]);
  assert.strictEqual(h.context.state.coverLookup.optimisticAlbumCovers['/A/track.mp3'], optimistic);
  assert.equal(h.context.isCoverLookupMutationPending(a), true);
  await h.settle(1);
  await second;
});

for (const [label, generation, candidates, expected] of [
  ['remapped', 'generation-1', [{ id: 'persisted-choice', url: 'https://example.test/choice.jpg' }], 'persisted-choice'],
  ['temporarily omitted', 'generation-1', [{ id: 'unrelated', url: 'https://example.test/other.jpg' }], 'choice'],
  ['new generation', 'generation-2', [{ id: 'unrelated', url: 'https://example.test/other.jpg' }], 'choice'],
]) {
  test(`reopened authoritative read preserves the candidate owner's ${label} reconciliation`, async () => {
    const h = harness(), a = album('A');
    await h.open(a);
    const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
    h.context.closeCoverLookupModal();
    await h.open(clone(a));
    Object.assign(h.context.state.coverLookup.modal, { candidateGeneration: 'generation-1',
      possibleMatches: [{ id: 'choice', url: 'https://example.test/choice.jpg' }] });
    h.context.selectRemoteCoverFromLookup('choice');
    h.server.set('A', { ok: true, local_covers: [], candidate_snapshot: {
      search_generation: generation, status: 'running', best_candidate_id: candidates[0].id, candidates,
    } });
    h.requests[0].reject(new Error('Deletion failed'));
    await pending;
    assert.equal(h.context.state.coverLookup.modal.selectedRemoteId, expected);
    assert.equal(h.context.state.coverLookup.modal.candidateGeneration, generation);
    if (generation === 'generation-2') {
      assert.equal(h.context.state.coverLookup.modal.remoteSelectionOverrideGeneration, 'generation-1');
    }
  });
}

const generationChoice = generation => ({
  id: `${generation}-choice`,
  url: `https://example.test/${generation}-choice.jpg`,
});

function generationPayload(taskId, status, candidates, bestCandidateId = candidates[0]?.id || '') {
  return {
    task: { id: taskId, status, best_candidate_id: bestCandidateId, possible_matches: candidates },
    candidate_snapshot: {
      search_generation: taskId, status, best_candidate_id: bestCandidateId, candidates,
    },
  };
}

async function openGenerationAWhileBIsRunning(h, a, generationAChoice) {
  const generationA = generationPayload('generation-a-task', 'completed', [generationAChoice]);
  h.server.set('A', { ok: true, local_covers: [], ...generationA });
  await h.open(a);

  const generationBTask = { id: 'generation-b-task', status: 'running', album_payload: a };
  h.context.state.coverLookup.tasks = [generationBTask];
  h.context.state.coverLookup.modal.taskId = generationBTask.id;
  h.server.set('A', {
    ok: true,
    local_covers: [],
    task: generationBTask,
    candidate_snapshot: generationA.candidate_snapshot,
  });
  await h.context.refreshCoverLookupGallery(false);
  assert.equal(h.context.state.coverLookup.tasks[0].status, 'running');
}

test('new task completion suggests its best candidate without selecting it when the user made no explicit choice', async () => {
  const h = harness(), a = album('A');
  a.cover_ref = null;
  a.tracks[0].cover_ref = null;
  await openGenerationAWhileBIsRunning(h, a, generationChoice('generation-a'));
  const generationBChoice = generationChoice('generation-b');
  h.server.set('A', {
    ok: true,
    local_covers: [],
    ...generationPayload('generation-b-task', 'completed', [generationBChoice]),
  });

  await h.context.refreshCoverLookupGallery(false);

  // Owner (11-08): an unsaved automatic pick wears the suggestion frame; nothing reads as "Selected".
  assert.equal(h.context.state.coverLookup.modal.suggestedRemoteId, generationBChoice.id);
  assert.equal(h.context.state.coverLookup.modal.selectedRemoteId, '');
});

test('a retained candidate saves through the generation that published it', async () => {
  const h = harness(), a = album('A');
  const generationAChoice = generationChoice('generation-a');
  await h.open(a);
  h.context.applyCoverLookupCandidateSource({
    generation: 'generation-a-task',
    status: 'completed',
    candidates: [generationAChoice],
  });
  h.context.state.coverLookup.tasks = [{
    id: 'generation-b-task',
    status: 'running',
    album_payload: a,
    possible_matches: [],
  }];
  h.context.state.coverLookup.modal.taskId = 'generation-b-task';
  h.context.applyCoverLookupCandidateSource({
    generation: 'generation-b-task',
    status: 'running',
    candidates: [],
  });

  h.context.selectRemoteCoverFromLookup(generationAChoice.id);
  const pending = h.context.saveCoverFromLookup();

  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].body, {
    album: a,
    task_id: 'generation-a-task',
    candidate_id: generationAChoice.id,
    snapshot_generation: 'generation-a-task',
  });
  h.requests[0].resolve({ ok: true, json: async () => ({ ok: true }) });
  await pending;
});

for (const terminalStatus of ['completed', 'failed']) {
  test(`new task ${terminalStatus} preserves and saves an explicit remote choice from the prior generation`, async () => {
    const h = harness(), a = album('A');
    const generationAChoice = generationChoice('generation-a');
    const generationBChoice = {
      ...generationChoice('generation-b'),
      id: generationAChoice.id,
    };
    await openGenerationAWhileBIsRunning(h, a, generationAChoice);
    h.context.state.coverLookup.tasks[0].possible_matches = [generationBChoice];
    h.context.state.coverLookup.tasks.push({
      id: 'generation-a-task',
      status: 'completed',
      album_payload: a,
      possible_matches: [generationAChoice],
    });
    h.context.state.coverLookup.tasks.unshift({
      id: 'unrelated-album-task',
      status: 'completed',
      album_payload: album('Unrelated'),
      possible_matches: [generationAChoice],
    });
    h.context.state.coverLookup.modal.candidateGeneration = 'generation-a-snapshot';

    h.context.selectRemoteCoverFromLookup(generationAChoice.id);
    assert.equal(
      h.context.state.coverLookup.modal.remoteSelectionOverrideGeneration,
      'generation-a-task',
    );

    h.server.set('A', {
      ok: true,
      local_covers: [],
      ...generationPayload('generation-b-task', terminalStatus, [generationBChoice]),
    });
    await h.context.refreshCoverLookupGallery(false);

    const modal = h.context.state.coverLookup.modal;
    assert.equal(modal.selectedRemoteId, generationAChoice.id);
    assert.ok(modal.possibleMatches.some(candidate => candidate.id === generationAChoice.id));
    assert.equal(
      modal.possibleMatches.find(candidate => candidate.id === generationAChoice.id)?.url,
      generationAChoice.url,
    );
    assert.equal(h.save.disabled, false, 'the preserved prior-generation choice remains saveable');

    await h.context.refreshCoverLookupGallery(false);
    assert.equal(modal.selectedRemoteId, generationAChoice.id);
    assert.ok(modal.possibleMatches.some(candidate => candidate.id === generationAChoice.id));
    assert.equal(
      modal.possibleMatches.find(candidate => candidate.id === generationAChoice.id)?.url,
      generationAChoice.url,
    );
    assert.equal(h.save.disabled, false, 'repeat polling must keep the prior-generation choice saveable');

    const pending = h.context.saveCoverFromLookup();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0].body, {
      album: a,
      task_id: 'generation-a-task',
      candidate_id: generationAChoice.id,
      snapshot_generation: 'generation-a-task',
    });
    h.requests[0].resolve({ ok: true, json: async () => ({ ok: true }) });
    await pending;
  });
}

for (const selectionType of ['local', 'pasted']) {
  for (const terminalStatus of ['completed', 'failed']) {
    test(`new task ${terminalStatus} preserves an explicit ${selectionType} choice from the prior generation`, async () => {
      const h = harness(), a = album('A');
      const generationAChoice = generationChoice('generation-a');
      await openGenerationAWhileBIsRunning(h, a, generationAChoice);
      h.context.state.coverLookup.modal.localCovers = [{ candidate_cover_ref: '/A/next.jpg' }];
      h.context.state.coverLookup.modal.pastedImages = [{ id: 'new-pasted-image' }];
      h.context.selectRemoteCoverFromLookup(generationAChoice.id);

      if (selectionType === 'local') h.context.selectLocalCoverFromLookup('/A/next.jpg');
      else h.context.selectPastedCoverFromLookup('new-pasted-image');
      assert.equal(
        h.context.state.coverLookup.modal.remoteSelectionOverrideGeneration,
        '',
        'a non-remote choice must not retain the prior remote owner reference',
      );

      h.server.set('A', {
        ok: true,
        local_covers: [{ candidate_cover_ref: '/A/next.jpg' }],
        ...generationPayload('generation-b-task', terminalStatus, [generationChoice('generation-b')]),
      });
      await h.context.refreshCoverLookupGallery(false);

      const modal = h.context.state.coverLookup.modal;
      assert.equal(modal.pendingLocalRef, selectionType === 'local' ? '/A/next.jpg' : '');
      assert.equal(modal.pendingPastedImageId, selectionType === 'pasted' ? 'new-pasted-image' : '');
      assert.equal(modal.selectedRemoteId, '', 'terminal task publication must not auto-select remote art');
      assert.equal(h.save.disabled, false, 'the explicit non-remote choice remains saveable');
      assert.equal(h.requests.length, 0, 'preserving a choice must not save it automatically');
    });
  }
}

const unseen = (generation, revision) => ({ search_generation: generation, revision,
  automatic_improvement_revision: revision, seen_automatic_improvement_revision: 0,
  has_unseen_automatic_improvement: true, candidates: [] });
const marked = snapshot => ({ ...snapshot, has_unseen_automatic_improvement: false,
  seen_automatic_improvement_revision: snapshot.automatic_improvement_revision });
function settleSeen(request, snapshot) {
  request.resolve({ ok: true, json: async () => ({ ok: true, candidate_snapshot: marked(snapshot) }) });
}

for (const outcome of ['success', 'error']) {
  test(`mark-seen ${outcome} cannot affect a reopened same album object`, async () => {
    const h = harness(), a = album('A'), first = unseen('generation-1', 1), next = unseen('generation-2', 1);
    a.cover_candidate_snapshot = first;
    await h.open(a);
    h.context.state.coverLookup.modal.candidateSnapshot = first;
    const pending = h.markSeen(first);
    h.context.closeCoverLookupModal();
    await h.open(a);
    h.context.state.coverLookup.modal.candidateSnapshot = next;
    h.context.state.coverLookup.modal.seenCandidateImprovementToken = 'generation-2:1';
    if (outcome === 'success') settleSeen(h.requests[0], first);
    else h.requests[0].reject(new Error('Stale seen failure'));
    await pending;
    assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, next);
    assert.strictEqual(a.cover_candidate_snapshot, first, 'stale same-object owner may not replace resource metadata');
    assert.equal(h.context.state.coverLookup.modal.seenCandidateImprovementToken, 'generation-2:1');
  });
}

for (const [label, next] of [['new revision', unseen('generation-1', 2)], ['new generation', unseen('generation-2', 1)]]) {
  test(`older mark-seen cannot overwrite ${label} after its successful completion`, async () => {
    const h = harness(), a = album('A'), first = unseen('generation-1', 1);
    a.cover_candidate_snapshot = first;
    await h.open(a);
    h.context.state.coverLookup.modal.candidateSnapshot = first;
    const pendingFirst = h.markSeen(first);
    h.context.state.coverLookup.modal.candidateSnapshot = next;
    const pendingNext = h.markSeen(next);
    settleSeen(h.requests[1], next);
    await pendingNext;
    const accepted = h.context.state.coverLookup.modal.candidateSnapshot;
    settleSeen(h.requests[0], first);
    await pendingFirst;
    assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, accepted);
    assert.strictEqual(a.cover_candidate_snapshot, accepted);
    assert.equal(accepted.has_unseen_automatic_improvement, false);
    assert.equal(accepted.search_generation, next.search_generation);
    assert.equal(accepted.revision, next.revision);
  });
}

test('mark-seen completion preserves a newer same-token gallery snapshot', async () => {
  const h = harness(), a = album('A'), first = unseen('generation-1', 1);
  a.cover_candidate_snapshot = first;
  await h.open(a);
  h.context.state.coverLookup.modal.candidateSnapshot = first;
  const pending = h.markSeen(first);
  const newerRead = { ...first, revision: 2, diagnostic: 'new candidates' };
  h.context.state.coverLookup.modal.candidateSnapshot = newerRead;
  settleSeen(h.requests[0], first);
  await pending;
  assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, newerRead);
  assert.strictEqual(a.cover_candidate_snapshot, first);
});

test('mark-seen does not propagate a rebound release snapshot to the historical source album', async () => {
  const h = harness(), a = album('A'), first = unseen('generation-1', 1);
  h.context.getAlbumRequestKey = value => value?.key || '';
  a.key = 'historical-release';
  a.cover_candidate_snapshot = first;
  await h.open(a);
  h.context.state.coverLookup.modal.album.key = 'current-release';
  h.context.state.coverLookup.modal.candidateSnapshot = first;
  const pending = h.markSeen(first);
  settleSeen(h.requests[0], first);
  await pending;
  assert.strictEqual(a.cover_candidate_snapshot, first);
  assert.equal(a.key, 'historical-release');
});

test('mark-seen does not replace a newer snapshot on the hydrated source album', async () => {
  const h = harness(), a = album('A'), first = unseen('generation-1', 1);
  a.cover_candidate_snapshot = first;
  await h.open(a);
  h.context.state.coverLookup.modal.candidateSnapshot = first;
  const pending = h.markSeen(first);
  const next = unseen('generation-2', 2);
  a.cover_candidate_snapshot = next;
  settleSeen(h.requests[0], first);
  await pending;
  assert.strictEqual(a.cover_candidate_snapshot, next);
  assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, first);
});

test('mark-seen may update an unchanged original resource after opening a different album', async () => {
  const h = harness(), a = album('A'), first = unseen('generation-1', 1);
  a.cover_candidate_snapshot = first;
  await h.open(a);
  h.context.state.coverLookup.modal.candidateSnapshot = first;
  const pending = h.markSeen(first);
  h.context.closeCoverLookupModal();
  await h.open(album('B'));
  const bSnapshot = h.context.state.coverLookup.modal.candidateSnapshot;
  settleSeen(h.requests[0], first);
  await pending;
  assert.equal(a.cover_candidate_snapshot.has_unseen_automatic_improvement, false);
  assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, bSnapshot);
  assert.equal(h.context.state.coverLookup.modal.album.name, 'B');
});

test('mark-seen settles an unchanged resource after Close without reopening the modal', async () => {
  const h = harness(), a = album('A'), first = unseen('generation-1', 1);
  a.cover_candidate_snapshot = first;
  await h.open(a);
  h.context.state.coverLookup.modal.candidateSnapshot = first;
  const pending = h.markSeen(first);
  h.context.closeCoverLookupModal();
  settleSeen(h.requests[0], first);
  await pending;
  assert.equal(a.cover_candidate_snapshot.has_unseen_automatic_improvement, false);
  assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, null);
  assert.equal(h.overlay.hidden, true);
});

for (const destination of ['closed A', 'different B']) {
  for (const order of ['older first', 'newer first']) {
    test(`inactive mark-seen resource uses its current request owner: ${destination}, ${order}`, async () => {
      const h = harness(), a = album('A'), first = unseen('generation-1', 1), next = unseen('generation-2', 1);
      a.cover_candidate_snapshot = first;
      await h.open(a);
      h.context.state.coverLookup.modal.candidateSnapshot = first;
      const pendingFirst = h.markSeen(first);
      h.context.state.coverLookup.modal.candidateSnapshot = next;
      const pendingNext = h.markSeen(next);
      h.context.closeCoverLookupModal();
      if (destination === 'different B') await h.open(album('B'));
      if (order === 'older first') {
        settleSeen(h.requests[0], first);
        await pendingFirst;
        settleSeen(h.requests[1], next);
        await pendingNext;
      } else {
        settleSeen(h.requests[1], next);
        await pendingNext;
        settleSeen(h.requests[0], first);
        await pendingFirst;
      }
      assert.equal(a.cover_candidate_snapshot.search_generation, 'generation-2');
      assert.equal(a.cover_candidate_snapshot.has_unseen_automatic_improvement, false);
      assert.strictEqual(h.context.state.coverLookup.modal.candidateSnapshot, null);
    });
  }
}

for (const choice of ['local', 'pasted', 'remote']) {
  for (const galleryMode of ['response gallery', 'fresh gallery fallback']) {
    test(`same-session Delete preserves a newly selected ${choice} draft through ${galleryMode}`, async () => {
      const h = harness(), a = album('A');
      const snapshot = { search_generation: 'draft-generation', revision: 1, status: 'running',
        best_candidate_id: 'choice', candidates: [{ id: 'choice', url: 'https://example.test/choice.jpg' }] };
      h.server.set('A', { ok: true, active_cover_ref: a.cover_ref, selected_source_cover_ref: a.cover_ref,
        local_covers: [{ candidate_cover_ref: a.cover_ref, is_active: true }, { candidate_cover_ref: '/A/fallback.jpg' }, { candidate_cover_ref: '/A/next.jpg' }],
        candidate_snapshot: snapshot });
      await h.open(a);
      h.context.state.coverLookup.modal.pastedImages = [{ id: 'new-pasted-image' }];
      const pending = h.context.deleteLocalCoverFromLookup(a.cover_ref);
      if (choice === 'local') h.context.selectLocalCoverFromLookup('/A/next.jpg');
      else if (choice === 'pasted') h.context.selectPastedCoverFromLookup('new-pasted-image');
      else h.context.selectRemoteCoverFromLookup('choice');
      assert.equal(h.save.disabled, true, 'the new draft waits for the deletion to settle');
      const updated = { ...a, cover_ref: '/A/fallback.jpg', cover_revision: 'after-delete' };
      const gallery = { ok: true, active_cover_ref: updated.cover_ref, selected_source_cover_ref: updated.cover_ref,
        local_covers: [{ candidate_cover_ref: updated.cover_ref, is_active: true }, { candidate_cover_ref: '/A/next.jpg' }],
        candidate_snapshot: { ...snapshot, revision: 2, best_candidate_id: 'persisted-choice',
          candidates: [{ id: 'persisted-choice', url: 'https://example.test/choice.jpg' }] } };
      h.server.set('A', gallery);
      const reads = h.galleries.length;
      h.requests[0].resolve({ ok: true, json: async () => ({ ok: true, updated_albums: [updated],
        ...(galleryMode === 'response gallery' ? { gallery } : {}) }) });
      await pending;
      const modal = h.context.state.coverLookup.modal;
      assert.equal(modal.pendingLocalRef, choice === 'local' ? '/A/next.jpg' : '');
      assert.equal(modal.pendingPastedImageId, choice === 'pasted' ? 'new-pasted-image' : '');
      assert.equal(modal.selectedRemoteId, choice === 'remote' ? 'persisted-choice' : '');
      if (choice === 'remote') assert.equal(modal.remoteSelectionOverrideGeneration, 'draft-generation');
      assert.equal(h.save.disabled, false, 'the preserved draft is ready to Save after release');
      assert.equal(h.galleries.length, reads + (galleryMode === 'fresh gallery fallback' ? 1 : 0));
      assert.equal(h.requests.length, 1, 'preserving a draft must not save it automatically');
      assert.equal(h.painted.get('A'), 'after-delete');
    });
  }
}

test('bounded interaction: a Cover Look Up gallery refresh reads its own album once and renders once beside any number of notifications', async () => {
  const { measureInteractionContract } = require('../helpers/request-capture');
  await measureInteractionContract('js:runtime/cover-lookup-modal-and-drawer.js#refreshCoverLookupGallery', {
    // The library's other work, as the drawer holds it: notification tasks for other albums.
    setup: async (notifications) => {
      const h = harness();
      h.context.state.coverLookup.tasks = Array.from({ length: notifications }, (_value, index) => ({
        id: `task-${index}`, status: 'completed', album_payload: album(`Other ${index}`),
      }));
      const sent = [];
      const fetch = h.context.fetch;
      h.context.fetch = (url, options) => {
        sent.push({ url, method: options?.method || 'GET' });
        return fetch(url, options);
      };
      let renders = 0;
      const render = h.context.renderCoverLookupModal;
      h.context.renderCoverLookupModal = () => { renders += 1; render(); };
      await h.open(album('A'));
      return { h, sent, renders: () => renders };
    },
    act: async ({ h, sent, renders }) => {
      const before = sent.length;
      const rendered = renders();
      await h.context.refreshCoverLookupGallery(false);
      assert.equal(h.context.state.coverLookup.modal.album.name, 'A');
      return { requests: sent.slice(before), metrics: { renderCommits: renders() - rendered } };
    },
  });
});

// Owner (sandbox2): an OTHER ART image chosen as the cover reopened in both sections until a later listing.
// Every render of the reopened lookup shows it once, in LOCAL.
test('an other-art image chosen as the cover reopens only in LOCAL on every render', async () => {
  const h = harness();
  const a = album('A');
  const booklet = { candidate_cover_ref: '/A/booklet.jpg', is_squareish: false, width: 1200, height: 600 };
  h.server.set('A', { ok: true, active_cover_ref: a.cover_ref, selected_source_cover_ref: a.cover_ref,
    local_covers: [{ candidate_cover_ref: a.cover_ref, is_active: true, is_squareish: true }],
    other_art: [booklet] });
  await h.open(a);
  assert.deepEqual(Array.from(h.context.state.coverLookup.modal.otherArt, cover => cover.candidate_cover_ref), [booklet.candidate_cover_ref]);
  h.context.markCoverLookupTaskActionTaken = () => {};
  const saving = h.context.saveLocalCoverFromLookup(booklet.candidate_cover_ref);
  const saved = { ...a, cover_ref: booklet.candidate_cover_ref, cover_revision: 'booklet' };
  h.server.set('A', { ok: true, active_cover_ref: '/A/cover.jpg', selected_source_cover_ref: booklet.candidate_cover_ref,
    local_covers: [{ ...booklet, is_active: true }, { candidate_cover_ref: a.cover_ref, is_active: false, is_squareish: true }],
    other_art: [] });
  h.requests[0].resolve({ ok: true, json: async () => ({ ok: true, updated_albums: [saved] }) });
  await saving;

  const renders = [];
  h.context.renderCoverLookupModal = () => {
    const modal = h.context.state.coverLookup.modal;
    const count = list => (list || []).filter(cover => cover.candidate_cover_ref === booklet.candidate_cover_ref).length;
    renders.push({ local: count(modal.localCovers), other: count(modal.otherArt) });
  };
  await h.open(saved);
  await nextTurn();
  assert.ok(renders.length > 1, 'the reopening renders from its cache and then from the server');
  assert.deepEqual(renders.filter(render => render.local !== 1 || render.other !== 0), [], JSON.stringify(renders));
});

// Owner (sandbox2): deleting the selected cover brought it back into the window. A listing that answers while
// the delete is in flight never restores it, and the selection is on the fallback from the first render.
test('a deleted selected cover never reappears while its delete is in flight', async () => {
  const h = harness();
  const a = album('A');
  const listing = { ok: true, active_cover_ref: a.cover_ref, selected_source_cover_ref: a.cover_ref,
    local_covers: [{ candidate_cover_ref: a.cover_ref, is_active: true, is_squareish: true },
      { candidate_cover_ref: '/A/second.jpg', is_squareish: true }, { candidate_cover_ref: '/A/third.jpg', is_squareish: true }] };
  h.server.set('A', listing);
  await h.open(a);
  const renders = [];
  h.context.renderCoverLookupModal = () => {
    const modal = h.context.state.coverLookup.modal;
    renders.push({
      deletedShown: (modal.localCovers || []).some(cover => cover.candidate_cover_ref === a.cover_ref),
      selected: String(modal.pendingLocalRef || modal.activeLocalSelectionRef || ''),
    });
  };
  const deleting = h.context.deleteLocalCoverFromLookup(a.cover_ref);
  await nextTurn();
  // The folder index has not caught up yet: a refresh still lists the deleted file.
  await h.context.refreshCoverLookupGallery(false);
  const deleteRequest = h.requests.find(request => request.url === '/utilities/cover-lookup/local-delete');
  assert.equal(deleteRequest.body.next_cover_ref, '/A/second.jpg', 'the server selects the card the lookup shows selected');
  const afterDelete = { ok: true, active_cover_ref: '/A/second.jpg', selected_source_cover_ref: '/A/second.jpg',
    local_covers: [{ candidate_cover_ref: '/A/second.jpg', is_active: true, is_squareish: true },
      { candidate_cover_ref: '/A/third.jpg', is_squareish: true }] };
  h.server.set('A', afterDelete);
  deleteRequest.resolve({ ok: true, json: async () => ({ ok: true,
    updated_albums: [{ ...a, cover_ref: '/A/second.jpg' }], gallery: afterDelete }) });
  await deleting;
  assert.ok(renders.length >= 3, JSON.stringify(renders));
  assert.deepEqual(renders.filter(render => render.deletedShown), [], JSON.stringify(renders));
  assert.deepEqual([...new Set(renders.map(render => render.selected))], ['/A/second.jpg'], JSON.stringify(renders));
});
