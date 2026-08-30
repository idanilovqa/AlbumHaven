const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'tag-editor-and-optimistic-updates.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(albums, overrides = {}) {
  const context = {
    console,
    claimTagEditViewMutation(album, editedPaths, updates) {
      return { album, editedPaths, updates };
    },
    tagEditViewMutationStillOwnsResources() {
      return true;
    },
    settleTagEditViewMutation() {},
    releaseFailedTagEditViewMutation() {},
    getTrackTagInitialValues(track, album) {
      const usesTrackOwnedIdentity = album?.tag_editor_collection === true;
      return {
        artist: usesTrackOwnedIdentity
          ? String(track?.tag_artist ?? track?.artist ?? '')
          : String(track?.tag_artist || track?.artist || album?.album_artist || ''),
        album_artist: usesTrackOwnedIdentity
          ? String(track?.album_artist ?? '')
          : String(track?.album_artist || album?.raw_album_artist || album?.album_artist || track?.artist || ''),
        album: usesTrackOwnedIdentity || Object.prototype.hasOwnProperty.call(track || {}, 'album')
          ? String(track?.album ?? '')
          : String(album?.raw_name || album?.name || ''),
        title: String(track?.title || ''),
        genre: String(track?.genre || ''),
        year: String(track?.year ?? album?.year ?? ''),
        track_number: String(track?.track_number ?? ''),
        disc_number: String(track?.disc_number ?? ''),
        exception_type: String(track?.exception_type || ''),
        edition: String(track?.edition || album?.edition || ''),
        album_rating: String(track?.album_rating ?? album?.album_rating ?? ''),
      };
    },
    state: {
      view: {
        artist_groups: [
          {
            artist: 'Porcupine Tree',
            albums,
          },
        ],
        primary_artist_groups: [],
        family_artist_groups: [],
        ignored_version_keys: [],
        manual_version_links: {},
      },
      gallery: {
        playbackPreferences: {
          albumTopsEndBehavior: 'continue',
          artistPagesEndBehavior: 'stop',
        },
      },
    },
  };
  Object.assign(context, overrides);

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

test('buildPlayerTrackPayload carries numeric duration_seconds into durationSeconds', () => {
  const context = loadHelper([]);

  const payload = context.buildPlayerTrackPayload({
    path: 'C:\\Music\\Timed.flac',
    title: 'Timed',
    duration_seconds: 123.5,
  });

  assert.equal(payload.durationSeconds, 123.5);
});

test('track modal play button exposes numeric duration seconds', () => {
  const context = loadHelper([], {
    state: { player: { current: null } },
    escapeHtml: (value) => String(value ?? ''),
    formatAlbumDuration: () => '',
    formatTrackDuration: () => '3:00',
    getPlayerPlaybackSnapshot: () => ({ paused: true, ended: false }),
  });

  const markup = context.buildTrackListHtml([
    {
      path: 'C:\\Music\\Timed.flac',
      title: 'Timed',
      duration_seconds: 180,
    },
  ]);

  assert.match(markup, /data-track-duration-seconds="180"/);
});

test('track modal playback refresh preserves generic Play track and Pause track accessible names', () => {
  const trackPath = 'C:\\Music\\Named Track.flac';
  const attributes = new Map([
    ['data-track-row-path', trackPath],
    ['data-track-title', 'Named Track'],
  ]);
  const button = {
    innerHTML: '',
    getAttribute(name) { return attributes.get(name) || ''; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
  };
  const row = {
    classList: { toggle() {} },
    getAttribute(name) { return attributes.get(name) || ''; },
    querySelector(selector) {
      return selector === '.play-track-button' ? button : null;
    },
  };
  const playback = { currentTime: 0, duration: 180, ended: false, paused: false };
  const context = loadHelper([], {
    state: { player: { current: { path: trackPath } } },
    document: {
      getElementById(id) { return id === 'track-modal' ? { hidden: false } : null; },
      querySelectorAll(selector) {
        return selector === '#track-modal [data-track-row-path]' ? [row] : [];
      },
    },
    formatTrackDuration: () => '0:00',
    getPlayerPlaybackSnapshot: () => playback,
  });

  context.refreshTrackModalPlaybackState();
  assert.equal(attributes.get('aria-label'), 'Pause track');

  playback.paused = true;
  context.refreshTrackModalPlaybackState();
  assert.equal(attributes.get('aria-label'), 'Play track');
});

test('track modal cover transition hides pending image chrome over a blank placeholder', () => {
  const context = loadHelper([], {
    escapeHtml: (value) => String(value || ''),
  });
  const markup = context.buildTrackModalCoverVisualHtml({
    albumName: 'Kaipa',
    localCoverPath: '',
    remoteCoverUrl: 'https://images.example/kaipa.jpg',
  });

  assert.match(markup, /class="track-modal-cover-visual is-loading"/);
  assert.match(markup, /<span class="cover-placeholder" aria-hidden="true"><\/span>/);
  assert.match(markup, /data-cover-visual-state="pending"/);
  assert.match(markup, /aria-hidden="true"/);
  assert.doesNotMatch(markup, /Loading cover art/);
});

{
  const original = {
    key: 'original',
    name: 'Lightbulb Sun',
    album_artist: 'Porcupine Tree',
    year: 2000,
  };
  const specialEdition = {
    key: 'special-edition',
    name: 'Lightbulb Sun (Special Edition)',
    album_artist: 'Porcupine Tree',
    year: 2000,
    edition: 'Special Edition',
    release_date: '2000-11-21',
  };

  const context = loadHelper([original, specialEdition]);
  const releaseSet = context.getAlbumReleaseSet(specialEdition);
  const releaseKeys = Array.from(releaseSet.releases, (item) => item.key);
  const tabLabels = Array.from(releaseSet.releases, (item) => item.tabLabel);

  assert.deepEqual(
    releaseKeys,
    ['original', 'special-edition'],
  );
  assert.equal(releaseSet.selectedIndex, 1);
  assert.deepEqual(
    tabLabels,
    ['Original - 2000', 'Special Edition - 2000'],
  );
}

test('openTagEditor orders a copied track list by disc, track number, and natural filename', () => {
  const originalTracks = [
    { key: 'disc-two', path: 'C:\\Music\\Artist\\Album\\01 - Disc Two.mp3', disc_number: 2, track_number: 1 },
    { key: 'filename-ten', path: 'C:\\Music\\Artist\\Album\\10 - Missing Number.mp3', disc_number: 1, track_number: null },
    { key: 'track-one-zulu', path: 'C:\\Music\\Artist\\Album\\01 - Zulu.mp3', disc_number: 1, track_number: 1 },
    { key: 'filename-two', path: 'C:\\Music\\Artist\\Album\\2 - Missing Number.mp3', disc_number: 1, track_number: null },
    { key: 'missing-disc', path: 'C:\\Music\\Artist\\Album\\01 - Missing Disc.mp3', disc_number: null, track_number: 1 },
    { key: 'track-one-alpha', path: 'C:\\Music\\Artist\\Album\\01 - Alpha.mp3', disc_number: 1, track_number: 1 },
    { key: 'track-two', path: 'C:\\Music\\Artist\\Album\\02 - Track Two.mp3', disc_number: 1, track_number: 2 },
    { key: 'path-lower', path: 'C:\\Music\\Artist\\Album\\03 - caf\u00e9.mp3', disc_number: 1, track_number: 3 },
    { key: 'path-upper', path: 'C:\\Music\\Artist\\Album\\03 - CAFE.mp3', disc_number: 1, track_number: 3 },
    { key: 'key-lower', path: 'C:\\Music\\Artist\\Album\\04 - Same.mp3', disc_number: 1, track_number: 4 },
    { key: 'KEY-LOWER', path: 'C:\\Music\\Artist\\Album\\04 - Same.mp3', disc_number: 1, track_number: 4 },
  ];
  const originalSnapshot = structuredClone(originalTracks);
  const album = {
    key: 'artist-album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: originalTracks,
  };
  const overlay = { hidden: true };
  const boundOverlays = [];
  let renderCount = 0;
  const context = loadHelper([album], {
    bindOverlayPointerOrigin(candidate) {
      boundOverlays.push(candidate);
    },
    document: {
      body: {
        classList: {
          add() {},
        },
      },
    },
    getTagEditorElements() {
      return { overlay };
    },
    getTagEditorTracks() {
      return originalTracks;
    },
    getTrackTagInitialValues(track) {
      return { title: String(track.key || '') };
    },
    renderTagEditor() {
      renderCount += 1;
    },
    showRepairAlert(message) {
      throw new Error(message);
    },
  });

  context.openTagEditor(album, { tracksMode: 'all' });

  assert.deepEqual(
    Array.from(context.state.tagEditor.tracks, (track) => track.key),
    [
      'track-one-alpha',
      'track-one-zulu',
      'track-two',
      'path-upper',
      'path-lower',
      'KEY-LOWER',
      'key-lower',
      'filename-two',
      'filename-ten',
      'disc-two',
      'missing-disc',
    ],
  );
  assert.equal(context.state.tagEditor.selectedPaths[0], originalTracks[5].path);
  assert.equal(context.state.tagEditor.anchorPath, originalTracks[5].path);
  assert.deepEqual(originalTracks, originalSnapshot);
  assert.deepEqual(boundOverlays, [overlay]);
  assert.equal(overlay.hidden, false);
  assert.equal(renderCount, 1);
});

test('opening a tag editor immediately supersedes an older album mutation claim through confirmation', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist-album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Selected' }],
  };
  const olderClaim = { id: 'older-save-task' };
  let activeClaim = olderClaim;
  const claimCalls = [];
  const settledClaims = [];
  const watchedTasks = [];
  const tagEditorOverlay = { hidden: true };
  const closedOverlay = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: {
        classList: {
          add() {},
          remove() {},
        },
      },
      getElementById() {
        return closedOverlay;
      },
    },
    getTagEditorElements() {
      return { overlay: tagEditorOverlay };
    },
    bindOverlayPointerOrigin() {},
    getTagEditConfirmElements() {
      return { overlay: closedOverlay };
    },
    getTagEditorTracks() {
      return album.tracks;
    },
    getTrackTagInitialValues(track) {
      return { title: track.title };
    },
    renderTagEditor() {},
    showRepairAlert() {},
    claimTagEditViewMutation(...args) {
      const claim = { id: `tag-editor-${claimCalls.length + 1}` };
      claimCalls.push({ args, claim });
      activeClaim = claim;
      return claim;
    },
    tagEditViewMutationStillOwnsResources(claim) {
      return claim === activeClaim;
    },
    settleTagEditViewMutation(claim) {
      settledClaims.push(claim);
    },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { title: 'Changed' } };
    },
    deepCloneJson(value) {
      return JSON.parse(JSON.stringify(value));
    },
    buildOptimisticUpdatedAlbumsFromEdits() {
      return [album];
    },
    applyUpdatedAlbumsToCurrentView() {
      return [album];
    },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    watchSaveTask(taskId, options) {
      watchedTasks.push({ taskId, options });
    },
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            save_task_id: 'new-save-task',
            updated_albums: [],
          };
        },
      };
    },
  });

  context.openTagEditor(album, { tracksMode: 'all' });

  assert.equal(
    claimCalls.length,
    1,
    'opening the editor must claim the album before an older canonical response can apply',
  );
  const editorSessionClaim = claimCalls[0].claim;
  assert.equal(context.tagEditViewMutationStillOwnsResources(olderClaim), false);
  assert.equal(context.tagEditViewMutationStillOwnsResources(editorSessionClaim), true);

  context.closeTagEditor();

  assert.deepEqual(
    settledClaims,
    [editorSessionClaim],
    'closing the editor must settle its temporary mutation claim',
  );
  assert.equal(context.tagEditViewMutationStillOwnsResources(olderClaim), false);

  context.openTagEditor(album, { tracksMode: 'all' });
  const reopenedSessionClaim = claimCalls[1].claim;

  await context.confirmManualTagEdit();

  assert.equal(watchedTasks.length, 1);
  const confirmedClaim = watchedTasks[0].options.tagEditMutationClaim;
  assert.ok(
    confirmedClaim === reopenedSessionClaim || confirmedClaim === activeClaim,
    'confirmation must reuse the editor claim or safely transition ownership to its successor',
  );
  assert.deepEqual(
    settledClaims,
    [editorSessionClaim, reopenedSessionClaim],
    'confirmation must settle the reopened temporary claim after creating the full edit claim',
  );
  assert.equal(context.tagEditViewMutationStillOwnsResources(olderClaim), false);
  assert.equal(context.tagEditViewMutationStillOwnsResources(confirmedClaim), true);
  assert.equal(
    watchedTasks[0].options.problematicMutationOriginKey,
    '',
    'an Album Details edit must record that Problematic Files did not originate the task',
  );
});

