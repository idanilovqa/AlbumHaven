const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeHomeRuntime, requireOwner, cards, buttonNamed,
} = require('./native-home-harness.cjs');

// Contract fixtures: final Home response _build_row/build_home_payload. These are
// component-facing DTO fields; unrelated shell fields are omitted. This is not
// an app API mock, backend execution, or E2E acceptance.
function localRow(overrides = {}) {
  return {
    row_kind: 'local_album', local_match_state: 'matched_local', album_ref: 'album:zulu',
    name: 'Zulu record', album_artist: 'Zulu artist', listen_event_count: 7,
    listened_track_count: 3, album_track_count: 11, listened_duration_seconds: 125,
    listened_duration_by_source: { rendered_local_listen_session: 125 }, time_provenance: ['measured_started_at'],
    album_duration_seconds: 2400, completion_state: null, sitting_state: null,
    last_listened_at: '2026-10-04T22:17:00+00:00',
    allowed_actions: { can_open_album: true, can_play_album: true }, ...overrides,
  };
}
function externalRow(overrides = {}) {
  return {
    row_kind: 'external_album', local_match_state: 'not_local',
    name: 'External record', album_artist: 'External artist', listen_event_count: 2,
    listened_track_count: 2, album_track_count: null, listened_duration_seconds: null,
    listened_duration_by_source: { phase_6_json_file_backfill: null }, time_provenance: ['legacy_recorded_at'],
    album_duration_seconds: null, completion_state: null, sitting_state: null,
    last_listened_at: '2026-10-03T18:00:00+00:00',
    remote_cover_url: 'https://images.example.test/external.jpg',
    remote_cover_thumbnail_url: null,
    allowed_actions: { can_open_album: false, can_play_album: false }, ...overrides,
  };
}
function payload(local = [localRow()], external = [externalRow()]) {
  return {
    surface: { active: 'home' },
    recent_local_albums: local, recent_not_local_albums: external,
    artist_groups: [], primary_artist_groups: [], family_artist_groups: [],
    playback_context: { ordered_album_refs: [], albums: [] },
  };
}
function mountRecent() {
  const env = createNativeHomeRuntime({ home: true });
  const owner = requireOwner(env, 'HomeRecent');
  const element = env.document.createElement('section');
  env.document.body.appendChild(element);
  const intents = [];
  const callbacks = Object.fromEntries(['SelectAlbum', 'OpenAlbum', 'PlayAlbum', 'Retry'].map(name => [
    `on${name}`, (...args) => intents.push([name, args]),
  ]));
  const recent = owner.mount(element, callbacks);
  assert.equal(recent.element === element, true, 'HomeRecent keeps the supplied widget element');
  assert.equal(element.contains(recent.header), true, 'header belongs to the supplied widget');
  assert.equal(element.contains(recent.body), true, 'body belongs to the supplied widget');
  return { ...env, recent, element, intents, callbacks };
}
function ready(env, data = payload(), selectedAlbumRef = null) {
  env.recent.update({ status: 'ready', payload: data, selectedAlbumRef });
}

test('Recent display choices reuse native card identity and preserve controlled grants', () => {
  const env = mountRecent(), data = payload();
  env.recent.update({status: 'ready', payload: data, displayMode: 'cards'});
  const original = cards(env.element)[0];
  for (const mode of ['list', 'covers', 'cards']) {
    env.recent.update({status: 'ready', payload: data, displayMode: mode});
    assert.equal(cards(env.element)[0], original);
    assert.equal(original.getAttribute('data-gallery-display'), mode);
    assert.equal(env.element.querySelector('.home-recent__rows').dataset.homeDisplay, mode);
    assert.equal(intentButtons(original, 'play').length, 1);
    assert.equal(original.querySelector('[data-open-tracklist]'), null);
  }
});
function intentButtons(root, intent) {
  return root.querySelectorAll(`[data-gallery-card-intent="${intent}"]`);
}
const albumIntents = [['select', 'SelectAlbum'], ['open', 'OpenAlbum'], ['play', 'PlayAlbum']];
function controlFor(root, intent, ref) {
  const control = intentButtons(root, intent).find(node => node.getAttribute('data-gallery-card-ref') === ref);
  assert.equal(Boolean(control), true, `${intent} control for ${ref} exists`);
  return control;
}
function pinHomeShell(env) {
  const nodes = [env.element, env.recent.header, env.recent.body];
  const parents = nodes.map(node => node.parentNode), start = env.mutations.length;
  return () => {
    nodes.forEach((node, index) => assert.equal(node.parentNode === parents[index], true, `Home shell root ${index}: mount-established parent`));
    assert.equal(env.mutations.slice(start).some(change => nodes.includes(change.node)), false, 'Home updates never temporarily move widget/header/body roots');
  };
}
function assertNoMockModes(root) {
  const forbidden = /^(?:Tracks|Artists|History|Grouped|Period|7 days)$/i;
  for (const control of root.querySelectorAll('button, a, select, [role="tab"]')) {
    for (const [kind, value] of [['visible text', control.textContent], ['accessible label', control.getAttribute('aria-label') || '']]) {
      assert.doesNotMatch(value.trim().replace(/\s+/g, ' '), forbidden, `${kind} cannot expose a mock history mode`);
    }
  }
}
function assertNoNativeHooks(root) {
  assert.equal(root.querySelectorAll('[data-open-tracklist], [data-album], [data-album-key], [data-play-track], [data-play-album], [data-artist-info-trigger], .album-open-trigger').length, 0,
    'Recent must not provide native fallback actions or serialized album payloads');
}

