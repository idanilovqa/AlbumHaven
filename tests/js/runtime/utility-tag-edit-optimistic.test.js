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
  'utility-loaders-and-cover-lookup.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelpers() {
  const context = {
    deepCloneJson(value) {
      return JSON.parse(JSON.stringify(value));
    },
    formatAlbumDuration() {
      return '';
    },
    formatCanonicalAlbumDuration(seconds) {
      const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
      const totalMinutes = Math.floor(totalSeconds / 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours) return `${hours}h ${minutes}m`;
      return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
    },
    findVisibleAlbumByTrackPaths() {
      return null;
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

function createTagEditorTrackButton(path) {
  let pendingMarker = null;
  return {
    getAttribute(name) {
      return name === 'data-tag-editor-track' ? path : '';
    },
    insertAdjacentHTML(_position, html) {
      pendingMarker = {
        html,
        remove() { pendingMarker = null; },
      };
    },
    querySelector(selector) {
      return selector === '[data-tag-editor-pending="1"]' ? pendingMarker : null;
    },
  };
}

test('non-album tag-editor collections preserve blank track-owned identity fields', () => {
  const context = loadHelpers();
  const values = context.getTrackTagInitialValues({
    artist: 'Display Artist',
    tag_artist: '',
    album_artist: '',
    album: '',
  }, {
    name: 'Non-album tracks',
    album_artist: 'Selected Artist',
    tag_editor_collection: true,
  });

  assert.equal(values.artist, '');
  assert.equal(values.album_artist, '');
  assert.equal(values.album, '');
});

test('album detail tag editor preserves an explicitly blank track Album', () => {
  const context = loadHelpers();
  const values = context.getTrackTagInitialValues({
    album: '',
    artist: 'E2E Rarity Artist',
    title: 'Rename Track 2',
  }, {
    name: 'Queued Album Rename Fixture',
    album_artist: 'E2E Rarity Artist',
  });

  assert.equal(values.album, '');
});

test('blank Album edit immediately adds the track to the Other projection', () => {
  const context = loadHelpers();
  const path = 'C:\\Music\\Artist\\Album\\02 - Track.mp3';
  context.state = { view: { non_album_tracks: [] } };

  const tracks = context.applyTagEditsToNonAlbumView({
    album_artist: 'Artist',
    tracks: [{ path, title: 'Track', artist: 'Artist', track_number: 2 }],
  }, {
    [path]: { album: '' },
  });

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].path, path);
  assert.equal(tracks[0].album, '');
  assert.equal(tracks[0].exception_type, '');
});

test('exception-only rarity edit immediately adds the track to the non-album projection', () => {
  const context = loadHelpers();
  const path = 'C:\\Music\\Artist\\Album\\01 - Track.mp3';
  context.state = { view: { non_album_tracks: [] } };

  const tracks = context.applyTagEditsToNonAlbumView({
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{
      path,
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      track_number: 1,
      exception_type: '',
    }],
  }, {
    [path]: { exception_type: 'Non-album rarity' },
  });

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].path, path);
  assert.equal(tracks[0].album, 'Album');
  assert.equal(tracks[0].exception_type, 'Non-album rarity');
});