test('Problematic Files tag edits own the detail overlay before the edit request settles', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Selected' }],
  };
  const response = createDeferred();
  const claims = [];
  const watchedTasks = [];
  const utilityModal = { hidden: false };
  const closedOverlay = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById(id) {
        if (id === 'utility-modal') return utilityModal;
        return closedOverlay;
      },
    },
    getTagEditConfirmElements() { return { overlay: closedOverlay }; },
    getTagEditorElements() { return { overlay: closedOverlay }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { track_number: '2' } };
    },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    buildOptimisticUpdatedAlbumsFromEdits() { return [album]; },
    applyUpdatedAlbumsToCurrentView() { return [album]; },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert() {},
    claimProblematicSaveTaskMutation(taskId, originalAlbum, expectedAlbumKey) {
      const mutation = { taskId, albumKey: expectedAlbumKey };
      claims.push({ taskId, originalAlbum, expectedAlbumKey, mutation });
      return mutation;
    },
    watchSaveTask(taskId, options) {
      watchedTasks.push({ taskId, options });
    },
    fetch() { return response.promise; },
  });
  context.state.utility = {
    activeTab: 'problematic-files',
    loaded: true,
    selectedProblematicKey: album.key,
    pendingProblematicSaveTasks: {},
  };
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  const confirmation = context.confirmManualTagEdit();
  await Promise.resolve();

  assert.equal(claims.length, 1);
  assert.equal(claims[0].taskId, 'optimistic-tag-edit-1');
  assert.strictEqual(claims[0].originalAlbum, album);
  assert.equal(claims[0].expectedAlbumKey, album.key);

  response.resolve({
    ok: true,
    async json() {
      return {
        ok: true,
        save_task_id: 'persisted-save-task',
        save_task_status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
      };
    },
  });
  await confirmation;

  assert.equal(claims[0].mutation.taskId, 'persisted-save-task');
  assert.equal(watchedTasks.length, 1);
  assert.equal(watchedTasks[0].taskId, 'persisted-save-task');
});

test('Album Details falls back to natural filename order when track numbers are missing', () => {
  const context = loadHelper([]);
  const tracks = [
    {
      key: 'filename-ten',
      path: 'C:\\Music\\Artist\\Album\\10 - Tenth Signal.mp3',
      disc_number: 1,
      track_number: null,
    },
    {
      key: 'filename-two',
      path: 'C:\\Music\\Artist\\Album\\2 - Second Signal.mp3',
      disc_number: 1,
      track_number: null,
    },
  ];

  const grouped = context.groupAlbumTracks(tracks);

  assert.deepEqual(
    Array.from(grouped.groups[0].tracks, (track) => track.key),
    ['filename-two', 'filename-ten'],
  );
});

test('Album Details ignores bonus-like album and path words when the raw disc label is ordinary', () => {
  const context = loadHelper([]);
  const grouped = context.groupAlbumTracks([
    {
      path: 'C:\\Music\\Rarity Outtakes Archive\\01 - Ordinary.mp3',
      album: 'Rarity Outtakes Archive',
      disc_number: 1,
      disc_number_raw: '1',
      track_number: 1,
      duration_seconds: 300,
    },
  ]);

  assert.deepEqual(
    Array.from(grouped.groups, (group) => group.isBonus),
    [false],
  );
});

test('Album Details keeps an inferred ordinary CD1 and numeric CD2 out of bonus groups', () => {
  const context = loadHelper([]);
  const grouped = context.groupAlbumTracks([
    {
      path: 'C:\\Music\\Artist\\Album\\01 - First.mp3',
      disc_number: null,
      disc_number_raw: '',
      track_number: 1,
    },
    {
      path: 'C:\\Music\\Artist\\Album\\02 - Second.mp3',
      disc_number: 2,
      disc_number_raw: '2',
      track_number: 2,
    },
  ]);

  assert.deepEqual(
    Array.from(grouped.groups, (group) => ({
      discLabel: group.discLabel,
      isBonus: group.isBonus,
    })),
    [
      { discLabel: 'CD1', isBonus: false },
      { discLabel: 'CD2', isBonus: false },
    ],
  );
});

test('Album Details treats an explicit raw bonus-disc label as bonus evidence', () => {
  const context = loadHelper([]);
  const grouped = context.groupAlbumTracks([
    {
      path: 'C:\\Music\\Artist\\Album\\01 - Bonus.mp3',
      disc_number: 2,
      disc_number_raw: 'Bonus Disc',
      track_number: 1,
      duration_seconds: 270,
    },
  ]);

  assert.deepEqual(
    Array.from(grouped.groups, (group) => ({
      discLabel: group.discLabel,
      isBonus: group.isBonus,
      durationSeconds: group.tracks.reduce(
        (sum, track) => sum + track.duration_seconds,
        0,
      ),
    })),
    [{ discLabel: 'Bonus Disc', isBonus: true, durationSeconds: 270 }],
  );
});

test('Album Details separates exact main and bonus durations for mixed explicit disc labels', () => {
  const context = loadHelper([]);
  const grouped = context.groupAlbumTracks([
    {
      path: 'C:\\Music\\Artist\\Album\\01 - Main.mp3',
      disc_number: 1,
      disc_number_raw: '1',
      track_number: 1,
      duration_seconds: 180,
    },
    {
      path: 'C:\\Music\\Artist\\Album\\02 - Bonus.mp3',
      disc_number: 2,
      disc_number_raw: 'Bonus Disc',
      track_number: 1,
      duration_seconds: 245,
    },
  ]);

  assert.deepEqual(
    Array.from(grouped.groups, (group) => ({
      isBonus: group.isBonus,
      durationSeconds: group.tracks.reduce(
        (sum, track) => sum + track.duration_seconds,
        0,
      ),
    })),
    [
      { isBonus: false, durationSeconds: 180 },
      { isBonus: true, durationSeconds: 245 },
    ],
  );
});

test('Album Details displays the physical track number, then filename number, before row position', () => {
  const context = loadHelper([]);
  const getDisplayNumber = context.getAlbumTrackDisplayNumber;

  assert.deepEqual(
    [
      getDisplayNumber?.({
        path: 'C:\\Music\\Artist\\Album\\03 - Tagged As Seven.mp3',
        track_number: 7,
      }, 0),
      getDisplayNumber?.({
        path: 'C:\\Music\\Artist\\Album\\03. Missing Track Tag.mp3',
        track_number: null,
      }, 1),
      getDisplayNumber?.({
        path: 'C:\\Music\\Artist\\Album\\Untitled.mp3',
        track_number: null,
      }, 8),
    ],
    [7, 3, 9],
  );
});

test('auto-number restarts the configured sequence for each disc in a consecutive range', () => {
  const context = loadHelper([]);
  assert.equal(
    typeof context.buildSelectedTrackNumberValues,
    'function',
    'the runtime must expose the approved pure configurable auto-number helper',
  );
  const tracks = [
    { path: 'D:\\Album\\Disc 1\\01 Existing.flac', disc_number: 1, track_number: 8 },
    { path: 'D:\\Album\\Disc 1\\02 Selected.flac', disc_number: 1, track_number: null },
    { path: 'D:\\Album\\Disc 1\\03 Selected.flac', disc_number: 1, track_number: null },
    { path: 'D:\\Album\\Disc 2\\01 Selected.flac', disc_number: 2, track_number: 12 },
    { path: 'D:\\Album\\Disc 2\\02 Selected.flac', disc_number: 2, track_number: null },
    { path: 'D:\\Album\\Disc 2\\03 Existing.flac', disc_number: 2, track_number: null },
  ];
  const selectedPaths = [tracks[4].path, tracks[1].path, tracks[2].path, tracks[3].path];
  const values = context.buildSelectedTrackNumberValues(tracks, selectedPaths, 7);

  assert.deepEqual(
    JSON.parse(JSON.stringify(values)),
    {
      [tracks[1].path]: '7',
      [tracks[2].path]: '8',
      [tracks[3].path]: '7',
      [tracks[4].path]: '8',
    },
  );
  assert.equal(values[tracks[0].path], undefined);
  assert.equal(values[tracks[5].path], undefined);
});

test('auto-number rejects zero, one, gapped, and invalid-start selections', () => {
  const context = loadHelper([]);
  assert.equal(
    typeof context.buildSelectedTrackNumberValues,
    'function',
    'the runtime must expose the approved pure configurable auto-number helper',
  );
  const tracks = [
    { path: 'D:\\Album\\01 Only.flac', disc_number: 1, track_number: 7 },
    { path: 'D:\\Album\\02 Other.flac', disc_number: 1, track_number: 9 },
    { path: 'D:\\Album\\03 Last.flac', disc_number: 1, track_number: 11 },
  ];
  const build = (selectedPaths, startAt) => JSON.parse(JSON.stringify(
    context.buildSelectedTrackNumberValues(tracks, selectedPaths, startAt),
  ));

  assert.deepEqual(build([], 3), {});
  assert.deepEqual(build([tracks[0].path], 3), {});
  assert.deepEqual(build([tracks[0].path, tracks[2].path], 3), {});
  for (const invalidStart of ['', 0, -1, 1.5, 'two', null, undefined]) {
    assert.deepEqual(
      build([tracks[0].path, tracks[1].path], invalidStart),
      {},
      `start ${String(invalidStart)} must be rejected`,
    );
  }
});

test('auto-number uses deterministic file order instead of selected-path order', () => {
  const context = loadHelper([]);
  const tracks = [
    { path: 'D:\\Album\\10 Later.flac', disc_number: 1, track_number: null },
    { path: 'D:\\Album\\2 Earlier.flac', disc_number: 1, track_number: null },
  ];

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSelectedTrackNumberValues(
      tracks,
      [tracks[0].path, tracks[1].path],
      4,
    ))),
    {
      [tracks[1].path]: '4',
      [tracks[0].path]: '5',
    },
  );
  assert.equal(
    context.deriveTagEditorAutoNumberStart(
      [
        { path: 'D:\\Album\\02 Filename Evidence.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\03 Next.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\10 Later.flac', disc_number: 1, track_number: null },
      ],
      ['D:\\Album\\02 Filename Evidence.flac', 'D:\\Album\\03 Next.flac'],
    ),
    '2',
    'a consecutive 02/03 selection derives its start from the leading filename number',
  );
  assert.equal(
    context.deriveTagEditorAutoNumberStart(
      [
        { path: 'D:\\Album\\01 First.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\02 Second.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\03 Third.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\Alpha.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\Beta.flac', disc_number: 1, track_number: null },
      ],
      ['D:\\Album\\Alpha.flac', 'D:\\Album\\Beta.flac'],
    ),
    '4',
    'a no-leading selection derives the first selected track\'s 1-based ordered index',
  );
  assert.equal(
    context.deriveTagEditorAutoNumberStart(
      [
        { path: 'D:\\Album\\Alpha.flac', disc_number: 1, track_number: null },
        { path: 'D:\\Album\\Beta.flac', disc_number: 1, track_number: null },
      ],
      ['D:\\Album\\Alpha.flac', 'D:\\Album\\Beta.flac'],
    ),
    '1',
    'a first-row no-leading selection falls back to its 1-based ordered index',
  );
});

test('auto-number remains staged during track inspection and restores from its original range', () => {
  const firstPath = 'D:\\Album\\01 First.flac';
  const secondPath = 'D:\\Album\\02 Second.flac';
  const tracks = [
    { path: firstPath, disc_number: 1, track_number: 11 },
    { path: secondPath, disc_number: 2, track_number: 12 },
  ];
  let renderCount = 0;
  let selectedPaths = [firstPath, secondPath];
  const controls = { hidden: true };
  const startInput = { value: '4' };
  const buttonAttributes = new Map();
  const button = {
    disabled: true,
    setAttribute(name, value) { buttonAttributes.set(name, value); },
  };
  const elements = {
    'tag-editor-auto-number-controls': controls,
    'tag-editor-auto-number-start': startInput,
    'tag-editor-auto-number': button,
  };
  const context = loadHelper([], {
    document: {
      getElementById(id) { return elements[id] || null; },
    },
    getSelectedTagEditorPaths() { return selectedPaths; },
    getTagEditorElements() {
      return { autoNumberStart: startInput };
    },
    renderTagEditor() { renderCount += 1; },
  });
  context.state.tagEditor = {
    tracks,
    values: {
      [firstPath]: {
        disc_number: '1', genre: 'Rock', title: 'First', track_number: '11',
      },
      [secondPath]: {
        disc_number: '2', genre: 'Metal', title: 'Second', track_number: '12',
      },
    },
    autoNumberStartValue: '4',
    autoNumberSelectionSignature: '',
    autoNumberActive: false,
    autoNumberAppliedSelectionSignature: '',
    autoNumberTrackNumberSnapshots: {},
  };

  context.syncTagEditorAutoNumberControls();
  startInput.value = '4';
  context.state.tagEditor.autoNumberStartValue = '4';
  context.autoNumberSelectedTagEditorTracks();

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.tagEditor.values)), {
    [firstPath]: { disc_number: '1', genre: 'Rock', title: 'First', track_number: '4' },
    [secondPath]: { disc_number: '2', genre: 'Metal', title: 'Second', track_number: '4' },
  });
  assert.equal(context.state.tagEditor.autoNumberActive, true);
  assert.equal(buttonAttributes.get('aria-pressed'), 'true');

  selectedPaths = [firstPath];
  context.syncTagEditorAutoNumberControls();

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.tagEditor.values)), {
    [firstPath]: { disc_number: '1', genre: 'Rock', title: 'First', track_number: '4' },
    [secondPath]: { disc_number: '2', genre: 'Metal', title: 'Second', track_number: '4' },
  });
  assert.equal(buttonAttributes.get('aria-pressed'), 'false');

  selectedPaths = [firstPath, secondPath];
  context.syncTagEditorAutoNumberControls();
  assert.equal(buttonAttributes.get('aria-pressed'), 'true');

  context.autoNumberSelectedTagEditorTracks();

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.tagEditor.values)), {
    [firstPath]: { disc_number: '1', genre: 'Rock', title: 'First', track_number: '11' },
    [secondPath]: { disc_number: '2', genre: 'Metal', title: 'Second', track_number: '12' },
  });
  assert.equal(context.state.tagEditor.autoNumberActive, false);
  assert.equal(renderCount, 2);
});

