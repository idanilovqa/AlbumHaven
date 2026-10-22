'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read}=require('./search-native-fixtures/actual-runtime.cjs');
const {assertListenerPrivate,ACCOUNT,ROW,TOKEN}=require('./search-native-fixtures/listener-search.cjs');
const {createTabProvenancePlatform}=require('./search-native-fixtures/ownership-tab-provenance.cjs');
function generated(){
  const p=createTabProvenancePlatform(),c=vm.createContext({state:{player:{}}});c.window=c;p.install({c});
  vm.runInContext(read('music_app/static/js/runtime/playback-ownership-helpers.js'),c,{filename:'music_app/static/js/runtime/playback-ownership-helpers.js'});
  vm.runInContext('getPlaybackOwnershipTabId()',c);return p.capture();
}
function fixture(){
  const witness=generated(),record={tab_id:witness.tabId,status:'playing',reason:'manual_start',updated_at_ms:100000,expires_at_ms:115000,claim_revision:1};
  const h={host:{innerHTML:''},runtime:()=>({snapshot:()=>({})}),state:{view:{}},historyCalls:[],storageCalls:[]};
  h.storageCalls.push({key:'albumhaven.playbackOwnership.v1',value:JSON.stringify(record)});return {h,witness,record};
}
const run=({h,witness})=>assertListenerPrivate(h,[],{ownershipTab:witness});
const unicode=value=>Array.from(value,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0')).join('');
test('exact independent entropy witness allows only the generated top-level lease tab ID',()=>{const f=fixture();run(f);assert.throws(()=>assertListenerPrivate(f.h),/storage/);});
test('storage-derived same-value witness is not provenance',()=>{const f=fixture();f.witness={tabId:f.record.tab_id};assert.throws(()=>run(f),/provenance/);});
test('a separately generated tab is not this lease owner',()=>{const f=fixture();f.witness=generated();assert.throws(()=>run(f),/independently generated/);});
for(const secret of [ACCOUNT,ROW,TOKEN,'/library/private.flac','/track?path=%2Flibrary%2Fprivate.flac'])test(`known private value cannot stand in for tab identity: ${secret}`,()=>{
  const f=fixture();f.record.tab_id=secret;f.h.storageCalls[0].value=JSON.stringify(f.record);assert.throws(()=>run(f),/storage/);
});
for(const field of ['track','src','path','coverPath','context','privateUiContext','nested','extra'])test(`unknown ownership ${field} remains forbidden`,()=>{
  const f=fixture();f.record[field]={tab_id:f.witness.tabId};f.h.storageCalls[0].value=JSON.stringify(f.record);assert.throws(()=>run(f),/exact ownership schema/);
});
for(const place of ['reason','other key','other storage','DOM','snapshot','view','history'])test(`generated tab UUID cannot escape to ${place}`,()=>{
  const f=fixture(),id=f.witness.tabId;
  if(place==='reason'){f.record.reason=id;f.h.storageCalls[0].value=JSON.stringify(f.record);}
  if(place==='other key')f.h.storageCalls.push({key:id,value:'safe'});
  if(place==='other storage')f.h.storageCalls.push({key:'other',value:JSON.stringify({tab_id:id})});
  if(place==='DOM')f.h.host.innerHTML=id;
  if(place==='snapshot')f.h.runtime=()=>({snapshot:()=>({id})});
  if(place==='view')f.h.state.view={id};
  if(place==='history')f.h.historyCalls=[{id}];
  assert.throws(()=>run(f));
});
for(const mutation of [raw=>raw.replace('"tab_id":','"tab_id":"discarded","tab_id":'),
  raw=>raw.replace('"tab_id"','"\\u0074ab_id"'),raw=>raw.replace(/"tab_id":"([^"]+)"/,(_,id)=>`"tab_id":"${unicode(id)}"`),
  raw=>raw.replace(/"tab_id":"([^"]+)"/,(_,id)=>`"tab_id":"${id}","reason":"${unicode(id)}"`)])test('duplicate or JSON-escaped tab copies never receive a raw-string exemption',()=>{
  const f=fixture();f.h.storageCalls[0].value=mutation(f.h.storageCalls[0].value);assert.throws(()=>run(f));
});
test('caller extra check still applies to the witnessed tab value',()=>{const f=fixture();assert.throws(()=>assertListenerPrivate(f.h,[f.witness.tabId],{ownershipTab:f.witness}),/tab_id excludes/);});
for(const patch of [{claim_revision:0},{claim_revision:1.5},{expires_at_ms:115001},{expires_at_ms:100000},{status:'paused'}])test(`malformed lease is rejected: ${JSON.stringify(patch)}`,()=>{
  const f=fixture();Object.assign(f.record,patch);f.h.storageCalls[0].value=JSON.stringify(f.record);assert.throws(()=>run(f));
});

function deviceFixture(){
  const p=createTabProvenancePlatform(),c=vm.createContext({});c.window=c;p.install({c});
  vm.runInContext(read('music_app/static/js/runtime/player-listen-session-helpers.js'),c,{filename:'music_app/static/js/runtime/player-listen-session-helpers.js'});
  vm.runInContext('getMeasuredPlaybackDeviceId()',c);
  const witness=p.captureDevice(),h={host:{innerHTML:''},runtime:()=>({snapshot:()=>({})}),state:{view:{}},historyCalls:[],storageCalls:[{key:'album-haven-playback-device-id',value:witness.deviceId}]};
  return {h,witness};
}
test('device UUID requires independent local generation and exact dedicated key',()=>{
  const {h,witness}=deviceFixture();assertListenerPrivate(h,[],{playbackDevice:witness});
  assert.throws(()=>assertListenerPrivate(h));
  assert.throws(()=>assertListenerPrivate(h,[],{playbackDevice:{deviceId:witness.deviceId}}),/provenance/);
  assert.throws(()=>assertListenerPrivate(h,[],{playbackDevice:deviceFixture().witness}),/independently generated/);
  assert.throws(()=>assertListenerPrivate(h,[witness.deviceId],{playbackDevice:witness}),/device ID excludes/);
});
for(const value of [ACCOUNT,ROW,TOKEN,'/library/private.flac','arbitrary'])test(`device key cannot launder ${value}`,()=>{
  const {h,witness}=deviceFixture();h.storageCalls[0].value=value;assert.throws(()=>assertListenerPrivate(h,[],{playbackDevice:witness}));
});
for(const place of ['other storage','DOM','snapshot','view','history','JSON wrapper','escaped'])test(`device UUID cannot escape through ${place}`,()=>{
  const {h,witness}=deviceFixture(),id=witness.deviceId;
  if(place==='other storage')h.storageCalls.push({key:'other',value:id});
  if(place==='DOM')h.host.innerHTML=id;
  if(place==='snapshot')h.runtime=()=>({snapshot:()=>({id})});
  if(place==='view')h.state.view={id};
  if(place==='history')h.historyCalls=[{id}];
  if(place==='JSON wrapper')h.storageCalls[0].value=JSON.stringify({id});
  if(place==='escaped')h.storageCalls[0].value=unicode(id);
  assert.throws(()=>assertListenerPrivate(h,[],{playbackDevice:witness}));
});
