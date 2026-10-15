const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,driver,action}=require('./playlist-header-migration-fixture.cjs');
let createPlaylistController,mountPlaylistsView,mountPlaylistHeader;
test.before(async()=>{
 ({createPlaylistController}=await import('../../../music_app/static/js/playlists/model.mjs'));
 ({mountPlaylistsView}=await import('../../../music_app/static/js/playlists/native-app.mjs'));
 ({mountPlaylistHeader}=await import('../../../music_app/static/js/playlists/native-headers.mjs'));
});
function session({canExport = true, complete = true, authorOrder = true} = {}) {
  const controller = createPlaylistController();
  const track = (id, availability, extra = {}) => ({playlist_item_id: id, title: id, artist: 'Artist', album_title: 'Album', availability, ...extra});
  const payload = {playlist_sidebar: {items: [{playlist_id: 'one', title: 'Playlist', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'one', title: 'Playlist', description: '', revision: 'revision', items_complete: complete,
      active_sort: {key: authorOrder ? 'playlist_position' : 'title', direction: 'asc'},
      allowed_actions: {can_export: canExport, can_edit: true, can_reorder: true},
      track_rows: [track('missing', 'missing'), track('local', 'local'), track('unknown', 'unresolved'),
        track('hidden', 'missing', {title: 'Private title', source_readable: false})]}};
  controller.setScope('header-export:scope');
  assert.equal(controller.accept(payload, 'one'), true);
  assert.equal(controller.getSnapshot().resource.status, 'ready');
  return {controller, payload};
}

function page(t,controller,downloads){const h=fixture(t);h.runtime.downloadText=value=>downloads.push(value);const view=driver(t,h,mountPlaylistsView,{controller,state:controller.getSnapshot(),onSelect(){}});return {...h,view};}
const missingExport=h=>[...h.host.querySelectorAll('button')].find(button=>button.textContent==='Missing-only TXT');
test('native header dispatches icon clicks once and rejects every action while busy',t=>{
 const h=fixture(t),calls=[],props={detail:{title:'Playlist'},draft:{title:'Draft'},busy:false,filtersOpen:false,actions:{add:true,missing:true,top:true,export:true,save:true},onAction:key=>calls.push(key)},view=driver(t,h,mountPlaylistHeader,props);
 const buttons=[...h.host.querySelectorAll('[data-playlists-action]')].filter(button=>!button.closest('[hidden]'));
 for(const button of buttons)h.click(button.querySelector('svg'));assert.deepEqual(calls,['add','missing','top','export','share','settings','filters','save','discard']);
 view.render({...props,busy:true});for(const button of buttons){assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-disabled'),'true');h.click(button.querySelector('svg'));}assert.equal(calls.length,9);
});
test('header TXT and summary missing-only TXT preserve the full unsaved order independently of displayed filters',async t=>{
 const {controller}=session();t.after(()=>controller.dispose());const downloads=[];assert.equal(controller.reorder(['unknown','hidden','local','missing']),true);controller.filter({availability:'missing'});
 const h=page(t,controller,downloads),before=controller.getSnapshot();
 assert.deepEqual([...h.host.querySelectorAll('[data-playlist-row-key]')].map(row=>row.getAttribute('data-playlist-row-key')),[before.resource.data.detail.track_rows.find(row=>row.playlist_item_id==='missing').row_key]);
 assert.equal(action(h.host,'export').disabled,false);h.click(action(h.host,'export'));h.click(missingExport(h));await h.settle();
 assert.deepEqual(downloads.map(({filename,text})=>[filename,text]),[['playlist.txt','Artist - unknown [Album]\nArtist - local [Album]\nArtist - missing [Album]'],['playlist-missing.txt','Artist - unknown [Album]\nArtist - missing [Album]']]);assert.equal(controller.getSnapshot(),before,'export never saves or edits the draft');
});
test('TXT controls and handlers remain unavailable without exact export authority or a complete author order',async t=>{
 for(const options of [{canExport:false},{canExport:'true'},{complete:false},{authorOrder:false}]){const {controller}=session(options);t.after(()=>controller.dispose());const downloads=[],h=page(t,controller,downloads);assert.equal(action(h.host,'export').disabled,true);assert.equal(missingExport(h).disabled,true);h.click(action(h.host,'export'));h.click(missingExport(h));await h.settle();assert.deepEqual(downloads,[]);h.view.dispose();controller.dispose();}
});
test('old and already-queued TXT handlers reject scope, grant, provider and owner retirement',async t=>{
 const retirements=[controller=>controller.setScope('header-export:next'),(controller,payload)=>controller.accept({...payload,playlist_detail:{...payload.playlist_detail,allowed_actions:{can_export:false}}},'one'),controller=>controller.configure({readPlaylists(){}}),controller=>controller.dispose()];
 for(const retire of retirements)for(const queued of [false,true]){const {controller,payload}=session();t.after(()=>controller.dispose());const downloads=[],h=page(t,controller,downloads),exportButton=action(h.host,'export'),missingButton=missingExport(h),dispatch=()=>{h.click(exportButton);h.click(missingButton);};if(queued)dispatch();retire(controller,payload);if(!queued)dispatch();await h.settle();assert.deepEqual(downloads,[]);h.view.dispose();controller.dispose();}
});
