'use strict';
// UNRUN. Genuine Home React bridge helper, history controller, native adapter,
// classic private transport/CSRF/track dispatcher and complete Home player loop.
// Authorized provider rows and endpoint replies are explicit synthetic doubles;
// only media start and modal queue sink are replaced. No audio/provider traffic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const React=require('react'),{buildSync}=require('esbuild'),{pathToFileURL}=require('node:url');
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
const ROOT=path.resolve(__dirname,'../../..'),CONTEXT='c'.repeat(64),SOURCE='00000000-0000-4000-8000-000000000001';
const OBS='00000000-0000-4000-8000-000000000002';
const settle=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const target=patch=>({track_ref:'/synthetic/own/song.flac',path:'/synthetic/own/song.flac',title:'Song',artist:'Artist',album_title:'Album',
 duration_seconds:80,inventory_track_ref:'inventory-track:1:9',playback_state:{can_start_here:true},...patch});
async function fixture(t,{enhanced=true,media=true}={}){
 const env=createNativeHomeRuntime(),{context:c,document}=env,calls=[],replies=[],starts=[],queues=[];
 document.defaultView=c;const shell=document.createElement('div');shell.id='app-shell';Object.assign(shell.dataset,
 {privateUiContext:CONTEXT,nativeAccountId:'owner',nativeLibraryId:'1'});document.body.append(shell);
 c.Headers=Headers;c.location=new URL('https://albumhaven.test/');document.cookie='__Host-album_haven_csrf=synthetic';
 c.state={player:{current:null,playbackQueue:{prior:true}},modalReleases:[{key:'unrelated',tracks:[]}],modalReleaseIndex:0};
 c.AlbumHavenCapabilities={allows:action=>media&&action==='library.media.read'};
 c.fetch=async(url,options)=>{calls.push({url,options});assert.ok(replies.length,'Explicit endpoint reply required');return replies.shift()(url,options);};
 for(const name of ['session-csrf-fetch.js','private-ui-transport.js','track-actions.js','player-loop-playback.js']){
  const file='music_app/static/js/runtime/'+name;vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8'),c,{filename:file});}
 c.getPlayerPlaybackSnapshot=()=>({src:'',paused:true});c.playTrackFromPayload=value=>{starts.push(value);return Promise.resolve();};
 c.setAlbumPlaybackQueue=(...args)=>queues.push(args);c.focusPlayerTimeline=()=>{};
 const tracks=vm.runInContext('TrackActionsRuntime',c),transport=c.AlbumHavenPrivateUITransport;
 const row={observation_ref:OBS,...(enhanced?{enhanced:{observation_revision:'3'}}:{projection:{source_revision:'3'}})};
 const {createFoobarHistoryController}=await import(pathToFileURL(path.join(ROOT,'music_app/static/js/foobar-history/controller.mjs')));
 const controller=createFoobarHistoryController({provider:{readSources:async()=>({items:[{source_ref:SOURCE}],next_cursor:null}),
  readHistory:async({family,mode})=>({source_ref:SOURCE,source_revision:'8',family,mode,items:[row],next_cursor:null})}});
 await controller.initialize();controller.selectSource(SOURCE);await settle();
 const code=buildSync({entryPoints:[path.join(ROOT,'music_app/static/js/home-friends/foobar-history.jsx')],bundle:true,platform:'node',
  format:'cjs',write:false,external:['react','react-dom']}).outputFiles[0].text;
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,TrackActionsRuntime:tracks,AbortController,TextEncoder,TextDecoder,
  setTimeout,clearTimeout,require:n=>n==='react'?React:require(n)});
 let current=true;const actions=module.exports.createHomeFoobarNativeActions(c,()=>current,{controller,isCurrent:()=>current});assert.ok(actions);
 t.after(()=>{actions.dispose();controller.dispose();});
 const reply=(operation,result)=>({protocol:'foobar_account_history_native_v1',operation,context_ref:CONTEXT,result});
 const enqueue=value=>replies.push(()=>Promise.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}})));
 return {...env,c,shell,controller,actions,row,calls,starts,queues,transport,tracks,module,
  check:async allowed=>{enqueue(reply('eligibility',[{observation_ref:OBS,can_attempt_play:allowed}]));await actions.check(row);},
  play:async value=>{enqueue(reply('play',value));await actions.play(row);},current:value=>{current=value;},
  media:value=>{media=value;},replies};
}
test('Home React Foobar Enhanced and TSV matched Play use actual private dispatcher without borrowing open Album',async t=>{
 for(const enhanced of [true,false]){const f=await fixture(t,{enhanced}),modal=f.document.createElement('div');modal.id='track-modal';modal.hidden=false;f.document.body.append(modal);
  await f.check(true);await f.play(target());assert.equal(f.starts.length,1);assert.equal(f.starts[0].inventory_track_ref,'inventory-track:1:9');
  assert.equal(f.queues.length,0);assert.equal(f.c.state.player.playbackQueue,null);assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].options.headers.get('X-Album-Haven-CSRF'),'synthetic');
  assert.deepEqual(JSON.parse(f.calls[0].options.body).observations,[[OBS,'3']]);
  assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()),/synthetic\/own|inventory-track|data-src/);}
});
test('Home React Foobar missing association stays disabled and never dispatches Play',async t=>{
 const f=await fixture(t);await f.check(false);assert.equal(f.actions.state(f.row).canAttemptPlay,false);await f.actions.play(f.row);
 assert.equal(f.calls.length,1);assert.equal(f.starts.length,0);
});
test('Home React Foobar current-library context change retires checked grant before Play',async t=>{
 const f=await fixture(t);await f.check(true);f.shell.dataset.nativeLibraryId='2';f.shell.dataset.privateUiContext='d'.repeat(64);
 assert.equal(f.actions.state(f.row).canAttemptPlay,false);await f.actions.play(f.row);assert.equal(f.calls.length,1);assert.equal(f.starts.length,0);
});
test('Home React Foobar media permission and foreign inventory target cannot reach actual playback',async t=>{
 const f=await fixture(t);await f.check(true);f.media(false);await f.play(target());assert.equal(f.starts.length,0);
 f.media(true);await f.check(true);await f.play(target({inventory_track_ref:'inventory-track:2:9'}));assert.equal(f.starts.length,0);
});
test('Home React Foobar late native reply after navigation cannot dispatch or restore a grant',async t=>{
 const f=await fixture(t);await f.check(true);let resolve;f.replies.push(()=>new Promise(yes=>{resolve=yes;}));const pending=f.actions.play(f.row);
 await settle();f.current(false);resolve(new Response(JSON.stringify({protocol:'foobar_account_history_native_v1',operation:'play',context_ref:CONTEXT,result:target()}),
  {status:200,headers:{'Content-Type':'application/json'}}));await pending;assert.equal(f.starts.length,0);assert.equal(f.actions.state(f.row).canAttemptPlay,false);
});
test('Home actual modal-contained track retains its original Album queue fallback',async t=>{
 const f=await fixture(t),modal=f.document.createElement('div'),button=f.document.createElement('button');modal.id='track-modal';modal.hidden=false;f.document.body.append(modal);modal.append(button);
 button.setAttribute('data-src','/track?path=owned');button.setAttribute('data-track-path','owned');f.c.activateSharedTrackButton(button);
 assert.equal(f.starts.length,1);assert.equal(f.queues.length,1);assert.equal(f.queues[0][0],f.c.state.modalReleases[0]);
});
