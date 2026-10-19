'use strict';
// Synthetic oracle projections only: no fixture, VM, product or audio is invoked.
const test=require('node:test'),assert=require('node:assert/strict');
const {assertListenerPrivate,ROW,ROW2,TOKEN,CURSOR,ACCOUNT,ALBUM_ID,ARTIST_ID}=require('./search-native-fixtures/listener-search.cjs');
const expected=Object.freeze({inventoryTrackRef:'inventory-track:9:101',path:'/library/queue/101.flac',src:'/track?path=%2Flibrary%2Fqueue%2F101.flac'});
const options={actorNative:expected};
function synthetic(){
  return {host:{innerHTML:''},runtime:()=>({snapshot:()=>({})}),state:{view:{}},historyCalls:[],
    queue:{getSnapshot:()=>({entries:[]})},streams:[[{inventory_track_ref:expected.inventoryTrackRef,path:expected.path,src:expected.src}]],
    storageCalls:[{key:'albumhaven.playerState.v1',value:JSON.stringify({track:{path:expected.path,src:expected.src,title:'Actor title'},playbackQueue:null})}]};
}
function alter(h,mutate){const value=JSON.parse(h.storageCalls[0].value);mutate(value);h.storageCalls[0].value=JSON.stringify(value);}
function rejects(h,label=/storage/){assert.throws(()=>assertListenerPrivate(h,[],options),label);}
test('only exact existing player track.path/src with independent handoff can persist',()=>{
  assertListenerPrivate(synthetic(),[],options);
  assert.throws(()=>assertListenerPrivate(synthetic()),/storage/,'no default native allowance');
});
for(const [name,secret]of Object.entries({receipt:ROW,secondReceipt:ROW2,token:TOKEN,cursor:CURSOR,account:ACCOUNT,
  albumIdentity:ALBUM_ID,artistIdentity:ARTIST_ID,inventory:'inventory-track:9:101',nativeAlbum:'native-album-eleven',nativeArtist:'native-artist',
  inventoryAlbum:'inventory-album:9:11',inventoryArtist:'inventory-artist:9:12',
  canonicalAlbum:'canonical-album-eleven',canonicalArtist:'canonical-artist-twelve',nativeTarget:'native_target',snapshot:'snapshot_ref',subject:'subject_account'})){
  for(const field of ['path','src','title'])test(`${name} is rejected even in player track.${field}`,()=>{
    const h=synthetic();alter(h,value=>{value.track[field]=secret;});rejects(h);
  });
  for(const projection of ['Search DOM','Search snapshot','view state','history','public Queue','other storage'])test(`${name} is rejected in ${projection}`,()=>{
    const h=synthetic();
    if(projection==='Search DOM')h.host.innerHTML=secret;
    if(projection==='Search snapshot')h.runtime=()=>({snapshot:()=>({leak:secret})});
    if(projection==='view state')h.state.view={leak:secret};
    if(projection==='history')h.historyCalls=[{leak:secret}];
    if(projection==='public Queue')h.queue={getSnapshot:()=>({leak:secret})};
    if(projection==='other storage')h.storageCalls.push({key:'other',value:secret});
    rejects(h,new RegExp(projection==='other storage'?'storage':projection));
  });
}
for(const field of ['subject','subject_taste','subject_account','subject_id','identity_ref','account_ref','result_token','row_ref','native_target','album_ref','artist_ref','parent_album_ref','parent_artist_ref','inventory_album_ref','inventory_artist_ref'])test(`private ${field} object remains forbidden in player state`,()=>{
  const h=synthetic();alter(h,value=>{value.track[field]={username:'maya'};});rejects(h);
});
for(const field of ['path','src']){
  test(`unexpected player ${field} is rejected`,()=>{const h=synthetic();alter(h,value=>{value.track[field]='/unexpected/other.flac';});rejects(h);});
  test(`allowed ${field} cannot escape to another player field`,()=>{const h=synthetic();alter(h,value=>{value.track.coverPath=expected[field];});rejects(h);});
  test(`allowed ${field} cannot escape to nested player track`,()=>{const h=synthetic();alter(h,value=>{value.nested={track:{[field]:expected[field]}};});rejects(h);});
  test(`allowed ${field} cannot escape to another storage key`,()=>{const h=synthetic();h.storageCalls.push({key:'another.playerState',value:expected[field]});rejects(h);});
  test(`allowed ${field} cannot escape as a storage key`,()=>{const h=synthetic();h.storageCalls.push({key:expected[field],value:'safe'});rejects(h);});
  for(const projection of ['Search DOM','Search snapshot','view state','history','public Queue'])test(`native ${field} is forbidden in ${projection}`,()=>{
    const h=synthetic(),secret=expected[field];
    if(projection==='Search DOM')h.host.innerHTML=secret;
    if(projection==='Search snapshot')h.runtime=()=>({snapshot:()=>({path:secret})});
    if(projection==='view state')h.state.view={path:secret};
    if(projection==='history')h.historyCalls=[{path:secret}];
    if(projection==='public Queue')h.queue={getSnapshot:()=>({path:secret})};
    rejects(h,new RegExp(projection));
  });
}
test('explicit Queue persistence must remain null',()=>{const h=synthetic();alter(h,value=>{value.playbackQueue={tracks:[]};});rejects(h,/explicit Queue persistence remains null/);});
test('missing independent handoff rejects storage-derived permission',()=>{const h=synthetic();h.streams=[];rejects(h,/native streaming handoff/);});
for(const field of ['path','src','inventory_track_ref'])test(`mismatched independent handoff ${field} rejects permission`,()=>{
  const h=synthetic();h.streams[0][0][field]='unexpected';rejects(h,/native handoff/);
});
test('missing player persistence is not a vacuous positive',()=>{const h=synthetic();h.storageCalls=[];rejects(h,/persistence was observed/);});
test('renamed player storage key is not exempt',()=>{const h=synthetic();h.storageCalls[0].key='albumhaven.playerState.v2';rejects(h);});
test('caller-supplied extra secrets still apply inside allowed fields',()=>{
  assert.throws(()=>assertListenerPrivate(synthetic(),['queue/101'],options),/storage/);
});