test('auto-number preserves a valid user-entered start across an unrelated sync', () => {
  const firstPath = 'D:\\Album\\01 First.flac';
  const secondPath = 'D:\\Album\\02 Second.flac';
  const controls = { hidden: true };
  const startInput = { value: '' };
  const buttonAttributes = new Map();
  const button = {
    disabled: true,
    setAttribute(name, value) { buttonAttributes.set(name, value); },
  };
  const elements = {
    'tag-editor-auto-number-controls': controls,
    'tag-editor-auto-number-start': startInput,
    'tag-editor-auto-number': button,
  };
  const tracks = [
    { path: firstPath, disc_number: 1, track_number: 1 },
    { path: secondPath, disc_number: 1, track_number: 2 },
  ];
  const context = loadHelper([], {
    document: {
      getElementById(id) { return elements[id] || null; },
    },
    getSelectedTagEditorPaths() { return [firstPath, secondPath]; },
  });
  context.state.tagEditor = {
    tracks,
    autoNumberSelectionSignature: '',
    autoNumberStartValue: '',
  };

  context.syncTagEditorAutoNumberControls();
  assert.equal(startInput.value, '1');

  startInput.value = '7';
  context.state.tagEditor.autoNumberStartValue = '7';
  context.syncTagEditorAutoNumberControls();

  assert.equal(controls.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(buttonAttributes.get('aria-pressed'), 'false');
  assert.equal(startInput.value, '7');
  assert.equal(context.state.tagEditor.autoNumberStartValue, '7');
});

test('assigning Non-album rarity applies after the warning modal confirmation', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Album Track.flac';
  const album = {
    key: 'artist-album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', exception_type: '' }],
  };
  const modal = { hidden: false };
  const tagEditorModal = { hidden: false };
  const closedModal = { hidden: true };
  const alerts = [];
  const fetchCalls = [];
  const bodyClasses = new Set(['modal-open']);
  const context = loadHelper([album], {
    document: {
      body: {
        classList: {
          add(value) { bodyClasses.add(value); },
          remove(value) { bodyClasses.delete(value); },
        },
      },
      getElementById(id) {
        if (id === 'tag-edit-confirm-modal') return modal;
        if (id === 'tag-editor-modal') return tagEditorModal;
        return closedModal;
      },
    },
    getTagEditConfirmElements() { return { overlay: modal }; },
    getTagEditorElements() { return { overlay: tagEditorModal }; },
    buildChangedTagEditorUpdates() {
      return {
        [trackPath]: {
          exception_type: 'Non-album rarity',
        },
      };
    },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    buildOptimisticUpdatedAlbumsFromEdits() { return [album]; },
    applyUpdatedAlbumsToCurrentView() {},
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    applyViewPayload() {},
    renderTrackModalRelease() {},
    watchSaveTask() {},
    escapeHtml(value) { return String(value); },
    showRepairAlert(message, kind) { alerts.push({ message: String(message), kind }); },
    async fetch(url, options) {
      fetchCalls.push({ url, options });
      return { ok: true, async json() { return { ok: true, updated_albums: [] }; } };
    },
  });
  context.state.tagEditor = {
    album,
    tracks: album.tracks,
    values: { [trackPath]: { album: 'Album', exception_type: 'Non-album rarity' } },
  };

  await context.confirmManualTagEdit();

  assert.equal(fetchCalls.length, 1, 'accepting the warning modal must perform the mutation');
  assert.equal(modal.hidden, true, 'the accepted warning modal must close');
  assert.equal(
    alerts.some(({ message }) => /non-album rarity/i.test(message) && /album tag/i.test(message)),
    false,
    'the centered confirmation modal owns the warning instead of the global repair alert',
  );
});

test('Non-album rarity warning uses the effective pending album tag', () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Album Track.flac';
  const album = {
    key: 'artist-album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', exception_type: '' }],
  };
  const context = loadHelper([album]);
  context.state.tagEditor = {
    album,
    tracks: album.tracks,
    values: {},
  };

  assert.equal(
    context.nonAlbumRarityWarningFingerprint(album, {
      [trackPath]: {
        album: '',
        exception_type: 'Non-album rarity',
      },
    }),
    '',
    'clearing the album in the same edit must not warn',
  );

  album.tracks[0].album = '';
  assert.notEqual(
    context.nonAlbumRarityWarningFingerprint(album, {
      [trackPath]: {
        album: 'New Album',
        exception_type: 'Non-album rarity',
      },
    }),
    '',
    'adding an album in the same edit must warn',
  );
});

test('queued tag edit with empty response albums retains the nonempty optimistic albums', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    year: 2000,
    tracks: [{ path: trackPath, album: 'Album', album_artist: 'Artist', year: 2001 }],
  };
  const optimisticAlbums = [
    {
      key: 'artist::renamed::2000',
      name: 'Renamed',
      album_artist: 'Artist',
      year: 2000,
      tracks: [{ ...album.tracks[0], album: 'Renamed' }],
    },
  ];
  const applyCalls = [];
  const renderCalls = [];
  const watchedTasks = [];
  const scheduledFrames = [];
  const scheduledTimers = [];
  const mutationClaim = { id: 'tag-edit-claim-1' };
  const claimCalls = [];
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: {
        classList: {
          add() {},
          remove() {},
        },
      },
      getElementById() {
        return closedModal;
      },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { album: 'Renamed' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() {
      return optimisticAlbums;
    },
    deepCloneJson(value) {
      return JSON.parse(JSON.stringify(value));
    },
    applyUpdatedAlbumsToCurrentView(albums, options) {
      applyCalls.push({ albums, options });
    },
    updateOpenTrackModalAfterTagEdit() {},
    renderView(options) {
      renderCalls.push(options);
    },
    showRepairAlert() {},
    claimTagEditViewMutation(...args) {
      claimCalls.push(args);
      return mutationClaim;
    },
    scheduleBrowserAnimationFrame(callback) {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    },
    scheduleBrowserTimeout(callback, delay) {
      scheduledTimers.push({ callback, delay });
      return scheduledTimers.length;
    },
    watchSaveTask(taskId, options) {
      watchedTasks.push({ taskId, options });
    },
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            save_task_id: 'save-task-1',
            updated_albums: [],
          };
        },
      };
    },
  });
  context.state.tagEditor = {
    album,
    tracks: album.tracks,
    values: {},
  };

  await context.confirmManualTagEdit();

  assert.equal(
    applyCalls.length,
    1,
    'an empty queued response must retain the already-rendered optimistic state without another apply',
  );
  assert.strictEqual(applyCalls[0].albums, optimisticAlbums);
  assert.equal(
    renderCalls.length,
    1,
    'an empty queued response must not rerender the already-visible optimistic gallery',
  );
  assert.equal(watchedTasks.length, 0, 'save-task polling must not start in the edit-response turn');
  assert.equal(scheduledFrames.length, 1);
  scheduledFrames.shift()();
  assert.equal(watchedTasks.length, 0);
  assert.equal(scheduledFrames.length, 1);
  scheduledFrames.shift()();
  assert.equal(watchedTasks.length, 0);
  assert.equal(scheduledTimers.length, 1);
  assert.equal(scheduledTimers[0].delay, 300);
  scheduledTimers.shift().callback();
  assert.equal(watchedTasks.length, 1);
  assert.equal(watchedTasks[0].taskId, 'save-task-1');
  assert.strictEqual(watchedTasks[0].options.originalAlbum, album);
  assert.strictEqual(
    watchedTasks[0].options.tagEditMutationClaim,
    mutationClaim,
    'the queued save-task watcher must receive the optimistic mutation ownership claim',
  );
  assert.strictEqual(claimCalls[0][0], album);
  assert.deepEqual(Array.from(claimCalls[0][1]), [trackPath]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(claimCalls[0][2])),
    { [trackPath]: { album: 'Renamed' } },
  );
  assert.equal(
    watchedTasks[0].options.preserveAbsoluteScroll,
    true,
    'manual tag edits must scope absolute-scroll preservation to their save-task finalization',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(renderCalls[0])),
    {
      preserveScroll: true,
      preserveAbsoluteScroll: true,
      preserveMountedGalleryChildren: true,
    },
    'an identity-changing optimistic edit must preserve coordinates and patch mounted cards by identity',
  );
});

test('terminal tag edit refresh skips stale response fragments before canonical reconciliation', async () => {
  const trackPath = 'C:\\Music\\Artist\\Source\\01 - Selected.flac';
  const album = {
    key: 'artist::source::2000',
    name: 'Source',
    album_artist: 'Artist',
    year: 2000,
    tracks: [{ path: trackPath, album: 'Source', title: 'Selected' }],
  };
  const optimisticAlbums = [{
    ...album,
    key: 'artist::destination::2000',
    name: 'Destination',
    tracks: [{ ...album.tracks[0], album: 'Destination' }],
  }];
  const staleResponseAlbum = {
    ...album,
    preview_only: true,
    track_count_preview: 15,
    tracks: [],
  };
  const terminalPayload = {
    ok: true,
    save_task_id: 'terminal-refresh-task',
    save_task_status: 'completed',
    requires_view_refresh: true,
    updated_albums: [staleResponseAlbum],
  };
  const applyCalls = [];
  const watchedTasks = [];
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { album: 'Destination' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return optimisticAlbums; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    applyUpdatedAlbumsToCurrentView(albums, options) {
      applyCalls.push({ albums, options });
      return albums;
    },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert() {},
    async watchSaveTask(taskId, options) {
      watchedTasks.push({ taskId, options });
    },
    async fetch() {
      return {
        ok: true,
        async json() { return terminalPayload; },
      };
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.equal(
    applyCalls.length,
    1,
    'the completed response must not overwrite the published optimistic gallery with stale fragments',
  );
  assert.strictEqual(applyCalls[0].albums, optimisticAlbums);
  assert.equal(watchedTasks.length, 1);
  assert.equal(watchedTasks[0].taskId, terminalPayload.save_task_id);
  assert.strictEqual(watchedTasks[0].options.terminalPayload, terminalPayload);
});

test('queued tag edit retains its initial optimistic render until the save-task watcher reconciles differing response albums', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    year: 2000,
    tracks: [{ path: trackPath, album: 'Album', album_artist: 'Artist', year: 2000 }],
  };
  const optimisticAlbum = { ...album, name: 'Optimistic Rename' };
  const responseAlbum = { ...album, name: 'Saved Rename' };
  const renderCalls = [];
  const eventSequence = [];
  const watchedTasks = [];
  let releaseResponse;
  const closedModal = { hidden: true };
  const galleryScroll = { scrollTop: 9040, scrollLeft: 11 };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById(id) {
        return id === 'albums-scroll' ? galleryScroll : closedModal;
      },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { album: 'Saved Rename' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [optimisticAlbum]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    applyUpdatedAlbumsToCurrentView() {},
    updateOpenTrackModalAfterTagEdit() {},
    renderView(options) {
      renderCalls.push(options);
      eventSequence.push('render');
    },
    buildApiUrl() { return '/api/library?selected_artist=DDT'; },
    showRepairAlert() {},
    watchSaveTask(taskId, options) {
      watchedTasks.push({ taskId, options });
      eventSequence.push('watch');
    },
    fetch() {
      return new Promise((resolve) => {
        releaseResponse = () => resolve({
          ok: true,
          async json() {
            return {
              ok: true,
              save_task_id: 'save-task-coordinate-reconciliation',
              updated_albums: [responseAlbum],
            };
          },
        });
      });
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };
  context.openTagEditConfirmModal();
  galleryScroll.scrollTop = 9592;
  galleryScroll.scrollLeft = 37;

  const confirmation = context.confirmManualTagEdit();
  await Promise.resolve();
  const pendingOptimisticEntries = Object.values(
    context.state.utility?.pendingProblematicSaveTasks || {},
  );
  assert.equal(
    pendingOptimisticEntries.length,
    1,
    'the optimistic album must be navigable while the edit request is still pending',
  );
  assert.strictEqual(pendingOptimisticEntries[0].optimisticAlbums[0], optimisticAlbum);
  releaseResponse();
  await confirmation;

  assert.equal(
    renderCalls.length,
    1,
    'the queued POST response must not replace and rerender the optimistic gallery before save-task reconciliation',
  );
  assert.deepEqual(
    renderCalls.map((options) => JSON.parse(JSON.stringify(options))),
    [
      {
        preserveScroll: true,
        preserveAbsoluteScroll: true,
        preserveMountedGalleryChildren: true,
        absoluteScrollPosition: { scrollLeft: 11, scrollTop: 9040 },
      },
    ],
    'the initial structural render must preserve exact coordinates while patching mounted cards by identity',
  );
  assert.deepEqual(eventSequence, ['render', 'watch']);
  assert.equal(watchedTasks[0].options.originatingViewRequestUrl, '/api/library?selected_artist=DDT');
});

test('pending problematic navigation ownership includes only directly edited track paths', () => {
  const editedPath = 'C:\\Music\\Artist\\Album\\01 - Edited.flac';
  const untouchedPath = 'C:\\Music\\Artist\\Album\\02 - Untouched.flac';
  const album = {
    key: 'artist::album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [
      { path: editedPath, album: 'Album', title: 'Edited' },
      { path: untouchedPath, album: 'Album', title: 'Untouched' },
    ],
  };
  const context = loadHelper([album]);

  const pending = context.registerPendingProblematicOptimisticEdit(
    album,
    [{ ...album, name: 'Album Split' }],
    { [editedPath]: { album: 'Album Split' } },
  );

  assert.deepEqual(
    Array.from(pending.entry.trackPaths),
    [editedPath],
    'an older edit on another track must not own navigation for this track',
  );
  pending.settle();
});

