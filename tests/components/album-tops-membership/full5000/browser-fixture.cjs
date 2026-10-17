const fs = require('node:fs');
const path = require('node:path');
const {test: base, expect} = require('@playwright/test');
const {root, F, dataset} = require('../../../js/runtime/album-tops-membership-fixtures/full5000.cjs');
const {Full5000NativePicker} = require('./picker-page.cjs');
const N = 24;
const dataFixture = dataset(N);
function source(relative) {return fs.readFileSync(path.join(root, relative), 'utf8');}
// Resolve only the reachable native ES module graph. Exact review hashes live
// in the packet bindings, not in this durable browser delivery fixture.
function nativeDelivery(html) {
  const realRoot=fs.realpathSync(root), bodies=new Map();
  const nativeRoot=path.join(realRoot,'music_app/static/js');
  const confined=file=>{
    const resolved=fs.realpathSync(file);
    if(!resolved.startsWith(realRoot+path.sep))throw new Error('Native fixture path escaped repository: '+file);
    return resolved;
  };
  function collect(relative) {
    const url='/'+relative;
    if(bodies.has(url))return;
    if(!relative.startsWith('music_app/static/js/')||!relative.endsWith('.mjs'))throw new Error('Non-native module: '+relative);
    const file=confined(path.resolve(realRoot,relative));
    if(!file.startsWith(nativeRoot+path.sep)||!file.endsWith('.mjs'))throw new Error('Non-native module path: '+relative);
    const body=fs.readFileSync(file,'utf8');
    // Deliberately bounded static syntax, not a JavaScript parser or bundler.
    // Current owners use static imports. Dynamic imports fail closed.
    if(/\bimport\s*\(/.test(body))throw new Error('Dynamic module imports are not supported: '+relative);
    const imports=[];
    const declarations=/\bimport\s+(?:[^;'"`]*?\s+from\s*)?(['"])([^'"\r\n]+)\1\s*;|\bexport\s+(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\}\s*)from\s*(['"])([^'"\r\n]+)\3\s*;/g;
    const remaining=body.replace(declarations,(_match,_q,spec,_eq,exportSpec)=>{imports.push(spec||exportSpec);return '';});
    if(/^\s*import\b/m.test(remaining)||/^\s*export\s+(?:\*|\{)[^;]*\bfrom\b/m.test(remaining))throw new Error('Unsupported module declaration: '+relative);
    bodies.set(url,body);
    for(const spec of imports) {
      if(!/^\.{1,2}\/[a-zA-Z0-9_./-]+\.mjs$/.test(spec))throw new Error('Only relative native .mjs dependencies are allowed: '+spec);
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(relative),spec));
      collect(dependency);
    }
  }
  for(const entry of ["music_app/static/js/album-tops/builder.mjs", "music_app/static/js/album-tops/draft.mjs"])collect(entry);
  const entryFile=confined(path.join(__dirname,'fixture-entry.jsx'));
  if(path.dirname(entryFile)!==fs.realpathSync(__dirname)||path.basename(entryFile)!=='fixture-entry.jsx')throw new Error('Fixture entry escaped its fixed directory');
  const entry=fs.readFileSync(entryFile,'utf8').replace('__PICKER_INITIAL_STATE__',JSON.stringify(F.state({editing:true,data:dataFixture.data})));
  return route=>{
    const request=route.request(),raw=request.url();
    const reject=()=>route.fulfill({status:404,contentType:'text/plain',body:'Unknown fixture resource'});
    let url;try{url=new URL(raw);}catch{return reject();}
    const pathname=url.pathname;
    // Never reinterpret encoded/malformed paths as the document fallback.
    if(request.method()!=='GET'||pathname.includes('%')||raw.includes('\\'))return reject();
    if(!url.search&&pathname==='/__album_tops_fixture__/fixture-entry.mjs')return route.fulfill({contentType:'text/javascript; charset=utf-8',body:entry});
    if(!url.search&&bodies.has(pathname))return route.fulfill({contentType:'text/javascript; charset=utf-8',body:bodies.get(pathname)});
    if(request.resourceType()==='document'&&!/\.(?:m?js|jsx|cjs)(?:\/|$)/i.test(pathname)&&!pathname.startsWith('/music_app/')&&!pathname.startsWith('/__album_tops_fixture__/'))return route.fulfill({contentType:'text/html',body:html});
    return reject();
  };
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
  await page.route('https://albumhaven.test/**',nativeDelivery(fixtureHtml()));await page.goto('https://albumhaven.test/');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/loader-status-helpers.js',
    'runtime/alert-components.js', 'runtime/album-artbox.js', 'runtime/gallery-main-components.js',
    'runtime/gallery-card-component.js', 'runtime/in-page-tabs.js', 'runtime/search-input.js']) {
    await page.addScriptTag({content: source(`music_app/static/js/${file}`)});
  }
  const styles = new Set(['button-component.css', ...[...source('music_app/templates/index.html').matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(row => row[1])]);
  for (const file of styles) await page.addStyleTag({content: source(`music_app/static/css/${file}`)});
  await page.addStyleTag({content: 'body{margin:0;overflow:auto;height:auto}#picker-root{width:100%;min-width:0}nav[aria-label="Explicit component-fixture simulations"]{display:flex;flex-wrap:wrap;gap:4px;padding:8px}'});
  await page.evaluate(()=>{window.albumTopsFixtureReady=import('/__album_tops_fixture__/fixture-entry.mjs');return window.albumTopsFixtureReady.then(()=>undefined);});
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
