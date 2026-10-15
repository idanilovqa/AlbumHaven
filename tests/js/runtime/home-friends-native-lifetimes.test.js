const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const base = path.resolve(__dirname, '../../../music_app/static/js/home-friends');
const load = name => import(pathToFileURL(path.join(base, name)).href);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const flush = async () => {for (let i = 0; i < 6; i++) await Promise.resolve();};
function nativeRuntime(env) {return {buttonHtml: value => env.context.ButtonComponent.renderButton(value), actionHtml: value => env.context.ButtonComponent.renderActionButton(value), alertHtml: value => env.context.buildOnPageAlertHtml(value)};}
function freshPresence(subject) {const now = Date.now();return {status:'ready',data:{subject_ref:subject,state:'playing',occurrence_ref:`occurrence:${subject}`,observed_at:new Date(now).toISOString(),expires_at:new Date(now+10000).toISOString(),row:{kind:'track',source_readable:true,title:subject}}};}

test('native now-playing aborts old audiences and ignores late reads', async () => {
  const {createNowPlaying} = await load('now-playing.mjs'), calls = [], changes = [];
  const read = request => {const pending = deferred();calls.push({request,...pending});return pending.promise;};
  const owner = createNowPlaying({read,scopeKey:'session',accountRef:'alice',allowed:true},value=>changes.push(value));
  assert.equal(calls.length,1);
  owner.update({read,scopeKey:'session',accountRef:'bob',allowed:true});
  assert.equal(calls[0].request.signal.aborted,true);assert.equal(calls.length,2);
  calls[0].resolve(freshPresence('alice'));await flush();assert.equal(owner.getSnapshot(),null);
  calls[1].resolve(freshPresence('bob'));await flush();assert.equal(owner.getSnapshot().subject_ref,'bob');
  owner.update({read,scopeKey:'session',accountRef:'bob',allowed:false});assert.equal(owner.getSnapshot(),null);assert.equal(calls[1].request.signal.aborted,true);
  owner.dispose();const count=changes.length;owner.update({read,scopeKey:'other',accountRef:'alice',allowed:true});assert.equal(changes.length,count);assert.equal(calls.length,2);
});

test('native missing eligibility and inspection are scoped to exact source lifetime', async () => {
  const {mountActivityMissingAction} = await load('activity-missing.mjs'), env=createNativeHomeRuntime(),host=env.document.createElement('div');env.document.body.append(host);
  const eligibility=[],inspections=[],errors=[],runtime={...nativeRuntime(env),readActivityMissingEligibility:request=>{const value=deferred();eligibility.push({request,...value});return value.promise;},inspectActivityMissing:request=>{const value=deferred();inspections.push({request,...value});return value.promise;}};
  const first={status:'ready',data:{snapshot_ref:'snapshot:first'}},second={status:'ready',data:{snapshot_ref:'snapshot:second'}};
  const settings=value=>({value,scopeKey:'scope',kind:'tracks',period:'week',onError:message=>errors.push(message)});
  const owner=mountActivityMissingAction(host,runtime,settings(first));await flush();owner.update(settings(second));await flush();
  assert.equal(eligibility[0].request.signal.aborted,true);eligibility[0].resolve({can_inspect_missing:true});await flush();assert.equal(host.querySelector('button'),null);
  eligibility[1].resolve({can_inspect_missing:true});await flush();env.click(host.querySelector('button'));await flush();assert.equal(inspections.length,1);assert.equal(inspections[0].request.origin.snapshot_ref,'snapshot:second');
  owner.update({...settings(second),enabled:false});assert.equal(inspections[0].request.signal.aborted,true);inspections[0].reject(new Error('late'));await flush();assert.deepEqual(errors,[]);assert.equal(host.querySelector('button'),null);
  owner.dispose();assert.equal(host.childNodes.length,0);
});

test('native missing action keeps selected-row evidence and prevents duplicate inspections', async () => {
  const {mountActivityMissingAction}=await load('activity-missing.mjs'),env=createNativeHomeRuntime(),host=env.document.createElement('div');env.document.body.append(host);
  const pending=deferred(),calls=[],runtime={...nativeRuntime(env),readActivityMissingEligibility:async request=>{assert.deepEqual(request.row_refs,['row:one']);return {can_inspect_missing:true};},inspectActivityMissing:request=>{calls.push(request);return pending.promise;}};
  const owner=mountActivityMissingAction(host,runtime,{scopeKey:'scope',account_ref:'friend',kind:'listens',period:'month',value:{status:'ready',data:{snapshot_ref:'sealed'}},selectedRowIds:['row:one']});await flush();
  const button=host.querySelector('button');env.click(button);env.click(button);assert.equal(calls.length,1);assert.equal(calls[0].origin.audience,'friend');assert.equal(calls[0].origin.subject_ref,'friend');
  owner.dispose();assert.equal(calls[0].signal.aborted,true);pending.resolve(true);await flush();
});

test('native sharing member keeps its actions slot and safe text when identity updates',async()=>{
  const {mountSharingMember}=await load('resource-sharing.mjs'),env=createNativeHomeRuntime(),host=env.document.createElement('div');env.document.body.append(host);
  const owner=mountSharingMember(host,{person:{display_name:'First'}}),actions=owner.actions,button=env.document.createElement('button');actions.append(button);
  owner.update({person:{display_name:'<Second>',username_display:'second',is_active:false}});
  assert.equal(owner.actions,actions);assert.equal(button.parentNode,actions);assert.match(host.textContent,/<Second> \(second\) · Inactive account/);assert.equal(host.querySelector('Second'),null);
  owner.dispose();assert.equal(host.childNodes.length,0);
});

test('native queue detail owners re-admit saved occurrence IDs and retire on scope change',async()=>{
  const {createQueueDetails}=await load('queue.mjs'),adapters=[];
  const api={getSnapshot:()=>({entries:[{id:'readable',sourceReadable:true},{id:'denied',sourceReadable:false}]})};
  const runtime={createQueueResourceSelection:options=>{const adapter={options,selected:[],disposed:false,getSnapshot:()=>({selectedIds:adapter.selected,album:null,artist:null}),subscribe:()=>()=>{},select:ids=>{adapter.selected=ids;},dispose:()=>{adapter.disposed=true;}};adapters.push(adapter);return adapter;}};
  const owner=createQueueDetails({runtime,api,scopeKey:'first',enabled:true,selectedIds:['readable','denied']});
  assert.deepEqual(adapters[0].selected,[]);const detailRuntime=owner.getSnapshot().runtime;assert.equal(owner.getSnapshot().runtime,detailRuntime);
  owner.update({runtime,api,scopeKey:'second',enabled:true,selectedIds:['readable']});assert.deepEqual(adapters[1].selected,['readable']);assert.equal(adapters[0].disposed,true);assert.equal(adapters[0].options.isCurrent(),false);assert.equal(adapters[1].options.isCurrent(),true);
  owner.dispose();assert.equal(adapters[1].disposed,true);assert.equal(adapters[1].options.isCurrent(),false);
});