test('successful tag edit without a save task settles its optimistic mutation claim', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album' }],
  };
  const updatedAlbum = { ...album, name: 'Renamed' };
  const mutationClaim = { id: 'tag-edit-no-task-claim' };
  const settledClaims = [];
  const releasedClaims = [];
  const watchedTasks = [];
  const problematicAlbum = { ...updatedAlbum, problem_reasons: ['Missing cover'] };
  const problematicCalls = [];
  const applyCalls = [];
  const tagEdits = {
    [trackPath]: {
      album: 'Renamed',
      album_artist: 'Explicit Artist',
    },
  };
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return tagEdits;
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [updatedAlbum]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    applyUpdatedAlbumsToCurrentView(albums, options) {
      applyCalls.push({ albums, options });
      return albums;
    },
    updateOpenTrackModalAfterTagEdit() {},
    applyRepairResultToProblematicFiles(...args) { problematicCalls.push(args); },
    renderView() {},
    showRepairAlert() {},
    claimTagEditViewMutation() { return mutationClaim; },
    tagEditViewMutationStillOwnsResources(claim) {
      assert.strictEqual(claim, mutationClaim);
      return true;
    },
    settleTagEditViewMutation(claim) { settledClaims.push(claim); },
    releaseFailedTagEditViewMutation(claim) { releasedClaims.push(claim); },
    watchSaveTask(...args) { watchedTasks.push(args); },
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            updated_albums: [updatedAlbum],
            updated_problematic_album: problematicAlbum,
          };
        },
      };
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.deepEqual(settledClaims, [mutationClaim]);
  assert.deepEqual(releasedClaims, []);
  assert.deepEqual(watchedTasks, []);
  assert.deepEqual(problematicCalls, [[album, problematicAlbum]]);
  assert.equal(applyCalls.length, 2);
  assert.deepEqual(
    applyCalls.map(({ options }) => options.tagEdits),
    [tagEdits, tagEdits],
    'optimistic and immediate finalized reconciliation need the exact edits for targeted group migration',
  );
});

test('successful tag edit installs committed values before finalized album reconciliation', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Original' }],
  };
  const optimisticEdits = { [trackPath]: { title: 'Optimistic' } };
  const committedValues = { [trackPath]: { title: 'Committed' } };
  const reconciledEdits = [];
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() { return optimisticEdits; },
    buildOptimisticUpdatedAlbumsFromEdits() { return [album]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    installCommittedTagValues(_album, edits) { reconciledEdits.push(edits); },
    applyUpdatedAlbumsToCurrentView(_albums, options) {
      if (options.tagEdits) reconciledEdits.push(options.tagEdits);
      return [album];
    },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert() {},
    claimTagEditViewMutation() { return {}; },
    tagEditViewMutationStillOwnsResources() { return true; },
    settleTagEditViewMutation() {},
    releaseFailedTagEditViewMutation() {},
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            committed_values: committedValues,
            updated_albums: [album],
          };
        },
      };
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.deepEqual(
    reconciledEdits.map((value) => JSON.parse(JSON.stringify(value))),
    [optimisticEdits, committedValues, committedValues],
  );
});

test('completed save-task response reconciles immediately without starting a watcher', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Original' }],
  };
  const committedValues = { [trackPath]: { title: 'Committed' } };
  const finalizedAlbum = { ...album, tracks: [{ ...album.tracks[0], title: 'Committed' }] };
  const applyCalls = [];
  const problematicCalls = [];
  const watchedTasks = [];
  const settledClaims = [];
  const alerts = [];
  const closedModal = { hidden: true };
  const mutationClaim = {};
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() { return committedValues; },
    buildOptimisticUpdatedAlbumsFromEdits() { return [finalizedAlbum]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    installCommittedTagValues() {},
    applyUpdatedAlbumsToCurrentView(...args) {
      applyCalls.push(args);
      return [finalizedAlbum];
    },
    updateOpenTrackModalAfterTagEdit() {},
    applyRepairResultToProblematicFiles(...args) { problematicCalls.push(args); },
    renderView() {},
    showRepairAlert(...args) { alerts.push(args); },
    claimTagEditViewMutation() { return mutationClaim; },
    tagEditViewMutationStillOwnsResources() { return true; },
    settleTagEditViewMutation(claim) { settledClaims.push(claim); },
    releaseFailedTagEditViewMutation() {},
    watchSaveTask(...args) { watchedTasks.push(args); },
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            save_task_id: 'completed-save-task',
            save_task_status: 'completed',
            committed_values: committedValues,
            updated_albums: [finalizedAlbum],
            updated_problematic_album: null,
          };
        },
      };
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.equal(applyCalls.length, 2, 'optimistic and completed authoritative albums both apply');
  assert.deepEqual(problematicCalls, [[album, null]]);
  assert.deepEqual(watchedTasks, []);
  assert.deepEqual(settledClaims, [mutationClaim]);
  assert.deepEqual(alerts.at(-1), ['Tag changes saved.', 'success', 2000]);
});

test('completed refresh-required response gives its terminal payload to canonical reconciliation before Saved', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Original' }],
  };
  const events = [];
  const settledClaims = [];
  const closedModal = { hidden: true };
  const mutationClaim = {};
  const terminalPayload = {
    ok: true,
    save_task_id: 'completed-refresh-task',
    save_task_status: 'completed',
    requires_view_refresh: true,
    committed_values: { [trackPath]: { title: 'Committed' } },
    updated_albums: [],
  };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { title: 'Committed' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [album]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    installCommittedTagValues() {},
    applyUpdatedAlbumsToCurrentView() { return [album]; },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert(message) { events.push(['alert', message]); },
    claimTagEditViewMutation() { return mutationClaim; },
    tagEditViewMutationStillOwnsResources() { return true; },
    settleTagEditViewMutation(claim) { settledClaims.push(claim); },
    releaseFailedTagEditViewMutation() {},
    async watchSaveTask(taskId, options) {
      events.push(['watch', taskId, options.tagEdits, options.terminalPayload]);
      context.settleTagEditViewMutation(options.tagEditMutationClaim);
    },
    async fetch() {
      return {
        ok: true,
        async json() {
          return terminalPayload;
        },
      };
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.deepEqual(
    events.slice(-2).map((event) => JSON.parse(JSON.stringify(event))),
    [
      [
        'watch',
        'completed-refresh-task',
        { [trackPath]: { title: 'Committed' } },
        terminalPayload,
      ],
      ['alert', 'Tag changes saved.'],
    ],
  );
  assert.deepEqual(settledClaims, [mutationClaim]);
});

test('completed loose-track membership edit refreshes canonically even when finalized albums are returned', async () => {
  const selectedPath = 'C:\\Music\\Folkstone\\ballad.mp3';
  const siblingPath = 'C:\\Music\\Folkstone\\goose.mp3';
  const looseCollection = {
    key: 'folkstone::non-album',
    name: 'Non-album tracks',
    album_artist: 'Folkstone',
    tag_editor_collection: true,
    tracks: [
      { path: selectedPath, album: 'Folkstone', exception_type: 'Non-album rarity' },
      { path: siblingPath, album: '', exception_type: '' },
    ],
  };
  const finalizedFolkstone = {
    key: 'folkstone::folkstone',
    name: 'Folkstone',
    album_artist: 'Folkstone',
    tracks: [{ path: selectedPath, album: 'Folkstone', exception_type: '' }],
  };
  const events = [];
  const requestBodies = [];
  const closedModal = { hidden: true };
  const context = loadHelper([looseCollection], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [selectedPath]: { exception_type: '' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [looseCollection]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    installCommittedTagValues() {},
    applyUpdatedAlbumsToCurrentView() { return [finalizedFolkstone]; },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert(message) { events.push(['alert', message]); },
    claimTagEditViewMutation() { return {}; },
    tagEditViewMutationStillOwnsResources() { return true; },
    settleTagEditViewMutation() {},
    releaseFailedTagEditViewMutation() {},
    async watchSaveTask(taskId) { events.push(['watch', taskId]); },
    async fetch(_url, options) {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            save_task_id: 'completed-loose-membership-task',
            save_task_status: 'completed',
            requires_view_refresh: true,
            committed_values: { [selectedPath]: { exception_type: '' } },
            updated_albums: [finalizedFolkstone],
          };
        },
      };
    },
  });
  context.state.tagEditor = {
    album: looseCollection,
    tracks: looseCollection.tracks,
    values: {},
  };

  await context.confirmManualTagEdit();

  assert.equal(
    Object.prototype.hasOwnProperty.call(requestBodies[0], 'problematic_files_origin'),
    false,
    'Album Details edits must omit the Problematic Files origin flag entirely.',
  );
  assert.deepEqual(events.slice(-2), [
    ['watch', 'completed-loose-membership-task'],
    ['alert', 'Tag changes saved.'],
  ]);

  closedModal.hidden = false;
  context.state.utility = {
    activeTab: 'problematic-files',
    selectedProblematicKey: 'folkstone::problematic',
  };
  context.state.tagEditor = {
    album: looseCollection,
    tracks: looseCollection.tracks,
    values: {},
  };

  await context.confirmManualTagEdit();

  assert.equal(requestBodies[1].problematic_files_origin, true);
});

test('an older tag-edit response cannot reconcile after a newer edit starts', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Original' }],
  };
  const installedValues = [];
  const responseResolvers = [];
  let currentResourceClaim = null;
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { title: 'Edited' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [album]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    installCommittedTagValues(_album, values) { installedValues.push(values); },
    applyUpdatedAlbumsToCurrentView() { return [album]; },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert() {},
    claimTagEditViewMutation() {
      currentResourceClaim = {};
      return currentResourceClaim;
    },
    tagEditViewMutationStillOwnsResources(claim) { return claim === currentResourceClaim; },
    settleTagEditViewMutation() {},
    releaseFailedTagEditViewMutation() {},
    fetch() {
      return new Promise((resolve) => responseResolvers.push(resolve));
    },
  });
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  const older = context.confirmManualTagEdit();
  await Promise.resolve();
  const newer = context.confirmManualTagEdit();
  await Promise.resolve();
  responseResolvers[1]({
    ok: true,
    async json() {
      return {
        ok: true,
        committed_values: { [trackPath]: { title: 'Newer' } },
        updated_albums: [album],
      };
    },
  });
  await newer;
  responseResolvers[0]({
    ok: true,
    async json() {
      return {
        ok: true,
        committed_values: { [trackPath]: { title: 'Older' } },
        updated_albums: [album],
      };
    },
  });
  await older;

  assert.deepEqual(
    installedValues.map((value) => JSON.parse(JSON.stringify(value))),
    [{ [trackPath]: { title: 'Newer' } }],
  );
});

test('overlapping unrelated tag edits reconcile successes and roll back failures independently', async () => {
  const firstPath = 'C:\\Music\\Artist A\\Album A\\01 - First.flac';
  const secondPath = 'C:\\Music\\Artist B\\Album B\\01 - Second.flac';
  const firstAlbum = {
    key: 'artist-a::album-a::2000',
    name: 'Album A',
    album_artist: 'Artist A',
    tracks: [{ path: firstPath, album: 'Album A', title: 'First' }],
  };
  const secondAlbum = {
    key: 'artist-b::album-b::2001',
    name: 'Album B',
    album_artist: 'Artist B',
    tracks: [{ path: secondPath, album: 'Album B', title: 'Second' }],
  };
  const responseResolvers = [];
  const installedValues = [];
  const restoredSnapshots = [];
  const appliedAlbumCalls = [];
  const closedModal = { hidden: true };
  const context = loadHelper([firstAlbum, secondAlbum], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates(album) {
      const path = album.tracks[0].path;
      return { [path]: { title: `Edited ${album.name}` } };
    },
    buildOptimisticUpdatedAlbumsFromEdits(album) { return [album]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    installCommittedTagValues(album, values) {
      installedValues.push({ album: album.key, values: JSON.parse(JSON.stringify(values)) });
    },
    applyViewPayload(snapshot) { restoredSnapshots.push(snapshot); },
    applyUpdatedAlbumsToCurrentView(albums, options = {}) {
      appliedAlbumCalls.push({ albums, options });
      return albums;
    },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert() {},
    claimTagEditViewMutation(album) { return { albumKey: album.key }; },
    tagEditViewMutationStillOwnsResources() { return true; },
    settleTagEditViewMutation() {},
    releaseFailedTagEditViewMutation() {},
    fetch() { return new Promise((resolve) => responseResolvers.push(resolve)); },
  });

  context.state.tagEditor = { album: firstAlbum, tracks: firstAlbum.tracks, values: {} };
  const firstRequest = context.confirmManualTagEdit();
  await Promise.resolve();
  context.state.tagEditor = { album: secondAlbum, tracks: secondAlbum.tracks, values: {} };
  const secondRequest = context.confirmManualTagEdit();
  await Promise.resolve();

  responseResolvers[1]({
    ok: true,
    async json() {
      return {
        ok: true,
        committed_values: { [secondPath]: { title: 'Committed Second' } },
        updated_albums: [secondAlbum],
      };
    },
  });
  await secondRequest;
  responseResolvers[0]({
    ok: true,
    async json() {
      return {
        ok: true,
        committed_values: { [firstPath]: { title: 'Committed First' } },
        updated_albums: [firstAlbum],
      };
    },
  });
  await firstRequest;

  assert.deepEqual(installedValues, [
    {
      album: secondAlbum.key,
      values: { [secondPath]: { title: 'Committed Second' } },
    },
    {
      album: firstAlbum.key,
      values: { [firstPath]: { title: 'Committed First' } },
    },
  ]);
  appliedAlbumCalls.length = 0;

  context.state.tagEditor = { album: firstAlbum, tracks: firstAlbum.tracks, values: {} };
  const failedFirstRequest = context.confirmManualTagEdit();
  await Promise.resolve();
  context.state.tagEditor = { album: secondAlbum, tracks: secondAlbum.tracks, values: {} };
  const laterSecondRequest = context.confirmManualTagEdit();
  await Promise.resolve();
  responseResolvers[3]({
    ok: true,
    async json() {
      return {
        ok: true,
        committed_values: { [secondPath]: { title: 'Later Second' } },
        updated_albums: [secondAlbum],
      };
    },
  });
  await laterSecondRequest;
  responseResolvers[2]({
    ok: false,
    async json() { return { ok: false, error: 'First unrelated edit failed.' }; },
  });
  await failedFirstRequest;

  assert.deepEqual(
    restoredSnapshots,
    [],
    'a failed unrelated edit must not restore the whole pre-request view over a later commit',
  );
  const rollbackCall = appliedAlbumCalls.at(-1);
  assert.equal(rollbackCall.albums.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rollbackCall.albums[0])),
    firstAlbum,
    'the failed request must roll back only its owned album',
  );
  assert.equal(rollbackCall.options.skipRender, true);
  assert.equal(rollbackCall.options.preserveScroll, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rollbackCall.options.originalAlbum)),
    firstAlbum,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(rollbackCall.options.tagEdits)),
    { [firstPath]: { title: 'First' } },
  );
  assert.deepEqual(
    installedValues.at(-1),
    {
      album: secondAlbum.key,
      values: { [secondPath]: { title: 'Later Second' } },
    },
    'the unrelated later committed result must remain installed after the scoped rollback',
  );
});