// These extension assertions run against existing published owners even when the
// new modules are absent. Their RED is a behavior failure, not an import failure.
test('controlled GalleryCard emits only explicit authorized reference intents', () => {
  const env = createNativeHomeRuntime();
  const holder = env.document.createElement('div');
  holder.innerHTML = env.context.buildGalleryCardHtml({
    identity: 'local:album:zulu', title: 'Zulu record', artist: 'Zulu artist',
    interaction: 'controlled', actionRef: 'album:zulu', actions: { select: true, open: true, play: true },
    albumKey: 'MUST-NOT-LEAK', albumFallback: '{"tracks":["MUST-NOT-LEAK"]}',
    artboxHtml: env.context.buildAlbumArtboxHtml({ state: 'empty' }),
  });
  assertNoNativeHooks(holder);
  for (const intent of ['select', 'open', 'play']) {
    const controls = intentButtons(holder, intent);
    assert.equal(controls.length, 1, `one independent ${intent} control`);
    assert.equal(controls[0].tagName, 'BUTTON', `${intent} is a native keyboard-operable button`);
    assert.equal(controls[0].getAttribute('data-gallery-card-ref'), 'album:zulu');
    assert.equal(Boolean(controls[0].getAttribute('aria-label') || controls[0].textContent.trim()), true, `${intent} has an accessible name`);
  }
  const play = intentButtons(holder, 'play')[0];
  assert.equal(play.classList.contains('action-button'), true, 'play uses native ActionButton');
  assert.equal(play.querySelectorAll('.ui-icon--play').length, 1, 'play uses the native play glyph');
  assert.doesNotMatch(holder.innerHTML, /MUST-NOT-LEAK/);
});

test('controlled and none GalleryCard modes cannot turn truthy values or absent references into authority', () => {
  const env = createNativeHomeRuntime();
  for (const config of [
    { interaction: 'none', actionRef: 'album:zulu', actions: { select: true, open: true, play: true } },
    { interaction: 'controlled', actionRef: '', actions: { select: true, open: true, play: true } },
    { interaction: 'controlled', actionRef: 'album:zulu', actions: { select: 'true', open: 1, play: {} } },
    { interaction: 'controlled', actionRef: 'album:zulu', actions: { select: false, open: false, play: false } },
  ]) {
    const holder = env.document.createElement('div');
    holder.innerHTML = env.context.buildGalleryCardHtml({ title: 'Read only', ...config });
    assertNoNativeHooks(holder);
    assert.equal(holder.querySelectorAll('[data-gallery-card-intent]').length, 0, 'no active controlled hook without exact grants');
    assert.equal(holder.querySelectorAll('button, a, [tabindex]').length, 0, 'read-only card has no interactive control');
  }
});

