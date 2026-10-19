'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const ROOT=process.env.ALBUM_TOP_TEST_ROOT||path.resolve(__dirname,'../../../..');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
// Actual ResourceSelection owner, synthetic boundary callbacks only. This suite
// proves factory/transfer wiring, not production scheduler or DOM behavior.
function fixture({failure,open='commit',authorizeGate,prepareGate}={}){
 const calls=[],attempts=[],album={key:'native-key',tracks:[],track_rows:[],preference:{rating:4}},target={kind:'album',ref:'public-album',allowed_actions:{can_view_details:true},native_actions:{album_ref:'native-key',allowed_actions:{can_open_album:true,can_play_album:true}}};
 let openedOptions;
 const c=vm.createContext({console,AbortController,state:{ui:{pendingTrackModalLoadToken:0}},document:{},window:{},
  fetchTrackModalAlbumDetails:async()=>{calls.push('fetch');if(failure==='fetch')throw Error('fetch failed');return album;},
  releaseTrackModalSelection:()=>calls.push('release'),albumRequiresHydration:()=>false,albumHasDisplayCover:()=>true,buildAlbumDisplayCoverUrl:()=>'/cover',openImageLightbox:()=>calls.push('artwork'),
  openTrackModal:(value,options)=>{calls.push('open');openedOptions=options;if(open==='commit'){options.searchPresentationAttempt?.rendered(value);options.searchPresentationAttempt?.commit();}return open==='false'?false:undefined;}});
 vm.runInContext(fs.readFileSync(path.join(ROOT,'music_app/static/js/runtime/resource-selection.js'),'utf8'),c);
 const owner=c.window.AlbumHavenResourceSelection.create({sourceResource:()=>target,
 authorizeResource:async()=>{calls.push('authorize');if(authorizeGate)await authorizeGate.promise;if(failure==='authorize')throw Error('authorize failed');},
 projectAlbum:value=>{calls.push('project');if(failure==='project')throw Error('project failed');return value;},
 revalidateResource:async()=>{calls.push('revalidate');return failure==='replay-null'?null:{target,isCurrent:()=>true};},
 beginAlbumPresentation:(_s,_c,options)=>{calls.push('begin:'+options.intent);let committed=false,disposed=false;const attempt=Object.freeze({isCurrent:()=>!disposed,isCommitted:()=>committed&&!disposed,
 prepare:async value=>{calls.push('prepare');assert.equal(value,album);if(prepareGate)await prepareGate.promise;if(failure==='prepare')throw Error('prepare failed');},rendered:()=>calls.push('rendered'),commit:()=>{calls.push('commit');committed=true;return true;},dispose:reason=>{if(!disposed){disposed=true;calls.push('dispose:'+reason);}}});attempts.push(attempt);return attempt;}});
 return {owner,target,album,calls,attempts,c,context:{scopeKey:'scope'},get options(){return openedOptions;}};
}
test('actual owner allocates immutable attempt synchronously before authorize await and commits only after renderer',async()=>{const gate=deferred(),h=fixture({authorizeGate:gate}),work=h.owner.resourceIntent('open',h.target,h.context);assert.deepEqual(h.calls,['begin:open','authorize']);assert.ok(Object.isFrozen(h.attempts[0]));gate.resolve();await work;assert.deepEqual(h.calls,['begin:open','authorize','fetch','prepare','project','release','open','rendered','commit']);assert.equal(h.album.preference.rating,4);});
for(const failure of ['authorize','fetch','prepare','project'])test(`actual owner ${failure} failure disposes exact staged attempt`,async()=>{const h=fixture({failure});await assert.rejects(h.owner.resourceIntent('open',h.target,h.context));assert.equal(h.attempts.length,1);assert.equal(h.attempts[0].isCurrent(),false);assert.equal(h.calls.filter(x=>x.startsWith('dispose:')).length,1);assert.ok(!h.calls.includes('commit'));});
for(const open of ['undefined','false'])test(`actual owner ${open} open does not infer post-render commitment`,async()=>{const h=fixture({open});const work=h.owner.resourceIntent('open',h.target,h.context);if(open==='false')await assert.rejects(work);else await work;assert.equal(h.attempts[0].isCommitted(),false);assert.equal(h.attempts[0].isCurrent(),false);assert.ok(!h.calls.includes('commit'));});
test('artwork action allocates no presentation and leaves committed attempt alive',async()=>{const h=fixture();await h.owner.resourceIntent('open',h.target,h.context);const active=h.attempts[0];h.calls.length=0;await h.owner.resourceIntent('artwork',h.target,h.context);assert.equal(h.attempts.length,1);assert.equal(active.isCurrent(),true);assert.equal(active.isCommitted(),true);assert.deepEqual(h.calls,['authorize','fetch','project','artwork']);});
test('superseded prepare cannot commit or dispose successor',async()=>{const gate=deferred(),h=fixture({prepareGate:gate});const a=h.owner.resourceIntent('open',h.target,h.context).then(()=>null,e=>e);await drain();const b=h.owner.resourceIntent('open',h.target,h.context);await drain();assert.equal(h.attempts.length,2);gate.resolve();assert.ok(await a);await b;assert.equal(h.attempts[0].isCurrent(),false);assert.equal(h.attempts[1].isCommitted(),true);});
test('replay allocates before source revalidation and null reproof disposes its own attempt',async()=>{const h=fixture({failure:'replay-null'});await h.owner.resourceIntent('open',h.target,h.context);h.calls.length=0;await assert.rejects(h.options.sourcePageOwner.revalidate({signal:new AbortController().signal,albumKey:'native-key'}));assert.deepEqual(h.calls,['begin:replay','revalidate','dispose:replay-hydrate-failed']);assert.equal(h.attempts[0].isCommitted(),true);assert.equal(h.attempts[1].isCurrent(),false);});
