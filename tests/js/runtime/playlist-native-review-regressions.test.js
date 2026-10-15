const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./playlist-native-review-fixture.cjs');
const load=name=>import(`../../../music_app/static/js/playlists/${name}.mjs`);
test('F1 filter updates keep focused Choice DOM and open native menu until its value changes',async()=>{
 const {mountPlaylistFilterControls}=await load('native-directory-filters'),{defaultFilters}=await load('model'),h=fixture();let props,owner;
 const onChange=patch=>{props={...props,filters:{...props.filters,...patch}};owner.update(props);};
 props={filters:defaultFilters,rows:[],onChange};owner=mountPlaylistFilterControls(h.host,h.runtime,props);
 const button=h.host.querySelector('button[aria-label="Love: Any love"]');assert.ok(button);button.focus();h.click(button);const menu=h.menus.at(-1);assert.ok(menu.isOpen);
 owner.update({...props,rows:[]});assert.equal(h.host.querySelector('button[aria-label="Love: Any love"]'),button);assert.equal(h.document.activeElement,button);assert.equal(menu.closes,0);
 menu.config.onSelect('loved');assert.equal(props.filters.love,'loved');assert.equal(h.host.querySelector('button[aria-label="Love: Only loved"]'),button);assert.equal(h.document.activeElement,button);
 const before=[...h.host.querySelectorAll('.ui-choice__trigger')];owner.update({...props,filters:{...props.filters,frequency:'frequent'}});assert.equal(h.host.querySelector('button[aria-label="Love: Only loved"]'),button);assert.ok(before.every(node=>node.isConnected));owner.dispose();assert.equal(button.isConnected,false);
});
test('F2 same item replacement retains Album tab and pending detail owner; another item resets Track',async()=>{
 const {mountPlaylistSelectionPanel}=await load('native-selection'),h=fixture(),requests=[];
 const readDetail=options=>{requests.push(options);return new Promise(()=>{});};
 const row={row_key:'one',playlist_item_id:'item-one',source_readable:true,title:'One',album_ref:'album:one',allowed_actions:{can_read:true,can_view_details:true}},props={scopeKey:'scope',row,readDetail};
 const owner=mountPlaylistSelectionPanel(h.host,h.runtime,props);h.click(h.host.querySelector('[data-in-page-tab="album"]'));await h.settle();assert.equal(h.host.querySelector('[aria-selected="true"]').dataset.inPageTab,'album');assert.equal(requests.length,1);
 const nativeHost=h.host.querySelector('.home-detail__native-host');owner.update({...props,row:{...row,title:'Updated title'}});await h.settle();assert.equal(h.host.querySelector('[aria-selected="true"]').dataset.inPageTab,'album');assert.equal(h.host.querySelector('.home-detail__native-host'),nativeHost);assert.equal(requests.length,1);assert.equal(requests[0].signal.aborted,false);
 owner.update({...props,row:{...row,album_ref:'album:two'}});await h.settle();assert.equal(h.host.querySelector('[aria-selected="true"]').dataset.inPageTab,'album');assert.equal(requests.length,2);assert.equal(requests[0].signal.aborted,true);
 owner.update({...props,row:{...row,row_key:'two',playlist_item_id:'item-two'}});assert.equal(h.host.querySelector('[aria-selected="true"]').dataset.inPageTab,'track');assert.equal(requests[1].signal.aborted,true);owner.dispose();
});
test('F5 table follows refreshed default until explicit local sort, including explicit default-order override',async()=>{
 const {mountPlaylistTracks}=await load('native-track-table'),h=fixture();
 const rows=[{row_key:'a',playlist_item_id:'a',source_readable:true,title:'A',duration_seconds:90,availability:'local'},{row_key:'b',playlist_item_id:'b',source_readable:true,title:'B',duration_seconds:20,availability:'local'}];
 let detail={playlist_id:'p',title:'P',track_rows:rows,items_complete:true,author_order:true,allowed_actions:{}},state={scopeKey:'s',selectedPlaylistId:'p',resource:{status:'ready',data:{detail}},mutation:{status:'idle'},drafts:{},filters:{}};
 const controller={getSnapshot:()=>state,reorder(){assert.fail('Sort must not mutate order');}},props=()=>({rows,detail,state,controller,onSelect(){},onError:assert.fail});const owner=mountPlaylistTracks(h.host,h.runtime,props()),order=()=>[...h.host.querySelectorAll('[data-playlist-row-key]')].map(node=>node.dataset.playlistRowKey);
 assert.deepEqual(order(),['a','b']);detail={...detail,saved_default_sort:{key:'duration',direction:'asc'}};state={...state,resource:{status:'ready',data:{detail}}};owner.update(props());assert.deepEqual(order(),['b','a']);
 h.click(h.host.querySelector('[data-cdt-sort="duration"]'));assert.deepEqual(order(),['a','b']);detail={...detail,saved_default_sort:{key:'duration',direction:'asc'}};state={...state,resource:{status:'ready',data:{detail}}};owner.update(props());assert.deepEqual(order(),['a','b']);
 h.click(h.host.querySelector('[data-cdt-sort="duration"]'));owner.update(props());assert.deepEqual(order(),['a','b']);owner.dispose();
});
test('F6 Library Mix setup starts without unavailable warning and shows preparation failures',async()=>{
 const {mountLibraryMixSetup}=await load('native-library-mix'),h=fixture(),listeners=new Set();let state={resource:{status:'unavailable'}};
 const controller={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},prepare:async()=>false},owner=mountLibraryMixSetup(h.host,h.runtime,{controller,onReady(){},onClose(){}});
 const status=()=>h.document.querySelector('.home-friends__status');assert.equal(h.visible(status()),false);
 for(const value of ['loading','error','denied']){state={resource:{status:value}};for(const fn of listeners)fn();assert.equal(h.visible(status()),true,value);}
 state={resource:{status:'ready'}};for(const fn of listeners)fn();assert.equal(h.visible(status()),false);owner.dispose();assert.equal(listeners.size,0);
});
test('F6 temporary Mix suppresses idle save status and exposes pending recovery and confirmed navigation',async()=>{
 const {mountLibraryMixPage}=await load('native-library-mix'),h=fixture(),listeners=new Set();let pending=false,opened=0,state={scopeKey:'s',resource:{status:'ready',data:null},mutation:{status:'idle'},title:'Mix',description:'',playbackOrder:'regular',coverage:{},recipe:{auto_update:true}};
 const controller={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},pendingSave:()=>pending,canSave:()=>false,edit(){},setOrder(){},retrySave:async()=>null},owner=mountLibraryMixPage(h.host,h.runtime,{controller,onClose(){},onSaved(){opened++;}});
 const statuses=()=>[...h.host.querySelectorAll('.home-friends__status')];assert.equal(h.visible(statuses().at(-1)),false);
 pending=true;state={...state,mutation:{status:'error'}};for(const fn of listeners)fn();assert.equal(h.visible(statuses().at(-1)),true);const retry=[...h.host.querySelectorAll('button')].find(button=>button.textContent==='Check original save');assert.equal(h.visible(retry),true);
 pending=false;state={...state,mutation:{status:'ready',data:{playlist_id:'saved'}}};for(const fn of listeners)fn();const open=[...h.host.querySelectorAll('button')].find(button=>button.textContent==='Open saved playlist');assert.equal(h.visible(open),true);h.click(open);assert.equal(opened,1);owner.dispose();assert.equal(listeners.size,0);
});
