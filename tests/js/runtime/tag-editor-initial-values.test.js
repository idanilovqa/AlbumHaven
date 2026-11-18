const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(
  __dirname, '../../../music_app/static/js/runtime/utility-loaders-and-cover-lookup.js',
), 'utf8');
const start = source.indexOf('function getTrackTagInitialValues(');
const end = start + source.slice(start).search(/\r?\n}\r?\n/);
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}\n}`, context);
const { getTrackTagInitialValues } = context;

// Owner (11-18): the year was erased on "...Карусель Эпох...", yet Edit Tags opened
// from Problematic Files showed the cached list's 2006.
test('an erased track year opens empty even when the album summary still has one', () => {
  const staleListItem = { name: '...Карусель Эпох...', album_artist: 'R.D.(Роман Дрозд)', year: 2006 };
  const detailTrack = { path: 'D:/Music/Карусель Эпох/1 Герзлания.mp3', title: 'Герзлания', year: null };

  assert.equal(getTrackTagInitialValues(detailTrack, staleListItem).year, '');
});

test('a track year wins over the album summary year', () => {
  assert.equal(getTrackTagInitialValues({ year: 2007 }, { year: 2006 }).year, '2007');
});

test('a track without a year field still shows the album year', () => {
  assert.equal(getTrackTagInitialValues({ title: 'Song' }, { year: 2006 }).year, '2006');
});
