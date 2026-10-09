const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const model = () => import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/queue-selection.mjs')));
test('Queue descriptor keeps occurrence identities and normalizes order against current rows', async () => {
  const {queueSelectionIds} = await model(); const value = {entries: [{id:'one'}, {id:'two'}, {id:'three'}]};
  assert.deepEqual(queueSelectionIds(['three','one'], value), ['one','three']);
  assert.deepEqual(queueSelectionIds(['one','one'], value), []);
  assert.deepEqual(queueSelectionIds(['one','removed'], value), []);
});
