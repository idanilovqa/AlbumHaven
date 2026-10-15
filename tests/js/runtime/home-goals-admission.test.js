const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle} = require('./home-friends-native-app-fixture.cjs');
const goal = '11111111-1111-4111-8111-111111111111', album = '22222222-2222-4222-8222-222222222222', cycle = '33333333-3333-4333-8333-333333333333';
function value(populated = false) {
  const periods = Object.fromEntries(['week','month','six-months','year'].map(period => [period, {
    top_ref: populated ? goal : null, period, cycle: populated ? {cycle_id: cycle, started_at: '2026-12-01T00:00:00Z',
      start_date: '2026-12-01', due_date: '2027-01-01', timezone_name: 'UTC'} : null,
    album_refs: populated ? [album] : [], manual_completed_at: populated ? {[album]: null} : {}, total: populated ? 1 : 0, completed: 0, percent: 0,
  }]));
  return {goal_ref: populated ? goal : null, revision: populated ? '2' : '1', periods, albums: populated ? [{catalog_ref: album,
    title: 'Remote Album', artist_display: 'Artist', first_release_date: null, primary_type: null}] : [],
    allowed_actions: {can_read: true, can_add: true, can_reset: true}};
}

const group='55555555-5555-4555-8555-555555555555';
const handle='66666666-6666-4666-8666-666666666666';
const candidate={provider:'musicbrainz',entity_kind:'release-group',release_group_id:group,title:'Search title',artist_display:'Search artist',first_release_date:null,primary_type:null};
const preview={evidence_ref:handle,evidence_version:'a'.repeat(64),expires_at:'2030-01-01T00:00:00Z',
  album:{title:'Verified title',artist_display:'Verified artist',first_release_date:'2001',primary_type:'Album'}};
const results=(items=[candidate])=>({limit:10,candidates:items});
async function mounted(t,{populated=false,allowed=true,script=[]}={}) {
  const h=fixture(t), {mountGoalsPanel}=await load('goals.mjs'), requests=[],listeners=new Set();
  let context='a'.repeat(64), data=value(populated), owner;
  data.allowed_actions.can_add=allowed;
  const wire={context:()=>context,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async request(path,options){requests.push({path,options});
      const next=path==='/account/goals'?data:script.shift();
      assert.notEqual(next,undefined,`Unexpected request ${path}`);
      const answer=await(typeof next==='function'?next(path,options):next);
      if(answer instanceof Error)throw answer;
      return {status:'ready',context_ref:context,data:answer};},
    change(){context='b'.repeat(64);for(const fn of [...listeners])fn();},set(next){data=next;}};
  const header={actions:h.add('goals-actions'),content:h.add('goals-content')};
  t.after(()=>owner?.dispose());
  owner=h.own(mountGoalsPanel(h.host,h.runtime,{transport:wire,header,isCurrent:()=>true}));await settle();h.drain();
  return {...h,owner,wire,header,requests,listeners,script};
}
function gate(t,h){const wait=deferred();t.after(async()=>{try{h.owner.dispose();}finally{wait.resolve(undefined);}await wait.promise;await settle();});return wait;}
function open(h){h.click(h.named('Start')||h.named('Add'));h.drain();}
function search(h,title='Album query',artist='Artist query'){
  h.input(h.form.querySelector('[aria-label="Album title"]'),title);h.input(h.form.querySelector('[aria-label="Artist (optional)"]'),artist);
  h.form.querySelector('form').dispatchEvent(new h.c.Event('submit',{bubbles:true,cancelable:true}));
}
async function verify(h){search(h);await settle();h.click(h.named('Search title — Search artist'));await settle();}

test('Empty Start is the sole central primary admission action; populated Add stays in the header',async t=>{
  const empty=await mounted(t);assert.ok(empty.named('Start'));assert.equal(empty.named('Add'),undefined);
  assert.ok(empty.host.querySelector('.home-goals__empty-state').contains(empty.named('Start')));
  assert.equal(empty.header.actions.contains(empty.named('Start')),false);
  assert.equal(empty.named('Start').classList.contains('ui-button--primary'),true);
  empty.owner.dispose();
  const full=await mounted(t,{populated:true});assert.equal(full.named('Start'),undefined);assert.ok(full.header.actions.contains(full.named('Add')));
  assert.ok(full.named('Add').querySelector('svg'));assert.equal(full.header.actions.querySelectorAll('button')[0].getAttribute('aria-label'),'Reset');
});