test('all exposed tag fields are applied optimistically and committed values replace them authoritatively', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Artist\\Album\\01 - Track.flac';
  const album = {
    name: 'Album',
    album_artist: 'Artist',
    year: 2001,
    tracks: [{
      path: trackPath,
      artist: 'Artist',
      album_artist: 'Artist',
      album: 'Album',
      title: 'Track',
      genre: 'Rock',
      year: 2001,
      track_number: 1,
      disc_number: 1,
      exception_type: '',
      edition: '',
      album_rating: 4,
    }],
  };
  const optimisticValues = {
    artist: 'Optimistic Artist',
    album_artist: 'Optimistic Album Artist',
    album: 'Optimistic Album',
    title: 'Optimistic Track',
    genre: 'Folk',
    year: '2002',
    track_number: '2',
    disc_number: '3',
    exception_type: '',
    edition: 'Optimistic Edition',
    album_rating: '8',
  };
  const committedValues = {
    ...optimisticValues,
    artist: 'Committed Artist',
    title: 'Committed Track',
    album_rating: '9',
  };
  context.state = {
    tagEditor: {
      album,
      tracks: album.tracks,
      values: { [trackPath]: { ...optimisticValues } },
    },
    view: { non_album_tracks: [] },
  };

  const optimisticAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [trackPath]: optimisticValues,
  });
  const optimisticTrack = optimisticAlbums[0].tracks[0];
  context.installCommittedTagValues(album, { [trackPath]: committedValues });

  assert.deepEqual(
    JSON.parse(JSON.stringify({
      artist: optimisticTrack.artist,
      album_artist: optimisticTrack.album_artist,
      album: optimisticTrack.album,
      title: optimisticTrack.title,
      genre: optimisticTrack.genre,
      year: optimisticTrack.year,
      track_number: optimisticTrack.track_number,
      disc_number: optimisticTrack.disc_number,
      exception_type: optimisticTrack.exception_type,
      edition: optimisticTrack.edition,
      album_rating: optimisticTrack.album_rating,
    })),
    {
      ...optimisticValues,
      year: 2002,
      track_number: 2,
      disc_number: 3,
      album_rating: 8,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.tagEditor.values[trackPath])),
    committedValues,
  );
  assert.equal(context.state.tagEditor.tracks[0].artist, 'Committed Artist');
  assert.equal(context.state.tagEditor.tracks[0].title, 'Committed Track');
  assert.equal(context.state.tagEditor.tracks[0].album_rating, 9);
});

test('committed blank Album and None exception remain in the Other projection', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Artist\\Album\\02 - Track.flac';
  const album = {
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{
      path: trackPath,
      artist: 'Artist',
      album: 'Album',
      title: 'Track',
      exception_type: 'Non-album rarity',
    }],
  };
  context.state = { tagEditor: {}, view: { non_album_tracks: [] } };

  context.installCommittedTagValues(album, {
    [trackPath]: { album: '', exception_type: '' },
  });

  assert.equal(context.state.view.non_album_tracks.length, 1);
  assert.equal(context.state.view.non_album_tracks[0].path, trackPath);
  assert.equal(context.state.view.non_album_tracks[0].album, '');
  assert.equal(context.state.view.non_album_tracks[0].exception_type, '');
});

test('pending tag diff controls Apply eligibility and exact track-row markers', () => {
  const context = loadHelpers();
  const changedPath = 'C:\\Music\\Artist\\Album\\01 Changed.flac';
  const unchangedPath = 'C:\\Music\\Artist\\Album\\02 Unchanged.flac';
  const album = {
    name: 'Album',
    album_artist: 'Artist',
    tracks: [
      { path: changedPath, album: 'Album', album_artist: 'Artist', title: 'Original title' },
      { path: unchangedPath, album: 'Album', album_artist: 'Artist', title: 'Unchanged' },
    ],
  };
  const changedButton = createTagEditorTrackButton(changedPath);
  const unchangedButton = createTagEditorTrackButton(unchangedPath);
  const applyButton = { disabled: true };
  context.state = {
    tagEditor: {
      album,
      tracks: album.tracks,
      values: Object.fromEntries(album.tracks.map((track) => [
        track.path,
        context.getTrackTagInitialValues(track, album),
      ])),
    },
  };
  context.state.tagEditor.values[changedPath].title = 'Proposed title';
  context.getTagEditorElements = () => ({
    applyButton,
    list: {
      querySelectorAll() { return [changedButton, unchangedButton]; },
    },
  });

  const pending = context.syncTagEditorPendingChanges();

  assert.deepEqual(Object.keys(pending), [changedPath]);
  assert.equal(applyButton.disabled, false);
  assert.match(
    changedButton.querySelector('[data-tag-editor-pending="1"]').html,
    /aria-label="Pending changes"/,
  );
  assert.equal(unchangedButton.querySelector('[data-tag-editor-pending="1"]'), null);

  context.state.tagEditor.values[changedPath].title = 'Original title';
  context.syncTagEditorPendingChanges();

  assert.equal(applyButton.disabled, true);
  assert.equal(changedButton.querySelector('[data-tag-editor-pending="1"]'), null);
});

