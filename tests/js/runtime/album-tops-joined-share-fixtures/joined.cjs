'use strict';
const assert = require('node:assert/strict');
const N = require('../album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('../album-tops-native-fixtures/actual-choice-runtime.cjs');
const H = require('../album-tops-sharing-harness.cjs');
const {id, TOP, OTHER, ALBUM, SCOPE, deferred, detail, sharing, service, preparedController, connectedView} = N;
const ITEM = id(21), SOURCE = id(31), SHARE = id(41), PUBLICATION = id(42);
const candidate = (n = 70, name = 'Ada') => ({account_ref: id(n), account_id: n, display_name: name,
  username_display: null, grant_ref: null, role: null, allowed_actions: {can_grant_viewer: true, can_grant_editor: true}});
function publication(state = 'unpublished', patch = {}) {
  const enabled = state === 'enabled', path = enabled ? `/public/album-tops/${SHARE}` : null;
  return {state, share_ref: state === 'unpublished' ? null : SHARE, link_revision: state === 'unpublished' ? null : enabled ? '2' : '3',
    publication_ref: enabled ? PUBLICATION : null, publication_revision: enabled ? '1' : null,
    public_path: path, public_url: path ? `https://saved.example.test${path}` : null,
    deployment_available: true, can_enable_external: true, can_revoke_external: enabled, ...patch};
}
const source = (ref = TOP, revision = '7') => ({top_ref: ref, revision, item_ref: ITEM, album_ref: ALBUM,
  sources: [{selected_local_album_id: 101, selected_source_ref: SOURCE, title: 'Source album', artist: 'Source artist', year: 2001}], next_cursor: null});
function backend({owner = publication(), handlers = {}} = {}) {
  let data; const control = {...handlers}, live = {publication: owner};
  const defaults = {
    read: ref => ({...data.data.detail, top_ref: ref}),
    readSharing: ref => sharing({top_ref: ref, revision: data.data.detail.revision, publication: H.plain(live.publication)}),
    readAccessCandidates: ref => ({top_ref: ref, revision: data.data.detail.revision, candidates: [candidate()], next_cursor: null}),
    readAccessGrants: ref => ({top_ref: ref, revision: data.data.detail.revision, grants: [], next_cursor: null}),
    readPublicationSources: ref => source(ref, data.data.detail.revision),
  };
  data = service(Object.fromEntries(['read', 'readSharing', 'readAccessCandidates', 'readAccessGrants', ...Object.keys(handlers)
    .filter(key => !['read','readSharing','readAccessCandidates','readAccessGrants','readPublicationSources'].includes(key))]
    .map(key => [key, (...args) => (control[key] || defaults[key])(...args)])));
  data.providers.readPublicationSources = (...args) => {data.calls.push({method: 'readPublicationSources', args});
    return (control.readPublicationSources || defaults.readPublicationSources)(...args);};
  data.data.detail = detail({items: [{item_ref: ITEM, album_ref: ALBUM, title: 'Saved album', artist: 'Saved artist', year: 2001, position: 1}],
    edit_draft: {items: [{item_ref: ITEM, album_ref: ALBUM}], publication_preview_required: false}});
  return {...data, control, live, defaults, last: method => data.calls.filter(row => row.method === method).at(-1)};
}
async function fixture(t, data = backend(), {open = true} = {}) {
  const env = actualChoiceEnvironment(), controller = await preparedController(data), owner = await connectedView(env, data, controller);
  t.after(async () => {owner.dispose(); await settle(); env.assertClean(); env.host.remove();});
  const launch = async () => {const trigger = env.button(env.host, 'Share'); trigger.focus(); env.click(trigger); await settle(); return trigger;};
  if (open) await launch(); return {...env, controller, viewOwner: owner, data, launch};
}
function joined(env) {
  const root = env.content(), grids = root.querySelectorAll('.app-form-joined'); assert.equal(grids.length, 1);
  const grid = grids[0], [publicPane, people] = grid.children;
  assert.equal(grid.children.length, 2); assert.equal(publicPane.id, 'album-top-share-public'); assert.equal(people.id, 'album-top-share-people');
  assert.equal(publicPane.classList.contains('album-top-share__public'), true);
  assert.equal(people.classList.contains('album-top-share__people'), true);
  for (const [pane, id, text] of [[publicPane, 'album-top-share-public-heading', 'Public Share'], [people, 'album-top-share-people-heading', 'People']]) {
    assert.equal(pane.tagName, 'SECTION'); assert.equal(pane.classList.contains('app-form-joined__pane'), true);
    assert.equal(H.visible(pane), true); assert.equal(pane.hidden, false); assert.equal(pane.getAttribute('role'), null);
    assert.equal(pane.getAttribute('aria-labelledby'), id); const heading = pane.querySelector('#' + id);
    assert.ok(heading); assert.equal(heading.textContent, text); assert.equal(heading.classList.contains('app-form-joined__title'), true);
  }
  assert.equal(root.querySelector('[role="tablist"]'), null); assert.equal(root.querySelector('[role="tabpanel"]'), null);
  assert.equal(root.querySelector('[role="tab"]'), null); return {grid, publicPane, people};
}
module.exports = {...N, ...H, ITEM, SOURCE, SHARE, PUBLICATION, candidate, publication, source, backend, fixture, joined, settle};
