// Additive source-boundary tests. Execute only in the authorized validation phase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../music_app/static/js');
const paths = ['playlists/native-creation.mjs','playlists/native-mutation-status.mjs','playlists/native-directory-filters.mjs','playlists/native-library-mix.mjs','playlists/native-selection.mjs','playlists/native-track-table.mjs','playtables/native-selection.mjs','playtables/native-track-table-presentation.mjs'];
for (const file of paths) test(`${file} uses native owners without a replacement framework`, () => {
 const source=fs.readFileSync(path.join(root,file),'utf8');
 assert.doesNotMatch(source,/from\s+['"](?:react(?:-dom)?(?:\/[^'"]*)?|preact|vue|solid-js)['"]/);
 assert.doesNotMatch(source,/createRoot\s*\(|use(?:State|Effect|LayoutEffect|Memo|Ref|SyncExternalStore)\s*\(/);
 assert.doesNotMatch(source,/from\s+['"][^'"]+\.jsx['"]/);
 assert.match(source,/dispose\s*\(/);
});
test('Playlist track table delegates native selection, reorder and preference authority',()=>{
 const source=fs.readFileSync(path.join(root,'playlists/native-track-table.mjs'),'utf8');
 for(const name of ['mountPlaytableSelection','mountPlaylistReorder','createTrackPreferenceController','trackIntent','displayedItemIds'])assert.ok(source.includes(name),name);
 assert.match(source,/owner\.controller\.getSnapshot\(\)\s*===\s*owner\.state/);
 assert.match(source,/props\s*===\s*owner/);
});
test('Library Mix retains recipe locking disclosure and original-save recovery',()=>{
 const source=fs.readFileSync(path.join(root,'playlists/native-library-mix.mjs'),'utf8');
 for(const name of ['normalizeMixRecipe','generated membership locked','generated membership is locked','retrySave','pendingSave','notifications===before','setLibraryMixOrder'])assert.ok(source.includes(name),name);
 assert.match(source,/const current=owner=>!disposed&&active===owner&&owner\.generation===generation/);
 assert.match(source,/if\(!current\(owner\)\)\{release\(stop\);return;\}/);
});