test('failed Album Artist edit rolls back with the original group semantic options', async () => {
  const trackPath = 'C:\\Music\\Original Artist\\Album\\01 - Track.flac';
  const album = {
    key: 'original-artist::album::2000',
    name: 'Album',
    album_artist: 'Original Artist',
    tracks: [{ path: trackPath, album: 'Album', title: 'Track' }],
  };
  const applyCalls = [];
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { album_artist: 'Failed New Artist' } };
    },
    getTrackTagInitialValues(track, originalAlbum) {
      return {
        ...track,
        album_artist: originalAlbum.album_artist,
      };
    },
    buildOptimisticUpdatedAlbumsFromEdits() {
      return [{ ...album, album_artist: 'Failed New Artist' }];
    },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    applyUpdatedAlbumsToCurrentView(albums, options) {
      applyCalls.push({ albums, options });
      return albums;
    },
    updateOpenTrackModalAfterTagEdit() {},
    renderView() {},
    showRepairAlert() {},
    async fetch() {
      return {
        ok: false,
        async json() { return { ok: false, error: 'Album Artist write failed.' }; },
      };
    },
  });
  context.state.ui = { viewStateRevision: 1 };
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  const rollbackCall = applyCalls.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(rollbackCall.albums)), [album]);
  assert.equal(rollbackCall.options.skipRender, true);
  assert.equal(rollbackCall.options.preserveScroll, true);
  assert.deepEqual(JSON.parse(JSON.stringify(rollbackCall.options.originalAlbum)), album);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rollbackCall.options.tagEdits)),
    { [trackPath]: { album_artist: 'Original Artist' } },
  );
});

test('no-save-task tag edit does not reconcile Problematic Files after navigation or supersession', async () => {
  for (const scenario of ['navigation', 'superseded']) {
    const trackPath = `C:\\Music\\Artist\\Album\\01 - ${scenario}.flac`;
    const album = {
      key: `artist::album::${scenario}`,
      name: 'Album',
      album_artist: 'Artist',
      tracks: [{ path: trackPath, album: 'Album' }],
    };
    const updatedAlbum = { ...album, name: 'Renamed' };
    const problematicAlbum = {
      ...updatedAlbum,
      problem_reasons: ['Missing cover'],
    };
    const mutationClaim = { id: `${scenario}-claim` };
    const problematicCalls = [];
    const closedModal = { hidden: true };
    const context = loadHelper([album], {
      document: {
        body: { classList: { add() {}, remove() {} } },
        getElementById() { return closedModal; },
      },
      getTagEditConfirmElements() { return { overlay: closedModal }; },
      getTagEditorElements() { return { overlay: closedModal }; },
      buildChangedTagEditorUpdates() {
        return { [trackPath]: { album: 'Renamed' } };
      },
      buildOptimisticUpdatedAlbumsFromEdits() { return [updatedAlbum]; },
      deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
      applyUpdatedAlbumsToCurrentView(albums) { return albums; },
      updateOpenTrackModalAfterTagEdit() {},
      applyRepairResultToProblematicFiles(...args) { problematicCalls.push(args); },
      renderView() {},
      showRepairAlert() {},
      claimTagEditViewMutation() { return mutationClaim; },
      tagEditViewMutationStillOwnsResources() {
        return scenario !== 'superseded';
      },
      settleTagEditViewMutation() {},
      releaseFailedTagEditViewMutation() {},
      async fetch() {
        return {
          ok: true,
          async json() {
            if (scenario === 'navigation') {
              context.state.ui.viewStateRevision += 1;
            }
            return {
              ok: true,
              updated_albums: [updatedAlbum],
              updated_problematic_album: problematicAlbum,
            };
          },
        };
      },
    });
    context.state.ui = { viewStateRevision: 61 };
    context.state.tagEditor = { album, tracks: album.tracks, values: {} };

    await context.confirmManualTagEdit();

    assert.deepEqual(
      problematicCalls,
      [],
      `${scenario} must not let a stale no-task completion rewrite Problematic Files`,
    );
  }
});

test('manual tag edit does not apply successful origin albums after navigation during the POST', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album' }],
  };
  const optimisticAlbum = { ...album, name: 'Optimistic Rename' };
  const finalizedAlbum = { ...album, name: 'Finalized Rename' };
  const navigatedView = {
    selected_artist: 'Different Artist',
    artist_groups: [{ artist: 'Different Artist', albums: [] }],
    primary_artist_groups: [],
    family_artist_groups: [],
  };
  const applyCalls = [];
  const modalCalls = [];
  const renderCalls = [];
  const watchedTasks = [];
  const alerts = [];
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { album: 'Finalized Rename' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [optimisticAlbum]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    applyUpdatedAlbumsToCurrentView(...args) { applyCalls.push(args); },
    updateOpenTrackModalAfterTagEdit(...args) { modalCalls.push(args); },
    renderView(...args) { renderCalls.push(args); },
    showRepairAlert(...args) { alerts.push(args); },
    watchSaveTask(...args) { watchedTasks.push(args); },
    async fetch() {
      return {
        ok: true,
        async json() {
          context.state.view = navigatedView;
          context.state.ui.viewStateRevision = 22;
          return {
            ok: true,
            save_task_id: 'save-task-after-navigation',
            updated_albums: [finalizedAlbum],
          };
        },
      };
    },
  });
  context.state.ui = { viewStateRevision: 21 };
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.equal(applyCalls.length, 1, 'only the pre-request optimistic mutation may run');
  assert.strictEqual(applyCalls[0][0][0], optimisticAlbum);
  assert.equal(modalCalls.length, 1, 'the completed response must not rewrite a newer modal');
  assert.equal(renderCalls.length, 1, 'the completed response must not rerender a newer view');
  assert.strictEqual(context.state.view, navigatedView);
  assert.equal(watchedTasks.length, 1);
  assert.equal(watchedTasks[0][1].originatingViewStateRevision, 21);
  assert.deepEqual(alerts.at(-1), [
    'Tag changes queued. Finalizing library view...',
    'success',
    2000,
  ]);
});

test('manual tag edit does not restore its previous snapshot after navigation during a failed POST', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: trackPath, album: 'Album' }],
  };
  const navigatedView = {
    selected_artist: 'Different Artist',
    artist_groups: [{ artist: 'Different Artist', albums: [] }],
    primary_artist_groups: [],
    family_artist_groups: [],
  };
  const restoredSnapshots = [];
  const renderCalls = [];
  const alerts = [];
  const persistedEntries = [];
  const mutationClaim = { id: 'failed-tag-edit-claim' };
  const releasedClaims = [];
  const logEntry = {
    id: 'tag-edit-failure-42',
    action: 'Tag edit failed',
    error: 'Immediate tag write failed for 01 - Selected.flac.',
    files: [trackPath],
  };
  const closedModal = { hidden: true };
  const context = loadHelper([album], {
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return closedModal; },
    },
    getTagEditConfirmElements() { return { overlay: closedModal }; },
    getTagEditorElements() { return { overlay: closedModal }; },
    buildChangedTagEditorUpdates() {
      return { [trackPath]: { album: 'Failed Rename' } };
    },
    buildOptimisticUpdatedAlbumsFromEdits() { return [{ ...album, name: 'Failed Rename' }]; },
    deepCloneJson(value) { return JSON.parse(JSON.stringify(value)); },
    applyUpdatedAlbumsToCurrentView() {},
    updateOpenTrackModalAfterTagEdit() {},
    applyViewPayload(...args) { restoredSnapshots.push(args); },
    renderView(...args) { renderCalls.push(args); },
    showRepairAlert(...args) { alerts.push(args); },
    claimTagEditViewMutation() { return mutationClaim; },
    releaseFailedTagEditViewMutation(claim) { releasedClaims.push(claim); },
    async prependUtilityLogHistoryEntry(entry) { persistedEntries.push(entry); },
    async fetch() {
      return {
        ok: false,
        async json() {
          context.state.view = navigatedView;
          context.state.ui.viewStateRevision = 32;
          return {
            ok: false,
            error: logEntry.error,
            log_entry: logEntry,
          };
        },
      };
    },
  });
  context.state.ui = { viewStateRevision: 31 };
  context.state.tagEditor = { album, tracks: album.tracks, values: {} };

  await context.confirmManualTagEdit();

  assert.deepEqual(restoredSnapshots, []);
  assert.equal(renderCalls.length, 1, 'only the pre-request optimistic render may run');
  assert.strictEqual(context.state.view, navigatedView);
  assert.deepEqual(persistedEntries, [logEntry]);
  assert.equal(persistedEntries[0].error, logEntry.error);
  assert.equal(alerts.at(-1)[0], 'Failed to edit tags.');
  assert.equal(alerts.at(-1)[1], 'error');
  assert.equal(alerts.at(-1)[2], null);
  assert.equal(alerts.at(-1)[3].logHistoryEntryId, logEntry.id);
  assert.equal(alerts.at(-1)[3].logHistoryLink, true);
  assert.deepEqual(
    releasedClaims,
    [mutationClaim],
    'a failed POST must release its optimistic mutation claim even after navigation',
  );
  assert.doesNotMatch(alerts.at(-1)[0], /Immediate tag write failed/);
});

test('repair POST does not apply origin albums after navigation and passes its revision to the save task', async () => {
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Selected.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    tracks: [{ path: trackPath, album: 'Album' }],
  };
  const updatedAlbum = { ...album, name: 'Repaired Album' };
  const localMutations = [];
  const watchedTasks = [];
  const context = loadHelper([album], {
    getSelectedProblematicAlbum() { return album; },
    getSelectedRepairRowKeys() { return [`${trackPath}::album`]; },
    getIgnoredRepairRowKeys() { return []; },
    getSelectedSeparateReleaseKeys() { return []; },
    showRepairProgressOverlay() {},
    hideRepairProgressOverlay() {},
    closeRepairConfirmModal() {},
    applyUpdatedAlbumsToCurrentView(...args) { localMutations.push(['apply', ...args]); },
    updateOpenTrackModalAfterTagEdit(...args) { localMutations.push(['modal', ...args]); },
    showRepairAlert() {},
    watchSaveTask(...args) { watchedTasks.push(args); },
    async fetch() {
      return {
        ok: true,
        async json() {
          context.state.ui.viewStateRevision = 42;
          return {
            ok: true,
            changed_count: 1,
            updated_albums: [updatedAlbum],
            save_task_id: 'repair-save-task-after-navigation',
          };
        },
      };
    },
  });
  context.state.ui = { viewStateRevision: 41 };
  context.state.utility = {
    pendingRepairKey: album.key,
    pendingRepairAction: 'repair',
    problematicFiles: [album],
  };

  await context.confirmRepairSelectedAlbum();

  assert.deepEqual(localMutations, []);
  assert.equal(watchedTasks.length, 1);
  assert.equal(watchedTasks[0][0], 'repair-save-task-after-navigation');
  assert.equal(watchedTasks[0][1].originatingViewStateRevision, 41);
});

