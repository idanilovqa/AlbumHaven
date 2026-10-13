'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {React, native, components, render} = require('./artist-visible-fixtures/source-harness.cjs');
const ARTIST = 'Canonical & Artist / Live';
const OTHER = 'Family canonical / B';
const members = () => [
  {artistRef: ARTIST, label: 'Canonical display', albumCount: 3, artworkHtml: ''},
  {artistRef: OTHER, label: 'Related display', albumCount: 2, artworkHtml: ''},
];
function required(name) {
  const component = components()[name];
  assert.equal(typeof component, 'function', `The actual existing shared React entry must export ${name}`);
  return component;
}

test('existing shared native Family owner renders intrinsic canonical navigation instead of a drawer', () => {
  const env = native(), host = env.document.createElement('div');
  host.innerHTML = env.runtime.artistFamilyHtml({presentation: 'navigation', title: 'Artist Family', members: members(), currentArtist: ARTIST});
  const panel = host.querySelector('.artist-family-panel');
  assert.ok(panel);
  assert.equal(panel.hasAttribute('hidden'), false, 'navigation is real inline content, not an initially closed drawer');
  assert.notEqual(panel.getAttribute('aria-hidden'), 'true');
  assert.ok(panel.classList.contains('artist-family-panel--navigation'));
  const rows = [...panel.querySelectorAll('[data-artist-page-family]')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('data-artist-page-family'), ARTIST);
  assert.equal(rows[0].getAttribute('data-navigation-tree-item'), 'wide');
  assert.equal(rows[0].getAttribute('data-navigation-tree-key'), ARTIST);
  assert.ok(rows[0].querySelector('.navigation-tree-label'));
  assert.equal(rows[1].getAttribute('data-navigation-tree-key'), OTHER);
  assert.equal(rows[1].querySelector('.navigation-tree-count').textContent, '2');
  assert.equal(rows[1].getAttribute('data-artist-page-family'), OTHER, 'display name must not become the canonical destination');
  assert.equal(rows[0].getAttribute('aria-current'), 'true', 'preserve the native NavigationTree selected-row contract');
  assert.equal(rows[0].hasAttribute('aria-pressed'), false);
  assert.equal(rows[1].hasAttribute('aria-pressed'), false);
  assert.ok(rows[1].textContent.includes('Related display'));
  assert.ok(rows[1].textContent.includes('2'));
  assert.equal(panel.querySelector('[data-gallery-family-artist]'), null);
  assert.equal(panel.querySelector('[data-toggle-combine-similar-artists]'), null);
  assert.equal(panel.querySelector('[role="switch"]'), null);
  assert.equal(panel.querySelector('#artist-family-combine-similar'), null);
});

test('ordinary shared Family drawer retains its existing native filter contract', () => {
  const env = native(), host = env.document.createElement('div');
  host.innerHTML = env.runtime.artistFamilyHtml({title: 'Artist Family', albumTotal: '5 albums', combineSimilarArtists: true,
    bodyHtml: '<button data-gallery-family-artist="Retained">Retained</button>'});
  const panel = host.querySelector('[data-artist-family-panel]');
  assert.ok(panel);
  assert.equal(panel.hasAttribute('hidden'), true);
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.classList.contains('artist-family-panel--navigation'), false);
  assert.equal(panel.querySelector('#artist-family-combine-similar').getAttribute('aria-checked'), 'true');
  assert.equal(panel.querySelector('[data-gallery-family-artist]').textContent, 'Retained');
  assert.equal(panel.querySelectorAll('[data-artist-page-family]').length, 0);
});

