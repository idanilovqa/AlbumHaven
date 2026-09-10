const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
function setup(key = 'problem-ignores', query = '') {
  const handlers = {};
  const elements = { overlay: {dataset: {}, addEventListener() {}}, list: {innerHTML: ''}, detail: {innerHTML: ''}, count: {}, search: {value: query, disabled: true, addEventListener(type, handler) { handlers[type] = handler; }} };
  const tables = [];
  const rules = [
    {key: 'version-exceptions', title: 'Version exceptions', albums: [{key: 'v1', name: 'Alpha Album', album_artist: 'Artist One', edition: 'Deluxe'}, {key: 'v2', name: 'Beta Album', album_artist: 'Artist Two'}]},
    {key: 'problem-ignores', title: 'Problem exclusions', album_items: [{row_key: 'a1', artist: 'Artist One', album: 'Alpha Album', problem_reason: 'Poor art quality'}], file_items: [{row_key: 'f1', filename: 'First Song.flac', album: 'Alpha Album', problem_reason: 'Missing year'}, {row_key: 'f2', filename: 'Second Song.flac', album: 'Beta Album', problem_reason: 'Missing title'}]},
  ];
  const context = { console, state: {utility: {activeTab: 'rules', rules, selectedRuleKey: key, rulesSearchQuery: query, searchQuery: 'existing Problems query'}},
    getUtilityModalElements: () => elements, escapeHtml: value => String(value ?? ''),
    ButtonComponent: {renderButton: () => '<button>Revert rule</button>'},
    buildCompactDataTable(config) { tables.push(config); return config.rows.map(row => JSON.stringify(row)).join(''); },
    bindOverlayPointerOrigin() {}, closeUtilityModal() {}, groupProblemIgnoreItems: () => [],
  };
  vm.createContext(context);
  for (const filename of ['utility-list-builders.js', 'utility-renderers-and-actions.js', 'track-modal-and-gallery.js']) vm.runInContext(fs.readFileSync(path.join(runtime, filename), 'utf8'), context);
  context.buildUtilityAlbumArtbox = () => '';
  context.buildUtilityRuleListItem = rule => `<nav>${rule.key}</nav>`;
  context.renderUtilityModalContent = () => context.renderUtilityRules();
  return {context, elements, tables, rules, handlers};
}
test('R01 Rules search is enabled and preserves both rule types and selected context', () => {
  const {context, elements} = setup('problem-ignores', 'Missing year');
  context.renderUtilityRules();
  assert.equal(elements.search.disabled, false);
  assert.equal(elements.search.value, 'Missing year');
  assert.match(elements.list.innerHTML, /version-exceptions/);
  assert.match(elements.list.innerHTML, /problem-ignores/);
  assert.equal(context.state.utility.selectedRuleKey, 'problem-ignores');
});
for (const [key, query, expected] of [['version-exceptions', 'alpha', ['v1']], ['version-exceptions', 'ARTIST TWO', ['v2']], ['version-exceptions', 'Deluxe', ['v1']], ['problem-ignores', '', ['a1', 'f1', 'f2']], ['problem-ignores', 'first song', ['f1']], ['problem-ignores', 'missing year', ['f1']], ['problem-ignores', 'alpha album', ['a1', 'f1']], ['problem-ignores', 'no matching target', []]]) {
  test(`R01 Rules filters ${key} by ${query} without mutating stored rules`, () => {
    const {context, tables, rules} = setup(key, query);
    const before = JSON.stringify(rules);
    context.renderUtilityRules();
    assert.deepEqual(tables.flatMap(table => Array.from(table.rows, row => row.key)), expected);
    assert.equal(JSON.stringify(rules), before);
    assert.equal(context.state.utility.selectedRuleKey, key);
  });
}
for (const event of ['input', 'search']) {
  test(`R01 shared ${event} event updates Rules while preserving Problems search`, () => {
    const {context, elements, handlers} = setup();
    context.attachUtilityModalEvents();
    elements.search.value = 'Missing year';
    handlers[event]();
    assert.equal(context.state.utility.rulesSearchQuery, 'Missing year');
    assert.equal(context.state.utility.searchQuery, 'existing Problems query');
    assert.match(elements.detail.innerHTML, /f1/);
    assert.doesNotMatch(elements.detail.innerHTML, /f2/);
  });
}