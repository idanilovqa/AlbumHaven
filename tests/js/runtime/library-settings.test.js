const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'library-settings.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelpers(overrides = {}) {
  const calls = {
    fetches: [],
    toasts: [],
    statusUpdates: [],
    renders: 0,
    libraryLoaderRenders: 0,
    scheduledPolls: [],
    viewRefreshes: [],
  };
  const context = {
    console,
    cloneRuntimeJson(value, fallback = null) {
      return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
    },
    escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    },
    state: {
      wasPollingBusy: false,
      wasCoverPollingBusy: false,
      status: {},
      utility: {
        activeTab: 'integrations',
        selectedIntegrationKey: 'library',
        loaded: true,
        problematicFiles: [{ key: 'old-problem' }],
        integrations: [{
          key: 'lastfm',
          title: 'Last.fm',
          description: 'Scrobbling',
          connected: true,
          api_configured: true,
        }],
        librarySettings: {
          settings: null,
          draft: null,
          loaded: false,
          loading: false,
          loadPromise: null,
          saveBusy: false,
          albumRatingImportBusy: false,
          albumRatingImportResult: null,
          error: '',
          allowedActions: {'library.settings.manage':true,'library.filesystem.browse':true,'library.paths.read':true},
        },
      },
      view: {
        query: 'Rating Import Candidate',
      },
    },
    buildApiUrl(view) {
      return `/api?query=${encodeURIComponent(String(view?.query || ''))}`;
    },
    async fetchAndRender(url, force, options) {
      calls.viewRefreshes.push([url, force, options]);
    },
    showToast(message, tone, duration) {
      calls.toasts.push([message, tone, duration]);
    },
    getUtilityModalElements: () => ({ overlay: { hidden: false } }),
    renderUtilityModalContent() {
      calls.renders += 1;
    },
    updateStatusIndicator(status) {
      calls.statusUpdates.push(status);
      context.state.status = status;
    },
    renderLibraryLoader(status) {
      calls.libraryLoaderRenders += 1;
      context.state.status = status;
    },
    scheduleBrowserTimeout(callback, delay) {
      calls.scheduledPolls.push(delay);
      if (callback === context.pollStatus) {
        calls.scheduledPolls.push('pollStatus');
      }
    },
    pollStatus() {},
    async fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      if (url === '/library-settings' && (!options.method || options.method === 'GET')) {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              settings: {
                version: 1,
                main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
                hoarding_library_roots: [],
                new_arrivals_roots: [],
                move_policy: {},
              },
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            settings: {
              version: 1,
              main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
              hoarding_library_roots: [{ id: 'hoard-1', path: 'D:\\Hoard' }],
              new_arrivals_roots: [],
              move_policy: { preferred_main_write_root: 'main-1', move_new_arrivals_to: 'hoard-1' },
            },
            status: {
              scan_in_progress: true,
              relations_in_progress: false,
              covers_in_progress: false,
              scan_mode: 'library_settings_update',
            },
            refresh_started: true,
          };
        },
      };
    },
  };
  Object.assign(context, overrides);
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), '../button-component.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'alert-components.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'gallery-main-components.js'), 'utf8'), context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('empty library sections retain one draft path and Add appends a second', () => {
  const { context } = loadHelpers();
  const settings = context.normalizeLibrarySettingsPayload({});
  context.state.utility.librarySettings.settings = settings;
  for (const category of ['main_library_roots', 'hoarding_library_roots', 'new_arrivals_roots']) {
    const draft = context.getLibrarySettingsDraft();
    assert.equal(draft[category].length, 1);
    assert.equal(draft[category][0].path, '');
    context.addLibraryRootDraftEntry(category);
    assert.equal(draft[category].length, 2);
    assert.notEqual(draft[category][0].id, draft[category][1].id);
    context.removeLibraryRootDraftEntry(category, 1);
    context.removeLibraryRootDraftEntry(category, 0);
    assert.equal(draft[category].length, 1);
    assert.equal(draft[category][0].path, '');
    const html = context.buildLibrarySettingsRootSection(category, 'Library', 'Paths');
    assert.equal((html.match(/data-library-root-field="path"/g) || []).length, 1);
    assert.doesNotMatch(html, /Folder layout|data-library-layout-trigger|No roots added yet/);
  }
  assert.equal(JSON.stringify(context.serializeLibrarySettingsDraft(context.getLibrarySettingsDraft())), JSON.stringify(settings));
});

