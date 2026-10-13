// Actual navigation owners; only HTTP/provider data and the external shell are synthetic.
const fs=require('node:fs'),path=require('node:path'),{buildSync}=require('esbuild');
const {ROOT:root}=require('../../../js/runtime/album-tops-membership-fixtures/top-builder-fixtures.cjs');
const components=['button-component.js','navigation-tree.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/alert-components.js','runtime/album-artbox.js','runtime/gallery-main-components.js','runtime/gallery-card-component.js','runtime/in-page-tabs.js','runtime/search-input.js'];
const owners=['settings-navigation.js','runtime/mobile-navigation.js','runtime/private-ui-transport.js','runtime/browser-dialog-helpers.js','runtime/browser-navigation-helpers.js','runtime/track-actions.js','runtime/track-modal-lightbox-helpers.js','runtime/gallery-refresh-and-status.js','runtime/album-tops-react-bridge.js'];
const template=fs.readFileSync(path.join(root,'music_app/templates/index.html'),'utf8');
const styles=[...new Set(['button-component.css',...[...template.matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(row=>row[1])])];
const dialogTemplate=fs.readFileSync(path.join(root,'music_app/templates/partials/confirm-modals.html'),'utf8');
const dialogStart=dialogTemplate.indexOf('<div class="confirm-modal" id="app-confirm-modal"');
if(dialogStart<0)throw new Error('Canonical native confirmation/form template is unavailable');
// Only this server-rendered macro needs a normal synthetic host equivalent;
// the native dialog markup, lifecycle and shared CSS remain actual owners.
const dialogs=dialogTemplate.slice(dialogStart).replace("{{ action_button('Close dialog', id='app-form-close', icon='close', hidden=true) }}",'<button type="button" id="app-form-close" class="action-button" aria-label="Close dialog" hidden>Close dialog</button>');
if(dialogs.includes('{{')||!dialogs.includes('id="app-form-modal"'))throw new Error('Native dialog template needs an explicit fixture update');
const html='<!doctype html><html><head><meta charset="utf-8"><title>Album Top real-owner UI fixture</title></head><body><button id="opener">Open Top builder</button>'+
  '<div id="app-shell" data-native-account-id="account:one" data-native-library-id="library:one" data-private-ui-context="'+'a'.repeat(64)+'"><main id="shell-main-surface"><div id="album-tops-root"><div id="mount"></div></div></main></div>'+
  '<section data-settings-host hidden><nav data-settings-nav><a href="/account" data-navigation-tree-item="settings" data-navigation-tree-key="account">Account</a></nav><div data-settings-outlet></div></section>'+dialogs+
  '<template id="native-search-field-template"><div class="search-input-wrap search-field"><div class="search-field-control ui-input-action"><input type="search" autocomplete="off"><span class="search-field-action"><button type="button" data-search-clear aria-label="Clear search" hidden>Clear</button><button type="button" data-search-submit>Search</button></span></div></div></template>'+
  '<script id="navigation-tree-item-template" type="text/plain"><%s %s>%s<span class="navigation-tree-label">%s</span>%s</%s></script></body></html>';
// Geometry only for the synthetic host. No field/header/card/modal styling.
const hostStyle='body{margin:0;overflow:auto;height:auto}#app-shell{display:block}#shell-main-surface{height:auto;min-height:0;overflow:visible}#album-tops-root,#mount{width:100%;min-width:0}';
let bundle;
async function mount(page,kind,options={}){
  const errors=[],consoleMessages=[];page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>consoleMessages.push({type:message.type(),text:message.text()}));
  if(!bundle)bundle=buildSync({stdin:{contents:fs.readFileSync(path.join(__dirname,'fixture-entry.jsx'),'utf8'),resolveDir:root,loader:'jsx'},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
  await page.route('https://albumhaven.test/**',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto('https://albumhaven.test/');
  for(const file of components)await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  for(const file of styles)await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static/css',file),'utf8')});
  await page.addStyleTag({content:hostStyle});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'navigation-prelude.js'),'utf8')});await page.evaluate(options=>bootstrapNavigationFixture(options),options);
  for(const file of owners)await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  await page.evaluate(()=>installNavigationObservers());await page.addScriptTag({content:bundle});await page.evaluate(({kind,options})=>startReviewFixture(kind,options),{kind,options});
  if(kind==='top-inline')await page.getByRole('button',{name:'Edit Album Top',exact:true}).waitFor({state:'visible'});
  else await page.getByRole('dialog',{name:'Create Album Top',exact:true}).waitFor({state:'visible'});
  return{errors,consoleMessages,search:page.getByRole('searchbox')};
}
module.exports={mount,root,html,components,owners,styles,hostStyle};