for(const placement of ['other storage','player root','player nested','player array','other nested','other array'])test(`bare subject object rejected in ${placement}`,()=>{
  const h=synthetic(),subject={subject:{username:'maya'}};
  if(placement==='other storage')h.storageCalls.push({key:'ordinary',value:JSON.stringify(subject)});
  if(placement==='player root')alter(h,value=>{value.subject=subject.subject;});
  if(placement==='player nested')alter(h,value=>{value.track.extra={nested:subject};});
  if(placement==='player array')alter(h,value=>{value.track.extra=[subject];});
  if(placement==='other nested')h.storageCalls.push({key:'ordinary',value:JSON.stringify({nested:subject})});
  if(placement==='other array')h.storageCalls.push({key:'ordinary',value:JSON.stringify([subject])});
  rejects(h);
});
test('Queue positive extra permits only the exact independently authorized player slots',()=>{
  const h=synthetic(),queueExpected={inventoryTrackRef:'inventory-track:9:101',path:'/library/current.flac',src:'/track?path=%2Flibrary%2Fcurrent.flac'};
  h.streams=[[{inventory_track_ref:queueExpected.inventoryTrackRef,path:queueExpected.path,src:queueExpected.src}]];
  alter(h,value=>{value.track.path=queueExpected.path;value.track.src=queueExpected.src;});
  assertListenerPrivate(h,[queueExpected.path],{actorNative:queueExpected});
  for(const placement of ['Search DOM','Search snapshot','view state','history','public Queue','other storage','other player field']){
    const candidate={...h,host:{innerHTML:''},state:{view:{}},historyCalls:[],storageCalls:h.storageCalls.map(write=>({...write}))};
    if(placement==='Search DOM')candidate.host.innerHTML=queueExpected.path;
    if(placement==='Search snapshot')candidate.runtime=()=>({snapshot:()=>({leak:queueExpected.path})});
    if(placement==='view state')candidate.state.view={leak:queueExpected.path};
    if(placement==='history')candidate.historyCalls=[{leak:queueExpected.path}];
    if(placement==='public Queue')candidate.queue={getSnapshot:()=>({leak:queueExpected.path})};
    if(placement==='other storage')candidate.storageCalls.push({key:'ordinary',value:queueExpected.path});
    if(placement==='other player field')alter(candidate,value=>{value.track.coverPath=queueExpected.path;});
    assert.throws(()=>assertListenerPrivate(candidate,[queueExpected.path],{actorNative:queueExpected}),
      new RegExp(placement.includes('storage')||placement==='other player field'?'storage':placement));
  }
  assert.throws(()=>assertListenerPrivate(h,[queueExpected.path,'current.flac'],{actorNative:queueExpected}),/storage/,
    'a substring extra is still forbidden inside exact allowed player slots');
});
for(const key of ['subject','album_ref','artist_ref'])for(const storage of ['player','ordinary'])test(`parsed ${key} key cannot hide behind JSON escaping in ${storage} storage`,()=>{
  const h=synthetic();
  const escapedKey='\\u'+key.charCodeAt(0).toString(16).padStart(4,'0')+key.slice(1);
  const object=`{"${escapedKey}":{"username":"maya"}}`;
  if(storage==='ordinary')h.storageCalls.push({key:'ordinary',value:object});
  else h.storageCalls[0].value=h.storageCalls[0].value.replace('"title":"Actor title"',`"title":"Actor title","extra":${object}`);
  rejects(h,/private structural key/);
});
test('parsed native identity strings cannot hide behind JSON escaping',()=>{
  const h=synthetic();h.storageCalls.push({key:'ordinary',value:'{"label":"\\u006eative-album-eleven"}'});rejects(h);
});
// Encode every character as JSON Unicode, so the raw stored text deliberately
// has no recognizable path/src or caller-only extra. Parsed checks must reject.
const unicodeJson=value=>'"'+Array.from(value,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
for(const native of [true,false])for(const [kind,secret]of Object.entries({path:expected.path,src:expected.src,extra:'caller-only-secret-Z'})){
  for(const placement of ['value','key','nested value','nested key','array value','root string'])test(`escaped ${kind} ${placement} rejected in ordinary storage with native=${native}`,()=>{
    const h=synthetic();if(!native){h.storageCalls=[];h.streams=[];}
    const encoded=unicodeJson(secret),value=placement==='value'?`{"leak":${encoded}}`
      :placement==='key'?`{${encoded}:"safe"}`
      :placement==='nested value'?`{"nested":{"leak":${encoded}}}`
      :placement==='nested key'?`{"nested":[{${encoded}:"safe"}]}`
      :placement==='array value'?`{"nested":["safe",${encoded}]}`:encoded;
    const index=h.storageCalls.length;h.storageCalls.push({key:'ordinary',value});
    assert.throws(()=>assertListenerPrivate(h,[expected.path,'caller-only-secret-Z'],native?options:{}),new RegExp(`storage\\[${index}\\]`));
  });
}
test('JSON-escaped player path does not gain an allowance without opt-in',()=>{
  const h=synthetic();h.storageCalls=[{key:'albumhaven.playerState.v1',value:`{"track":{"path":${unicodeJson(expected.path)}}}`}];
  assert.throws(()=>assertListenerPrivate(h),/storage/);
});
