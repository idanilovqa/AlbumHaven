const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname,
  '../../../music_app/static/js/runtime/cover-lookup-modal-and-drawer.js',
);

function loadRuntime() {
  const context = {
    document: { getElementById: () => null },
    window: {},
    state: {
      coverLookup: {
        modal: {
          orderedCoverSelections: [],
          orderedSelectionMode: false,
        },
      },
    },
    console,
    URLSearchParams,
    escapeHtml: (value) => String(value ?? ''),
    buildCoverUrl: (value) => `/cover?path=${encodeURIComponent(value)}`,
    ButtonComponent: { renderActionButton: () => '' },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return context;
}

const local = (name) => ({
  key: `local:C:/Music/Album/${name}.jpg`,
  reference: { kind: 'local', path: `C:/Music/Album/${name}.jpg` },
});

require('node:test')('normal selection keeps one checked cover', () => {
  const context = loadRuntime();

  context.applyCoverLookupSelectionIntent(local('front'));
  context.applyCoverLookupSelectionIntent(local('back'));

  assert.equal(context.state.coverLookup.modal.orderedSelectionMode, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections)),
    [local('back')],
  );
});

require('node:test')('holding the checked cover enters and exits numbered mode', () => {
  const context = loadRuntime();

  context.applyCoverLookupSelectionIntent(local('front'));
  assert.equal(context.applyCoverLookupSelectionIntent(local('front'), { held: true }), true);
  assert.equal(context.state.coverLookup.modal.orderedSelectionMode, true);

  assert.equal(context.applyCoverLookupSelectionIntent(local('front'), { held: true }), true);
  assert.equal(context.state.coverLookup.modal.orderedSelectionMode, false);
  assert.equal(context.state.coverLookup.modal.orderedCoverSelections.length, 1);
});

require('node:test')('numbered selection caps at three and renumbers after removal', () => {
  const context = loadRuntime();
  const front = local('front');
  const back = local('back');
  const booklet = local('booklet');
  const insert = local('insert');

  context.applyCoverLookupSelectionIntent(front);
  context.applyCoverLookupSelectionIntent(front, { held: true });
  context.applyCoverLookupSelectionIntent(back);
  context.applyCoverLookupSelectionIntent(booklet);

  assert.equal(context.applyCoverLookupSelectionIntent(insert), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections.map((item) => item.key))),
    [front.key, back.key, booklet.key],
  );

  assert.equal(context.applyCoverLookupSelectionIntent(back), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections.map((item) => item.key))),
    [front.key, booklet.key],
  );
  assert.equal(context.applyCoverLookupSelectionIntent(front), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections.map((item) => item.key))),
    [booklet.key],
  );
  assert.equal(context.applyCoverLookupSelectionIntent(booklet), false);
  assert.equal(context.state.coverLookup.modal.orderedCoverSelections.length, 1);
});

require('node:test')('loading saved covers keeps server order and opaque save references', async () => {
  const context = loadRuntime();
  const album = { album_id: 72 };
  context.fetch = async (url) => {
    assert.equal(url, '/albums/72/selected-covers');
    return {
      ok: true,
      json: async () => ({
        ok: true,
        selected_covers_revision: 7,
        current_cover_token: 'a'.repeat(64),
        selected_covers: [
          { selection_id: 'front', kind: 'local', path: 'C:/Music/Album/front.jpg' },
          {
            selection_id: 'remote',
            kind: 'remote',
            candidate_id: 'candidate-2',
            candidate_generation: '5eb06241-b890-41ac-9df4-2f2f51b91f1c',
            url: 'https://images.example/cover.jpg',
          },
        ],
      }),
    };
  };

  assert.equal(await context.loadOrderedCoverSelectionForAlbum(album), true);
  assert.equal(context.state.coverLookup.modal.orderedCoversRevision, 7);
  assert.equal(context.state.coverLookup.modal.currentCoverToken, 'a'.repeat(64));
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections)),
    [
      { key: 'local:C:/Music/Album/front.jpg', reference: { selection_id: 'front' } },
      { key: 'remote:candidate-2', reference: { selection_id: 'remote' } },
    ],
  );
  assert.equal(context.state.coverLookup.modal.orderedSelectionMode, true);
});