test('problem exclusion delegates to the optimistic queue without opening tag-repair progress', async () => {
  const ignoredRowKey = 'album::problem-album::missing-cover-art';
  const album = {
    key: 'album',
    name: 'Album',
    album_artist: 'Artist',
    year: 2005,
    album_problem_rows: [{
      row_key: ignoredRowKey,
      reason: 'Missing cover art',
    }],
    tracks: [],
  };
  const queued = [];
  let progressOverlayCalls = 0;
  let repairFetchCalls = 0;
  const context = loadHelper([album], {
    getSelectedProblematicAlbum() { return album; },
    getSelectedRepairRowKeys() { return []; },
    getIgnoredRepairRowKeys() { return [ignoredRowKey]; },
    getSelectedSeparateReleaseKeys() { return []; },
    showRepairProgressOverlay() { progressOverlayCalls += 1; },
    hideRepairProgressOverlay() {},
    queueProblemExclusionCreate(input) {
      queued.push(input);
      return Promise.resolve();
    },
    fetch() { repairFetchCalls += 1; },
  });
  context.state.ui = { viewStateRevision: 1 };
  context.state.utility = {
    pendingRepairKey: album.key,
    pendingRepairAction: 'detected',
    problematicFiles: [album],
    rulesLoaded: true,
    rules: [{ key: 'problem-ignores', count: 0, album_items: [], file_items: [] }],
  };

  await context.confirmRepairSelectedAlbum();

  assert.equal(queued.length, 1);
  assert.strictEqual(queued[0].album, album);
  assert.deepEqual(
    Array.from(queued[0].items, (item) => ({
      row_key: item.row_key,
      scope: item.scope,
      album_key: item.album_key,
    })),
    [{ row_key: ignoredRowKey, scope: 'album', album_key: album.key }],
  );
  assert.equal(progressOverlayCalls, 0);
  assert.equal(repairFetchCalls, 0, 'an exclusion must not call /utilities/repair-album');
});

test('separate releases submits only its keys when problem exclusions are also selected', async () => {
  const album = { key: 'album', name: 'Album', tracks: [{ path: 'C:\\Music\\01.flac' }] };
  let requestPayload = null;
  const context = loadHelper([album], {
    getSelectedProblematicAlbum() { return album; },
    getSelectedRepairRowKeys() { return []; },
    getIgnoredRepairRowKeys() { return ['album::problem-album::missing-cover-art']; },
    getSelectedSeparateReleaseKeys() { return ['artist::album']; },
    showRepairProgressOverlay() {},
    hideRepairProgressOverlay() {},
    closeRepairConfirmModal() {},
    applyUpdatedAlbumsToCurrentView() { return []; },
    updateOpenTrackModalAfterTagEdit() {},
    showRepairAlert() {},
    showToast() {},
    applyRepairResultToProblematicFiles() {},
    async fetch(_url, options) {
      requestPayload = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { ok: true, changed_count: 0, updated_albums: [] };
        },
      };
    },
  });
  context.state.ui = { viewStateRevision: 1 };
  context.state.utility = {
    pendingRepairKey: album.key,
    pendingRepairAction: 'separate-release',
    problematicFiles: [album],
    rulesLoaded: false,
  };

  await context.confirmRepairSelectedAlbum();

  assert.deepEqual(requestPayload.ignored_rows, []);
  assert.deepEqual(requestPayload.separate_release_keys, ['artist::album']);
});

class TrackModalTestClassList {
  constructor() {
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(String(token)));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.values.delete(String(token)));
  }

  contains(token) {
    return this.values.has(String(token));
  }
}

class TrackModalTestElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.classList = new TrackModalTestClassList();
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.parentElement = null;
    this.children = [];
    this._innerHTML = '';
    this._slot = null;
    this._image = null;
    this.isConnected = true;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    const disconnect = (node) => {
      if (!(node instanceof TrackModalTestElement)) return;
      node.isConnected = false;
      node.children.forEach(disconnect);
    };
    this.children.forEach(disconnect);
    this._innerHTML = String(value);
    this.children = [];
    this._slot = null;
    this._image = null;
    if (this._innerHTML.includes('track-modal-cover-image-slot')) {
      const slot = new TrackModalTestElement('span');
      slot.parentElement = this;
      slot._replaceOwner = this;
      slot.isConnected = this.isConnected;
      slot.classList.add('track-modal-cover-image-slot');
      this._slot = slot;
      this.children.push(slot);
    }
  }

  set outerHTML(value) {
    const owner = this._replaceOwner || this.parentElement;
    if (!(owner instanceof TrackModalTestElement)) return;
    const markup = String(value);
    owner._innerHTML = owner._innerHTML.replace(
      /<span class="track-modal-cover-image-slot"><\/span>/,
      markup,
    );
    const visual = new TrackModalTestElement('span');
    visual.classList.add('track-modal-cover-visual');
    if (/class="[^"]*\bis-loading\b/.test(markup)) visual.classList.add('is-loading');
    visual.parentElement = owner;
    visual.isConnected = owner.isConnected;
    const image = new TrackModalTestImage();
    image.parentElement = visual;
    image.isConnected = visual.isConnected;
    const imageMarkup = markup.match(/<img\b[\s\S]*?>/i)?.[0] || '';
    for (const match of imageMarkup.matchAll(/([:\w-]+)="([^"]*)"/g)) {
      image.setAttribute(match[1], match[2]);
    }
    visual.children = [image];
    owner.children = [visual];
    owner._slot = null;
    owner._image = image;
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) || '';
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = this.isConnected;
    this.children.push(child);
    if (child instanceof TrackModalTestImage) this._image = child;
    return child;
  }

  replaceWith(replacement) {
    const owner = this._replaceOwner || this.parentElement;
    if (!(owner instanceof TrackModalTestElement)) return;
    replacement.parentElement = owner;
    replacement.isConnected = owner.isConnected;
    owner.children = [replacement];
    owner._slot = null;
    owner._image = replacement instanceof TrackModalTestImage
      ? replacement
      : replacement.querySelector('img');
  }

  querySelector(selector) {
    const query = String(selector);
    if (query === '.track-modal-cover-image-slot') return this._slot;
    if (query === 'img' || query.startsWith('img[') || query === '.track-modal-cover-visual img') {
      return this._image;
    }
    for (const child of this.children) {
      const match = child.querySelector(query);
      if (match) return match;
    }
    return null;
  }

  closest(selector) {
    if (String(selector) === '.track-modal-cover-visual' && this.classList.contains('track-modal-cover-visual')) {
      return this;
    }
    return this.parentElement?.closest(selector) || null;
  }
}

class TrackModalTestImage extends TrackModalTestElement {
  constructor() {
    super('img');
    this.complete = false;
    this.naturalWidth = 0;
    this.currentSrc = '';
  }

  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (String(name) === 'src') this.currentSrc = String(value);
  }

  removeAttribute(name) {
    super.removeAttribute(name);
    if (String(name) === 'src') this.currentSrc = '';
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTrackModalCoverContext(options = {}) {
  const albums = options.albums || [{
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    cover_path: 'C:\\Music\\Artist Alpha\\Album Alpha\\cover.png',
    tracks: [],
  }];
  const cover = new TrackModalTestElement('div');
  const elements = {
    overlay: new TrackModalTestElement('div'),
    cover,
    title: new TrackModalTestElement('h2'),
    subtitle: new TrackModalTestElement('div'),
    list: new TrackModalTestElement('div'),
    footer: new TrackModalTestElement('div'),
    tabs: new TrackModalTestElement('div'),
    duplicateWarning: new TrackModalTestElement('div'),
    duplicateTabs: new TrackModalTestElement('div'),
    folder: new TrackModalTestElement('button'),
    editTags: new TrackModalTestElement('button'),
  };
  const loaderCalls = [];
  const directFetchCalls = [];
  const documentBody = new TrackModalTestElement('body');
  const context = {
    console,
    Promise,
    URL,
    window: { location: { href: 'http://127.0.0.1:4173/' } },
    HTMLElement: TrackModalTestElement,
    HTMLImageElement: TrackModalTestImage,
    document: {
      body: documentBody,
      createElement(tagName) {
        return String(tagName).toLowerCase() === 'img'
          ? new TrackModalTestImage()
          : new TrackModalTestElement(tagName);
      },
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    state: {
      player: { current: null },
      modalReleases: albums,
      modalReleaseIndex: 0,
      modalDuplicateSourceIndices: {},
      ui: {},
      view: {
        artist_groups: [{ artist: 'Artist Alpha', albums }],
        primary_artist_groups: [],
        family_artist_groups: [],
        ignored_version_keys: [],
        manual_version_links: {},
      },
    },
    getTrackModalElements() {
      return elements;
    },
    getAlbumRequestKey(album) {
      return String(album?.key || '');
    },
    getAlbumIdentity(album) {
      return String(album?.key || '');
    },
    escapeHtml(value) {
      return String(value);
    },
    albumHasDisplayCover() {
      return true;
    },
    buildAlbumDisplayCoverUrl(album) {
      return `/cover?path=${encodeURIComponent(album.cover_path)}&size=480&v=fixture`;
    },
    buildAlbumLightboxCoverUrl(album) {
      return `/cover?path=${encodeURIComponent(album.cover_path)}&v=fixture`;
    },
    async loadGalleryCoverPreviewImage(image, productionUrl, loaderOptions = {}) {
      loaderCalls.push({ image, productionUrl, options: loaderOptions });
      image.setAttribute('data-production-cover-src', productionUrl);
      const result = await options.resolvePreview(productionUrl);
      if (typeof loaderOptions.isCurrent === 'function' && !loaderOptions.isCurrent()) return null;
      if (result?.displayUrl) image.setAttribute('src', result.displayUrl);
      return result;
    },
    fetch(...args) {
      directFetchCalls.push(args);
      throw new Error('the track modal must not fetch a production cover outside the shared gallery loader');
    },
    formatAlbumDuration() {
      return '';
    },
    getPlayerPlaybackSnapshot() {
      return { paused: true, ended: false, currentTime: 0, duration: 0 };
    },
    formatTrackDuration() {
      return '0:00';
    },
    formatLoopTime() {
      return '0:00';
    },
    getProblematicAlbumForTrackPath() {
      return null;
    },
    refreshTrackModalPlaybackState() {},
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, cover, elements, loaderCalls, directFetchCalls };
}

async function flushTrackModalCoverWork() {
  await Promise.resolve();
  await Promise.resolve();
}

test('first track-modal cover render stays source-less until a shared-cache hit resolves', async () => {
  const cachedResult = createDeferred();
  const { context, cover, loaderCalls, directFetchCalls } = createTrackModalCoverContext({
    resolvePreview: () => cachedResult.promise,
  });

  context.renderTrackModalRelease(context.state.modalReleases[0]);

  const image = cover.querySelector('img');
  assert.ok(image instanceof TrackModalTestImage);
  assert.equal(image.getAttribute('src'), '', 'first render must not assign the production cover URL directly');
  assert.equal(loaderCalls.length, 1, 'the modal must resolve its preview through the shared gallery loader');
  assert.match(loaderCalls[0].productionUrl, /^\/cover\?.*size=480/);
  assert.equal(typeof loaderCalls[0].options.isCurrent, 'function');
  assert.equal(loaderCalls[0].options.isCurrent(), true);
  assert.deepEqual(directFetchCalls, []);

  cachedResult.resolve({ displayUrl: 'blob:gallery-cache-hit', cached: true });
  await flushTrackModalCoverWork();

  assert.equal(image.getAttribute('src'), 'blob:gallery-cache-hit');
  assert.deepEqual(directFetchCalls, [], 'a cache hit must add no production fetch path');
});

test('track-modal cover exposes gallery navigation only for gallery-enabled modal opens', () => {
  const singleCover = createTrackModalCoverContext({
    resolvePreview: async () => ({ displayUrl: 'blob:single-cover', cached: true }),
  });
  singleCover.context.state.ui.trackModalCoverLightboxGallery = false;
  singleCover.context.renderTrackModalRelease(singleCover.context.state.modalReleases[0]);
  assert.doesNotMatch(singleCover.cover.innerHTML, /data-lightbox-gallery="visible"/);

  const galleryEnabled = createTrackModalCoverContext({
    resolvePreview: async () => ({ displayUrl: 'blob:gallery-cover', cached: true }),
  });
  galleryEnabled.context.state.ui.trackModalCoverLightboxGallery = true;
  galleryEnabled.context.renderTrackModalRelease(galleryEnabled.context.state.modalReleases[0]);
  assert.match(galleryEnabled.cover.innerHTML, /data-lightbox-gallery="visible"/);
});

test('track-modal cover gallery icon exposes only unseen automatic improvements', () => {
  const album = {
    key: 'automatic-improvement-album',
    name: 'Automatic Improvement Album',
    album_artist: 'Candidate Artist',
    cover_path: 'C:\\Music\\Candidate Artist\\Automatic Improvement Album\\cover.jpg',
    tracks: [],
    cover_candidate_snapshot: {
      search_kind: 'automatic',
      automatic_improvement_revision: 2,
      seen_automatic_improvement_revision: 1,
      has_unseen_automatic_improvement: true,
    },
  };
  const { context, cover } = createTrackModalCoverContext({
    albums: [album],
    resolvePreview: async () => ({ displayUrl: 'blob:automatic-improvement', cached: true }),
  });

  context.renderTrackModalRelease(album);

  assert.match(
    cover.innerHTML,
    /class="track-modal-cover-tool is-lookup has-unseen-automatic-improvement"/,
    'an unseen automatic improvement must add the red-dot state class to the gallery icon',
  );
  assert.match(
    cover.innerHTML,
    /aria-label="Open cover art look up gallery; new automatic cover candidate available"/,
    'the red-dot state must also be announced to assistive technology',
  );

  album.cover_candidate_snapshot = {
    ...album.cover_candidate_snapshot,
    seen_automatic_improvement_revision: 2,
    has_unseen_automatic_improvement: false,
  };
  context.renderTrackModalRelease(album);
  assert.doesNotMatch(cover.innerHTML, /has-unseen-automatic-improvement/);
  assert.match(
    cover.innerHTML,
    /aria-label="Open cover art look up gallery"/,
    'marking the current revision seen must restore the ordinary accessible label',
  );

  album.cover_candidate_snapshot = {
    ...album.cover_candidate_snapshot,
    automatic_improvement_revision: 3,
    has_unseen_automatic_improvement: true,
  };
  context.renderTrackModalRelease(album);
  assert.match(cover.innerHTML, /has-unseen-automatic-improvement/);

  album.cover_candidate_snapshot = {
    ...album.cover_candidate_snapshot,
    search_kind: 'manual',
    automatic_improvement_revision: 4,
    has_unseen_automatic_improvement: true,
  };
  context.renderTrackModalRelease(album);
  assert.doesNotMatch(
    cover.innerHTML,
    /has-unseen-automatic-improvement/,
    'manual lookup revisions must remain notification-owned and never set the album icon dot',
  );
});

test('track-modal cover cache miss still enters through the shared gallery preview loader', async () => {
  const networkResult = createDeferred();
  const { context, cover, loaderCalls, directFetchCalls } = createTrackModalCoverContext({
    resolvePreview: () => networkResult.promise,
  });

  context.renderTrackModalRelease(context.state.modalReleases[0]);

  assert.equal(loaderCalls.length, 1);
  assert.equal(cover.querySelector('img').getAttribute('src'), '');
  networkResult.resolve({ displayUrl: 'blob:shared-loader-network-result', cached: false });
  await flushTrackModalCoverWork();

  assert.equal(cover.querySelector('img').getAttribute('src'), 'blob:shared-loader-network-result');
  assert.deepEqual(directFetchCalls, []);
});

test('same-source track-modal refresh retains an in-flight cover and its loading state', () => {
  const pending = createDeferred();
  const { context, cover, loaderCalls } = createTrackModalCoverContext({
    resolvePreview: () => pending.promise,
  });
  const album = context.state.modalReleases[0];

  context.renderTrackModalRelease(album);
  const pendingImage = cover.querySelector('img');
  const pendingVisual = pendingImage.closest('.track-modal-cover-visual');
  assert.equal(pendingImage.complete, false);
  assert.equal(pendingVisual.classList.contains('is-loading'), true);

  context.renderTrackModalRelease({ ...album });

  const retainedImage = cover.querySelector('img');
  const retainedVisual = retainedImage.closest('.track-modal-cover-visual');
  assert.equal(retainedImage, pendingImage, 'a same-source refresh must not detach the decoding image');
  assert.equal(retainedImage.isConnected, true);
  assert.equal(retainedVisual.classList.contains('is-loading'), true);
  assert.equal(loaderCalls.length, 1, 'the retained in-flight image must keep its original shared load');
});

test('a stale track-modal cover completion cannot reveal an earlier album over the current modal', async () => {
  const alpha = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    cover_path: 'C:\\Music\\Artist Alpha\\Album Alpha\\cover.png',
    tracks: [],
  };
  const beta = {
    key: 'beta',
    name: 'Album Beta',
    album_artist: 'Artist Beta',
    cover_path: 'C:\\Music\\Artist Beta\\Album Beta\\cover.png',
    tracks: [],
  };
  const pending = new Map([
    ['alpha', createDeferred()],
    ['beta', createDeferred()],
  ]);
  const { context, cover, loaderCalls } = createTrackModalCoverContext({
    albums: [alpha, beta],
    resolvePreview(productionUrl) {
      const key = productionUrl.includes('Album%20Alpha') ? 'alpha' : 'beta';
      return pending.get(key).promise;
    },
  });

  context.renderTrackModalRelease(alpha);
  const staleImage = cover.querySelector('img');
  context.state.modalReleaseIndex = 1;
  context.renderTrackModalRelease(beta);
  const currentImage = cover.querySelector('img');

  assert.notEqual(currentImage, staleImage);
  assert.equal(loaderCalls.length, 2);
  pending.get('alpha').resolve({ displayUrl: 'blob:stale-alpha', cached: true });
  await flushTrackModalCoverWork();

  assert.equal(staleImage.getAttribute('src'), '', 'the shared loader must reject a completion whose modal ownership is stale');
  assert.equal(currentImage.getAttribute('src'), '', 'the detached stale result must not appear in the current modal');

  pending.get('beta').resolve({ displayUrl: 'blob:current-beta', cached: true });
  await flushTrackModalCoverWork();
  assert.equal(cover.querySelector('img'), currentImage);
  assert.equal(currentImage.getAttribute('src'), 'blob:current-beta');
});

test('track modal shows the existing problem link from server-owned track state before utility data loads', () => {
  const trackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\18 Late Problem.flac';
  const album = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    tracks: [{
      path: trackPath,
      title: 'Late Problem',
      artist: 'Artist Alpha',
      album_artist: 'Artist Alpha',
      track_number: 18,
      is_problematic: true,
    }],
  };
  const { context, elements } = createTrackModalCoverContext({
    albums: [album],
    resolvePreview: async () => ({ displayUrl: 'blob:problem-cover', cached: true }),
  });
  context.state.utility = { problematicFiles: [] };

  context.renderTrackModalRelease(album);

  assert.match(elements.list.innerHTML, /class="track-problem-link"/);
  assert.match(elements.list.innerHTML, /data-open-track-problematic="1"/);
  assert.match(elements.list.innerHTML, /aria-label="Open this track in Problematic Files"/);
  assert.match(elements.list.innerHTML, /data-track-path="C:\\Music\\Artist Alpha\\Album Alpha\\18 Late Problem\.flac"/);
});

