const fs=require('node:fs'),path=require('node:path'),{buildSync}=require('esbuild');
const {ROOT:root}=require('../../../js/runtime/album-tops-membership-fixtures/top-builder-fixtures.cjs');
const components=['button-component.js','navigation-tree.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/alert-components.js','runtime/album-artbox.js','runtime/gallery-main-components.js','runtime/gallery-card-component.js','runtime/in-page-tabs.js','runtime/search-input.js'];
const owners=['settings-navigation.js','runtime/mobile-navigation.js','runtime/private-ui-transport.js','runtime/browser-dialog-helpers.js','runtime/album-tops-react-bridge.js'];
const html='<!doctype html><html><head><meta charset="utf-8"><title>Top navigation fixture</title></head><body><a href="/account" id="settings-link">Open Settings</a>'+
  '<div id="app-shell" data-native-account-id="account:one" data-native-library-id="library:one" data-private-ui-context="'+'a'.repeat(64)+'"><aside id="album-tops-sidebar-root"></aside><main id="shell-main-surface"><div id="album-tops-root"></div></main></div>'+
  '<section data-settings-host hidden><nav data-settings-nav><a href="/account" data-navigation-tree-item="settings" data-navigation-tree-key="account">Account</a></nav><div data-settings-outlet></div></section>'+
  '<div class="confirm-modal" id="app-confirm-modal" hidden><div class="confirm-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title" aria-describedby="app-confirm-text"><h3 id="app-confirm-title"></h3><div id="app-confirm-text"></div><div class="confirm-modal-actions"><button class="button ui-button ui-button--quiet ui-button--medium" id="app-confirm-cancel">Cancel</button><button class="button ui-button ui-button--primary ui-button--medium" id="app-confirm-accept">Discard</button></div></div></div>'+
  '<template id="native-search-field-template"><div class="search-input-wrap search-field"><div class="search-field-control ui-input-action"><input type="search" autocomplete="off"><span class="search-field-action"><button type="button" data-search-clear aria-label="Clear search" hidden>Clear</button><button type="button" data-search-submit>Search</button></span></div></div></template>'+
  '<script id="navigation-tree-item-template" type="text/plain"><%s %s>%s<span class="navigation-tree-label">%s</span>%s</%s></script></body></html>';
let bundle;
async function mount(page,options={}){
  const errors=[],consoleMessages=[];page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>consoleMessages.push({type:message.type(),text:message.text()}));
  if(!bundle)bundle=buildSync({stdin:{contents:fs.readFileSync(path.join(__dirname,'fixture-entry.jsx'),'utf8'),resolveDir:root,loader:'jsx'},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
  await page.route('https://albumhaven.test/**',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto('https://albumhaven.test/');
  for(const file of components)await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  const template=fs.readFileSync(path.join(root,'music_app/templates/index.html'),'utf8');
  for(const file of new Set(['button-component.css',...[...template.matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(row=>row[1])]))await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static/css',file),'utf8')});
  await page.addStyleTag({content:'body{margin:0;overflow:auto;height:auto}#app-shell{display:block}#album-tops-sidebar-root{position:static;display:block;width:auto}#shell-main-surface{height:auto;min-height:0;overflow:visible}#album-tops-root{width:100%;min-width:0}'});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'navigation-prelude.js'),'utf8')});await page.evaluate(options=>bootstrapNavigationFixture(options),options);
  for(const file of owners)await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  await page.evaluate(()=>installNavigationObservers());await page.addScriptTag({content:bundle});await page.evaluate(options=>startNavigationFixture(options),options);
  await page.getByRole('button',{name:'Edit Album Top',exact:true}).waitFor({state:'visible'});return{errors,consoleMessages};
}
module.exports={mount,root,html,components,owners};