test('GalleryCardInfo summary slot replaces ordinary totals and preserves the default Gallery summary', () => {
  const env = createNativeHomeRuntime();
  const summary = '<span class="listening-proof">3 listened tracks · 2m 05s listened</span>';
  const recent = env.context.buildGalleryCardInfoHtml({ title: 'Record', trackCount: 99, lengthDisplay: '88m', listeningSummaryHtml: summary });
  assert.equal(recent.includes(summary), true, 'supplied listening facts occupy the native info slot');
  assert.doesNotMatch(recent, /99 tracks|88m/);
  const gallery = env.context.buildGalleryCardInfoHtml({ title: 'Record', trackCount: 99, lengthDisplay: '88m' });
  assert.match(gallery, /99 tracks/);
  assert.match(gallery, /88m/);
});

test('Recent GalleryBar variant honors its native title/actions without adding Gallery filters or invented totals', () => {
  const env = createNativeHomeRuntime();
  const action = env.context.ButtonComponent.renderActionButton({ ariaLabel: 'Native proof action', icon: 'play' });
  const recent = env.context.buildGalleryBarHtml({ contextKind: 'recent', title: 'Recent <safe>', actionsHtml: action });
  assert.match(recent, /Recent &lt;safe&gt;/);
  assert.equal(recent.includes(action), true, 'native action fragment survives composition');
  assert.doesNotMatch(recent, /data-gallery-bar-action|data-gallery-view-choice|0 artists|0 albums|id="gallery-/);
  const gallery = env.context.buildGalleryBarHtml({});
  for (const actionName of ['artist-family', 'view', 'album-types']) assert.match(gallery, new RegExp(`data-gallery-bar-action="${actionName}"`));
});

test('default GalleryCard native open behavior remains the existing Gallery contract', () => {
  const env = createNativeHomeRuntime();
  const config = { identity: 'gallery:1', albumKey: 'key', albumVersionKey: 'version', albumFallback: '{}', title: 'Native record', trackCount: 5, lengthDisplay: '40m' };
  const implicit = env.context.buildGalleryCardHtml(config);
  assert.equal(implicit, env.context.buildGalleryCardHtml({ ...config, interaction: 'native' }), 'omitted mode is byte-equivalent to explicit native mode');
  assert.match(implicit, /data-open-tracklist="1"/);
  assert.match(implicit, /album-open-trigger/);
  assert.match(implicit, /data-album-key="key"/);
  assert.match(implicit, /5 tracks/);
  assert.doesNotMatch(implicit, /data-gallery-card-intent/);
});

test('HomeRecent exposes its required controlled API and rejects missing intent callbacks', () => {
  const env = createNativeHomeRuntime({ home: true });
  const owner = requireOwner(env, 'HomeRecent');
  for (const omitted of ['onSelectAlbum', 'onOpenAlbum', 'onPlayAlbum', 'onRetry']) {
    const options = { onSelectAlbum() {}, onOpenAlbum() {}, onPlayAlbum() {}, onRetry() {} };
    delete options[omitted];
    assert.throws(() => owner.mount(env.document.createElement('section'), options), { name: 'TypeError' }, `${omitted} is required`);
  }
});

test('HomeRecent renders real local/external DTO rows in server order with native art and listening facts', () => {
  const env = mountRecent();
  const rows = [localRow(), localRow({ album_ref: 'album:alpha', name: 'Alpha record', last_listened_at: '2026-10-04T23:00:00+00:00' })];
  ready(env, payload(rows, [externalRow({ name: 'Zulu external' }), externalRow({ name: 'Alpha external', last_listened_at: '2026-10-04T23:00:00+00:00' })]));
  const rendered = cards(env.recent.body);
  assert.equal(rendered.length, 4);
  assert.deepEqual(rendered.map(card => card.querySelector('.album-title').textContent.trim()), ['Zulu record', 'Alpha record', 'Zulu external', 'Alpha external'], 'both server-ordered groups win over alphabetic or timestamp sorting');
  const local = rendered[0];
  assert.match(local.textContent, /Zulu artist/);
  assert.match(local.textContent, /7\s+(?:listen\s+)?events|7\s+listens/i);
  assert.match(local.textContent, /3\s+(?:listened\s+)?tracks/i);
  assert.match(local.textContent, /11/);
  assert.match(local.textContent, /2m\s*0?5s/);
  assert.equal(local.querySelector('time')?.getAttribute('datetime'), rows[0].last_listened_at, 'last-listened timestamp is retained as a machine-readable time');
  assert.equal(local.querySelectorAll('[data-album-artbox-state="empty"]').length, 1, 'local summary has native empty artwork');
  assert.equal(local.querySelectorAll('img').length, 0, 'no invented local cover URL');
  assert.equal(rendered[2].querySelector('img')?.getAttribute('src'), 'https://images.example.test/external.jpg');
  assert.match(env.recent.body.textContent, /Not local listens/);
  assert.doesNotMatch(env.recent.body.textContent, /full listens|full sessions|single sitting|0 tracks|0m|NaN|undefined|null/i);
  assertNoNativeHooks(env.element);
});

test('HomeRecent omits unknown totals/durations/completion rather than turning null into zero', () => {
  const env = mountRecent();
  ready(env, payload([localRow({ album_track_count: null, listened_duration_seconds: null, album_duration_seconds: null })], []));
  const row = cards(env.recent.body)[0];
  assert.match(row.textContent, /3\s+(?:listened\s+)?tracks/i);
  assert.doesNotMatch(row.textContent, /\b0\b|full listen|complete|sitting|NaN|undefined|null/i);
  assert.doesNotMatch(env.recent.body.textContent, /Not local listens/);
});

test('HomeRecent does not synthesize mock history modes, track lists, artist history or local resources', () => {
  const env = mountRecent();
  ready(env, payload());
  assertNoMockModes(env.element);
  const proof = env.document.createElement('div');
  for (const label of ['Tracks', 'Artists', 'History', 'Grouped', 'Period', '7 days']) {
    proof.innerHTML = env.context.ButtonComponent.renderButton({ label, ariaLabel: label });
    assert.throws(() => assertNoMockModes(proof), { name: 'AssertionError' }, `duplicated ${label} labels still fail the control guard`);
  }
  assert.equal(env.element.querySelectorAll('table, audio, source, [data-track-path], [data-src], [data-album]').length, 0);
  assert.doesNotMatch(env.element.innerHTML, /\/cover\?|\/track\?|\/album-art\?|file:\/\//i);
  assert.deepEqual(env.forbiddenCalls, []);
});

test('HomeRecent gives loading, ready-empty, error and denied distinct native status presentations', () => {
  const env = mountRecent();
  const messages = [], assertStableShell = pinHomeShell(env);
  for (const status of ['loading', 'ready', 'error', 'denied']) {
    env.recent.update({ status, payload: payload([], []), selectedAlbumRef: null });
    assert.equal(cards(env.recent.body).length, 0, `${status} has no album rows`);
    assert.equal(env.recent.body.querySelectorAll('[data-on-page-alert]').length, 1, `${status} uses native alert presentation`);
    const message = env.recent.body.textContent.trim();
    assert.equal(message.length > 0, true, `${status} is explained`);
    messages.push(message);
    assertStableShell();
    const retry = buttonNamed(env.recent.body, /retry/i, false);
    assert.equal(Boolean(retry), status === 'error', 'retry is an error-only caller intent');
    if (retry) {
      assert.equal(retry.classList.contains('ui-button'), true);
      env.click(retry);
      assert.deepEqual(env.intents, [['Retry', []]]);
    }
  }
  assert.equal(new Set(messages).size, 4, 'empty success cannot stand in for loading/failure/denial');
});

test('malformed ready payload arrays produce native error rather than empty success or Gallery fallback', () => {
  const env = mountRecent();
  for (const bad of [null, {}, { recent_local_albums: [], recent_not_local_albums: null }, { recent_local_albums: {}, recent_not_local_albums: [] }]) {
    env.recent.update({ status: 'ready', payload: bad, selectedAlbumRef: null });
    assert.equal(cards(env.recent.body).length, 0);
    assert.equal(env.recent.body.querySelectorAll('[data-on-page-alert="error"]').length, 1, 'invalid DTO is an error');
    assert.equal(Boolean(buttonNamed(env.recent.body, /retry/i)), true);
  }
});

test('selection, explicit open and PLAY emit exactly one authorized reference intent without native bubbling', () => {
  const env = mountRecent();
  const zulu = localRow(), alpha = localRow({ album_ref: 'album:alpha', name: 'Alpha record' });
  let outerClicks = 0;
  env.document.body.addEventListener('click', () => { outerClicks += 1; });
  const expected = [];
  for (const orderedRows of [[zulu, alpha], [alpha, zulu]]) {
    ready(env, payload(orderedRows, []));
    for (const ref of ['album:zulu', 'album:alpha']) {
      for (const [intent, callback] of albumIntents) {
        const control = controlFor(env.recent.body, intent, ref);
        env.click(control.querySelector('svg, span') || control);
        expected.push([callback, [ref]]);
        assert.deepEqual(env.intents, expected, `${intent} resolves ${ref} independently before/after reordering`);
      }
    }
  }
  assert.equal(outerClicks, 0, 'handled album actions cannot reach a native Gallery owner');
  assert.deepEqual(env.forbiddenCalls, []);
});

test('server action gates reject denied, external, malformed and truthy-but-not-true grants', () => {
  const env = mountRecent();
  const badLocal = [
    localRow({ album_ref: 'denied', allowed_actions: { can_open_album: false, can_play_album: true } }),
    localRow({ album_ref: 'truthy', allowed_actions: { can_open_album: 'true', can_play_album: 1 } }),
    localRow({ album_ref: 'inherited', allowed_actions: Object.create({ can_open_album: true, can_play_album: true }) }),
    localRow({ album_ref: 'unmatched', local_match_state: 'not_local' }),
    localRow({ album_ref: 'unknown-kind', row_kind: 'unknown' }),
    localRow({ album_ref: '' }), localRow({ album_ref: null }),
  ];
  ready(env, payload(badLocal, [externalRow({ album_ref: 'contradictory-external', allowed_actions: { can_open_album: true, can_play_album: true } })]));
  assert.equal(env.element.querySelectorAll('[data-gallery-card-intent]').length, 0);
  assertNoNativeHooks(env.element);
  for (const row of cards(env.recent.body)) env.click(row);
  assert.deepEqual(env.intents, []);
});

test('custom detail selection uses the native card without authorizing Open or Play', () => {
  const env = mountRecent(), row = localRow({allowed_actions: {can_view_details: true, can_open_album: false, can_play_album: true}});
  let outerClicks = 0;
  env.document.body.addEventListener('click', () => {outerClicks++;});
  for (const displayMode of ['list', 'cards', 'covers']) {
    env.recent.update({status: 'ready', payload: payload([row], []), selectionMode: 'details', displayMode, selectedAlbumRef: row.album_ref});
    const select = controlFor(env.recent.body, 'select', row.album_ref), card = select.closest('.album-card');
    assert.equal(card.getAttribute('data-gallery-display'), displayMode);
    assert.equal(select.tagName, 'BUTTON'); assert.equal(select.getAttribute('aria-pressed'), 'true');
    assert.equal(intentButtons(card, 'open').length, 0); assert.equal(intentButtons(card, 'play').length, 0);
    assertNoNativeHooks(card);
    env.click(select.querySelector('svg, span') || select);
    assert.deepEqual(env.intents.splice(0), [['SelectAlbum', [row.album_ref]]]);
    // Even a forged current-card intent cannot turn the detail grant into
    // browsing or playback authority at the delegated activation boundary.
    for (const intent of ['open', 'play']) {
      const forged = env.document.createElement('button');
      forged.setAttribute('data-gallery-card-intent', intent); forged.setAttribute('data-gallery-card-ref', row.album_ref);
      card.append(forged); env.click(forged); forged.remove();
    }
    assert.deepEqual(env.intents, []);
  }
  assert.equal(outerClicks, 0); assert.deepEqual(env.forbiddenCalls, []);
});

test('custom selection requires its own exact grant while native Open and Play remain independent', () => {
  const env = mountRecent(), nativeGrants = {can_open_album: true, can_play_album: true};
  const grants = [nativeGrants, {...nativeGrants, can_view_details: false}, {...nativeGrants, can_view_details: 'true'},
    Object.assign(Object.create({can_view_details: true}), nativeGrants),
    {can_view_details: true, can_open_album: true, can_play_album: false},
    Object.assign(Object.create({can_open_album: true, can_play_album: true}), {can_view_details: true})];
  const rows = grants.map((allowed_actions, index) => localRow({album_ref: `album:grant-${index}`, allowed_actions}));
  env.recent.update({status: 'ready', payload: payload(rows, []), selectionMode: 'details'});
  for (let index = 0; index < rows.length; index++) {
    const ref = rows[index].album_ref, card = cards(env.recent.body)[index];
    assert.equal(intentButtons(card, 'select').length, index >= 4 ? 1 : 0, `detail selection grant ${index}`);
    assert.equal(intentButtons(card, 'open').length, index < 5 ? 1 : 0, `native Open grant ${index}`);
    assert.equal(intentButtons(card, 'play').length, index < 4 ? 1 : 0, `native Play grant ${index}`);
    for (const [intent, callback] of albumIntents) {
      const control = intentButtons(card, intent)[0];
      if (control) {env.click(control); assert.deepEqual(env.intents.splice(0), [[callback, [ref]]]);}
      else {
        const forged = env.document.createElement('button');
        forged.setAttribute('data-gallery-card-intent', intent); forged.setAttribute('data-gallery-card-ref', ref);
        card.append(forged); env.click(forged); forged.remove(); assert.deepEqual(env.intents, []);
      }
    }
  }
});

test('detail selection rejects external, ambiguous and malformed identities despite supplied detail grants', () => {
  const env = mountRecent(), allowed_actions = {can_view_details: true};
  const rows = [localRow({album_ref: 'duplicate', allowed_actions}), localRow({album_ref: 'duplicate', allowed_actions}),
    localRow({album_ref: '', allowed_actions}), localRow({album_ref: 'unmatched', local_match_state: 'not_local', allowed_actions})];
  env.recent.update({status: 'ready', payload: payload(rows, [externalRow({album_ref: 'external', allowed_actions})]), selectionMode: 'details'});
  assert.equal(env.recent.body.querySelectorAll('[data-gallery-card-intent]').length, 0);
  assertNoNativeHooks(env.recent.body);
});

test('changing the detail reader mode or row grant immediately retires former Select controls', () => {
  const row = localRow({allowed_actions: {can_view_details: true, can_open_album: false, can_play_album: false}});
  for (const change of ['reader removed', 'grant denied', 'grant inherited', 'loading', 'denied']) {
    const env = mountRecent();
    env.recent.update({status: 'ready', payload: payload([row], []), selectionMode: 'details'});
    const previous = controlFor(env.recent.body, 'select', row.album_ref), card = previous.closest('.album-card');
    const nextRow = change === 'grant denied' ? {...row, allowed_actions: {can_view_details: false}}
      : change === 'grant inherited' ? {...row, allowed_actions: Object.create({can_view_details: true})} : row;
    env.recent.update({status: ['loading', 'denied'].includes(change) ? change : 'ready',
      payload: payload([nextRow], []), selectionMode: change === 'reader removed' ? 'native' : 'details'});
    assert.equal(intentButtons(env.recent.body, 'select').length, 0, change);
    // Reinsert the old control into its actual keyed card so a detached-node
    // check alone cannot pass the current-mode/current-grant assertion.
    card.append(previous); if (!env.recent.body.contains(card)) env.recent.body.append(card);
    env.click(previous); assert.deepEqual(env.intents, [], change);
    env.recent.dispose();
  }
});

test('open permission does not imply PLAY and stale references lose authority on every current-state replacement', () => {
  const env = mountRecent();
  ready(env, payload([localRow({ allowed_actions: { can_open_album: true, can_play_album: 'true' } })], []));
  assert.equal(intentButtons(env.recent.body, 'select').length, 1);
  assert.equal(intentButtons(env.recent.body, 'open').length, 1);
  assert.equal(intentButtons(env.recent.body, 'play').length, 0);
  const zulu = localRow(), alpha = localRow({ album_ref: 'album:alpha', name: 'Alpha record' });
  const beta = localRow({ album_ref: 'album:beta', name: 'Beta record' });
  const transitions = [
    { label: 'revoked with another allowed row', status: 'ready', payload: payload([{ ...zulu, allowed_actions: { can_open_album: false, can_play_album: false } }, alpha], []), allowedRef: alpha.album_ref },
    { label: 'removed while another row remains', status: 'ready', payload: payload([alpha], []), allowedRef: alpha.album_ref },
    { label: 'ready-empty', status: 'ready', payload: payload([], []) },
    { label: 'replaced by a different allowed ref', status: 'ready', payload: payload([beta], []), allowedRef: beta.album_ref },
    ...['loading', 'error', 'denied'].map(status => ({ label: status, status, payload: payload([zulu, alpha], []) })),
    { label: 'malformed ready becomes error', status: 'ready', payload: { recent_local_albums: [], recent_not_local_albums: null } },
  ];
  for (const transition of transitions) {
    const current = mountRecent();
    ready(current, payload([zulu, alpha], []));
    const retired = albumIntents.map(([intent]) => controlFor(current.recent.body, intent, zulu.album_ref));
    for (const control of retired) current.click(control);
    assert.deepEqual(current.intents, albumIntents.map(([, callback]) => [callback, [zulu.album_ref]]), `${transition.label}: live event path reaches every intent`);
    current.intents.length = 0;
    // Preserve the actual card and all its native ancestor wrappers below body.
    // Transplant the exact saved controls into that emitted-markup snapshot so a
    // structural containment check cannot stand in for current-row authority.
    let nativeSubtree = retired[0].closest('.album-card');
    assert.equal(Boolean(nativeSubtree), true, 'saved controls originate in a native card');
    while (nativeSubtree.parentNode !== current.recent.body) nativeSubtree = nativeSubtree.parentNode;
    const holder = current.document.createElement('div');
    holder.innerHTML = nativeSubtree.outerHTML;
    const staleSubtree = holder.firstElementChild;
    const staleCard = controlFor(staleSubtree, 'select', zulu.album_ref).closest('.album-card');
    for (const [index, control] of retired.entries()) {
      const placeholder = controlFor(staleSubtree, albumIntents[index][0], zulu.album_ref);
      placeholder.parentNode.insertBefore(control, placeholder);
      placeholder.remove();
    }
    current.recent.update({ status: transition.status, payload: transition.payload, selectedAlbumRef: zulu.album_ref });
    current.recent.body.appendChild(staleSubtree);
    for (const [index, control] of retired.entries()) {
      assert.equal(control.getAttribute('data-gallery-card-ref'), zulu.album_ref, 'saved stale control retains the retired ref');
      assert.equal(control.closest('.album-card') === staleCard, true, 'stale intent retains its native card ancestor');
      assert.equal(current.recent.body.contains(control), true, 'stale intent remains inside the mounted Home body');
      current.click(control);
      assert.deepEqual(current.intents, [], `${transition.label}: stale ${albumIntents[index][0]} cannot borrow current authority`);
    }
    staleSubtree.remove();
    if (transition.allowedRef) {
      for (const [intent] of albumIntents) current.click(controlFor(current.recent.body, intent, transition.allowedRef));
      assert.deepEqual(current.intents, albumIntents.map(([, callback]) => [callback, [transition.allowedRef]]), `${transition.label}: current exact ref still works`);
    }
    current.recent.dispose();
  }
});

test('unchanged and changed rows retain keyed card identity without borrowing another album selection', () => {
  const env = mountRecent();
  const first = localRow(), second = localRow({ album_ref: 'album:alpha', name: 'Alpha record' });
  const assertStableShell = pinHomeShell(env);
  ready(env, payload([first, second], [externalRow()]), first.album_ref);
  const initial = cards(env.recent.body), header = env.recent.header, body = env.recent.body;
  const parents = initial.map(row => row.parentNode);
  env.recent.body.scrollTop = 137; env.recent.body.scrollLeft = 29;
  ready(env, payload([first, second], [externalRow()]), first.album_ref);
  const unchanged = cards(env.recent.body);
  unchanged.forEach((row, index) => assert.equal(row === initial[index], true, `unchanged row ${index} retains identity`));
  ready(env, payload([{ ...second, name: 'Alpha updated' }, first], [externalRow()]), second.album_ref);
  const next = cards(env.recent.body);
  assert.equal(next[0] === initial[1], true, 'updated Alpha keeps its card');
  assert.equal(next[1] === initial[0], true, 'reordered Zulu keeps its card');
  assert.equal(next[2] === initial[2], true, 'external response identity remains stable');
  assert.equal(next[0].parentNode === parents[1], true, 'row parent remains stable');
  assert.match(next[0].textContent, /Alpha updated/);
  assert.equal(intentButtons(next[0], 'select')[0].getAttribute('aria-pressed'), 'true');
  assert.equal(intentButtons(next[1], 'select')[0].getAttribute('aria-pressed'), 'false');
  assert.equal(env.recent.header === header, true, 'header instance stays owned');
  assert.equal(env.recent.body === body, true, 'scroll body instance stays owned');
  assert.equal(body.scrollTop, 137); assert.equal(body.scrollLeft, 29);
  assertStableShell();
});

test('denial clears old private rows and stale action references while retaining the stable widget shell', () => {
  const env = mountRecent();
  ready(env);
  const body = env.recent.body, header = env.recent.header;
  const oldSelect = intentButtons(body, 'select')[0];
  env.recent.update({ status: 'denied', payload: payload(), selectedAlbumRef: 'album:zulu' });
  assert.equal(env.recent.body === body, true); assert.equal(env.recent.header === header, true);
  assert.equal(cards(body).length, 0);
  assert.doesNotMatch(body.textContent, /Zulu|External record/);
  body.appendChild(oldSelect); env.click(oldSelect);
  assert.deepEqual(env.intents, [], 'denial revokes previously rendered intent authority');
});

test('untrusted DTO text and both external artwork fields preserve safe URLs without local or script authority', () => {
  const env = mountRecent();
  const full = 'https://images.example.test/full.jpg?name="quoted"&edition=one';
  const thumb = 'https://images.example.test/thumb.jpg?name="quoted"&edition=two';
  const cases = [
    { label: 'safe full only', full, thumb: null, expected: full },
    { label: 'safe thumbnail only', full: null, thumb, expected: thumb },
    { label: 'thumbnail survives unsafe full', full: 'javascript:bad()', thumb, expected: thumb },
    { label: 'full survives unsafe thumbnail', full, thumb: 'javascript:bad()', expected: full },
  ];
  for (const unsafe of ['javascript:alert(1)', 'file:///private/cover.jpg', '/cover?path=private', 'data:text/html,unsafe', 'https://user:password@images.example.test/cover.jpg', 'https://user@images.example.test/cover.jpg']) {
    cases.push({ label: `unsafe full ${unsafe}`, full: unsafe, thumb: null, expected: null });
    cases.push({ label: `unsafe thumbnail ${unsafe}`, full: null, thumb: unsafe, expected: null });
  }
  for (const entry of cases) {
    ready(env, payload([localRow({ name: '<img src=x onerror=bad()>', album_artist: '<script>bad()</script>' })], [externalRow({ remote_cover_url: entry.full, remote_cover_thumbnail_url: entry.thumb })]));
    const [local, external] = cards(env.recent.body);
    assert.match(local.textContent, /<img src=x onerror=bad\(\)>/);
    assert.equal(local.querySelectorAll('img').length, 0, 'local summaries keep native empty artwork');
    assert.equal(local.querySelectorAll('[data-album-artbox-state="empty"]').length, 1);
    assert.equal(env.element.querySelectorAll('script, [onerror]').length, 0);
    const images = external.querySelectorAll('img');
    assert.equal(images.length, entry.expected === null ? 0 : 1, entry.label);
    if (entry.expected !== null) {
      assert.equal(images[0].getAttribute('src'), entry.expected, `${entry.label}: quote and ampersand survive parsed attribute escaping exactly`);
      assert.equal(images[0].hasAttribute('edition'), false, 'query text cannot become a second attribute');
    } else {
      assert.equal(external.querySelectorAll('[data-album-artbox-state="empty"]').length, 1, `${entry.label}: native fallback`);
    }
  }
});

test('HomeRecent dispose removes only owned listeners and makes saved callbacks and later updates inert', () => {
  const env = mountRecent();
  ready(env);
  let unrelated = 0;
  const other = () => { unrelated += 1; };
  env.element.addEventListener('click', other);
  const owned = env.listeners().filter(entry => entry.callback !== other);
  assert.equal(owned.length > 0, true, 'component owns real listeners');
  const target = intentButtons(env.recent.body, 'select')[0];
  env.recent.dispose();
  const after = env.element.innerHTML;
  env.recent.dispose();
  env.recent.update({ status: 'ready', payload: payload([localRow({ name: 'Retired injection' })], []), selectedAlbumRef: null });
  for (const entry of owned) entry.callback.call(entry.target, env.event('click', target));
  assert.equal(env.element.innerHTML, after, 'retired renderer cannot repopulate or blank the body');
  assert.deepEqual(env.intents, []);
  assert.equal(env.listeners().filter(entry => entry.callback !== other).length, 0, 'owned listeners were removed');
  env.click(env.element);
  assert.equal(unrelated, 1, 'caller listener survives disposal');
  assert.deepEqual(env.forbiddenCalls, []);
});