test('blank Album remains applicable without an Exception', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Artist\\Album\\01 Track.flac';
  const album = {
    name: 'Album',
    album_artist: 'Artist',
    tracks: [
      { path: trackPath, album: 'Album', album_artist: 'Artist', title: 'Track' },
    ],
  };
  const attributes = new Map();
  const albumInput = {
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const applyButton = { disabled: true };
  context.state = {
    tagEditor: {
      album,
      tracks: album.tracks,
      values: {
        [trackPath]: {
          ...context.getTrackTagInitialValues(album.tracks[0], album),
          album: '',
        },
      },
    },
  };
  context.getTagEditorElements = () => ({
    albumInput,
    applyButton,
    list: { querySelectorAll() { return []; } },
  });

  context.syncTagEditorPendingChanges();

  assert.equal(attributes.has('aria-invalid'), false);
  assert.equal(attributes.has('aria-describedby'), false);
  assert.equal(applyButton.disabled, false);
});

test('optimistic album rename preserves album year when detail tracks omit year', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Kaipa\\2026 - Sommargryningsljus\\01 Track.flac';
  const album = {
    key: 'kaipa::sommargryningsljus::2026',
    name: 'Sommargryningsljus',
    album_artist: 'Kaipa',
    year: 2026,
    tracks: [{
      path: trackPath,
      album: 'Sommargryningsljus',
      album_artist: 'Kaipa',
      title: 'Track',
    }],
  };

  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [trackPath]: { album: 'Sommargryningsljus (Renamed)' },
  });

  assert.equal(updatedAlbums.length, 1);
  assert.equal(updatedAlbums[0].year, 2026);
  assert.equal(updatedAlbums[0].tracks[0].year, 2026);
});

test('optimistic album split preserves release ordering metadata for the inserted card', () => {
  const context = loadHelpers();
  const firstPath = 'C:\\Music\\Artist\\Remixes\\01 First.flac';
  const secondPath = 'C:\\Music\\Artist\\Remixes\\02 Second.flac';
  const album = {
    key: 'artist::remixes::2026',
    name: 'Remixes',
    album_artist: 'Artist',
    year: 2026,
    release_date: '2026-07-03',
    edition: 'Fixture Edition',
    album_preference: { rating: 8 },
    tracks: [
      {
        path: firstPath,
        album: 'Remixes',
        album_artist: 'Artist',
        title: 'First',
        duration_seconds: 64,
      },
      {
        path: secondPath,
        album: 'Remixes',
        album_artist: 'Artist',
        title: 'Second',
        duration_seconds: 8,
      },
    ],
  };

  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [firstPath]: { album: 'Remixes 2' },
  });
  const insertedAlbum = updatedAlbums.find((item) => item.name === 'Remixes 2');
  const sourceAlbum = updatedAlbums.find((item) => item.name === 'Remixes');

  assert.ok(insertedAlbum);
  assert.ok(sourceAlbum);
  assert.equal(insertedAlbum.total_duration_display, '1m 04s');
  assert.equal(sourceAlbum.total_duration_display, '0m 08s');
  assert.deepEqual(
    JSON.parse(JSON.stringify(insertedAlbum.album_preference)),
    album.album_preference,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sourceAlbum.album_preference)),
    album.album_preference,
  );
  assert.notStrictEqual(insertedAlbum.album_preference, sourceAlbum.album_preference);
  assert.equal(
    insertedAlbum.release_date,
    album.release_date,
    'the optimistic new card must sort in the same release-date position as its authoritative replacement',
  );
  assert.equal(
    insertedAlbum.edition,
    album.edition,
    'the optimistic new card must keep the canonical album edition in its identity key',
  );
  assert.equal(
    insertedAlbum.key,
    'artist::remixes 2::fixture edition',
    'ordinary optimistic album keys must match the authoritative artist/name/edition identity',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(insertedAlbum.tracks.map((track) => track.edition))),
    [album.edition],
    'tracks without detail-level edition metadata must inherit the canonical album edition',
  );

  const separateReleaseAlbums = context.buildOptimisticUpdatedAlbumsFromEdits({
    ...album,
    key: 'artist::remixes::fixture edition::year::2026',
  }, {
    [firstPath]: { album: 'Remixes 2' },
  });
  assert.equal(
    separateReleaseAlbums.find((item) => item.name === 'Remixes 2')?.key,
    'artist::remixes 2::fixture edition',
    'a renamed destination must not inherit a separate-release rule owned by the source base key',
  );
  assert.equal(
    separateReleaseAlbums.find((item) => item.name === 'Remixes')?.key,
    'artist::remixes::fixture edition::year::2026',
    'the unchanged source base must retain its explicit separate-release year segment',
  );
});