test('cross-album continuity peek is side-effect free until the exact boundary consumes it', () => {
  const firstPath = 'C:\\Music\\Artist\\First\\01.flac';
  const secondPath = 'C:\\Music\\Artist\\Second\\01.flac';
  const first = {
    key: 'first', name: 'First', album_artist: 'Artist',
    tracks: [{ path: firstPath, title: 'First' }],
    playback_context: {
      kind: 'artist_page', end_behavior: 'continue', ordered_album_refs: ['first', 'second'],
      albums: [{ album_ref: 'first', can_play: true }, { album_ref: 'second', can_play: true }],
    },
  };
  const second = {
    key: 'second', name: 'Second', album_artist: 'Artist',
    tracks: [{ path: secondPath, title: 'Second' }],
  };
  const context = loadHelper([first, second]);
  context.state.player = { current: { path: firstPath }, playbackQueue: null };
  context.setAlbumPlaybackQueue(first, firstPath);
  const originalQueue = context.state.player.playbackQueue;

  const firstPeek = context.peekNextQueuedTrack();
  const secondPeek = context.peekNextQueuedTrack();

  assert.equal(firstPeek.path, secondPath);
  assert.deepEqual(
    JSON.parse(JSON.stringify(secondPeek)),
    JSON.parse(JSON.stringify(firstPeek)),
    'repeated preparation sees one stable queued identity',
  );
  assert.strictEqual(context.state.player.playbackQueue, originalQueue, 'peek cannot cross albums eagerly');
  assert.equal(originalQueue.albumRef, 'first');
  assert.equal(originalQueue.currentIndex, 0);

  const consumed = context.getNextQueuedTrack();
  assert.equal(consumed.path, firstPeek.path);
  assert.equal(context.state.player.playbackQueue.albumRef, 'second');
  assert.equal(context.state.player.playbackQueue.currentIndex, 0);
});

test('Various Artists modal playback preserves album artist in markup and queue payloads', () => {
  const trackPath = 'C:\\Music\\Various Artists\\Featured Signal Collection\\01 - Credit Signal 1.mp3';
  const album = {
    key: 'various-artists-featured-signal-collection',
    name: 'Featured Signal Collection',
    album_artist: 'Various Artists',
    tracks: [{
      path: trackPath,
      title: 'Clean Signal (feat. Featured Voice)',
      artist: 'Solo Voice',
      album_artist: 'Various Artists',
      album: 'Featured Signal Collection',
      track_number: 1,
    }],
  };
  const { context, elements } = createTrackModalCoverContext({
    albums: [album],
    resolvePreview: async () => ({ displayUrl: 'blob:various-artists-cover', cached: true }),
  });
  context.renderTrackModalRelease(album);
  context.setAlbumPlaybackQueue(album, trackPath);

  assert.match(elements.list.innerHTML, /data-track-artist="Solo Voice"/);
  assert.match(elements.list.innerHTML, /data-track-album-artist="Various Artists"/);
  assert.equal(context.state.player.playbackQueue.tracks[0].artist, 'Solo Voice');
  assert.equal(context.state.player.playbackQueue.tracks[0].albumArtist, 'Various Artists');
  assert.strictEqual(context.state.player.playbackQueue.albumSnapshot, album);
});

{
  const alphaTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac';
  const betaTrackPath = 'C:\\Music\\Artist Alpha\\Album Beta\\01 Track.flac';
  const alpha = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [
      {
        path: alphaTrackPath,
        title: 'Track One',
        artist: 'Artist Alpha',
        album_artist: 'Artist Alpha',
        album: 'Album Alpha',
      },
    ],
    playback_context: {
      kind: 'artist_page',
      end_behavior: 'continue',
      ordered_album_refs: ['alpha', 'beta'],
      albums: [
        { album_ref: 'alpha', can_play: true },
        { album_ref: 'beta', can_play: true },
      ],
    },
  };
  const beta = {
    key: 'beta',
    name: 'Album Beta',
    album_artist: 'Artist Alpha',
    year: 2002,
    tracks: [
      {
        path: betaTrackPath,
        title: 'Track Two',
        artist: 'Artist Alpha',
        album_artist: 'Artist Alpha',
        album: 'Album Beta',
      },
    ],
  };

  const context = loadHelper([alpha, beta]);
  context.state.player = {
    current: { path: alphaTrackPath },
    playbackQueue: null,
  };
  context.setAlbumPlaybackQueue(alpha, alphaTrackPath);
  const advancedTrack = context.getNextQueuedTrack();

  assert.deepEqual(
    JSON.parse(JSON.stringify(advancedTrack)),
    {
      src: `/track?path=${encodeURIComponent(betaTrackPath)}`,
      path: betaTrackPath,
      title: 'Track Two',
      artist: 'Artist Alpha',
      albumArtist: 'Artist Alpha',
      album: 'Album Beta',
      coverPath: '',
      durationSeconds: 0,
    },
  );
  assert.equal(context.state.player.playbackQueue.currentIndex, 0);
  assert.equal(context.state.player.playbackQueue.albumRef, 'beta');
  assert.strictEqual(context.state.player.playbackQueue.albumSnapshot, beta);
}

{
  const alphaTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac';
  const betaTrackPath = 'C:\\Music\\Artist Alpha\\Album Beta\\01 Track.flac';
  const alpha = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [{ path: alphaTrackPath, title: 'Track One', artist: 'Artist Alpha', album: 'Album Alpha' }],
    playback_context: {
      kind: 'artist_page',
      end_behavior: 'stop',
      ordered_album_refs: ['alpha', 'beta'],
      albums: [
        { album_ref: 'alpha', can_play: true },
        { album_ref: 'beta', can_play: true },
      ],
    },
  };
  const beta = {
    key: 'beta',
    name: 'Album Beta',
    album_artist: 'Artist Alpha',
    year: 2002,
    tracks: [{ path: betaTrackPath, title: 'Track Two', artist: 'Artist Alpha', album: 'Album Beta' }],
  };

  const context = loadHelper([alpha, beta], {
    resolveGalleryPlaybackEndBehavior(playbackContext) {
      return playbackContext?.kind === 'artist_page' ? 'continue' : String(playbackContext?.end_behavior || '');
    },
  });
  context.state.player = {
    current: { path: alphaTrackPath },
    playbackQueue: null,
  };
  context.setAlbumPlaybackQueue(alpha, alphaTrackPath);
  const advancedTrack = context.getNextQueuedTrack();

  assert.equal(advancedTrack?.path, betaTrackPath);
  assert.equal(context.state.player.playbackQueue?.albumRef, 'beta');
}

{
  const alphaTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac';
  const betaTrackPath = 'C:\\Music\\Artist Alpha\\Album Beta\\01 Track.flac';
  const alpha = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [{ path: alphaTrackPath, title: 'Track One', artist: 'Artist Alpha', album: 'Album Alpha' }],
    playback_context: {
      kind: 'album_top',
      end_behavior: 'continue',
      ordered_album_refs: ['alpha', 'beta'],
      albums: [
        { album_ref: 'alpha', can_play: true },
        { album_ref: 'beta', can_play: true },
      ],
    },
  };
  const beta = {
    key: 'beta',
    name: 'Album Beta',
    album_artist: 'Artist Alpha',
    year: 2002,
    tracks: [{ path: betaTrackPath, title: 'Track Two', artist: 'Artist Alpha', album: 'Album Beta' }],
  };

  const context = loadHelper([alpha, beta], {
    resolveGalleryPlaybackEndBehavior(playbackContext) {
      return playbackContext?.kind === 'album_top' ? 'stop' : String(playbackContext?.end_behavior || '');
    },
  });
  context.state.player = {
    current: { path: alphaTrackPath },
    playbackQueue: null,
  };
  context.setAlbumPlaybackQueue(alpha, alphaTrackPath);
  const advancedTrack = context.getNextQueuedTrack();

  assert.equal(advancedTrack, null);
  assert.equal(context.state.player.playbackQueue, null);
}

