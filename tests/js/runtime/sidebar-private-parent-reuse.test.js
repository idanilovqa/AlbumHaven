'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, admit, ready, ordinary} = require('./search-native-fixtures/actual-runtime.cjs');

// Actual renderSidebar, markup/signature, finite apply and private parent owners.
// The existing connected browser platform is reused without fixture changes.
function paintedArtist(h) {
  h.c.renderSidebar();
  const node = h.sidebar.querySelector('[data-sidebar-artist]');
  assert.ok(node, 'the actual native Sidebar contains an Artist');
  return node;
}

for (const marker of ['absent', 'undefined', 'null']) {
  test(`ordinary Sidebar reuses unchanged native nodes with ${marker} private receipt`, t => {
    const h = fixture(t);
    const node = paintedArtist(h);
    const signature = h.sidebar.dataset.sidebarStructureSignature;
    if (marker === 'absent') delete h.sidebar.albumHavenSidebarPrivateView;
    else h.sidebar.albumHavenSidebarPrivateView = marker === 'null' ? null : undefined;
    assert.equal(paintedArtist(h), node, 'ordinary selection painting must not rebuild unchanged rows');
    assert.equal(node.isConnected, true);
    assert.equal(h.sidebar.dataset.sidebarStructureSignature, signature);
    assert.equal(node.albumHavenPrivateSearchView, undefined);
    assert.equal(h.requests.length, 0, 'ordinary painting does not dispatch a request');
  });
}

test('same admitted private parent reuses its exact native Sidebar nodes', async t => {
  const h = fixture(t);
  const snapshot = await admit(h);
  const node = paintedArtist(h), parent = h.state.view;
  assert.equal(node.albumHavenPrivateSearchView, parent);
  assert.equal(h.runtime().sidebarNodeIsCurrent(node), true);
  assert.equal(paintedArtist(h), node);
  assert.equal(h.sidebar.albumHavenSidebarPrivateView, parent);
  assert.equal(h.runtime().snapshot(), snapshot);
  assert.equal(h.runtime().sidebarNodeIsCurrent(node), true);
});

test('equal private Sidebar labels cannot transfer nodes to a replacement parent', async t => {
  const h = fixture(t);
  const oldSnapshot = await admit(h, ready());
  const oldNode = paintedArtist(h), oldParent = h.state.view;
  const signature = h.sidebar.dataset.sidebarStructureSignature;
  const replacement = await admit(h, ready());
  const node = paintedArtist(h);
  assert.notEqual(h.state.view, oldParent);
  assert.notEqual(replacement, oldSnapshot);
  assert.equal(h.sidebar.dataset.sidebarStructureSignature, signature, 'the actual structural signature is unchanged');
  assert.notEqual(node, oldNode, 'exact private parent identity still forces replacement');
  assert.equal(oldNode.isConnected, false);
  assert.equal(h.runtime().sidebarNodeIsCurrent(oldNode), false);
  assert.equal(node.albumHavenPrivateSearchView, h.state.view);
  assert.equal(h.runtime().sidebarNodeIsCurrent(node), true);
});

test('ordinary replacement removes private node authority even with identical Sidebar structure', async t => {
  const h = fixture(t);
  await admit(h);
  const oldNode = paintedArtist(h), oldParent = h.state.view;
  const signature = h.sidebar.dataset.sidebarStructureSignature;
  const payload = {...ordinary(), artists_sidebar: oldParent.artists_sidebar,
    show_all_artists_sidebar_link: oldParent.show_all_artists_sidebar_link};
  const work = h.read('/view-data?surface=albums');
  h.reply(1, payload);
  const result = await work;
  assert.equal(result.error, undefined);
  assert.equal(result.value, true);
  const node = paintedArtist(h);
  assert.equal(h.sidebar.dataset.sidebarStructureSignature, signature);
  assert.notEqual(node, oldNode);
  assert.equal(oldNode.isConnected, false);
  assert.equal(h.runtime().sidebarNodeIsCurrent(oldNode), false);
  assert.equal(h.sidebar.albumHavenSidebarPrivateView, null);
  assert.equal(node.albumHavenPrivateSearchView, undefined);
  assert.equal(h.runtime().sidebarNodeIsCurrent(node), false);
});
