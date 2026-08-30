const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('isolated rarity fixture uses generated media before the Postgres snapshot', () => {
  const fixture = read('tests/e2e/support/isolatedLibraryApp.py');

  assert.match(fixture, /RARITY_FIXTURE_ARTIST = "E2E Rarity Artist"/);
  assert.match(fixture, /sine=frequency=\{int\(frequency_hz\)\}:duration=4:sample_rate=44100/);
  assert.match(fixture, /"-codec:a",[\s\S]*"libmp3lame",[\s\S]*"-q:a",[\s\S]*"4"/);
  assert.match(
    fixture,
    /materialize_rarity_fixture_tracks\(library_root, file_cache\)[\s\S]*materialize_fixture_track_files\(file_cache, loop_source\)[\s\S]*persist_fixture_inventory\(setup_database_url, library_root, file_cache\)/,
  );
  assert.match(fixture, /resolved_destination\.relative_to\(resolved_root\)/);
});

test('rarity-edit scenario keeps selectors and interactions in POMs and actions', () => {
  const spec = read('tests/e2e/specs/nonAlbumRarity.spec.js');
  const pom = read('tests/e2e/poms/tagEditor.js');
  const actions = read('tests/e2e/actions/tagEditorActions.js');
  const settingsPom = read('tests/e2e/poms/artistPageSettings.js');
  const settingsActions = read('tests/e2e/actions/artistPageSettingsActions.js');
  const pomExports = read('tests/e2e/poms/index.js');
  const actionExports = read('tests/e2e/actions/index.js');
  const fixtures = read('tests/e2e/support/baseFixtures.js');

  assert.match(spec, /FTC-NON-ALBUM-006/);
  assert.doesNotMatch(spec, /FTC-TAGS-002|FTC-NON-ALBUM-004/);
  assert.match(
    spec,
    /openTagEditor\(\)[\s\S]*selectTrackByFilename\(RARITY_TRACK_FILENAME\)[\s\S]*setException\('Non-album rarity'\)[\s\S]*applyAndWaitForSavedFiles\(\{[\s\S]*expectNonAlbumRarityWarning: true/,
  );
  assert.match(
    spec,
    /applyAndWaitForSavedFiles\(\{[\s\S]*expectNonAlbumRarityWarning: true[\s\S]*openTagEditor\(\)[\s\S]*waitForOpen\(\{ expectedTrackCount: 1 \}\)[\s\S]*tagEditorActions\.close\(\)[\s\S]*readAlbumNamesByHeading\(RARITY_ARTIST\)/,
  );
  assert.match(
    spec,
    /readAlbumNamesByHeading\(RARITY_ARTIST\)[\s\S]*albumNames\.filter\(\(albumName\) => albumName === RARITY_ALBUM\)[\s\S]*new Set\(albumNames\)\.size[\s\S]*reloadCurrentView\(\)[\s\S]*readAlbumNamesByHeading\(RARITY_ARTIST\)[\s\S]*albumNames\.filter\(\(albumName\) => albumName === RARITY_ALBUM\)[\s\S]*new Set\(albumNames\)\.size/,
  );
  assert.match(spec, /thirdPartyRequestEvidence\.snapshot\(\)[\s\S]*toEqual\(\[\]\)/);
  assert.match(
    spec,
    /openNonAlbumTracks\(1\)[\s\S]*readNonAlbumTrackTitles\(\)[\s\S]*RARITY_TRACK_TITLE[\s\S]*search\(RARITY_TRACK_TITLE[\s\S]*waitForAlbumHidden\(RARITY_ALBUM\)/,
  );
  assert.doesNotMatch(spec, /\.locator\s*\(|\.evaluate\s*\(|\.route\s*\(/);
  assert.match(pom, /class TagEditor extends BasePage/);
  assert.match(pom, /select\[data-tag-field="exception_type"\]/);
  assert.match(actions, /class TagEditorActions/);
  assert.match(actions, /\/utilities\/edit-tags/);
  assert.match(actions, /utilities\\\/save-task\\\//);
  assert.match(
    actions,
    /expectNonAlbumRarityWarning[\s\S]*editRequestCount !== 0[\s\S]*confirmButton\.click\(\)/,
  );
  assert.match(
    actions,
    /const responseTaskCompleted = String\(payload\.save_task_status \|\| ''\) === 'completed';[\s\S]*if \(!responseTaskCompleted\)[\s\S]*\.toBe\('completed'\);[\s\S]*responseTaskCompleted[\s\S]*\? 'Tag changes saved\.'[\s\S]*: 'Library view updated from saved files\.'[\s\S]*expect\(this\.tagEditor\.repairAlert\)\.toBeVisible\(/,
  );
  assert.match(pomExports, /export \{ TagEditor \} from '\.\/tagEditor\.js'/);
  assert.match(actionExports, /export \{ TagEditorActions \} from '\.\/tagEditorActions\.js'/);
  assert.match(fixtures, /tagEditorActions: async[\s\S]*new TagEditorActions\(new TagEditor\(page, testInfo\)\)/);
  assert.match(settingsPom, /nonAlbumTracksButtonSelector[\s\S]*data-open-non-album-modal/);
  assert.match(
    settingsActions,
    /openNonAlbumTracks\(expectedCount[\s\S]*readNonAlbumTrackTitles\(\)/,
  );
});