test('optimistic source split publishes exact full membership for both resulting albums', () => {
  const context = loadHelpers();
  const sourceTracks = Array.from({ length: 15 }, (_value, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
    title: `Studio Track ${index + 1}`,
    album: 'Studio Records',
    album_artist: 'DDT',
    track_number: index + 1,
  }));
  const album = {
    key: 'ddt::studio-records',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 15,
    track_paths: sourceTracks.map((track) => track.path),
    tracks: sourceTracks,
  };

  const candidates = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [sourceTracks[0].path]: { album: 'Studio Records3' },
  });
  const source = candidates.find((candidate) => candidate.name === album.name);
  const suffix = candidates.find((candidate) => candidate.name === 'Studio Records3');

  assert.ok(source);
  assert.equal(source.preview_only, false);
  assert.equal(source.track_count_preview, 14);
  assert.deepEqual(
    Array.from(source.track_paths),
    sourceTracks.slice(1).map((track) => track.path),
  );
  assert.deepEqual(
    Array.from(source.tracks, (track) => track.path),
    sourceTracks.slice(1).map((track) => track.path),
  );
  assert.ok(suffix);
  assert.equal(suffix.preview_only, false);
  assert.equal(suffix.track_count_preview, 1);
  assert.deepEqual(Array.from(suffix.track_paths), [sourceTracks[0].path]);
  assert.deepEqual(Array.from(suffix.tracks, (track) => track.path), [sourceTracks[0].path]);
});

test('album-only split preserves raw album-artist credits without an implicit artist edit', () => {
  const context = loadHelpers();
  const firstPath = 'C:\\Music\\ДДТ\\Студийные записи\\01 First.flac';
  const secondPath = 'C:\\Music\\ДДТ\\Студийные записи\\02 Second.flac';
  const album = {
    key: 'ддт::студийные записи::1988',
    name: 'Студийные записи',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [
      {
        path: firstPath,
        album: 'Студийные записи',
        album_artist: 'Юрий Шевчук / ДДТ',
        title: 'First',
      },
      {
        path: secondPath,
        album: 'Студийные записи',
        album_artist: 'Юрий Шевчук / ДДТ',
        title: 'Second',
      },
    ],
  };
  context.findVisibleAlbumByTrackPaths = () => ({
    album_artist: 'Юрий Шевчук / ДДТ',
    name: 'Студийные записи',
  });

  const albumOnlyCandidates = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [firstPath]: { album: 'Студийные записи2' },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(albumOnlyCandidates.map((candidate) => ({
      albumArtist: candidate.album_artist,
      name: candidate.name,
      trackAlbumArtists: candidate.tracks.map((track) => track.album_artist),
    })).sort((left, right) => left.name.localeCompare(right.name)))),
    [
      {
        albumArtist: 'Юрий Шевчук / ДДТ',
        name: 'Студийные записи',
        trackAlbumArtists: ['Юрий Шевчук / ДДТ'],
      },
      {
        albumArtist: 'Юрий Шевчук / ДДТ',
        name: 'Студийные записи2',
        trackAlbumArtists: ['Юрий Шевчук / ДДТ'],
      },
    ],
  );

  const explicitArtistCandidates = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [firstPath]: {
      album: 'Студийные записи2',
      album_artist: 'Юрий Шевчук',
    },
  });
  const explicitlyCreditedSuffix = explicitArtistCandidates.find(
    (candidate) => candidate.name === 'Студийные записи2',
  );
  assert.equal(explicitlyCreditedSuffix?.album_artist, 'Юрий Шевчук');
  assert.equal(explicitlyCreditedSuffix?.tracks[0]?.album_artist, 'Юрий Шевчук');
});

