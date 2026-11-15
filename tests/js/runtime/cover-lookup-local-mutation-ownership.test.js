const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const clone = value => JSON.parse(JSON.stringify(value));
const album = name => ({ name, cover_path: `/${name}/cover.jpg`, cover_revision: `${name}-old`,
  tracks: [{ path: `/${name}/track.mp3`, cover_path: `/${name}/cover.jpg` }] });

function harness() {
  class Button { disabled = false; hidden = false; textContent = ''; }
  const save = new Button(), remove = new Button();
  const overlay = { hidden: true, querySelectorAll: () => [remove] };
  const confirm = { hidden: true, style: {} };
  const requests = [], galleries = [], notifications = [], painted = new Map(), server = new Map();
  const context = vm.createContext({
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
  context.loadCoverLookupTasks = async () => {};
  const markSeen = context.markCoverLookupAutomaticImprovementSeen;
  context.markCoverLookupAutomaticImprovementSeen = async () => {};
  context.syncCoverLookupSelectionUi = () => context.syncCoverLookupSaveButton();
  context.refreshCoverLookupAlbumArtwork = (_original, updated) => updated.forEach(value => painted.set(value.name, value.cover_revision));
  const setGallery = (value, suffix = 'fresh') => server.set(value.name, { ok: true,
    active_cover_path: value.cover_path, selected_source_path: value.cover_path,
    local_covers: [{ path: value.cover_path, is_active: true, cover_revision: value.cover_revision },
      { path: `/${value.name}/${suffix}.jpg` }] });
  const open = async value => {
    if (!server.has(value.name)) setGallery(value, 'source');
    await context.openCoverLookupModal(value);
  };
  const settle = async (index, outcome = 'success', includeGallery = true) => {
    const request = requests[index];
    const value = { ...request.body.album, cover_path: `/${request.body.album.name}/settled.jpg`, cover_revision: `${request.body.album.name}-settled` };
    if (outcome === 'error') request.reject(new Error('Owned local mutation failed'));
    else {
      setGallery(value);
      request.resolve({ ok: true, json: async () => ({ ok: true, updated_albums: [value],
        ...(includeGallery ? { gallery: clone(server.get(value.name)) } : {}) }) });
    }
    return value;
  };
  const draft = name => Object.assign(context.state.coverLookup.modal, {
    pendingLocalPath: `/${name}/draft.jpg`, pendingPastedImageId: `${name}-pasted`, selectedRemoteId: `${name}-remote`,
    remoteSelectionOverrideGeneration: `${name}-generation`, remoteSelectionOverrideCandidateId: `${name}-remote`,
    remoteSelectionOverrideUrl: `https://example.test/${name}`, manualUrlText: `${name} manual draft`,
  });
  const selection = () => {
    const m = context.state.coverLookup.modal;
    return [m.pendingLocalPath, m.pendingPastedImageId, m.selectedRemoteId,
      m.remoteSelectionOverrideGeneration, m.remoteSelectionOverrideCandidateId, m.remoteSelectionOverrideUrl, m.manualUrlText];
  };
  return { context, markSeen, open, settle, draft, selection, save, remove, overlay, confirm, requests, galleries, notifications, painted, server };
}

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
    const pending = h.context.deleteLocalCoverFromLookup(a.cover_path);
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
    test(`${mutation} ${outcome} keeps reopened same-album mutations exclusive, then releases its draft`, async () => {
      const h = harness(), a = album('A');
      await h.open(a);
      const pending = mutation === 'save'
        ? h.context.saveLocalCoverFromLookup('/A/source.jpg')
        : h.context.deleteLocalCoverFromLookup(a.cover_path);
      h.context.closeCoverLookupModal();
      await h.open(clone(a));
      h.draft('A');
      h.context.syncCoverLookupSaveButton();
      const selected = h.selection();
      assert.equal(h.save.disabled, true);
      assert.equal(h.remove.disabled, true);
      h.context.openCoverLookupDeleteConfirm('/A/source.jpg');
      assert.equal(h.confirm.hidden, true, 'native delete confirmation is blocked while the claim is active');
      const denied = [h.context.saveLocalCoverFromLookup('/A/newer.jpg'),
        h.context.deleteLocalCoverFromLookup('/A/newer.jpg'), h.context.saveCoverFromLookup()];
      assert.equal(h.requests.length, 1, 'no overlapping same-album mutation may reach the server');
      await Promise.all(denied);
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
      assert.ok(h.context.state.coverLookup.modal.localCovers.some(card => card.path === (outcome === 'success' ? '/A/settled.jpg' : '/A/cover.jpg')));
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
    assert.equal(h.context.state.coverLookup.modal.saving, true);
    assert.equal(h.context.isCoverLookupLocalMutationPending(), true);
    assert.equal(h.save.disabled, true);
    assert.equal(h.overlay.hidden, false);
    assert.strictEqual(h.context.state.coverLookup.optimisticAlbumCovers['/B/track.mp3'], optimistic);
    assert.equal(h.context.state.coverRefreshTokens['/B/source.jpg'], token);
    await h.settle(1);
    await second;
    assert.equal(h.context.state.coverLookup.modal.saving, false);
    assert.equal(h.context.isCoverLookupLocalMutationPending(), false);
    assert.equal(h.painted.get('B'), 'B-settled');
  });
}

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
  const denied = h.context.deleteLocalCoverFromLookup('/A/source.jpg');
  assert.equal(h.requests.length, 1);
  await denied;
  finishPreload(true);
  await pending;
  h.context.applyOptimisticLocalCoverSelection = () => { throw new Error('Setup failed'); };
  await h.context.saveLocalCoverFromLookup('/A/newer.jpg');
  assert.equal(h.context.state.coverLookup.modal.saving, false);
  assert.equal(h.context.isCoverLookupLocalMutationPending(), false);
  assert.equal(h.remove.disabled, false);
  assert.equal(h.notifications.at(-1)[1], 'error');
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
  assert.equal(h.context.isCoverLookupLocalMutationPending(), false);
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
  const pending = h.context.deleteLocalCoverFromLookup(a.cover_path);
  await h.settle(0);
  await pending;
  settleGallery({ ok: true, json: async () => ({ ok: true, local_covers: [{ path: '/A/deleted.jpg' }] }) });
  await stale;
  assert.ok(h.context.state.coverLookup.modal.localCovers.some(card => card.path === '/A/settled.jpg'));
  assert.ok(!h.context.state.coverLookup.modal.localCovers.some(card => card.path === '/A/deleted.jpg'));
});