test('blank rows do not save or become policy targets and layout metadata survives', async () => {
  const { context, calls } = loadHelpers();
  const draft = context.getLibrarySettingsDraft();
  draft.main_library_roots = [{ id: 'shared', path: '/music', layout_mode: 'genre/artist' }, { id: 'blank', path: '   ', layout_mode: 'artist' }];
  draft.hoarding_library_roots = [{ id: 'shared', path: '' }];
  draft.move_policy = { preferred_main_write_root: 'shared', move_new_arrivals_to: 'shared' };
  const payload = context.serializeLibrarySettingsDraft(draft);
  assert.equal(payload.main_library_roots.length, 1);
  assert.equal(payload.main_library_roots[0].layout_mode, 'genre/artist');
  assert.equal(payload.hoarding_library_roots.length, 0);
  assert.equal(payload.move_policy.preferred_main_write_root, 'shared');
  assert.equal(payload.move_policy.move_new_arrivals_to, '');
  assert.equal(context.buildLibrarySettingsRootOptions(draft.hoarding_library_roots, 'Default').length, 1);
  context.removeLibraryRootDraftEntry('hoarding_library_roots', 0);
  assert.equal(draft.move_policy.preferred_main_write_root, 'shared');
  assert.equal(draft.move_policy.move_new_arrivals_to, '');
  draft.move_policy.preferred_main_write_root = 'blank';
  assert.equal(context.serializeLibrarySettingsDraft(draft).move_policy.preferred_main_write_root, '');
  draft.move_policy.preferred_main_write_root = 'unknown';
  assert.equal(context.serializeLibrarySettingsDraft(draft).move_policy.preferred_main_write_root, 'unknown');
  await context.saveUtilityLibrarySettings();
  const posted = JSON.parse(calls.fetches[0][1].body).settings;
  assert.equal(posted.main_library_roots.length, 1);
  assert.equal(posted.main_library_roots[0].layout_mode, 'genre/artist');
  assert.equal(posted.hoarding_library_roots.length, 0);
  assert.equal(posted.new_arrivals_roots.length, 0);
});

test('folder browse fills the materialized empty row', async () => {
  const { context } = loadHelpers();
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, entries: [] }) });
  context.showAppFormDialog = async () => '/chosen';
  assert.equal(await context.browseLibraryRootDraft('hoarding_library_roots', 0), true);
  assert.equal(context.getLibrarySettingsDraft().hoarding_library_roots.length, 1);
  assert.equal(context.getLibrarySettingsDraft().hoarding_library_roots[0].path, '/chosen');
});

