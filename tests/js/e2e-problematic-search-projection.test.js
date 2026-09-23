const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

test('Problematic Files search waits for the exact nonempty virtual projection', async () => {
  const { UtilityProblematicFilesActions } = await import('../e2e/actions/utilityProblematicFilesActions.js');
  const { UtilityProblematicFilesTab } = await import('../e2e/poms/utilityProblematicFilesTab.js');
  const keys = Array.from({ length: 706 }, (_, index) => `album-${index}`);
  let rendered = keys.slice(12, 20);
  const dataset = { problematicVirtualStart: '12', problematicVirtualEnd: '20', problematicMountedCount: '8' };
  const count = { textContent: '706' };
  const context = vm.createContext({
    state: { utility: { searchQuery: '' } },
    getFilteredProblematicAlbums: () => keys.map(key => ({ key })),
    document: {
      querySelector: selector => selector === '#utility-problematic-list' ? {
        dataset,
        querySelectorAll: () => rendered.map(key => ({ getAttribute: () => key })),
      } : count,
      querySelectorAll: () => rendered.map(key => ({ getAttribute: () => key })),
    },
  });
  const pom = Object.create(UtilityProblematicFilesTab.prototype);
  pom.searchSection = { searchInput: { fill: async value => assert.equal(value, '') } };
  pom.waitForPageCondition = async (predicate, options, arg) => {
    assert.equal(options.timeout, 60000);
    context.expected = arg;
    const ready = () => vm.runInContext(`(${predicate.toString()})(expected)`, context);
    assert.equal(ready(), true, 'A correct 8-row window of 706 filtered albums is ready');
    context.state.utility.searchQuery = 'stale';
    assert.equal(ready(), false, 'The input query must have committed');
    context.state.utility.searchQuery = '';
    rendered = [...rendered].reverse();
    assert.equal(ready(), false, 'Mounted order must match the filtered slice');
    rendered = keys.slice(12, 19);
    assert.equal(ready(), false, 'The entire declared window must be mounted');
    rendered = [];
    assert.equal(ready(), false, 'An empty window cannot satisfy a nonempty dataset');
    rendered = keys.slice(12, 20);
    dataset.problematicVirtualEnd = '707';
    assert.equal(ready(), false, 'Range must stay inside the filtered dataset');
    dataset.problematicVirtualEnd = '20';
    count.textContent = '1';
    assert.equal(ready(), false, 'Rendered filtered count must match the projection');
    count.textContent = '706';
    dataset.problematicMountedCount = '7';
    assert.equal(ready(), false, 'Mounted count must match the declared window');
  };
  await new UtilityProblematicFilesActions(pom).clearSearch();
});