test('album-only split preserves server-owned per-track artist rows in optimistic albums', () => {
  const context = loadHelpers();
  const ddtPath = 'C:\\Music\\DDT\\Studio Records\\04.mp3';
  const shevchukPath = 'C:\\Music\\DDT\\Studio Records\\09.mp3';
  const album = {
    key: 'ddt::studio-records',
    name: 'Студийные записи',
    album_artist: 'ДДТ / Юрий Шевчук',
    year: 1990,
    tracks: [
      {
        path: ddtPath,
        album: 'Студийные записи',
        artist: 'ДДТ',
        album_artist: 'ДДТ',
        title: 'Предчувствие гражданской войны',
      },
      {
        path: shevchukPath,
        album: 'Студийные записи',
        artist: 'Юрий Шевчук',
        album_artist: 'Юрий Шевчук',
        title: 'Ариозо Германа',
      },
    ],
    track_rows: [
      { path: ddtPath, title: 'Предчувствие гражданской войны', secondary_artist: 'ДДТ' },
      { path: shevchukPath, title: 'Ариозо Германа', secondary_artist: 'Юрий Шевчук' },
    ],
  };

  const candidates = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [ddtPath]: { album: 'Студийные записи5' },
  });
  const source = candidates.find((candidate) => candidate.name === 'Студийные записи');
  const suffix = candidates.find((candidate) => candidate.name === 'Студийные записи5');

  assert.deepEqual(
    JSON.parse(JSON.stringify(source?.track_rows || [])),
    [{ path: shevchukPath, title: 'Ариозо Германа', secondary_artist: 'Юрий Шевчук' }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(suffix?.track_rows || [])),
    [{ path: ddtPath, title: 'Предчувствие гражданской войны', secondary_artist: 'ДДТ' }],
  );
});

test('optimistic album split normalizes legacy album rating into each preference', () => {
  const context = loadHelpers();
  const firstPath = 'C:\\Music\\Artist\\Legacy\\01 First.flac';
  const secondPath = 'C:\\Music\\Artist\\Legacy\\02 Second.flac';
  const album = {
    key: 'artist::legacy::2026',
    name: 'Legacy',
    album_artist: 'Artist',
    year: 2026,
    album_rating: 8,
    tracks: [
      {
        path: firstPath,
        album: 'Legacy',
        album_artist: 'Artist',
        title: 'First',
        album_rating: '',
      },
      {
        path: secondPath,
        album: 'Legacy',
        album_artist: 'Artist',
        title: 'Second',
        album_rating: '',
      },
    ],
  };

  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [firstPath]: { album: 'Legacy 2' },
  });
  const insertedAlbum = updatedAlbums.find((item) => item.name === 'Legacy 2');
  const sourceAlbum = updatedAlbums.find((item) => item.name === 'Legacy');

  assert.equal(insertedAlbum?.album_preference?.rating, 8);
  assert.equal(sourceAlbum?.album_preference?.rating, 8);
  assert.notStrictEqual(insertedAlbum.album_preference, sourceAlbum.album_preference);
});

test('optimistic album split inherits the visible source preference when modal data omits it', () => {
  const context = loadHelpers();
  const firstPath = 'C:\\Music\\Artist\\Visible\\01 First.flac';
  const secondPath = 'C:\\Music\\Artist\\Visible\\02 Second.flac';
  const sourceTrackPaths = new Set([firstPath, secondPath]);
  context.findVisibleAlbumByTrackPaths = (trackPaths) => {
    assert.deepEqual(Array.from(trackPaths), Array.from(sourceTrackPaths));
    return {
      album_preference: { rating: 8, loved: true },
      album_rating: 8,
    };
  };
  const album = {
    key: 'artist::visible::2026',
    name: 'Visible',
    album_artist: 'Artist',
    year: 2026,
    album_rating: '',
    tracks: [
      {
        path: firstPath,
        album: 'Visible',
        album_artist: 'Artist',
        title: 'First',
        album_rating: '',
      },
      {
        path: secondPath,
        album: 'Visible',
        album_artist: 'Artist',
        title: 'Second',
        album_rating: '',
      },
    ],
  };

  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [firstPath]: { album: 'Visible 2' },
  });
  const insertedAlbum = updatedAlbums.find((item) => item.name === 'Visible 2');
  const sourceAlbum = updatedAlbums.find((item) => item.name === 'Visible');

  assert.deepEqual(
    JSON.parse(JSON.stringify(insertedAlbum?.album_preference)),
    { rating: 8, loved: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sourceAlbum?.album_preference)),
    { rating: 8, loved: true },
  );
  assert.notStrictEqual(insertedAlbum.album_preference, sourceAlbum.album_preference);
});