test('move policy choices retain IDs, reset defaults, and honor manage permission', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  const draft = context.getLibrarySettingsDraft();
  draft.main_library_roots = [{ id: 'first', path: '/same' }, { id: 'second', path: '/same' }, { id: 'blank', path: '' }];
  draft.move_policy.preferred_main_write_root = 'second';
  let menu;
  context.openUtilityChoiceDropdown = (trigger, options) => { menu = options; };
  const trigger = { getAttribute: () => 'preferred_main_write_root' };
  const event = { preventDefault() {}, target: { closest: selector => selector === '[data-library-policy-trigger]' ? trigger : null } };
  assert.equal(context.handleLibrarySettingsClick(event), true);
  assert.equal(menu.label, 'Library destination'); assert.equal(menu.selected, 'second');
  assert.equal(JSON.stringify(menu.formats), JSON.stringify([{ value: 'first', label: '/same' }, { value: 'second', label: '/same' }]));
  menu.onSelect('first'); assert.equal(draft.move_policy.preferred_main_write_root, 'first');
  menu.onSelect(''); assert.equal(draft.move_policy.preferred_main_write_root, '');
  context.state.utility.librarySettings.moveAutomationDraft = { preferred_main_write_root: true, move_new_arrivals_to: true };
  const html = context.buildUtilityLibrarySettingsDetail();
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /aria-label="Library destination"/); assert.match(html, /Move New Arrivals to Hoard/);
  assert.doesNotMatch(html, /<label class="lastfm-inline-field library-settings-inline-field">/);
  assert.equal((html.match(/class="library-settings-move-policy-row"/g) || []).length, 2);
  context.state.utility.librarySettings.allowedActions['library.settings.manage'] = false;
  assert.equal(menu.onSelect('second'), false);
  assert.equal(draft.move_policy.preferred_main_write_root, '');
  menu = null; context.handleLibrarySettingsClick(event); assert.equal(menu, null);
  assert.doesNotMatch(context.buildLibrarySettingsPolicyButton('preferred_main_write_root', [], '', 'Library destination', ''), /<button/);
});

test('choice dropdown opens above the persistent player when the lower space is covered', () => {
  const { context } = loadHelpers();
  const above = context.resolveUtilityChoiceDropdownVerticalPlacement(
    { top: 620, bottom: 660 }, 96, 680,
  );
  assert.equal(above.top, 520);
  assert.equal(above.maxHeight, 608);
  const below = context.resolveUtilityChoiceDropdownVerticalPlacement(
    { top: 120, bottom: 160 }, 96, 680,
  );
  assert.equal(below.top, 164);
  assert.equal(below.maxHeight, 508);
});

test('shared choice dropdown toggles, switches triggers, preserves IDs and Foobar strings', () => {
  const { context } = loadHelpers();
  const menus = [], selected = [];
  const makeNode = () => ({
    style: {}, listeners: {}, attributes: {}, isConnected: true,
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    remove() { this.removed = true; }, contains: () => false,
    focus() { this.focused = true; },
    getBoundingClientRect: () => ({ left: 10, bottom: 50 }),
  });
  const firstButton = makeNode();
  context.document = { body: { append: menu => menus.push(menu) }, addEventListener() {}, removeEventListener() {},
    createElement: () => ({ ...makeNode(), querySelector: () => firstButton, querySelectorAll: () => [firstButton] }) };
  context.addEventListener = () => {}; context.removeEventListener = () => {};
  context.innerWidth = 1000; context.innerHeight = 800;
  context.syncTriggerAnchor = () => {}; context.clearTriggerAnchor = () => {};
  const first = makeNode(), second = makeNode();
  const firstLabel = {}, secondLabel = {};
  first.querySelector = () => firstLabel; second.querySelector = () => secondLabel;
  const options = { formats: [{ value: '', label: 'Default' }, { value: 'id-one', label: '/same' }, { value: 'id-two', label: '/same' }], selected: 'id-two', label: 'Library writes', onSelect: value => selected.push(value) };
  context.openUtilityChoiceDropdown(first, options);
  assert.match(menus[0].innerHTML, /aria-checked="true" data-foobar-format="id-two"/);
  assert.match(menus[0].className, /gallery-anchored-menu/);
  assert.match(menus[0].innerHTML, /gallery-menu-action/);
  context.openUtilityChoiceDropdown(second, options);
  assert.equal(menus[0].removed, true); assert.equal(menus.length, 2); assert.equal(second.attributes['aria-expanded'], 'true');
  menus[1].listeners.click({ target: { closest: () => ({ getAttribute: () => 'id-one' }) } });
  assert.equal(selected.at(-1), 'id-one'); assert.equal(secondLabel.textContent, '/same'); assert.equal(second.focused, true);
  context.openUtilityChoiceDropdown(first, options);
  menus[2].listeners.click({ target: { closest: () => ({ getAttribute: () => '' }) } });
  assert.equal(selected.at(-1), ''); assert.equal(firstLabel.textContent, 'Default');
  context.openUtilityFoobarFormats(first);
  menus[3].listeners.click({ target: { closest: () => ({ getAttribute: () => 'Text Tools — standard' }) } });
  assert.equal(context.state.utility.foobarFormat, 'Text Tools — standard'); assert.equal(firstLabel.textContent, 'Text Tools — standard');
  context.openUtilityChoiceDropdown(first, options);
  context.openUtilityChoiceDropdown(first, options);
  assert.equal(menus.length, 5); assert.equal(menus[4].removed, true); assert.equal(first.attributes['aria-expanded'], 'false');
});