require('node:test')('ordered Save sends revision and reuses its mutation UUID after an uncertain response', async () => {
  const context = loadRuntime();
  const calls = [];
  let attempt = 0;
  context.crypto = { randomUUID: () => '1d7ddf55-2af0-4fea-83a2-18b73398a89a' };
  context.showToast = () => {};
  context.closeCoverLookupModal = () => {};
  context.state.coverLookup.modal = {
    album: {
      album_id: 72,
      selected_covers_album_id: 72,
      selected_covers_library_id: 23,
    },
    orderedCoversRevision: 4,
    orderedCoverSelections: [
      local('front'),
      {
        key: 'remote:candidate-2',
        reference: {
          kind: 'remote',
          candidate_id: 'candidate-2',
          candidate_generation: '5eb06241-b890-41ac-9df4-2f2f51b91f1c',
        },
      },
    ],
    saving: false,
  };
  context.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    assert.equal(context.state.coverLookup.modal.album.selected_covers_loaded, true);
    assert.equal(context.state.coverLookup.modal.album.selected_covers.length, 2);
    attempt += 1;
    if (attempt === 1) {
      return {
        ok: false,
        json: async () => ({
          ok: false,
          persisted: null,
          error: 'Save confirmation was interrupted. Retry the same request to check its outcome.',
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        selected_covers_revision: 5,
        selected_covers: [
          { selection_id: 'front-id', kind: 'local' },
          { selection_id: 'remote-id', kind: 'remote' },
        ],
      }),
    };
  };

  assert.equal(await context.saveOrderedCoverSelection(), false);
  assert.equal(context.state.coverLookup.modal.album.selected_covers_loaded, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.coverLookup.modal.album.selected_covers)), []);
  assert.equal(context.state.coverLookup.modal.orderedCoverMutationId, calls[0].body.mutation_id);
  assert.equal(await context.saveOrderedCoverSelection(), true);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/albums/72/selected-covers');
  assert.deepEqual(calls[0].body, {
    expected_revision: 4,
    mutation_id: '1d7ddf55-2af0-4fea-83a2-18b73398a89a',
    references: [
      { kind: 'local', path: 'C:/Music/Album/front.jpg' },
      {
        kind: 'remote',
        candidate_id: 'candidate-2',
        candidate_generation: '5eb06241-b890-41ac-9df4-2f2f51b91f1c',
      },
    ],
  });
  assert.equal(calls[1].body.mutation_id, calls[0].body.mutation_id);
  assert.equal(context.state.coverLookup.modal.orderedCoversRevision, 5);
  assert.equal(context.state.coverLookup.modal.orderedCoverMutationId, '');
  assert.deepEqual(
    context.state.coverLookup.modal.album.selected_covers.map((item) => item.image_url),
    [
      '/cover?library_id=23&album_id=72&selection_id=front-id',
      '/cover?library_id=23&album_id=72&selection_id=remote-id',
    ],
  );
});

require('node:test')('Cover Lookup cards show saved order and dim only unselected cards at the limit', () => {
  const context = loadRuntime();
  context.state.coverLookup.modal = {
    orderedSelectionMode: true,
    orderedCoverSelections: [local('front'), local('back'), local('booklet')],
    selectedRemoteId: '',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    activeLocalSelectionPath: '',
    localCovers: [],
    otherArt: [],
  };

  const selected = context.buildCoverLookupCard({ path: 'C:/Music/Album/front.jpg' });
  const limited = context.buildCoverLookupCard({ path: 'C:/Music/Album/insert.jpg' });

  assert.match(selected, /data-cover-selection-key="local:C:\/Music\/Album\/front\.jpg"/);
  assert.match(selected, /cover-lookup-art-check[^>]*>1</);
  assert.doesNotMatch(selected, /is-selection-limited/);
  assert.match(limited, /is-selection-limited/);
  assert.match(limited, /aria-disabled="true"/);
  assert.match(limited, /tabindex="-1"/);
  assert.doesNotMatch(limited, /cover-lookup-art-check/);
});

