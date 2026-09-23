const test = require('node:test');
const assert = require('node:assert/strict');

test('recent searches align with the complete shared search control including Clear', async () => {
  const { SearchToolbar } = await import('../e2e/poms/searchToolbar.js');
  const control = { x: 20, y: 10, width: 360, height: 38 };
  const popover = { x: 20, y: 48, width: 360, height: 80 };
  const page = {
    locator: selector => ({ boundingBox: async () => selector === '#search-form .search-field-control' ? control : { ...control, width: 324 } }),
    getByRole: () => ({ boundingBox: async () => popover, getByRole: () => ({}) }),
    on() {},
  };
  const pom = new SearchToolbar(page);
  assert.deepEqual(await pom.readRecentSearchGeometry(), { input: control, popover });
});