test('library failures use shared escaped alerts and retain the retry action', async () => {
  const { context } = loadHelpers();
  const settings = context.ensureLibrarySettingsState();
  settings.error = '<img src=x onerror=bad>';
  let html = context.buildUtilityLibrarySettingsDetail();
  assert.match(html, /data-on-page-alert="error"/);
  assert.match(html, /&lt;img src=x onerror=bad&gt;/);
  assert.match(html, /data-reload-library-settings="1"/);
  assert.match(html, /ui-button__content/);
  await context.loadUtilityLibrarySettings(true);
  context.ensureLibrarySettingsState().error = '<failed>';
  html = context.buildUtilityLibrarySettingsDetail();
  assert.match(html, /data-on-page-alert="error"/);
  assert.match(html, /&lt;failed&gt;/);
});

test('loadUtilityLibrarySettings stores normalized settings and drafts', async () => {
  const { context, calls } = loadHelpers();

  const settings = await context.loadUtilityLibrarySettings(true);

  assert.equal(calls.fetches[0][0], '/library-settings');
  assert.equal(settings.main_library_roots[0].path, 'C:\\Music');
  assert.equal(context.state.utility.librarySettings.loaded, true);
  assert.equal(context.state.utility.librarySettings.draft.main_library_roots[0].layout_mode, 'artist');
});

test('saveUtilityLibrarySettings posts draft, clears stale problematic state, and starts polling', async () => {
  const { context, calls } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  context.state.utility.librarySettings.draft = {
    version: 1,
    main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
    hoarding_library_roots: [{ id: 'hoard-1', path: 'D:\\Hoard' }],
    new_arrivals_roots: [],
    move_policy: { preferred_main_write_root: 'main-1', move_new_arrivals_to: 'hoard-1' },
  };

  const result = await context.saveUtilityLibrarySettings();

  assert.equal(result, true);
  assert.equal(calls.fetches[0][0], '/library-settings');
  assert.equal(calls.fetches[0][1].method, 'POST');
  assert.equal(
    JSON.stringify(JSON.parse(calls.fetches[0][1].body)),
    JSON.stringify({ settings: context.serializeLibrarySettingsDraft(context.state.utility.librarySettings.draft) }),
  );
  assert.equal(context.state.utility.loaded, false);
  assert.equal(JSON.stringify(context.state.utility.problematicFiles), '[]');
  assert.equal(context.state.wasPollingBusy, true);
  assert.deepEqual(calls.statusUpdates[0], {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
    scan_mode: 'library_settings_update',
  });
  assert.deepEqual(calls.toasts.at(-1), ['Library settings saved. Scan started.', 'success', 3200]);
  assert.ok(calls.scheduledPolls.includes('pollStatus'));
});

test('handleLibrarySettingsIntegrationSelection loads the library settings detail when the library integration is selected', async () => {
  const { context, calls } = loadHelpers();

  const handled = await context.handleLibrarySettingsIntegrationSelection('library');

  assert.equal(handled, true);
  assert.equal(context.state.utility.selectedIntegrationKey, 'library');
  assert.equal(calls.fetches[0][0], '/library-settings');
  assert.equal(context.state.utility.librarySettings.loaded, true);
  assert.ok(calls.renders >= 2);
});