require('node:test')('existing local and remote card actions produce backend reference selectors', () => {
  const context = loadRuntime();
  context.state.coverLookup.modal = {
    orderedCoverSelections: [],
    orderedSelectionMode: false,
    possibleMatches: [{
      id: 'candidate-2',
      display_only: false,
      _coverLookupGeneration: '5eb06241-b890-41ac-9df4-2f2f51b91f1c',
      url: 'https://images.example/cover.jpg',
    }],
    localCovers: [],
    otherArt: [],
  };

  context.selectLocalCoverFromLookup('C:/Music/Album/front.jpg');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections)),
    [local('front')],
  );

  context.selectRemoteCoverFromLookup('candidate-2');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections)),
    [{
      key: 'remote:candidate-2',
      reference: {
        kind: 'remote',
        candidate_id: 'candidate-2',
        candidate_generation: '5eb06241-b890-41ac-9df4-2f2f51b91f1c',
      },
    }],
  );
});

require('node:test')('footer Save uses ordered persistence when the reference list changed', async () => {
  const context = loadRuntime();
  let ordered = 0;
  let legacy = 0;
  context.state.coverLookup.modal = {
    orderedCoverSelections: [local('front')],
    orderedCoverBaseline: '[]',
    pendingPastedImageId: '',
    pendingLocalPath: 'C:/Music/Album/front.jpg',
    selectedRemoteId: '',
  };
  context.saveOrderedCoverSelection = async () => { ordered += 1; };
  context.saveLocalCoverFromLookup = async () => { legacy += 1; };

  await context.saveCoverFromLookup();

  assert.equal(ordered, 1);
  assert.equal(legacy, 0);
});

require('node:test')('loaded ordered selection never falls through to stale legacy selection state', async () => {
  const context = loadRuntime();
  let legacy = 0;
  const front = local('front');
  context.state.coverLookup.modal = {
    orderedSelectionLoaded: true,
    orderedCoverSelections: [front],
    orderedCoverBaseline: context.orderedCoverSelectionSignature([front]),
    pendingPastedImageId: '',
    pendingLocalPath: front.reference.path,
    selectedRemoteId: 'stale-candidate',
  };
  context.saveLocalCoverFromLookup = async () => { legacy += 1; };
  context.saveRemoteCoverFromLookup = async () => { legacy += 1; };

  await context.saveCoverFromLookup();

  assert.equal(legacy, 0);
});

require('node:test')('selection sync numbers selected cards and marks only remaining cards limited', () => {
  const createCard = (key) => {
    const classes = new Set();
    let check = null;
    const preview = { appendChild(value) { check = value; } };
    const label = { textContent: '' };
    return {
      classes,
      getAttribute(name) { return name === 'data-cover-selection-key' ? key : ''; },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); } },
      querySelector(selector) {
        if (selector === '.cover-lookup-art-check') return check;
        if (selector === '.cover-lookup-art-preview') return preview;
        if (selector === '.cover-lookup-art-action-label') return label;
        return null;
      },
      label,
      get check() { return check; },
    };
  };
  const selected = createCard(local('front').key);
  const limited = createCard(local('insert').key);
  const modal = {
    hidden: false,
    querySelectorAll(selector) {
      return selector === '[data-cover-selection-key]' ? [selected, limited] : [];
    },
  };
  const context = loadRuntime();
  context.document = {
    getElementById: (id) => id === 'cover-lookup-modal' ? modal : null,
    createElement: () => ({ className: '', innerHTML: '', remove() {} }),
  };
  context.state.coverLookup.modal = {
    orderedSelectionMode: true,
    orderedCoverSelections: [local('front'), local('back'), local('booklet')],
  };

  context.syncCoverLookupSelectionUi();

  assert.equal(selected.check.innerHTML, '1');
  assert.equal(selected.classes.has('is-active'), true);
  assert.equal(selected.classes.has('is-selection-limited'), false);
  assert.equal(selected.label.textContent, 'Selected 1');
  assert.equal(limited.check, null);
  assert.equal(limited.classes.has('is-selection-limited'), true);
  assert.equal(limited.attributes['aria-disabled'], 'true');
  assert.equal(limited.attributes.tabindex, '-1');
});

require('node:test')('selection limit uses the card-local disabled treatment', () => {
  const css = fs.readFileSync(path.join(
    __dirname,
    '../../../music_app/static/css/runtime/cover-lookup-modal.css',
  ), 'utf8');
  assert.match(
    css,
    /\.cover-lookup-art-card\.is-selection-limited\s*\{[^}]*opacity:\s*0\.38;[^}]*filter:\s*grayscale\(0\.85\)[^}]*cursor:\s*not-allowed;[^}]*\}/s,
  );
});