test('one selected track album edit leaves sibling tracks in the source album', () => {
  const context = loadHelpers();
  const firstPath = 'C:\\Music\\Artist\\Remixes\\01 First.flac';
  const secondPath = 'C:\\Music\\Artist\\Remixes\\02 Second.flac';
  const album = {
    key: 'artist::remixes::2026',
    name: 'Remixes',
    album_artist: 'Artist',
    year: 2026,
    tracks: [
      { path: firstPath, album: 'Remixes', album_artist: 'Artist', title: 'First' },
      { path: secondPath, album: 'Remixes', album_artist: 'Artist', title: 'Second' },
    ],
  };
  const initialValues = Object.fromEntries(album.tracks.map((track) => [
    track.path,
    context.getTrackTagInitialValues(track, album),
  ]));
  initialValues[firstPath].album = 'Remixes 2';

  const updates = context.buildChangedTagEditorUpdates(album, album.tracks, initialValues);
  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, updates);

  assert.deepEqual(JSON.parse(JSON.stringify(updates)), {
    [firstPath]: { album: 'Remixes 2' },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(updatedAlbums.map((item) => ({
      name: item.name,
      paths: item.tracks.map((track) => track.path),
    })))),
    [
      { name: 'Remixes 2', paths: [firstPath] },
      { name: 'Remixes', paths: [secondPath] },
    ],
  );
});

test('blanking Album on the only track produces no optimistic gallery album', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Artist\\Only Album\\01 Only.flac';
  const album = {
    key: 'artist::only album::2009',
    name: 'Only Album',
    album_artist: 'Artist',
    year: 2009,
    tracks: [{
      path: trackPath,
      album: 'Only Album',
      album_artist: 'Artist',
      title: 'Only Track',
    }],
  };

  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, {
    [trackPath]: { album: '' },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(updatedAlbums)), []);
});

test('album edit still updates every track when every track is selected', () => {
  const context = loadHelpers();
  const firstPath = 'C:\\Music\\Artist\\Remixes\\01 First.flac';
  const secondPath = 'C:\\Music\\Artist\\Remixes\\02 Second.flac';
  const album = {
    key: 'artist::remixes::2026',
    name: 'Remixes',
    album_artist: 'Artist',
    year: 2026,
    tracks: [
      { path: firstPath, album: 'Remixes', album_artist: 'Artist', title: 'First' },
      { path: secondPath, album: 'Remixes', album_artist: 'Artist', title: 'Second' },
    ],
  };
  const values = Object.fromEntries(album.tracks.map((track) => [
    track.path,
    {
      ...context.getTrackTagInitialValues(track, album),
      album: 'Remixes 2',
    },
  ]));

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.buildChangedTagEditorUpdates(album, album.tracks, values),
    )),
    {
      [firstPath]: { album: 'Remixes 2' },
      [secondPath]: { album: 'Remixes 2' },
    },
  );
});