test('handleLibrarySettingsClick routes library settings actions through the feature seam', async () => {
  const { context } = loadHelpers();
  const routedCalls = [];
  context.addLibraryRootDraftEntry = (category) => routedCalls.push(['add', category]);
  context.removeLibraryRootDraftEntry = (category, index) => routedCalls.push(['remove', category, index]);
  context.loadUtilityLibrarySettings = (force) => routedCalls.push(['reload', force]);
  context.saveUtilityLibrarySettings = () => routedCalls.push(['save']);
  context.importAlbumRatingsFromFileTags = () => routedCalls.push(['import-album-ratings']);

  const addEvent = {
    target: {
      closest(selector) {
        if (selector === '[data-add-library-root]') {
          return {
            getAttribute(name) {
              return name === 'data-add-library-root' ? 'main_library_roots' : '';
            },
          };
        }
        return null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'add']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(addEvent), true);

  const removeEvent = {
    target: {
      closest(selector) {
        if (selector === '[data-remove-library-root]') {
          return {
            getAttribute(name) {
              if (name === 'data-remove-library-root') return 'hoarding_library_roots';
              if (name === 'data-library-root-index') return '2';
              return '';
            },
          };
        }
        return null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'remove']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(removeEvent), true);

  const reloadEvent = {
    target: {
      closest(selector) {
        return selector === '[data-reload-library-settings="1"]' ? {} : null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'reload']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(reloadEvent), true);

  const importAlbumRatingsEvent = {
    target: {
      closest(selector) {
        return selector === '[data-import-album-ratings="1"]' ? {} : null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'import-album-ratings']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(importAlbumRatingsEvent), true);

  const saveEvent = {
    target: {
      closest(selector) {
        return selector === '[data-save-library-settings="1"]' ? {} : null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'save']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(saveEvent), true);

  assert.deepEqual(routedCalls, [
    ['prevented', 'add'],
    ['add', 'main_library_roots'],
    ['prevented', 'remove'],
    ['remove', 'hoarding_library_roots', 2],
    ['prevented', 'reload'],
    ['reload', true],
    ['prevented', 'import-album-ratings'],
    ['import-album-ratings'],
    ['prevented', 'save'],
    ['save'],
  ]);
});

test('handleLibrarySettingsInput updates draft fields for text inputs', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  context.state.utility.librarySettings.draft = {
    version: 1,
    main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
    hoarding_library_roots: [],
    new_arrivals_roots: [],
    move_policy: { preferred_main_write_root: '', move_new_arrivals_to: '' },
  };

  const rootInputEvent = {
    target: {
      value: 'E:\\Library',
      closest(selector) {
        if (selector === '[data-library-root-field]') {
          return {
            value: 'E:\\Library',
            getAttribute(name) {
              if (name === 'data-library-root-list') return 'main_library_roots';
              if (name === 'data-library-root-index') return '0';
              if (name === 'data-library-root-field') return 'path';
              return '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsInput(rootInputEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.main_library_roots[0].path, 'E:\\Library');

  const policyInputEvent = {
    target: {
      value: 'main-1',
      closest(selector) {
        if (selector === '[data-library-settings-field]') {
          return {
            value: 'main-1',
            getAttribute(name) {
              return name === 'data-library-settings-field' ? 'preferred_main_write_root' : '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsInput(policyInputEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.move_policy.preferred_main_write_root, 'main-1');
});

test('handleLibrarySettingsChange updates draft fields for select inputs', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  context.state.utility.librarySettings.draft = {
    version: 1,
    main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
    hoarding_library_roots: [{ id: 'hoard-1', path: 'D:\\Hoard' }],
    new_arrivals_roots: [],
    move_policy: { preferred_main_write_root: '', move_new_arrivals_to: '' },
  };

  const layoutSelectEvent = {
    target: {
      closest(selector) {
        if (selector === 'select[data-library-root-field]') {
          return {
            value: 'genre/artist',
            getAttribute(name) {
              if (name === 'data-library-root-list') return 'main_library_roots';
              if (name === 'data-library-root-index') return '0';
              if (name === 'data-library-root-field') return 'layout_mode';
              return '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsChange(layoutSelectEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.main_library_roots[0].layout_mode, 'genre/artist');

  const movePolicySelectEvent = {
    target: {
      closest(selector) {
        if (selector === 'select[data-library-settings-field]') {
          return {
            value: 'hoard-1',
            getAttribute(name) {
              return name === 'data-library-settings-field' ? 'move_new_arrivals_to' : '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsChange(movePolicySelectEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.move_policy.move_new_arrivals_to, 'hoard-1');
});

test('buildUtilityLibrarySettingsDetail exposes the explicit album-rating import action', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;

  const markup = context.buildUtilityLibrarySettingsDetail();

  assert.match(markup, /data-import-album-ratings="1"/);
  assert.match(markup, /<button\b[^>]*data-import-album-ratings="1"[^>]*>Import ratings<\/button>/);
  assert.doesNotMatch(markup, /data-album-rating-import-result="1"/);
});

test('importAlbumRatingsFromFileTags posts to Library Settings and renders exact result counts on repeat actions', async () => {
  const responses = [
    { ok: true, created: 2, authority_skipped: 3, failed: 1 },
    { ok: true, created: 0, authority_skipped: 5, failed: 0 },
  ];
  const { context, calls } = loadHelpers({
    async fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      const payload = responses.shift();
      return {
        ok: true,
        async json() {
          return payload;
        },
      };
    },
  });
  context.state.utility.librarySettings.loaded = true;

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 2, authority_skipped: 3, failed: 1 },
  );
  assert.equal(calls.viewRefreshes.length, 1);
  assert.equal(calls.viewRefreshes[0][0], '/api?query=Rating%20Import%20Candidate');
  assert.equal(calls.viewRefreshes[0][1], false);
  assert.equal(
    JSON.stringify(calls.viewRefreshes[0][2]),
    JSON.stringify({ preserveScroll: true }),
  );
  assert.match(
    context.buildUtilityLibrarySettingsDetail(),
    /data-album-rating-import-result="1">Created: 2 · Authority skipped: 3 · Failed: 1<\/div>/,
  );

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.equal(calls.fetches.length, 2);
  assert.equal(calls.viewRefreshes.length, 1);
  calls.fetches.forEach(([url, options]) => {
    assert.equal(url, '/library-settings/import-album-ratings');
    assert.equal(options.method, 'POST');
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 0, authority_skipped: 5, failed: 0 },
  );
});

test('importAlbumRatingsFromFileTags keeps a successful import authoritative when view refresh fails', async () => {
  const { context, calls } = loadHelpers({
    async fetch() {
      return {
        ok: true,
        async json() {
          return { ok: true, created: 2, authority_skipped: 3, failed: 1 };
        },
      };
    },
    async fetchAndRender() {
      throw new Error('refresh unavailable');
    },
  });

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 2, authority_skipped: 3, failed: 1 },
  );
  assert.equal(context.state.utility.librarySettings.error, '');
  assert.deepEqual(calls.toasts, [
    ['Album ratings were imported, but the current view could not be refreshed.', 'warning', 3600],
  ]);
});

test('importAlbumRatingsFromFileTags guards concurrent clicks and exposes busy state', async () => {
  let releaseResponse;
  const { context, calls } = loadHelpers({
    fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      return new Promise((resolve) => {
        releaseResponse = () => resolve({
          ok: true,
          async json() {
            return { ok: true, created: 1, authority_skipped: 0, failed: 0 };
          },
        });
      });
    },
  });
  context.state.utility.librarySettings.loaded = true;

  const firstImport = context.importAlbumRatingsFromFileTags();
  assert.equal(context.state.utility.librarySettings.albumRatingImportBusy, true);
  assert.equal(await context.importAlbumRatingsFromFileTags(), false);
  assert.equal(calls.fetches.length, 1);
  const busyMarkup = context.buildUtilityLibrarySettingsDetail();
  const busyButton = busyMarkup.match(/<button[^>]*data-import-album-ratings="1"[^>]*>[^<]*<\/button>/)?.[0] || '';
  assert.match(busyButton, /disabled/);
  assert.match(busyButton, />Importing ratings\.\.\.<\/button>/);

  releaseResponse();
  assert.equal(await firstImport, true);
  assert.equal(context.state.utility.librarySettings.albumRatingImportBusy, false);
});

test('importAlbumRatingsFromFileTags clears its busy error state so a failed action can be retried', async () => {
  let attempt = 0;
  const { context, calls } = loadHelpers({
    async fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          async json() {
            return { ok: false, error: 'Album rating import failed.' };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { ok: true, created: 1, authority_skipped: 2, failed: 0 };
        },
      };
    },
  });
  context.state.utility.librarySettings.loaded = true;

  assert.equal(await context.importAlbumRatingsFromFileTags(), false);
  assert.equal(context.state.utility.librarySettings.albumRatingImportBusy, false);
  assert.equal(context.state.utility.librarySettings.error, 'Album rating import failed.');
  assert.deepEqual(calls.toasts.at(-1), ['Album rating import failed.', 'error', 3600]);
  const retryMarkup = context.buildUtilityLibrarySettingsDetail();
  const retryButton = retryMarkup.match(/<button[^>]*data-import-album-ratings="1"[^>]*>[^<]*<\/button>/)?.[0] || '';
  assert.match(retryButton, /data-import-album-ratings="1"/);
  assert.doesNotMatch(retryButton, /disabled/);

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.equal(calls.fetches.length, 2);
  assert.equal(context.state.utility.librarySettings.error, '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 1, authority_skipped: 2, failed: 0 },
  );
});


test('main library destination is automatic for one path and lists only actual paths for multiple', () => {
  const { context } = loadHelpers();
  const single = [{ id: 'main', path: '/music' }, { id: 'draft', path: '' }];
  const render = roots => context.buildLibrarySettingsPolicyButton('preferred_main_write_root', roots, '', 'Library destination', '');
  assert.match(render(single), /\/music/);
  assert.doesNotMatch(render(single), /<button|aria-haspopup/);
  const multiple = [...single, { id: 'other', path: '/other' }];
  assert.match(render(multiple), /aria-haspopup="menu"/);
  assert.match(render(multiple), /\/music/);
  assert.equal(JSON.stringify(context.buildLibrarySettingsRootOptions(multiple)), JSON.stringify([{value: 'main', label: '/music'}, {value: 'other', label: '/other'}]));
  context.state.utility.librarySettings.allowedActions['library.settings.manage'] = false;
  assert.match(render(multiple), /disabled/);
});

test('automatic move switches are UI-only and reveal destinations only while enabled', () => {
  const { context } = loadHelpers();
  const owner = context.state.utility.librarySettings;
  const roots = [{ id: 'one', path: '/one' }, { id: 'two', path: '/two' }];
  const render = () => context.buildLibraryMovePolicyRow('preferred_main_write_root', roots, '', 'Auto Move rated albums to Main library', 'Library destination', 'main');
  assert.match(render(), /role="switch" aria-checked="false"/);
  assert.doesNotMatch(render(), /data-library-policy-trigger/);
  owner.moveAutomationDraft = { preferred_main_write_root: true };
  assert.match(render(), /role="switch" aria-checked="true"/);
  assert.match(render(), /data-library-policy-trigger/);
  assert.equal(context.serializeLibrarySettingsDraft(context.getLibrarySettingsDraft()).move_policy.auto_move_rated_to_main, undefined);
  owner.allowedActions['library.settings.manage'] = false;
  assert.match(render(), /disabled/);
});
