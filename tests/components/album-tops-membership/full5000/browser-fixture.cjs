const fs = require('node:fs');
const path = require('node:path');
const {buildSync} = require('esbuild');
const {test: base, expect} = require('@playwright/test');
const {root, F, dataset} = require('../../../js/runtime/album-tops-membership-fixtures/full5000.cjs');
const {Full5000NativePicker} = require('./picker-page.cjs');
const N = 24;
const dataFixture = dataset(N);
let bundle;
function source(relative) {return fs.readFileSync(path.join(root, relative), 'utf8');}
function buildFixture() {
  bundle ||= buildSync({stdin: {contents: fs.readFileSync(path.join(__dirname, 'fixture-entry.jsx'), 'utf8'),
    resolveDir: root, sourcefile: 'full5000-native-component-fixture.jsx', loader: 'jsx'},
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: {__PICKER_INITIAL_STATE__: JSON.stringify(F.state({editing: true, data: dataFixture.data}))}}).outputFiles[0].text;
  return bundle;
}
function fixtureHtml() {
  const match = source('music_app/templates/partials/search-input.html').match(/\{% macro search_input\([^]*?-?%\}([^]*?)\{%- endmacro %\}/);
  if (!match) throw new Error('The native Search macro is required by this component fixture');
  const search = match[1].replace(/\{% if suggestions_id %\}[^]*?\{% endif %\}/g, '')
    .replace(/\{% if caller is defined %\}[^]*?\{% endif %\}/g, '').replace(/\{\{[^]*?\}\}/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Native AlbumPicker row preservation</title></head><body>
<nav aria-label="Explicit component-fixture simulations">
<button type="button" id="fixture-busy">Simulate controller busy</button>
<button type="button" id="fixture-deny">Simulate metadata authority revocation</button>
<button type="button" id="fixture-recover">Restore initial controller state</button>
<button type="button" id="fixture-disabled-remove">Synthetic probe: disabled Remove click</button>
<button type="button" id="fixture-disabled-end">Synthetic probe: disabled End event</button>
</nav><main id="picker-root"></main><template id="native-search-field-template">${search}</template></body></html>`;
}
async function mount(page) {
  await page.setContent(fixtureHtml());
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js',
    'runtime/alert-components.js', 'runtime/album-artbox.js', 'runtime/gallery-main-components.js',
    'runtime/gallery-card-component.js', 'runtime/in-page-tabs.js', 'runtime/search-input.js']) {
    await page.addScriptTag({content: source(`music_app/static/js/${file}`)});
  }
  const styles = new Set(['button-component.css', ...[...source('music_app/templates/index.html').matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(row => row[1])]);
  for (const file of styles) await page.addStyleTag({content: source(`music_app/static/css/${file}`)});
  await page.addStyleTag({content: 'body{margin:0;overflow:auto;height:auto}#picker-root{width:100%;min-width:0}nav[aria-label="Explicit component-fixture simulations"]{display:flex;flex-wrap:wrap;gap:4px;padding:8px}'});
  await page.addScriptTag({content: buildFixture()});
}
const test = base.extend({
  picker: async ({page}, use, testInfo) => {
    const errors = [], consoleErrors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
    const picker = new Full5000NativePicker(page, dataFixture.expected, dataFixture.data);
    try {
      await mount(page); await picker.ready();
      await use(picker);
      expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
    } finally {
      let observation;
      try {observation = await picker.read();} catch (error) {observation = {unavailable: String(error)};}
      await testInfo.attach('native-picker-row-observation', {body: JSON.stringify({observation, errors, consoleErrors}, null, 2), contentType: 'application/json'});
    }
  },
});
module.exports = {test};