test('selected-track album-only rename keeps the source album year while preserving the raw track year', () => {
  const context = loadHelpers();
  const selectedPath = 'C:\\Music\\Artist\\Album\\01 Selected.flac';
  const siblingPath = 'C:\\Music\\Artist\\Album\\02 Sibling.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    year: 2000,
    tracks: [
      {
        path: selectedPath,
        album: 'Album',
        album_artist: 'Artist',
        title: 'Selected',
        year: 2001,
      },
      {
        path: siblingPath,
        album: 'Album',
        album_artist: 'Artist',
        title: 'Sibling',
        year: 2000,
      },
    ],
  };
  const values = Object.fromEntries(album.tracks.map((track) => [
    track.path,
    context.getTrackTagInitialValues(track, album),
  ]));
  values[selectedPath].album = 'Album (Renamed)';

  const updates = context.buildChangedTagEditorUpdates(album, album.tracks, values);
  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, updates);

  assert.deepEqual(JSON.parse(JSON.stringify(updates)), {
    [selectedPath]: { album: 'Album (Renamed)' },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(updatedAlbums.map((item) => ({
      name: item.name,
      year: item.year,
      tracks: item.tracks.map((track) => ({
        path: track.path,
        year: track.year,
      })),
    })))),
    [
      {
        name: 'Album (Renamed)',
        year: 2000,
        tracks: [{ path: selectedPath, year: 2001 }],
      },
      {
        name: 'Album',
        year: 2000,
        tracks: [{ path: siblingPath, year: 2000 }],
      },
    ],
  );
});

test('title-only edit sends only title and retains one album card', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Artist\\Album\\01 Track.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    year: 2000,
    tracks: [{
      path: trackPath,
      album: 'Album',
      album_artist: 'Artist',
      title: 'Old title',
      year: 2000,
      genre: 'Progressive Rock',
    }],
  };
  const values = {
    [trackPath]: {
      ...context.getTrackTagInitialValues(album.tracks[0], album),
      title: 'New title',
    },
  };

  const updates = context.buildChangedTagEditorUpdates(album, album.tracks, values);
  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, updates);

  assert.deepEqual(JSON.parse(JSON.stringify(updates)), {
    [trackPath]: { title: 'New title' },
  });
  assert.equal(updatedAlbums.length, 1);
  assert.equal(updatedAlbums[0].name, 'Album');
  assert.equal(updatedAlbums[0].year, 2000);
  assert.equal(updatedAlbums[0].tracks[0].title, 'New title');
});

test('genre-only edit sends only genre and retains one album card', () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\Artist\\Album\\01 Track.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    year: 2000,
    tracks: [{
      path: trackPath,
      album: 'Album',
      album_artist: 'Artist',
      title: 'Track',
      year: 2000,
      genre: 'Progressive Rock',
    }],
  };
  const values = {
    [trackPath]: {
      ...context.getTrackTagInitialValues(album.tracks[0], album),
      genre: 'Art Rock',
    },
  };

  const updates = context.buildChangedTagEditorUpdates(album, album.tracks, values);
  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, updates);

  assert.deepEqual(JSON.parse(JSON.stringify(updates)), {
    [trackPath]: { genre: 'Art Rock' },
  });
  assert.equal(updatedAlbums.length, 1);
  assert.equal(updatedAlbums[0].name, 'Album');
  assert.equal(updatedAlbums[0].year, 2000);
  assert.equal(updatedAlbums[0].tracks[0].genre, 'Art Rock');
});

test('year-only edit sends only year and creates two same-name year cards', () => {
  const context = loadHelpers();
  const selectedPath = 'C:\\Music\\Artist\\Album\\01 Selected.flac';
  const siblingPath = 'C:\\Music\\Artist\\Album\\02 Sibling.flac';
  const album = {
    key: 'artist::album::2000',
    name: 'Album',
    album_artist: 'Artist',
    year: 2000,
    tracks: [
      {
        path: selectedPath,
        album: 'Album',
        album_artist: 'Artist',
        title: 'Selected',
        year: 2000,
      },
      {
        path: siblingPath,
        album: 'Album',
        album_artist: 'Artist',
        title: 'Sibling',
        year: 2000,
      },
    ],
  };
  const values = Object.fromEntries(album.tracks.map((track) => [
    track.path,
    context.getTrackTagInitialValues(track, album),
  ]));
  values[selectedPath].year = '2001';

  const updates = context.buildChangedTagEditorUpdates(album, album.tracks, values);
  const updatedAlbums = context.buildOptimisticUpdatedAlbumsFromEdits(album, updates);

  assert.deepEqual(JSON.parse(JSON.stringify(updates)), {
    [selectedPath]: { year: '2001' },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      updatedAlbums.map((item) => [item.name, item.year, item.tracks.length]),
    )),
    [
      ['Album', 2001, 1],
      ['Album', 2000, 1],
    ],
  );
});