test('Explicit search does not select a candidate or acquire evidence; exact verified preview gates Add',async t=>{
  const h=await mounted(t,{script:[results(),preview]});open(h);
  assert.equal(h.requests.length,1);assert.equal(h.named('Add',h.form).disabled,true);
  h.input(h.form.querySelector('[aria-label="Album title"]'),'Album query');await settle();assert.equal(h.requests.length,1);
  search(h);await settle();assert.equal(h.requests[1].path,'/account/goals/remote-search');
  assert.deepEqual(h.requests[1].options.body,{title:'Album query',artist:'Artist query'});
  assert.equal(h.requests.length,2);assert.equal(h.named('Add',h.form).disabled,true);
  h.click(h.named('Search title — Search artist'));await settle();
  assert.equal(h.requests[2].path,'/account/goals/remote-evidence');assert.deepEqual(h.requests[2].options.body,{release_group_id:group});
  const shown=h.form.querySelector('[aria-label="Verified album preview"]');assert.match(shown.textContent,/Verified title/);
  assert.match(shown.textContent,/Verified artist/);assert.doesNotMatch(shown.textContent,/Search title/);
  assert.equal(shown.querySelector('.album-card').getAttribute('data-gallery-card-interaction'),'none');assert.equal(shown.querySelector('img'),null);
  assert.match(h.form.textContent,/2030-01-01T00:00:00Z/);assert.equal(h.named('Add',h.form).disabled,false);
});

test('Confirmed first Add uses evidence and captured command then refreshes authoritative membership',async t=>{
  const h=await mounted(t,{script:[results(),preview,(path,options)=>{
    assert.equal(path,'/account/goals/add');h.wire.set(value(true));
    return {ok:true,action:'add',request_key:options.body.request_key,changed:true,reason:'',goal_ref:goal,revision:'2',period:'week',catalog_ref:album,cycle_id:cycle};
  }]});open(h);await verify(h);h.click(h.named('Add',h.form));await settle();
  const post=h.requests.find(row=>row.path==='/account/goals/add');assert.ok(post);
  assert.deepEqual(Object.keys(post.options.body).sort(),['request_key','revision','period','timezone_name','evidence_ref','evidence_version'].sort());
  assert.equal(post.options.body.revision,'1');assert.equal(post.options.body.period,'week');
  assert.equal(post.options.body.evidence_ref,handle);assert.equal(post.options.body.evidence_version,'a'.repeat(64));
  assert.equal('release_group_id' in post.options.body,false);assert.ok(post.options.body.timezone_name);
  assert.equal(h.form.hidden,true);assert.match(h.host.textContent,/Remote Album/);assert.equal(h.named('Start'),undefined);
  assert.ok(h.named('Add'));assert.equal(h.requests.filter(row=>row.path==='/account/goals/add').length,1);
});

test('This year help explains December31 only inside the dialog and captures selected period',async t=>{
  const h=await mounted(t);h.click(h.named('Period: 1 week'));
  h.click(h.document.querySelectorAll('[role="menuitemradio"]').find(node=>/This year/.test(node.textContent)));
  assert.doesNotMatch(h.header.actions.textContent,/December 31/);open(h);assert.match(h.form.textContent,/This year ends on December 31/);
  assert.equal(h.requests.length,1);
});

for(const phase of ['search','evidence'])test(`Closing during ${phase} aborts and suppresses later private results`,async t=>{
  const h=await mounted(t,{script:phase==='search'?[]:[results()]});const wait=gate(t,h);h.script.push(()=>wait.promise);open(h);search(h);
  if(phase==='evidence'){await settle();h.click(h.named('Search title — Search artist'));}
  await settle();const pending=h.requests.at(-1);h.click(h.named('Cancel',h.form));assert.equal(pending.options.signal.aborted,true);
  wait.resolve(phase==='search'?results():preview);await settle();assert.equal(h.form.hidden,true);
  assert.doesNotMatch(h.document.body.textContent,/Verified title|Search title/);assert.equal(h.requests.filter(row=>row.path==='/account/goals/add').length,0);
});

