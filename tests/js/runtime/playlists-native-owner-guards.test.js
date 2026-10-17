const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../../music_app/static/js/playlists');
const load=name=>import(pathToFileURL(path.join(root,name)).href);
test('native filter session retires on source, provider and lifecycle replacement',async()=>{
 const {createPlaylistFilterSession}=await load('native-filter-session.mjs');let source={},state={scopeKey:'one',source},version=1,notifications=0;const listeners=new Set();const controller={getSnapshot:()=>state,getLifecycleVersion:()=>version,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};const identity=state=>state.source?[state.scopeKey,state.source]:null,providers={};const session=createPlaylistFilterSession(controller,identity,providers,()=>notifications++);
 session.toggle();const first=session.opening;assert.ok(first);assert.equal(session.current(first),true);session.toggle();assert.equal(session.opening,null);session.toggle();const second=session.opening;assert.notEqual(second,first);
 state={scopeKey:'one',source:{}};for(const fn of listeners)fn();assert.equal(session.opening,null);assert.equal(session.current(second),false);
 session.toggle();const third=session.opening;session.update(controller,identity,{});assert.equal(session.opening,null);assert.equal(session.sourceCurrent(third),false);
 session.toggle();version++;for(const fn of listeners)fn();assert.equal(session.opening,null);session.dispose();assert.equal(listeners.size,0);session.toggle();assert.equal(session.opening,null);assert.ok(notifications>=6);
});
test('native selection resolver rejects stale identities, unreadable and duplicate rows',async()=>{
 const {resolvePlaylistSelection}=await load('native-app.mjs'),detail={playlist_id:'p'},row={row_key:'r',playlist_item_id:'i',source_readable:true},selection={scopeKey:'s',playlistId:'p',itemId:'i'};
 assert.equal(resolvePlaylistSelection(selection,{scopeKey:'s',detail,rows:[row]}),row);
 assert.equal(resolvePlaylistSelection(selection,{scopeKey:'other',detail,rows:[row]}),null);
 assert.equal(resolvePlaylistSelection(selection,{scopeKey:'s',detail,rows:[row,{...row}]}),null);
 assert.equal(resolvePlaylistSelection(selection,{scopeKey:'s',detail,rows:[{...row,source_readable:false}]}),null);
 assert.equal(resolvePlaylistSelection({scopeKey:'s',playlistId:'p',rowKey:'r',detail:{}},{scopeKey:'s',detail,rows:[row]}),null);
});
test('native discard confirmation cannot discard a replacement draft',async()=>{
 const {confirmPlaylistDiscard}=await load('native-app.mjs');let resolve,discarded=0;const detail={playlist_id:'p'},draft={title:'draft'};let state={scopeKey:'s',selectedPlaylistId:'p',resource:{data:{detail}},drafts:{p:draft},mutation:{status:'idle'}};
 const controller={getSnapshot:()=>state,discard:()=>{discarded++;return true;}},runtime={confirm:()=>new Promise(done=>{resolve=done;})};const pending=confirmPlaylistDiscard(runtime,controller);state={...state,drafts:{p:{title:'new'}}};resolve(true);assert.equal(await pending,false);assert.equal(discarded,0);
 const second=confirmPlaylistDiscard(runtime,controller);resolve(true);assert.equal(await second,true);assert.equal(discarded,1);
});
