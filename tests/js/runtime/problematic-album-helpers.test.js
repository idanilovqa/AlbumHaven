const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  'problematic-album-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(overrides = {}) {
  const context = {
    URLSearchParams,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

{
  const context = loadHelper();

  assert.equal(context.formatRuleFieldLabel('album_artist'), 'album artist');
  assert.equal(context.formatRepairFieldLabel('album_disc_marker'), 'Album + disc number');
  assert.equal(context.getFileTypeFromPath('C:\\Music\\track.flac'), 'FLAC');
  assert.equal(context.getFilenameFromPath('/music/track01.mp3'), 'track01.mp3');
}

{
  const context = loadHelper();
  const grouped = JSON.parse(JSON.stringify(context.groupProblemIgnoreItems([
    { album_group_key: 'a', artist: 'Broadcast', album: 'Tender Buttons', year: '2005', filename: 'b.flac' },
    { album_group_key: 'a', artist: 'Broadcast', album: 'Tender Buttons', year: '2005', filename: 'a.flac' },
    { album_group_key: 'b', artist: 'Autechre', album: 'Amber', year: '1994', filename: 'c.flac' },
  ])));

  assert.deepEqual(grouped.map((group) => group.key), ['b', 'a']);
  assert.deepEqual(grouped[1].items.map((item) => item.filename), ['a.flac', 'b.flac']);
  assert.equal(context.getProblemIgnoreGroupTitle(grouped[1]), 'Broadcast - Tender Buttons - 2005 (2 files)');
}

{
  const context = loadHelper();
  const album = {
    album_artist: 'Unknown Artist',
    raw_album_artist: 'Boards of Canada',
    name: 'Unknown Album',
    raw_name: 'Music Has the Right to Children',
    year: '1998',
    repair_preview_rows: [
      { field: 'album_artist', repaired: 'Boards of Canada' },
      { field: 'album', repaired: 'Music Has the Right to Children' },
    ],
    tracks: [
      { path: 'C:\\Music\\one.flac', title: 'One' },
      { path: 'C:\\Music\\two.mp3', title: 'Two' },
    ],
  };

  assert.equal(
    context.buildDiscogsSearchUrl(album),
    'https://www.discogs.com/search/?q=Boards+of+Canada+Music+Has+the+Right+to+Children+1998&type=release',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(context.getProblematicAlbumFileTypes(album))), ['FLAC', 'MP3']);
  assert.equal(context.getRepairRowFileType({ path: 'C:\\Music\\one.flac' }), 'FLAC');
}