test('New query discards older search and requires fresh explicit Search',async t=>{
  const h=await mounted(t);const wait=gate(t,h);h.script.push(()=>wait.promise,results([]));open(h);search(h);await settle();
  const old=h.requests.at(-1);h.input(h.form.querySelector('[aria-label="Album title"]'),'New album');assert.equal(old.options.signal.aborted,true);
  wait.resolve(results());await settle();assert.equal(h.named('Search title — Search artist'),undefined);assert.equal(h.requests.length,2);
  search(h,'New album','');await settle();assert.match(h.form.textContent,/No albums found/);
  assert.equal(h.named('Add',h.form).disabled,true);assert.equal(h.requests.at(-1).options.body.artist,'');
});

test('Later candidate selection supersedes pending evidence without mixing preview identities',async t=>{
  const other={...candidate,release_group_id:'77777777-7777-4777-8777-777777777777',title:'Other title'};
  const h=await mounted(t,{script:[results([candidate,other])]});const wait=gate(t,h);h.script.push(()=>wait.promise,{...preview,evidence_ref:'88888888-8888-4888-8888-888888888888',album:{...preview.album,title:'Second verified'}});
  open(h);search(h);await settle();h.click(h.named('Search title — Search artist'));await settle();const first=h.requests.at(-1);
  h.click(h.named('Other title — Search artist'));await settle();assert.equal(first.options.signal.aborted,true);
  wait.resolve(preview);await settle();assert.match(h.form.querySelector('[aria-label="Verified album preview"]').textContent,/Second verified/);
  assert.doesNotMatch(h.form.querySelector('[aria-label="Verified album preview"]').textContent,/Verified title/);
});

for(const reason of ['context','period','dispose'])test(`Retained Add confirmation cannot write after ${reason} retirement`,async t=>{
  const h=await mounted(t,{script:[results(),preview]});open(h);await verify(h);const add=h.named('Add',h.form);
  if(reason==='context')h.wire.change();else if(reason==='dispose')h.owner.dispose();else{
    const trigger=h.header.actions.querySelectorAll('button').find(node=>(node.getAttribute('aria-label')||'').startsWith('Period:'));
    h.click(trigger);h.click(h.document.querySelectorAll('[role="menuitemradio"]').find(node=>/This year/.test(node.textContent)));
  }
  await settle();h.click(add);assert.equal(h.form.hidden,true);assert.equal(h.requests.filter(row=>row.path==='/account/goals/add').length,0);
});

test('Denied can_add has no Start or Add and makes no discovery request',async t=>{
  const h=await mounted(t,{allowed:false});assert.equal(h.named('Start'),undefined);assert.equal(h.named('Add'),undefined);
  assert.deepEqual(h.requests.map(row=>row.path),['/account/goals']);
});

for(const status of [403,503])test(`Search ${status} is an error rather than a valid empty result`,async t=>{
  const h=await mounted(t,{script:[Object.assign(new Error('provider secret'),{status,code:'provider_unavailable',responseRejected:true})]});open(h);search(h);await settle();
  assert.doesNotMatch(h.document.body.textContent,/provider secret|No albums found/);
  if(status===403){assert.equal(h.form.hidden,true);assert.equal(h.named('Start'),undefined);}
  else {assert.match(h.form.textContent,/Search could not be completed/);assert.equal(h.named('Add',h.form).disabled,true);}
});

for(const boundary of ['artboxHtml','galleryCardHtml'])test(`Verified preview rendering cannot revive evidence after reentrant query edit at ${boundary}`,async t=>{
  const h=await mounted(t,{script:[results(),preview]});open(h);search(h);await settle();
  const render=h.runtime[boundary];let changed=false;
  h.runtime[boundary]=options=>{if(!changed){changed=true;h.input(h.form.querySelector('[aria-label="Album title"]'),'A newer query');}return render(options);};
  h.click(h.named('Search title — Search artist'));await settle();
  assert.equal(changed,true);assert.equal(h.form.querySelector('[aria-label="Verified album preview"]').textContent,'');
  assert.equal(h.named('Add',h.form).disabled,true);assert.equal(h.requests.length,3);
});

test('Exact evidence failure preserves explicit retry choice without treating search text as a verified preview',async t=>{
  const h=await mounted(t,{script:[results(),Object.assign(new Error('private evidence failure'),{status:503})]});open(h);await verify(h);
  assert.match(h.form.textContent,/Album verification could not be completed/);assert.doesNotMatch(h.form.textContent,/private evidence failure/);
  assert.equal(h.form.querySelector('[aria-label="Verified album preview"]').textContent,'');assert.equal(h.named('Add',h.form).disabled,true);
  assert.equal(h.requests.filter(row=>row.path==='/account/goals/add').length,0);
});
