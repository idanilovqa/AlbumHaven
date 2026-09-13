const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../../../music_app/static/js/runtime');
test('filtered shared navigation rows override their authored flex/grid display',()=>{
  const css=fs.readFileSync(path.resolve(root,'../../css/navigation-tree.css'),'utf8');
  assert.match(css,/#utility-modal\s+\.navigation-tree-item\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});
test('Appearance search filters existing navigation while retaining the mounted draft and selection',()=>{
  const listeners={},rows=['Main elements','Player & Seekbar','Selection & Hover','Alerts','Album page'].map(textContent=>({textContent,hidden:false}));
  const empty={hidden:true};let remounts=0;
  const els={overlay:{dataset:{},addEventListener(){}},search:{value:'',addEventListener:(name,fn)=>{listeners[name]=fn;}},
    list:{scrollTop:48,querySelectorAll:()=>rows,querySelector:()=>empty},count:{},detail:{draft:{color:'#123456'}}};
  const context=vm.createContext({state:{utility:{activeTab:'appearance',appearanceKey:'seekbar',searchQuery:'problem',loopsSearchQuery:'loop'}},
    getUtilityModalElements:()=>els,bindOverlayPointerOrigin(){},closeUtilityModal(){},renderUtilityModalContent:()=>{remounts++;}});
  for(const name of ['utility-renderers-and-actions.js','track-modal-and-gallery.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);
  context.attachUtilityModalEvents();
  els.search.value='album';listeners.input();
  assert.deepEqual(rows.map(row=>row.hidden),[true,true,true,true,false]);
  assert.equal(context.state.utility.appearanceKey,'seekbar');assert.equal(remounts,0);assert.equal(els.list.scrollTop,48);
  assert.deepEqual(els.detail.draft,{color:'#123456'});
  els.search.value='no such setting';listeners.input();assert.equal(empty.hidden,false);
  els.search.value='';listeners.search();assert.ok(rows.every(row=>!row.hidden));assert.equal(empty.hidden,true);
  assert.equal(context.state.utility.searchQuery,'problem');assert.equal(context.state.utility.loopsSearchQuery,'loop');
});

test('Appearance renderer enables the existing SearchInput and restores its independent query',()=>{
  const els={overlay:{},list:{innerHTML:'',querySelectorAll:()=>[],querySelector:()=>({hidden:true})},detail:{},count:{},search:{},problemFilterButton:{}};
  const context=vm.createContext({state:{utility:{appearanceKey:'backgrounds',appearanceSearchQuery:'main'}},
    window:{NavigationTree:{renderItem:()=>''}},getUtilityModalElements:()=>els,mountBackgroundAppearanceEditor(){}});
  vm.runInContext(fs.readFileSync(path.join(root,'utility-renderers-and-actions.js'),'utf8'),context);
  context.renderUtilityAppearance();
  assert.equal(els.search.disabled,false);assert.equal(els.search.value,'main');assert.match(els.search.placeholder,/Search/);
});

test('Integration search filters mounted section rows without replacing the current library draft',()=>{
  const listeners={},rows=['Library','Scrobbling','Foobar2000','Import Local Playlist'].map(textContent=>({textContent,hidden:false}));
  const empty={hidden:true};
  const els={overlay:{dataset:{},addEventListener(){}},search:{value:'',addEventListener:(name,fn)=>{listeners[name]=fn;}},
    list:{scrollTop:73,querySelectorAll:()=>rows,querySelector:()=>empty},count:{},detail:{draft:{path:'/owned/draft'}}};
  const context=vm.createContext({state:{utility:{activeTab:'integrations',selectedIntegrationKey:'library',appearanceSearchQuery:'main'}},
    getUtilityModalElements:()=>els,bindOverlayPointerOrigin(){},closeUtilityModal(){}});
  for(const name of ['utility-renderers-and-actions.js','track-modal-and-gallery.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);
  context.renderUtilityModalContent=()=>assert.fail('search remounted the current editor');
  context.attachUtilityModalEvents();els.search.value='foobar';listeners.input();
  assert.deepEqual(rows.map(row=>row.hidden),[true,true,false,true]);
  assert.equal(context.state.utility.selectedIntegrationKey,'library');assert.equal(els.list.scrollTop,73);
  assert.equal(els.detail.draft.path,'/owned/draft');assert.equal(context.state.utility.appearanceSearchQuery,'main');
  els.search.value='unmatched';listeners.input();assert.equal(empty.hidden,false);
  els.search.value='';listeners.search();assert.ok(rows.every(row=>!row.hidden));assert.equal(empty.hidden,true);
});
