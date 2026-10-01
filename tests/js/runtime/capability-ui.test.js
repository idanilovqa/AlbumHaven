const test = require('node:test');
const assert = require('node:assert/strict');
const { readPolicy, install } = require('../../../music_app/static/js/capability-ui.js');

function documentFor(payload) {
  const handlers = new Map();
  return {
    handlers,
    readyState: 'loading',
    getElementById: () => ({ textContent: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    addEventListener: (name, callback) => handlers.set(name, callback),
  };
}

test('missing, malformed and role-only payloads fail closed', () => {
  for (const payload of ['not-json', {}, { roles: ['owner', 'admin'] }, { allowed_actions: [] }]) {
    const document = documentFor(payload);
    assert.equal(readPolicy(document), null);
    assert.equal(install(document).allows('library.files.edit_tags'), false);
  }
});

test('only true server decisions authorize a visible action', () => {
  const ui = install(documentFor({
    allowed_actions: { 'library.media.read': true, 'library.files.edit_tags': false, 'library.loops.create': 'true' },
    client_surface: 'mobile', denied_selectors: [], denied_tabs: [],
  }));
  assert.equal(ui.clientSurface, 'mobile');
  assert.equal(ui.allows('library.media.read'), true);
  assert.equal(ui.allows('library.files.edit_tags'), false);
  assert.equal(ui.allows('library.loops.create'), false);
  assert.equal(ui.allows('library.future_feature.write'), false);
});

test('denied dynamic controls reject activation without interfering with permitted controls', () => {
  const document = documentFor({ allowed_actions: {}, denied_selectors: ['.play-track-button'], denied_tabs: [] });
  install(document);
  let prevented = 0;
  let stopped = 0;
  const event = {
    target: { closest: (selector) => selector === '.play-track-button' ? {} : null },
    preventDefault: () => { prevented += 1; },
    stopImmediatePropagation: () => { stopped += 1; },
  };
  document.handlers.get('click')(event);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  event.target.closest = () => null;
  document.handlers.get('click')(event);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('full-access desktop installs no click interception', () => {
  const document = documentFor({ allowed_actions: { 'library.media.read': true }, denied_selectors: [], denied_tabs: [] });
  install(document);
  assert.equal(document.handlers.has('click'), false);
});


test('TV candidate filtering accepts only server-projected provider groups and fails closed on missing provenance', () => {
  const ui = install(documentFor({ allowed_actions: {}, client_surface: 'tv',
    cover_provider_groups: ['services', 'cover_art_archive', null, 7], denied_selectors: [] }));
  for (const group of ['services', 'cover_art_archive']) {
    assert.equal(ui.allowsCoverCandidate({ lookup_group: group }), true);
  }
  for (const candidate of [undefined, {}, { lookup_group: 'manual_links', source: 'spotify' },
    { lookup_group: 'local' }, { lookup_group: 7 }]) {
    assert.equal(ui.allowsCoverCandidate(candidate), false);
  }
  const missingGroups = install(documentFor({ allowed_actions: {}, client_surface: 'tv', denied_selectors: [] }));
  assert.equal(missingGroups.allowsCoverCandidate({ lookup_group: 'services' }), false);
  assert.equal(install(documentFor('bad')).allowsCoverCandidate({ lookup_group: 'services' }), false);
});

test('desktop cover selection keeps existing local and manual candidates', () => {
  const ui = install(documentFor({ allowed_actions: {}, client_surface: 'private_web', denied_selectors: [] }));
  assert.equal(ui.allowsCoverCandidate({ lookup_group: 'manual_links' }), true);
  assert.equal(ui.allowsCoverCandidate({ lookup_group: 'local' }), true);
});