require('node:test')('saved ordered covers seed synchronously before the refresh request', () => {
  const context = loadRuntime();
  const album = {
    selected_covers_loaded: true,
    selected_covers_revision: 9,
    selected_covers: [
      { selection_id: 'front', kind: 'local', path: 'C:/Music/Album/front.jpg', image_url: '/cover/front' },
      { selection_id: 'back', kind: 'local', path: 'C:/Music/Album/back.jpg', image_url: '/cover/back' },
    ],
  };

  assert.equal(context.seedOrderedCoverSelectionFromAlbum(album), true);
  assert.equal(context.state.coverLookup.modal.orderedSelectionLoaded, true);
  assert.equal(context.state.coverLookup.modal.orderedCoversRevision, 9);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections.map(item => item.reference))),
    [{ selection_id: 'front' }, { selection_id: 'back' }],
  );
});

require('node:test')('Save enables only when ordered references change', () => {
  const context = loadRuntime();
  const saveButton = {};
  const front = local('front');
  const back = local('back');
  context.document = {
    getElementById: (id) => (id === 'cover-lookup-save-remote-button' ? saveButton : null),
  };
  context.getCoverLookupModalElements = () => ({ overlay: { querySelectorAll: () => [] } });
  context.isCoverLookupLocalMutationPending = () => false;
  context.hasPendingLocalCoverSelection = () => false;
  context.state.coverLookup.tasks = [];
  Object.assign(context.state.coverLookup.modal, {
    orderedCoverSelections: [front],
    orderedCoverBaseline: context.orderedCoverSelectionSignature([front]),
    orderedSelectionMode: false,
    selectedRemoteId: '',
    pendingPastedImageId: '',
    saving: false,
  });

  context.syncCoverLookupSaveButton();
  assert.equal(saveButton.disabled, true);
  context.state.coverLookup.modal.orderedSelectionMode = true;
  context.syncCoverLookupSaveButton();
  assert.equal(saveButton.disabled, true);
  context.state.coverLookup.modal.orderedCoverSelections = [front, back];
  context.syncCoverLookupSaveButton();
  assert.equal(saveButton.disabled, false);
});

require('node:test')('loaded ordered selection ignores stale legacy dirty flags', () => {
  const context = loadRuntime();
  const saveButton = {};
  const front = local('front');
  context.document = {
    getElementById: (id) => (id === 'cover-lookup-save-remote-button' ? saveButton : null),
  };
  context.getCoverLookupModalElements = () => ({ overlay: { querySelectorAll: () => [] } });
  context.isCoverLookupLocalMutationPending = () => false;
  context.hasPendingLocalCoverSelection = () => true;
  context.state.coverLookup.tasks = [];
  Object.assign(context.state.coverLookup.modal, {
    orderedSelectionLoaded: true,
    orderedCoverSelections: [front],
    orderedCoverBaseline: context.orderedCoverSelectionSignature([front]),
    selectedRemoteId: 'stale-candidate',
    pendingPastedImageId: '',
    saving: false,
  });

  context.syncCoverLookupSaveButton();

  assert.equal(saveButton.disabled, true);
});

require('node:test')('holding a nested preview control does not change ordered selection', () => {
  const listeners = {};
  const card = {
    classList: { contains: () => true },
    getAttribute: () => local('front').key,
  };
  const previewButton = {
    closest(selector) {
      return selector === '[data-cover-selection-key]' ? card : previewButton;
    },
  };
  const overlay = {
    dataset: {},
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const context = loadRuntime();
  let timerStarted = false;
  context.window.setTimeout = () => { timerStarted = true; };
  context.window.clearTimeout = () => {};

  context.bindCoverLookupOrderedSelectionHold(overlay);
  listeners.pointerdown({
    button: 0,
    isPrimary: true,
    pointerId: 2,
    clientX: 10,
    clientY: 10,
    target: previewButton,
  });

  assert.equal(timerStarted, false);
  assert.deepEqual(context.state.coverLookup.modal.orderedCoverSelections, []);
});

require('node:test')('holding an active legacy cover seeds numbered mode with retain-current authority', () => {
  const listeners = {};
  const card = {
    classList: { contains: (name) => name === 'is-active' },
    getAttribute(name) {
      return ({
        'data-cover-selection-key': 'local:C:/Music/Album/front.jpg',
        'data-select-local-cover': 'C:/Music/Album/front.jpg',
      })[name] || '';
    },
  };
  const overlay = {
    dataset: {},
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const context = loadRuntime();
  context.window.setTimeout = (callback) => { callback(); return 1; };
  context.window.clearTimeout = () => {};
  context.state.coverLookup.modal = {
    currentCoverToken: 'a'.repeat(64),
    orderedCoverSelections: [],
    orderedSelectionMode: false,
  };

  context.bindCoverLookupOrderedSelectionHold(overlay);
  listeners.pointerdown({
    button: 0,
    isPrimary: true,
    pointerId: 4,
    clientX: 10,
    clientY: 10,
    target: {
      closest: (selector) => (selector === '[data-cover-selection-key]' ? card : null),
    },
  });

  assert.equal(context.state.coverLookup.modal.orderedSelectionMode, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.modal.orderedCoverSelections)),
    [{
      key: 'local:C:/Music/Album/front.jpg',
      reference: { retain_current: true, expected_primary: 'a'.repeat(64) },
    }],
  );
  assert.equal(context.consumeCoverLookupHeldSelectionClick(card), true);
  assert.equal(context.consumeCoverLookupHeldSelectionClick(card), false);
});

