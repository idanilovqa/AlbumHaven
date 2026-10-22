const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const source = fs.readFileSync(path.join(base, 'private-ui-transport.js'), 'utf8');
const marker = 'a'.repeat(64);
function fixture(t, {csrf = false} = {}) {
  const root = {dataset: {accountGoalsContext: marker}}, calls = [], observers = [];
  let respond = async () => ({ok: true, status: 200, json: async () => ({context_ref: marker, context_scope: 'account-goals-v1', data: {}})}), api;
  const context = {URL, Headers, URLSearchParams, document: {cookie: '__Host-album_haven_csrf=fixture-csrf', getElementById: () => null},
    location: {href: 'https://music.test/account/goals/view', origin: 'https://music.test'},
    fetch: async (...args) => {calls.push(args); return respond(...args);},
    MutationObserver: class {constructor(fn) {this.fn=fn;this.connected=false;observers.push(this);} observe(){this.connected=true;} disconnect(){this.connected=false;}},
  };
  context.window = context;
  t.after(() => api?.dispose());
  vm.createContext(context);
  if (csrf) vm.runInContext(fs.readFileSync(path.join(base, 'session-csrf-fetch.js'), 'utf8'), context);
  vm.runInContext(source, context);
  api = context.createAlbumHavenPrivateUITransport({root, accountGoals: true});
  return {api, root, calls, observers, context, respond: fn => {respond=fn;}};
}
function deferred(t) {let resolve;const promise=new Promise(yes=>{resolve=yes;});t.after(()=>resolve({ok:true,status:200,json:async()=>({context_ref:marker,context_scope:'account-goals-v1'})}));return {promise,resolve};}

test('account transport uses a distinct marker and requires server account scope', async t => {
  const h=fixture(t);await h.api.request('/account/goals');
  const options=h.calls[0][1];assert.equal(options.headers['X-AlbumHaven-Account-Context'],marker);
  assert.equal('X-AlbumHaven-Context' in options.headers,false);assert.equal(options.cache,'no-store');assert.equal(options.credentials,'same-origin');
  assert.equal(h.api.context(),marker);
});
for (const payload of [{context_ref:marker},{context_ref:marker,context_scope:'home'},{context_ref:'b'.repeat(64),context_scope:'account-goals-v1'}]) {
  test(`foreign or absent account response scope retires owners: ${JSON.stringify(payload)}`, async t => {
    const h=fixture(t);let notices=0;h.api.subscribe(()=>notices++);
    h.respond(async()=>({ok:true,status:200,json:async()=>payload}));
    await assert.rejects(h.api.request('/account/goals'),error=>error.code==='stale_context');
    assert.equal(notices,1);assert.throws(()=>h.api.context(),error=>error.code==='stale_context');
  });
}
for (const status of [401,403,409]) test(`account denial ${status} invalidates every retained owner`,async t=>{
  const h=fixture(t);let notices=0;h.api.subscribe(()=>{throw new Error('consumer cleanup');});h.api.subscribe(()=>notices++);
  h.respond(async()=>({ok:false,status,json:async()=>({error_code:status===409?'stale_context':'forbidden'})}));
  await assert.rejects(h.api.request('/account/goals'),error=>error.status===status);
  assert.equal(notices,1);assert.throws(()=>h.api.context());
  await assert.rejects(h.api.request('/account/goals'));assert.equal(h.calls.length,1);
});
test('ordinary service failure preserves context without automatic write retry',async t=>{
  const h=fixture(t);let notices=0;h.api.subscribe(()=>notices++);
  h.respond(async()=>({ok:false,status:503,json:async()=>({error_code:'temporarily_unavailable'})}));
  await assert.rejects(h.api.request('/account/goals/add',{method:'POST',body:{request_key:'synthetic'}}),error=>error.status===503);
  assert.equal(notices,0);assert.equal(h.api.context(),marker);assert.equal(h.calls.length,1);
});
test('missing account page marker refuses network dispatch',async t=>{
  const h=fixture(t);h.root.dataset.accountGoalsContext='';await assert.rejects(h.api.request('/account/goals'));
  assert.equal(h.calls.length,0);
});
test('account stamp replacement cannot adopt another session without a new entry owner',async t=>{
  const h=fixture(t);let notices=0;h.api.subscribe(()=>notices++);h.root.dataset.accountGoalsContext='b'.repeat(64);
  h.observers[0].fn();assert.equal(notices,1);assert.throws(()=>h.api.context());
  h.root.dataset.accountGoalsContext=marker;assert.throws(()=>h.api.context());
});
for(const boundary of ['fetch','json'])test(`retirement rejects pending ${boundary} success and disconnects observer`,async t=>{
  const h=fixture(t),wait=deferred(t);let decoding;
  let entered;const phaseEntered=new Promise(resolve=>{entered=resolve;});
  h.respond(async()=>{if(boundary==='fetch'){entered();return wait.promise;}
    return {ok:true,status:200,json:()=>{decoding=true;entered();return wait.promise;}};});
  const request=h.api.request('/account/goals');await phaseEntered;
  h.api.dispose();wait.resolve(boundary==='fetch'?{ok:true,status:200,json:async()=>({context_ref:marker,context_scope:'account-goals-v1'})}:{context_ref:marker,context_scope:'account-goals-v1'});
  await assert.rejects(request,error=>error.name==='AbortError');assert.equal(h.observers[0].connected,false);
  assert.throws(()=>h.api.context());if(boundary==='json')assert.equal(decoding,true);
});
test('existing CSRF fetch wrapper attaches session token to account-scoped writes',async t=>{
  const h=fixture(t,{csrf:true});await h.api.request('/account/goals/reset',{method:'POST',body:{request_key:'synthetic'}});
  const headers=h.calls[0][1].headers;
  assert.equal(headers.get('X-Album-Haven-CSRF'),'fixture-csrf');assert.equal(headers.get('X-AlbumHaven-Account-Context'),marker);
  assert.equal(headers.has('X-AlbumHaven-Context'),false);assert.equal(h.calls.length,1);
});

for (const status of [401,403]) test(`non-JSON HTTP ${status} retires before decoding`,async t=>{
  const h=fixture(t);let decoded=false,notices=0;h.api.subscribe(()=>notices++);
  h.respond(async()=>({ok:false,status,json:async()=>{decoded=true;throw new SyntaxError('HTML login page');}}));
  await assert.rejects(h.api.request('/account/goals',{isCurrent:()=>notices===0}),error=>error.status===status&&error.responseRejected===true);
  assert.equal(decoded,false);assert.equal(notices,1);assert.throws(()=>h.api.context());
});
test('explicit expected stamp cannot accept data after account invalidation',t=>{
  const h=fixture(t);h.api.invalidate();
  assert.throws(()=>h.api.accept({context_ref:marker,context_scope:'account-goals-v1'},marker),error=>error.name==='AbortError');
});
