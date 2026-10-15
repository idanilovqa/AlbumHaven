const fs=require('node:fs'),path=require('node:path');
const {ROOT:root}=require('../../../js/runtime/album-tops-membership-fixtures/top-builder-fixtures.cjs');
const scripts=['button-component.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/alert-components.js','runtime/album-artbox.js','runtime/gallery-main-components.js','runtime/gallery-card-component.js','runtime/in-page-tabs.js','runtime/search-input.js'];
const html='<!doctype html><html><head><meta charset="utf-8"><title>Bounded actual picker capacity</title></head><body><nav id="fixture-controls" aria-label="Explicit fixture operations"><button data-fixture="removeOne">Remove one through draft API</button><button data-fixture="reorder">Swap first two through draft API</button><button data-fixture="inspect">Inspect actual draft</button></nav><p>Bounded capacity probe: All is mounted against the genuine5000-item draft. Do not open Selected here; full-gallery rendering remains a separate unresolved performance observation.</p><pre id="fixture-observation"></pre><main id="picker-root"></main><template id="native-search-field-template"><div class="search-input-wrap search-field"><div class="search-field-control ui-input-action"><input type="search" autocomplete="off"><span class="search-field-action"><button type="button" data-search-clear aria-label="Clear search" hidden>Clear</button><button type="button" data-search-submit>Search</button></span></div></div></template></body></html>';
const extraCss='body{margin:0;overflow:auto;height:auto}#picker-root{width:100%;min-width:0}#fixture-controls{display:flex;gap:5px;padding:8px;background:#eee}#fixture-observation{max-height:160px;overflow:auto;font:12px monospace;white-space:pre-wrap}';
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
  for(const entry of ["music_app/static/js/album-tops/builder.mjs", "music_app/static/js/album-tops/draft.mjs", "music_app/static/js/album-tops/model.mjs"])collect(entry);
  const entryFile=confined(path.join(__dirname,'fixture-entry.jsx'));
  if(path.dirname(entryFile)!==fs.realpathSync(__dirname)||path.basename(entryFile)!=='fixture-entry.jsx')throw new Error('Fixture entry escaped its fixed directory');
  const entry=fs.readFileSync(entryFile,'utf8');
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
async function mount(page){const errors=[],consoleMessages=[];page.on('pageerror',error=>errors.push(String(error)));page.on('console',message=>consoleMessages.push({type:message.type(),text:message.text()}));
  await page.route('https://albumhaven.test/**',nativeDelivery(html));await page.goto('https://albumhaven.test/');for(const file of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  const template=fs.readFileSync(path.join(root,'music_app/templates/index.html'),'utf8');for(const file of new Set(['button-component.css',...[...template.matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(row=>row[1])]))await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static/css',file),'utf8')});
  await page.addStyleTag({content:extraCss});await page.evaluate(()=>{window.albumTopsFixtureReady=import('/__album_tops_fixture__/fixture-entry.mjs');return window.albumTopsFixtureReady.then(()=>undefined);});await page.evaluate(()=>startBoundedPicker());await page.getByRole('searchbox').waitFor({state:'visible'});return{errors,consoleMessages};}
module.exports={mount,root,scripts,html,extraCss};