{
  const alphaTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac';
  const betaTrackPath = 'C:\\Music\\Artist Alpha\\Album Beta\\01 Track.flac';
  const alpha = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [{ path: alphaTrackPath, title: 'Track One', artist: 'Artist Alpha', album: 'Album Alpha' }],
    playback_context: {
      kind: 'album_top',
      end_behavior: 'continue',
      ordered_album_refs: ['alpha', 'beta'],
      albums: [
        { album_ref: 'alpha', can_play: true },
        { album_ref: 'beta', can_play: true },
      ],
    },
  };
  const beta = {
    key: 'beta',
    name: 'Album Beta',
    album_artist: 'Artist Alpha',
    year: 2002,
    tracks: [{ path: betaTrackPath, title: 'Track Two', artist: 'Artist Alpha', album: 'Album Beta' }],
  };

  const context = loadHelper([alpha, beta], {
    canEmitPlaybackSessionSideEffects() {
      return false;
    },
  });
  context.state.player = {
    current: { path: alphaTrackPath },
    playbackQueue: null,
  };
  context.setAlbumPlaybackQueue(alpha, alphaTrackPath);
  const advancedTrack = context.getNextQueuedTrack();

  assert.equal(advancedTrack, null);
  assert.equal(context.state.player.playbackQueue, null);
}

{
  const album = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [{ path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac' }],
  };
  const cover = { innerHTML: '' };
  const title = { textContent: '' };
  const subtitle = { textContent: '' };
  const list = { innerHTML: '' };
  const footer = { hidden: true, textContent: '', innerHTML: '' };
  const tabs = { hidden: true, innerHTML: '' };
  const duplicateWarning = { hidden: true, innerHTML: '' };
  const duplicateTabs = { hidden: true, innerHTML: '' };
  const folder = { dataset: {} };
  const editTags = { dataset: {} };
  const context = {
    console,
    document: {
      getElementById() {
        return null;
      },
    },
    state: {
      player: {
        current: null,
      },
      modalReleases: [album],
      modalReleaseIndex: 0,
      modalDuplicateSourceIndices: {},
      view: {
        artist_groups: [{ artist: 'Artist Alpha', albums: [album] }],
        primary_artist_groups: [],
        family_artist_groups: [],
        ignored_version_keys: [],
        manual_version_links: {},
      },
    },
    getTrackModalElements() {
      return {
        overlay: {},
        cover,
        title,
        subtitle,
        list,
        footer,
        tabs,
        duplicateWarning,
        duplicateTabs,
        folder,
        editTags,
      };
    },
    getAlbumIdentity(item) {
      return String(item?.key || '');
    },
    escapeHtml(value) {
      return String(value);
    },
    albumHasDisplayCover() {
      return true;
    },
    buildAlbumDisplayCoverUrl() {
      return '/cover.png';
    },
    formatAlbumDuration() {
      return '';
    },
    getPlayerPlaybackSnapshot() {
      return {
        paused: true,
        ended: false,
        currentTime: 0,
        duration: 0,
      };
    },
    formatTrackDuration() {
      return '0:00';
    },
    formatLoopTime() {
      return '0:00';
    },
    getProblematicAlbumForTrackPath() {
      return null;
    },
    refreshTrackModalPlaybackState() {},
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.renderTrackModalRelease(album);

  assert.equal(folder.dataset.album, '');
  assert.equal(folder.dataset.albumKey, 'alpha');
  assert.equal(editTags.dataset.album, '');
  assert.equal(editTags.dataset.albumKey, 'alpha');
  assert.match(cover.innerHTML, /data-album-key="alpha"/);
  assert.doesNotMatch(cover.innerHTML, /data-album="/);
}

{
  const album = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [{ path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac' }],
    duplicate_sources: [
      {
        folder_name: 'Folder A',
        tracks: [{ path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac' }],
      },
      {
        folder_name: 'Folder B',
        tracks: [{ path: 'D:\\Mirror\\Artist Alpha\\Album Alpha\\01 Track.flac' }],
      },
    ],
  };
  const context = {
    console,
    document: {
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    state: {
      player: {
        current: null,
      },
      modalReleases: [album],
      modalReleaseIndex: 0,
      modalDuplicateSourceIndices: {},
      view: {
        artist_groups: [{ artist: 'Artist Alpha', albums: [album] }],
        primary_artist_groups: [],
        family_artist_groups: [],
        ignored_version_keys: [],
        manual_version_links: {},
      },
    },
    getAlbumIdentity(item) {
      return String(item?.key || '');
    },
    escapeHtml(value) {
      return String(value);
    },
    albumHasDisplayCover() {
      return false;
    },
    formatAlbumDuration() {
      return '';
    },
    getPlayerPlaybackSnapshot() {
      return {
        paused: true,
        ended: false,
        currentTime: 0,
        duration: 0,
      };
    },
    formatTrackDuration() {
      return '0:00';
    },
    formatLoopTime() {
      return '0:00';
    },
    getProblematicAlbumForTrackPath() {
      return null;
    },
    refreshTrackModalPlaybackState() {},
  };
  const duplicateWarning = { hidden: true, innerHTML: '' };
  const duplicateTabs = { hidden: true, innerHTML: '' };
  const baseElements = {
    overlay: {},
    cover: { innerHTML: '' },
    title: { textContent: '' },
    subtitle: { textContent: '' },
    list: { innerHTML: '' },
    footer: { hidden: true, textContent: '', innerHTML: '' },
    tabs: { hidden: true, innerHTML: '' },
    duplicateWarning,
    duplicateTabs,
    folder: { dataset: {} },
    editTags: { dataset: {} },
  };
  context.getTrackModalElements = () => baseElements;
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  context.renderTrackModalRelease(album);

  assert.match(duplicateWarning.innerHTML, /data-album-key="alpha"/);
  assert.match(duplicateWarning.innerHTML, /data-duplicate-source-index="0"/);
  assert.match(duplicateWarning.innerHTML, /data-duplicate-source-index="1"/);
  assert.doesNotMatch(duplicateWarning.innerHTML, /data-duplicate-folder-album=/);
}

{
  const album = {
    key: 'alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    year: 2001,
    tracks: [
      {
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac',
        title: 'Track One',
        artist: 'Artist Alpha',
        album_artist: 'Artist Alpha',
        track_number: 1,
        duration_seconds: 180,
      },
      {
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\02 Track.flac',
        title: 'Track Two (feat. Guest Singer)',
        artist: 'Solo Voice / Guest Singer',
        album_artist: 'Artist Alpha',
        track_number: 2,
        duration_seconds: 245,
      },
      {
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\03 Track.flac',
        title: 'Track Three',
        artist: 'Plain Performer',
        album_artist: 'Artist Alpha',
        track_number: 3,
        duration_seconds: 195,
      },
      {
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\04 Track.flac',
        title: 'Track Four',
        artist: 'Artist Alpha feat. Julien Jacob',
        album_artist: 'Artist Alpha',
        track_number: 4,
        duration_seconds: 205,
      },
    ],
    track_rows: [
      {
        track_ref: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac',
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Track.flac',
        title: 'Track One',
        track_number: 1,
        secondary_artist: null,
        duration_seconds: 180,
      },
      {
        track_ref: 'C:\\Music\\Artist Alpha\\Album Alpha\\02 Track.flac',
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\02 Track.flac',
        title: 'Track Two',
        track_number: 2,
        secondary_artist: 'Solo Voice / feat. Guest Singer',
        duration_seconds: 245,
      },
      {
        track_ref: 'C:\\Music\\Artist Alpha\\Album Alpha\\03 Track.flac',
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\03 Track.flac',
        title: 'Track Three',
        track_number: 3,
        secondary_artist: 'Plain Performer',
        duration_seconds: 195,
      },
      {
        track_ref: 'C:\\Music\\Artist Alpha\\Album Alpha\\04 Track.flac',
        path: 'C:\\Music\\Artist Alpha\\Album Alpha\\04 Track.flac',
        title: 'Track Four',
        track_number: 4,
        secondary_artist: 'feat. Julien Jacob',
        duration_seconds: 205,
      },
    ],
  };
  const list = { innerHTML: '' };
  const elements = {
    overlay: {},
    cover: { innerHTML: '' },
    title: { textContent: '' },
    subtitle: { textContent: '' },
    list,
    footer: { hidden: true, textContent: '', innerHTML: '' },
    tabs: { hidden: true, innerHTML: '' },
    duplicateWarning: { hidden: true, innerHTML: '' },
    duplicateTabs: { hidden: true, innerHTML: '' },
    folder: { dataset: {} },
    editTags: { dataset: {} },
  };
  const context = {
    console,
    document: {
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    state: {
      player: {
        current: null,
      },
      modalReleases: [album],
      modalReleaseIndex: 0,
      modalDuplicateSourceIndices: {},
      view: {
        artist_groups: [{ artist: 'Artist Alpha', albums: [album] }],
        primary_artist_groups: [],
        family_artist_groups: [],
        ignored_version_keys: [],
        manual_version_links: {},
      },
    },
    getAlbumIdentity(item) {
      return String(item?.key || '');
    },
    escapeHtml(value) {
      return String(value);
    },
    albumHasDisplayCover() {
      return false;
    },
    formatAlbumDuration() {
      return '';
    },
    getPlayerPlaybackSnapshot() {
      return {
        paused: true,
        ended: false,
        currentTime: 0,
        duration: 0,
      };
    },
    formatTrackDuration() {
      return '0:00';
    },
    formatLoopTime() {
      return '0:00';
    },
    getProblematicAlbumForTrackPath() {
      return null;
    },
    refreshTrackModalPlaybackState() {},
    getTrackModalElements() {
      return elements;
    },
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.renderTrackModalRelease(album);

  assert.match(
    list.innerHTML,
    /<span class="track-title">Track One<\/span>/,
  );
  assert.match(
    list.innerHTML,
    /<span class="track-title">Track Two<span class="track-artist-name">Solo Voice \/ feat\. Guest Singer<\/span><\/span>/,
  );
  assert.match(
    list.innerHTML,
    /<span class="track-title">Track Three<span class="track-artist-name">Plain Performer<\/span><\/span>/,
  );
  assert.match(
    list.innerHTML,
    /<span class="track-title">Track Four<span class="track-artist-name">feat\. Julien Jacob<\/span><\/span>/,
  );
  assert.match(list.innerHTML, /data-track-title="Track One"/);
  assert.match(list.innerHTML, /data-track-artist="Artist Alpha"/);
  assert.match(list.innerHTML, /data-track-title="Track Two \(feat\. Guest Singer\)"/);
  assert.match(list.innerHTML, /data-track-artist="Solo Voice \/ Guest Singer"/);
  assert.match(list.innerHTML, /data-track-title="Track Three"/);
  assert.match(list.innerHTML, /data-track-artist="Plain Performer"/);
  assert.match(list.innerHTML, /data-track-title="Track Four"/);
  assert.match(list.innerHTML, /data-track-artist="Artist Alpha feat\. Julien Jacob"/);

  const queue = context.buildQueueTracksForAlbum(
    album,
    'C:\\Music\\Artist Alpha\\Album Alpha\\02 Track.flac',
  );
  assert.equal(queue.tracks[0].title, 'Track One');
  assert.equal(queue.tracks[0].artist, 'Artist Alpha');
  assert.equal(queue.tracks[1].title, 'Track Two (feat. Guest Singer)');
  assert.equal(queue.tracks[1].artist, 'Solo Voice / Guest Singer');
  assert.equal(queue.tracks[2].title, 'Track Three');
  assert.equal(queue.tracks[2].artist, 'Plain Performer');
  assert.equal(queue.tracks[3].title, 'Track Four');
  assert.equal(queue.tracks[3].artist, 'Artist Alpha feat. Julien Jacob');

}

{
  const previewAlbum = {
    key: 'original',
    name: 'Lightbulb Sun',
    album_artist: 'Porcupine Tree',
    year: 2000,
    preview_only: true,
    tracks: [],
  };
  const hydratedAlbum = {
    key: 'original',
    name: 'Lightbulb Sun',
    album_artist: 'Porcupine Tree',
    year: 2000,
    tracks: [{ path: 'C:\\Music\\Porcupine Tree\\Lightbulb Sun\\01 - Lightbulb Sun.flac' }],
  };
  const specialEdition = {
    key: 'special-edition',
    name: 'Lightbulb Sun (Special Edition)',
    album_artist: 'Porcupine Tree',
    year: 2000,
    edition: 'Special Edition',
    release_date: '2000-11-21',
    preview_only: true,
    tracks: [],
  };

  const context = loadHelper([previewAlbum, specialEdition]);
  const releaseSet = context.getAlbumReleaseSet(hydratedAlbum);

  assert.equal(releaseSet.releases[0].key, 'original');
  assert.equal(Array.isArray(releaseSet.releases[0].tracks), true);
  assert.equal(releaseSet.releases[0].tracks.length, 1);
  assert.equal(releaseSet.releases[0].preview_only, undefined);
  assert.equal(releaseSet.releases[1].key, 'special-edition');
  assert.equal(releaseSet.selectedIndex, 0);
}

{
  const original = {
    key: 'original',
    name: 'Lightbulb Sun',
    album_artist: 'Porcupine Tree',
    year: 2000,
  };
  const specialEdition = {
    key: 'special-edition',
    name: 'Lightbulb Sun (Special Edition)',
    album_artist: 'Porcupine Tree',
    year: 2000,
    edition: 'Special Edition',
    release_date: '2000-11-21',
  };

  const context = loadHelper([original, specialEdition]);
  const releaseSet = context.getAlbumReleaseSet(original);
  const releaseKeys = Array.from(releaseSet.releases, (item) => item.key);
  const tabLabels = Array.from(releaseSet.releases, (item) => item.tabLabel);

  assert.deepEqual(
    releaseKeys,
    ['original', 'special-edition'],
  );
  assert.equal(releaseSet.selectedIndex, 0);
  assert.deepEqual(
    tabLabels,
    ['Original - 2000', 'Special Edition - 2000'],
  );
}