test('actual React ArtistInfo wrapper preserves supplied facts through existing embedded native owner', () => {
  const view = render(required('ArtistInfo'), {artist: ARTIST, summary: 'A source-supplied summary.', metadata: 'Formed 1999', sourceLabel: 'Library metadata'});
  const region = view.host.querySelector('.artist-info-overlay--embedded');
  assert.ok(region);
  assert.equal(region.getAttribute('role'), 'region');
  assert.equal(region.querySelector('h2').textContent, ARTIST);
  assert.ok(region.textContent.includes('A source-supplied summary.'));
  assert.ok(region.textContent.includes('Formed 1999'));
  assert.ok(region.textContent.includes('Source: Library metadata'));
  assert.equal(view.host.querySelectorAll('[role="dialog"]').length, 0);
  assert.deepEqual(view.forbiddenCalls, []);
});

test('actual React ArtistInfo has truthful absent Neal Morse metadata without trial biography or image', () => {
  const view = render(required('ArtistInfo'), {artist: 'Neal Morse'});
  assert.ok(view.host.textContent.includes('No information was supplied.'));
  assert.equal(view.host.querySelector('img'), null);
  assert.equal(view.host.textContent.includes('American singer'), false);
  assert.equal(view.host.textContent.includes('Wikipedia'), false);
});

test('actual React ArtistFamily wrapper keeps canonical destinations and native navigation rows', () => {
  const view = render(required('ArtistFamily'), {title: 'Artist Family', members: members(), currentArtist: ARTIST,
    onNavigate() {assert.fail('SSR must not navigate');}});
  const rows = [...view.host.querySelectorAll('[data-artist-page-family]')];
  assert.equal(rows.length, 2);
  assert.equal(rows[1].getAttribute('data-artist-page-family'), OTHER);
  assert.equal(view.host.querySelector('[data-toggle-combine-similar-artists]'), null);
  assert.deepEqual(view.forbiddenCalls, []);
});

test('actual React intrinsic disclosures render unique real panels and native accessible toggles', () => {
  const Disclosure = required('IntrinsicDisclosure');
  const child = React.createElement('button', {type: 'button'}, 'Child action');
  const first = render(Disclosure, {id: 'artist-entry-8-ep', memberKey: 'release:ep', label: 'EP', count: 2, children: child});
  const second = render(Disclosure, {id: 'artist-entry-8-family', memberKey: 'family', label: 'Family', count: 1, collapsed: true, children: child});
  for (const [view, key, expanded] of [[first, 'release:ep', true], [second, 'family', false]]) {
    const section = view.host.querySelector('[data-disclosure-key]');
    assert.ok(section);
    assert.equal(section.getAttribute('data-disclosure-key'), key);
    const toggle = section.querySelector('button[aria-controls]');
    const panel = section.querySelector('[data-disclosure-panel]');
    assert.ok(toggle?.classList.contains('action-button'), 'actual native ActionButton class survives React SSR');
    assert.ok(panel?.id);
    assert.equal(toggle.getAttribute('aria-controls'), panel.id);
    assert.equal(toggle.getAttribute('aria-expanded'), String(expanded));
    assert.equal(panel.hasAttribute('hidden'), !expanded);
    assert.equal(panel.hasAttribute('inert'), !expanded, 'React Boolean inert must serialize correctly');
    assert.equal(panel.querySelector('button').textContent, 'Child action');
  }
  assert.notEqual(first.host.querySelector('[data-disclosure-panel]').id, second.host.querySelector('[data-disclosure-panel]').id);
});

test('actual React disclosure keeps independent header actions outside collapsed body', () => {
  const view = render(required('IntrinsicDisclosure'), {id: 'discography-entry-3', memberKey: 'discography', label: 'Discography', count: 3, collapsed: true,
    actions: React.createElement('button', {type: 'button', 'data-independent-header-action': 'true'}, 'Full size'),
    children: React.createElement('span', null, 'Retained releases')});
  const panel = view.host.querySelector('[data-disclosure-panel]');
  const action = view.host.querySelector('[data-independent-header-action]');
  assert.ok(action);
  assert.equal(panel.contains(action), false);
  assert.equal(action.closest('[hidden]'), null);
});