require('node:test')('keyboard hold does not swallow the next intentional card activation', () => {
  const listeners = {};
  const card = {
    classList: { contains: (name) => name === 'is-active' },
    getAttribute: () => local('front').key,
    click() {},
  };
  const overlay = {
    dataset: {},
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const context = loadRuntime();
  context.window.setTimeout = (callback) => { callback(); return 1; };
  context.window.clearTimeout = () => {};
  context.state.coverLookup.modal = {
    orderedCoverSelections: [local('front')],
    orderedSelectionMode: false,
    suppressOrderedSelectionClickKey: '',
  };
  const event = {
    key: ' ',
    repeat: false,
    preventDefault() {},
    target: { closest: (selector) => (selector === '[data-cover-selection-key]' ? card : null) },
  };

  context.bindCoverLookupOrderedSelectionHold(overlay);
  listeners.keydown(event);
  listeners.keyup(event);

  assert.equal(context.state.coverLookup.modal.orderedSelectionMode, true);
  assert.equal(context.state.coverLookup.modal.suppressOrderedSelectionClickKey, '');
});

require('node:test')('a saved canonical cover answers on the source card the gallery shows for it', () => {
  // Owner 2026-11-15 (Dragonland, Holy War): 3 covers selected, but Cover Look Up showed
  // no #1. Saved #1 was cover.jpg, a byte copy of Covers/Front.jpg that the gallery hides.
  const context = loadRuntime();
  const modal = context.state.coverLookup.modal;
  const saved = [
    { selection_id: 'one', kind: 'local', path: 'C:/Music/Album/cover.jpg' },
    { selection_id: 'two', kind: 'local', path: 'C:/Music/Album/cover-existing-1.jpg' },
  ];
  context.seedOrderedCoverSelectionFromAlbum({ selected_covers_loaded: true, selected_covers: saved });
  context.applyCoverLookupGalleryPayload({
    active_cover_path: 'C:/Music/Album/cover.jpg',
    selected_source_path: 'C:/Music/Album/Covers/Front.jpg',
    local_covers: [
      { path: 'C:/Music/Album/cover.jpg', is_active: true },
      { path: 'C:/Music/Album/Covers/Front.jpg' },
      { path: 'C:/Music/Album/cover-existing-1.jpg' },
    ],
    other_art: [],
  });

  assert.deepEqual(modal.localCovers.map((cover) => cover.path),
    ['C:/Music/Album/Covers/Front.jpg', 'C:/Music/Album/cover-existing-1.jpg']);
  assert.deepEqual(modal.orderedCoverSelections.map((item) => item.key),
    ['local:C:/Music/Album/Covers/Front.jpg', 'local:C:/Music/Album/cover-existing-1.jpg']);
  // Unchanged references: Save is not offered for a selection the owner did not change.
  assert.equal(context.orderedCoverSelectionSignature(modal.orderedCoverSelections), modal.orderedCoverBaseline);
  // #1 can be unselected from that card.
  context.applyCoverLookupSelectionIntent({ key: 'local:C:/Music/Album/Covers/Front.jpg', reference: {} });
  assert.deepEqual(modal.orderedCoverSelections.map((item) => item.key),
    ['local:C:/Music/Album/cover-existing-1.jpg']);
});