test('closing without reopening settles the local deletion without a new gallery read', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const pending = h.context.deleteLocalCoverFromLookup(a.cover_path);
  h.context.closeCoverLookupModal();
  const reads = h.galleries.length;
  await h.settle(0);
  await pending;
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.galleries.length, reads);
  assert.equal(h.painted.get('A'), 'A-settled');
});

for (const outcome of ['success', 'error']) {
  test(`same-session local deletion ${outcome} settles cards and releases repeat activation`, async () => {
    const h = harness(), a = album('A');
    await h.open(a);
    const originalCards = clone(h.context.state.coverLookup.modal.localCovers);
    const pending = h.context.deleteLocalCoverFromLookup(a.cover_path);
    assert.equal(h.remove.disabled, true);
    await h.settle(0, outcome);
    await pending;
    assert.equal(h.remove.disabled, false);
    if (outcome === 'error') assert.deepEqual(clone(h.context.state.coverLookup.modal.localCovers), originalCards);
    else assert.ok(h.context.state.coverLookup.modal.localCovers.some(card => card.path === '/A/settled.jpg'));
    const again = h.context.deleteLocalCoverFromLookup('/A/source.jpg');
    assert.equal(h.requests.length, 2);
    await h.settle(1);
    await again;
  });
}

test('a reopened reconciliation read cannot overwrite a subsequently admitted local save', async () => {
  const h = harness(), a = album('A');
  await h.open(a);
  const first = h.context.deleteLocalCoverFromLookup(a.cover_path);
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
  const cards = clone(h.context.state.coverLookup.modal.localCovers);
  const optimistic = h.context.state.coverLookup.optimisticAlbumCovers['/A/track.mp3'];
  settleGallery({ ok: true, json: async () => ({ ok: true, local_covers: [{ path: '/A/stale.jpg' }] }) });
  await first;
  assert.deepEqual(clone(h.context.state.coverLookup.modal.localCovers), cards);
  assert.strictEqual(h.context.state.coverLookup.optimisticAlbumCovers['/A/track.mp3'], optimistic);
  assert.equal(h.context.state.coverLookup.modal.saving, true);
  assert.equal(h.context.isCoverLookupLocalMutationPending(), true);
  assert.equal(h.save.disabled, true);
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
    const pending = h.context.deleteLocalCoverFromLookup(a.cover_path);
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

test('new task completion auto-selects its best candidate when the user made no explicit choice', async () => {
  const h = harness(), a = album('A');
  a.cover_path = null;
  a.tracks[0].cover_path = null;
  await openGenerationAWhileBIsRunning(h, a, generationChoice('generation-a'));
  const generationBChoice = generationChoice('generation-b');
  h.server.set('A', {
    ok: true,
    local_covers: [],
    ...generationPayload('generation-b-task', 'completed', [generationBChoice]),
  });

  await h.context.refreshCoverLookupGallery(false);

  assert.equal(h.context.state.coverLookup.modal.selectedRemoteId, generationBChoice.id);
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
      h.context.state.coverLookup.modal.localCovers = [{ path: '/A/next.jpg' }];
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
        local_covers: [{ path: '/A/next.jpg' }],
        ...generationPayload('generation-b-task', terminalStatus, [generationChoice('generation-b')]),
      });
      await h.context.refreshCoverLookupGallery(false);

      const modal = h.context.state.coverLookup.modal;
      assert.equal(modal.pendingLocalPath, selectionType === 'local' ? '/A/next.jpg' : '');
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
      h.server.set('A', { ok: true, active_cover_path: a.cover_path, selected_source_path: a.cover_path,
        local_covers: [{ path: a.cover_path, is_active: true }, { path: '/A/fallback.jpg' }, { path: '/A/next.jpg' }],
        candidate_snapshot: snapshot });
      await h.open(a);
      h.context.state.coverLookup.modal.pastedImages = [{ id: 'new-pasted-image' }];
      const pending = h.context.deleteLocalCoverFromLookup(a.cover_path);
      if (choice === 'local') h.context.selectLocalCoverFromLookup('/A/next.jpg');
      else if (choice === 'pasted') h.context.selectPastedCoverFromLookup('new-pasted-image');
      else h.context.selectRemoteCoverFromLookup('choice');
      assert.equal(h.save.disabled, true, 'the new draft waits for the deletion to settle');
      const updated = { ...a, cover_path: '/A/fallback.jpg', cover_revision: 'after-delete' };
      const gallery = { ok: true, active_cover_path: updated.cover_path, selected_source_path: updated.cover_path,
        local_covers: [{ path: updated.cover_path, is_active: true }, { path: '/A/next.jpg' }],
        candidate_snapshot: { ...snapshot, revision: 2, best_candidate_id: 'persisted-choice',
          candidates: [{ id: 'persisted-choice', url: 'https://example.test/choice.jpg' }] } };
      h.server.set('A', gallery);
      const reads = h.galleries.length;
      h.requests[0].resolve({ ok: true, json: async () => ({ ok: true, updated_albums: [updated],
        ...(galleryMode === 'response gallery' ? { gallery } : {}) }) });
      await pending;
      const modal = h.context.state.coverLookup.modal;
      assert.equal(modal.pendingLocalPath, choice === 'local' ? '/A/next.jpg' : '');
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
