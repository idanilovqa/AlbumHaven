const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../../music_app/static/js');
const load=file=>import(pathToFileURL(path.join(root,file)).href);
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
function addHost(native){const host=native.document.createElement('div');native.document.body.appendChild(host);return host;}
test('native SearchInput updates values in place, suppresses Enter and retires callbacks',async()=>{
 const {mountCreationSearch}=await load('playlists/native-creation.mjs'),native=createNativeHomeRuntime(),host=addHost(native),calls=[];
 const runtime={searchHtml:()=>'<input type="search"><button data-search-submit>Search</button><button data-search-clear>Clear</button>'};
 const owner=mountCreationSearch(host,runtime,{id:'test',value:'old',onChange:value=>calls.push(value)}),input=host.querySelector('input');
 owner.update({id:'test',value:'new',maxLength:12,onChange:value=>calls.push(value)});
 assert.equal(host.querySelector('input'),input);assert.equal(input.value,'new');assert.equal(input.maxLength,12);
 input.value='typed';input.dispatchEvent(new native.context.Event('input',{bubbles:true}));assert.deepEqual(calls,['typed']);
 const enter=new native.context.Event('keydown',{bubbles:true});enter.key='Enter';input.dispatchEvent(enter);assert.equal(enter.defaultPrevented,true);
 owner.update({id:'test',value:'disabled',disabled:true,onChange:value=>calls.push(value)});input.dispatchEvent(new native.context.Event('input',{bubbles:true}));assert.deepEqual(calls,['typed']);assert.equal(input.disabled,true);
 owner.dispose();input.dispatchEvent(new native.context.Event('input',{bubbles:true}));assert.deepEqual(calls,['typed']);assert.equal(host.childNodes.length,0);
});
test('native source fallback never manufactures queue authority and retires on dispose',async()=>{
 const {createPlaytableSource}=await load('playtables/native-selection.mjs');let current=true;const context={scopeKey:'scope'},instance={},rows=[{id:'a'},{id:'b'}];
 const options={runtime:{},context,instance,sourceRows:rows,rows,revision:1,isCurrent:()=>current,rowFacts:row=>({rowKey:row.id,readable:true,selectable:true})};
 const owner=createPlaytableSource(options),source=owner.sourceAdapter;
 assert.deepEqual(source.snapshot().rows.map(row=>row.rowKey),['a','b']);assert.equal(owner.actionsAvailable,false);assert.equal(source.canQueue(['a']),false);assert.equal(source.captureQueue(['a']),null);
 owner.update({...options,rows:[rows[1]],revision:2});assert.deepEqual(source.snapshot().rows.map(row=>row.rowKey),['b']);assert.equal(source.snapshot().revision,2);
 current=false;assert.equal(source.snapshot(),null);current=true;owner.dispose();assert.equal(source.snapshot(),null);assert.equal(source.resolveRows(['b']),null);
});
test('native source forwards queue capability only after accepted mapping and invalidates stale mapping',async()=>{
 const {createPlaytableSource}=await load('playtables/native-selection.mjs');let accepted=true,disposed=0,reads=0;const native={snapshot:()=>({scopeKey:'scope',rows:[]}),updateRows:()=>accepted,canQueue:()=>true,captureQueue:()=>{reads++;return {private:'receipt'};},subscribe:()=>()=>{},dispose:()=>disposed++};
 const options={runtime:{createPlaytableSource:()=>native,openPlaylistAction(){}},sourceRows:[],rows:[],context:{scopeKey:'scope'},instance:{},revision:1,isCurrent:()=>true,rowFacts:row=>row};const owner=createPlaytableSource(options);
 assert.equal(owner.actionsAvailable,true);assert.equal(owner.sourceAdapter.canQueue(['a']),true);assert.deepEqual(owner.sourceAdapter.captureQueue(['a']),{private:'receipt'});
 accepted=false;owner.update({...options,revision:2});assert.equal(owner.sourceAdapter.snapshot(),null);assert.equal(owner.sourceAdapter.captureQueue(['a']),null);assert.equal(reads,1);owner.dispose();assert.equal(disposed,1);
});
test('native mounted selection preserves Ctrl/Shift selection and removes paint on dispose',async()=>{
 const {mountPlaytableSelection}=await load('playtables/native-selection.mjs'),native=createNativeHomeRuntime(),host=addHost(native),actions=addHost(native);
 host.innerHTML='<div data-cdt-row-key="a" tabindex="0">A</div><div data-cdt-row-key="b" tabindex="0">B</div><div data-cdt-row-key="c" tabindex="0">C</div>';
 const instance={},source={snapshot:()=>({scopeKey:'scope',instance,revision:1,rows:['a','b','c'].map(rowKey=>({rowKey,readable:true,selectable:true}))}),subscribe:()=>()=>{}};
 const runtime={buttonHtml:value=>native.context.ButtonComponent.renderButton(value)};
 const owner=mountPlaytableSelection(host,{runtime,actionsHost:actions,sourceAdapter:source,isViewCurrent:()=>true});
 function click(key,props={}){const event=new native.context.Event('click');Object.assign(event,{detail:1,...props});host.querySelector(`[data-cdt-row-key="${key}"]`).dispatchEvent(event);}
 click('a');assert.deepEqual(owner.getSnapshot().selectedRowKeys,['a']);click('b',{ctrlKey:true});assert.deepEqual(owner.getSnapshot().selectedRowKeys,['a','b']);click('c',{shiftKey:true});assert.deepEqual(owner.getSnapshot().selectedRowKeys,['b','c']);assert.equal(host.querySelector('[data-cdt-row-key="b"]').getAttribute('aria-selected'),'true');
 owner.dispose();assert.equal(host.querySelector('[data-cdt-row-key="b"]').hasAttribute('aria-selected'),false);assert.equal(actions.childNodes.length,0);
});
test('native source fails closed for replacement identity or provider factory',async()=>{
 const {createPlaytableSource}=await load('playtables/native-selection.mjs');const context={scopeKey:'s'},runtime={},options={runtime,context,instance:{},rows:[],sourceRows:[],revision:1,isCurrent:()=>true,rowFacts:row=>row};const owner=createPlaytableSource(options);assert.ok(owner.sourceAdapter.snapshot());owner.update({...options,context:{scopeKey:'other'}});assert.equal(owner.sourceAdapter.snapshot(),null);assert.equal(owner.sourceAdapter.canQueue(['x']),false);owner.dispose();
});
test('directory adds semantic disclosure attributes even when native renderer only accepts data attributes',async()=>{
 const {mountPlaylistGroupedDirectory}=await load('playlists/native-directory-filters.mjs'),native=createNativeHomeRuntime(),host=addHost(native),escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;');
 const runtime={escapeHtml:escape,navigationItemHtml:options=>`<button ${Object.entries(options.attributes||{}).filter(([key])=>key.startsWith('data-')).map(([key,value])=>`${key}="${escape(value)}"`).join(' ')}>${escape(options.label)}</button>`};
 const owner=mountPlaylistGroupedDirectory(host,runtime,{items:[]});const button=host.querySelector('[data-playlist-group-toggle="manual"]');assert.ok(button.getAttribute('id'));assert.equal(button.getAttribute('aria-expanded'),'true');assert.ok(button.getAttribute('aria-controls'));native.click(button);assert.equal(button.getAttribute('aria-expanded'),'false');owner.dispose();
});
