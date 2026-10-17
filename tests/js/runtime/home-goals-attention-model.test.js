const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = name => import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends', name)).href);
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const periods = ['week', 'month', 'six-months', 'year'], GOAL = id(1), ALBUM = id(2);
const copy = value => JSON.parse(JSON.stringify(value));
const cycle = n => ({cycle_id:id(n),started_at:'2026-01-01T00:00:00+00:00',start_date:'2026-01-01',due_date:'2026-01-08',timezone_name:'UTC'});
function goal(empty=false) {
  return {goal_ref:empty?null:GOAL,revision:empty?'1':'2',
    allowed_actions:{can_read:true,can_add:true,can_reset:true,can_complete:true,can_remove:true},
    albums:empty?[]:[{catalog_ref:ALBUM,title:'Retained album',artist_display:'Artist',first_release_date:null,primary_type:null}],
    periods:Object.fromEntries(periods.map((period,i)=>[period,{period,top_ref:empty?null:GOAL,
      cycle:empty?null:cycle(i+10),album_refs:empty?[]:[ALBUM],manual_completed_at:empty?{}:{[ALBUM]:null},total:empty?0:1,completed:0}]))};
}
function attention(data=goal(), acknowledged=false) {
  const rows = Object.fromEntries(periods.map(name=>{const row=data.periods[name];return [name,{
    cycle_id:row.cycle?.cycle_id??null,due_date:row.cycle?.due_date??null,timezone_name:row.cycle?.timezone_name??null,
    total:row.total,completed:row.completed,due:false,achieved:row.total>0&&row.completed===row.total}];}));
  const event=rows.week.total?{kind:'weekly_cycle_started',goal_ref:data.goal_ref,cycle_id:rows.week.cycle_id}:null;
  return {goal_ref:data.goal_ref,revision:data.revision,evaluated_at:'2026-01-02T00:00:00+00:00',periods:rows,
    weekly_event:event,weekly_acknowledged:acknowledged,indicator:event&&!acknowledged?'blue':'none'};
}
const gate = () => {let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const posts = h => h.calls.filter(row=>row.method==='POST');
async function fixture(t,{empty=false,keyHook}={}) {
  const h={data:goal(empty),calls:[],acknowledged:new Set(),receipts:new Map(),visible:true,gates:[],before:null,after:null};
  // Register before provider/controller acquisition and independently retire all owners.
  t.after(async()=>{try{h.controller?.dispose();}finally{try{h.provider?.dispose();}finally{
    for(const value of h.gates)value.resolve();await Promise.resolve();await Promise.resolve();
  }}});
  const {createGoalsProvider}=await load('goals-provider.mjs');
  const {createGoalsController}=await load('goals-model.mjs');
  let context='a'.repeat(64), notify, key=100;
  h.gate=()=>{const value=gate();h.gates.push(value);return value;};
  h.invalidate=()=>{context='b'.repeat(64);notify?.();};
  h.projection=()=>attention(h.data,h.acknowledged.has(h.data.periods.week.cycle?.cycle_id));
  h.nextCycle=()=>{h.data.revision=String(BigInt(h.data.revision)+1n);h.data.periods.week.cycle=cycle(30);};
  h.provider=createGoalsProvider({context:()=>context,subscribe:listener=>{notify=listener;return()=>{notify=null;};},
    async request(url,options={}) {
      h.calls.push({url,method:options.method||'GET',body:options.body});
      await h.before?.(url,options);
      let data;
      if(options.method==='POST'&&url.endsWith('/attention/ack')) {
        const command=options.body, event=command.event;
        const changed=!h.acknowledged.has(event.cycle_id);h.acknowledged.add(event.cycle_id);
        data={ok:true,action:'attention_ack',request_key:command.request_key,event:copy(event),changed};
        h.receipts.set(command.request_key,copy(data));
      } else if(options.method==='POST'&&url.endsWith('/reset')) {
        const command=options.body;h.nextCycle();
        data={ok:true,action:'reset',request_key:command.request_key,changed:true,reason:'',goal_ref:GOAL,
          revision:h.data.revision,period:'week',cycle_id:id(30)};
        h.receipts.set(command.request_key,copy(data));
      } else if(url==='/account/goals/attention')data=h.projection();
      else if(url==='/account/goals')data=copy(h.data);
      else if(url.includes('/operations/')) {const receipt=h.receipts.get(url.split('/').pop());data=receipt?{status:'committed',receipt:copy(receipt)}:{status:'unknown'};}
      else throw new Error('Unexpected route '+url);
      const changed=await h.after?.(url,options,data);
      return {status:'ready',context_ref:context,data:changed===undefined?data:changed};
    }});
  h.controller=createGoalsController({provider:h.provider,timezone:'UTC',requestKey:()=>{keyHook?.(h);return id(key++);}});
  h.ready=async()=>{await h.controller.load();await h.controller.loadAttention();};
  h.visit=()=>h.controller.createVisit({isCurrent:()=>h.visible});
  return h;
}

const malformed = [
  x=>{x.extra=true;},x=>{x.revision='0';},x=>{x.goal_ref=null;},x=>{x.evaluated_at='2026-02-30T00:00:00Z';},
  x=>{x.evaluated_at='2026-01-01';},x=>{x.periods.week.total=-1;},x=>{x.periods.week.total=true;},
  x=>{x.periods.week.completed=2;},x=>{x.periods.week.achieved=true;},x=>{x.periods.week.due=1;},
  x=>{x.periods.week.timezone_name='Invalid/Zone';},x=>{x.periods.week.cycle_id=null;},
  x=>{x.periods.month.cycle_id=x.periods.week.cycle_id;},x=>{x.weekly_event.kind='achievement';},
  x=>{x.weekly_event.goal_ref=id(9);},x=>{x.weekly_event.cycle_id=id(9);},x=>{x.weekly_event.extra=true;},
  x=>{x.weekly_acknowledged='true';},x=>{x.indicator='red';},x=>{delete x.periods.year;},
];
for(const [index,change] of malformed.entries())test(`attention DTO rejects malformed facts ${index+1}`,async()=>{
  const {normalizeGoalAttention}=await load('goals-provider.mjs');const value=attention();change(value);
  assert.throws(()=>normalizeGoalAttention(value));
});
test('attention DTO accepts frozen detached empty/red and server-time provenance',async()=>{
  const {normalizeGoalAttention}=await load('goals-provider.mjs');
  const empty=normalizeGoalAttention(attention(goal(true)));assert.equal(empty.indicator,'none');
  const value=attention();value.periods.month.due=true;value.indicator='red';
  const result=normalizeGoalAttention(value);value.periods.week.total=99;
  assert.equal(result.periods.week.total,1);assert.ok(Object.isFrozen(result.periods.week));
  assert.equal(result.evaluated_at,'2026-01-02T00:00:00+00:00');assert.equal(result.indicator,'red');
});

test('off-tab read fetches attention only and creates no mutation or visit',async t=>{
  const h=await fixture(t);await h.controller.loadAttention();
  assert.deepEqual(h.calls.map(x=>x.url),['/account/goals/attention']);
  assert.equal(h.controller.getSnapshot().data,null);assert.equal(h.controller.getSnapshot().mutation,'idle');
  assert.equal(h.controller.createVisit({isCurrent:()=>true}),null);assert.equal(posts(h).length,0);
});
test('explicit visible visit sends one exact ack and refreshes attention only',async t=>{
  const h=await fixture(t);await h.ready();const before=h.controller.getSnapshot().data,token=h.visit();
  assert.ok(token);assert.equal(posts(h).length,0);h.calls.length=0;
  await h.controller.acknowledgeVisit(token);
  assert.deepEqual(h.calls.map(x=>x.url),['/account/goals/attention/ack','/account/goals/attention']);
  assert.equal(posts(h)[0].body.event.cycle_id,id(10));assert.equal(posts(h)[0].body.action,'attention_ack');
  assert.equal(h.controller.getSnapshot().attention.indicator,'none');assert.equal(h.controller.getSnapshot().data,before);
  await h.controller.acknowledgeVisit(token);assert.equal(posts(h).length,1);
});
test('hidden forged empty and readonly visits cannot acknowledge',async t=>{
  const h=await fixture(t);await h.ready();h.visible=false;assert.equal(h.visit(),null);
  await h.controller.acknowledgeVisit({});assert.equal(posts(h).length,0);
  h.visible=true;h.data.allowed_actions.can_add=false;await h.ready();await h.controller.acknowledgeVisit(h.visit());
  assert.equal(posts(h).length,0);
  h.data=goal(true);await h.ready();await h.controller.acknowledgeVisit(h.visit());assert.equal(posts(h).length,0);
});
test('period switch away and back permanently retires captured visit',async t=>{
  const h=await fixture(t);await h.ready();const token=h.visit();
  h.controller.selectPeriod('month');h.controller.selectPeriod('week');
  await h.controller.acknowledgeVisit(token);assert.equal(posts(h).length,0);
  await h.controller.acknowledgeVisit(h.visit());assert.equal(posts(h).length,1);
});
test('changed attention snapshot and context retire tokens and private facts',async t=>{
  const h=await fixture(t);await h.ready();const old=h.visit();await h.controller.loadAttention();
  await h.controller.acknowledgeVisit(old);assert.equal(posts(h).length,0);
  const token=h.visit();h.invalidate();await h.controller.acknowledgeVisit(token);
  assert.equal(h.controller.getSnapshot().attention,null);assert.equal(h.controller.getSnapshot().data,null);
  assert.equal(posts(h).length,0);
});
test('incoherent revision or current counts cannot create a visit',async t=>{
  const h=await fixture(t);await h.ready();h.data.revision='3';await h.controller.loadAttention();assert.equal(h.visit(),null);
  await h.ready();h.data.periods.week.completed=1;h.data.periods.week.manual_completed_at[ALBUM]='2026-01-02T00:00:00Z';
  await h.controller.loadAttention();assert.equal(h.visit(),null);assert.equal(posts(h).length,0);
});
test('reentrant visibility callback changing period cannot admit a token',async t=>{
  const h=await fixture(t);await h.ready();
  const token=h.controller.createVisit({isCurrent(){h.controller.selectPeriod('month');return true;}});
  assert.equal(token,null);assert.equal(posts(h).length,0);
});
test('reentrant key generation context change blocks actual POST',async t=>{
  let armed=false;const h=await fixture(t,{keyHook:value=>{if(armed)value.invalidate();}});await h.ready();const token=h.visit();armed=true;
  await h.controller.acknowledgeVisit(token);assert.equal(posts(h).length,0);assert.equal(h.controller.getSnapshot().attention,null);
});
test('submitting observer hides visit and exact pending key stays recoverable',async t=>{
  const h=await fixture(t);await h.ready();const token=h.visit();
  h.controller.subscribe(state=>{if(state.mutation==='submitting')h.visible=false;});
  await h.controller.acknowledgeVisit(token);assert.equal(posts(h).length,0);assert.equal(h.controller.getSnapshot().mutation,'uncertain');
  await h.controller.retry();assert.equal(posts(h).length,0);assert.ok(h.calls.some(x=>x.url.includes('/operations/')));
  assert.equal(h.controller.dismissAttentionAcknowledgment(token),true);assert.equal(h.controller.getSnapshot().mutation,'idle');
  await h.controller.reset();assert.equal(posts(h).length,1);assert.equal(posts(h)[0].url,'/account/goals/reset');
});
test('attention read cannot replace a pending domain write or its recovery',async t=>{
  const h=await fixture(t);await h.ready();const held=h.gate();let enteredResolve;const entered=new Promise(r=>{enteredResolve=r;});
  h.before=async(url,options)=>{if(options.method==='POST'){enteredResolve();await held.promise;}};
  const writing=h.controller.reset();await entered;const count=h.calls.length;
  await h.controller.loadAttention();await h.controller.acknowledgeVisit({});
  assert.equal(h.calls.length,count);assert.equal(h.controller.getSnapshot().mutation,'submitting');
  held.resolve();await writing;assert.equal(h.controller.getSnapshot().mutation,'idle');
});
test('attention read never cancels active full load and stale read cannot republish',async t=>{
  const h=await fixture(t);const held=h.gate();let resolveEntered;const entered=new Promise(r=>{resolveEntered=r;});
  h.before=async url=>{if(url==='/account/goals/attention'){resolveEntered();await held.promise;}};
  const reading=h.controller.loadAttention();await entered;await h.controller.load();
  held.resolve();await reading;
  assert.equal(h.controller.getSnapshot().status,'ready');assert.equal(h.controller.getSnapshot().attention,null);
});
test('committed timeout recovers exact receipt with no second POST or visibility resurrection',async t=>{
  const h=await fixture(t);await h.ready();const token=h.visit();let fail=true;
  h.after=(url,options)=>{if(options.method==='POST'&&fail){fail=false;throw new Error('lost response');}};
  await h.controller.acknowledgeVisit(token);assert.equal(h.controller.getSnapshot().mutation,'uncertain');
  h.visible=false;await h.controller.retry();assert.equal(posts(h).length,1);
  assert.equal(h.controller.getSnapshot().attention.indicator,'none');assert.equal(h.controller.getSnapshot().mutation,'idle');
});
test('unknown recovery resends same key only for original still-visible visit',async t=>{
  const h=await fixture(t);await h.ready();const token=h.visit();let fail=true;
  h.before=(url,options)=>{if(options.method==='POST'&&fail){fail=false;throw new Error('not delivered');}};
  await h.controller.acknowledgeVisit(token);h.visible=false;await h.controller.retry();assert.equal(posts(h).length,1);
  h.visible=true;await h.controller.retry();assert.equal(posts(h).length,2);
  assert.deepEqual(posts(h)[0].body,posts(h)[1].body);assert.equal(h.controller.getSnapshot().mutation,'idle');
});
for(const corrupt of [x=>({...x,changed:'yes'}),x=>({...x,event:{...x.event,cycle_id:id(99)}}),x=>({...x,extra:true})]) {
  test('malformed receipt remains uncertain until real operation recovery',async t=>{
    const h=await fixture(t);await h.ready();h.after=(url,options,data)=>options.method==='POST'?corrupt(data):undefined;
    await h.controller.acknowledgeVisit(h.visit());assert.equal(h.controller.getSnapshot().mutation,'uncertain');
    await h.controller.retry();assert.equal(posts(h).length,1);assert.equal(h.controller.getSnapshot().mutation,'idle');
  });
}
test('acknowledged refresh failure retries GET only and cannot accept unacknowledged same cycle',async t=>{
  const h=await fixture(t);await h.ready();let stale=true;
  h.after=url=>url==='/account/goals/attention'&&stale?attention(h.data,false):undefined;
  await h.controller.acknowledgeVisit(h.visit());assert.equal(h.controller.getSnapshot().error.kind,'acknowledged-refresh');
  stale=false;await h.controller.retry();assert.equal(posts(h).length,1);assert.equal(h.controller.getSnapshot().attention.indicator,'none');
});
test('newer cycle after committed ack remains blue instead of clearing new event',async t=>{
  const h=await fixture(t);await h.ready();h.after=(url,options)=>{if(options.method==='POST')h.nextCycle();};
  await h.controller.acknowledgeVisit(h.visit());const state=h.controller.getSnapshot();
  assert.equal(state.mutation,'idle');assert.equal(state.attention.weekly_event.cycle_id,id(30));assert.equal(state.attention.indicator,'blue');
});
test('denial during attention read clears private state and any visit',async t=>{
  const h=await fixture(t);await h.ready();const token=h.visit();
  h.before=url=>{if(url==='/account/goals/attention')throw Object.assign(new Error('denied'),{status:403});};
  await h.controller.loadAttention();assert.equal(h.controller.getSnapshot().status,'denied');assert.equal(h.controller.getSnapshot().data,null);
  assert.equal(h.controller.getSnapshot().attention,null);await h.controller.acknowledgeVisit(token);assert.equal(posts(h).length,0);
});
test('explicit dismissal is exact-token only and never cancels an active POST',async t=>{
  const h=await fixture(t);await h.ready();const token=h.visit(),held=h.gate();let enteredResolve;const entered=new Promise(r=>{enteredResolve=r;});
  h.before=async(url,options)=>{if(options.method==='POST'){enteredResolve();await held.promise;}};
  const writing=h.controller.acknowledgeVisit(token);await entered;
  assert.equal(h.controller.dismissAttentionAcknowledgment(token),false);assert.equal(h.controller.dismissAttentionAcknowledgment({}),false);
  held.resolve();await writing;assert.equal(h.controller.dismissAttentionAcknowledgment(token),false);
});

test('active full load keeps its owner when attention is requested',async t=>{
  const h=await fixture(t),held=h.gate();let enteredResolve;const entered=new Promise(r=>{enteredResolve=r;});
  h.before=async url=>{if(url==='/account/goals'){enteredResolve();await held.promise;}};
  const loading=h.controller.load();await entered;await h.controller.loadAttention();
  assert.deepEqual(h.calls.map(x=>x.url),['/account/goals']);assert.equal(h.controller.getSnapshot().status,'loading');
  held.resolve();await loading;assert.equal(h.controller.getSnapshot().status,'ready');
});
test('visibility callback context change at actual dispatch cannot leak a POST',async t=>{
  const h=await fixture(t);await h.ready();
  const token=h.controller.createVisit({isCurrent(){if(h.controller.getSnapshot().mutation==='submitting')h.invalidate();return true;}});
  assert.ok(token);await h.controller.acknowledgeVisit(token);
  assert.equal(posts(h).length,0);assert.equal(h.controller.getSnapshot().data,null);
});
test('definitive stale-event rejection frees mutation owner and clears only attention',async t=>{
  const h=await fixture(t);await h.ready();const data=h.controller.getSnapshot().data;
  h.before=(url,options)=>{if(options.method==='POST')throw Object.assign(new Error('changed'),{status:409,responseRejected:true});};
  await h.controller.acknowledgeVisit(h.visit());
  assert.equal(h.controller.getSnapshot().mutation,'idle');assert.equal(h.controller.getSnapshot().data,data);
  assert.equal(h.controller.getSnapshot().attention,null);assert.equal(h.controller.getSnapshot().attentionError.kind,'attention-conflict');
  h.before=null;await h.controller.reset();assert.equal(posts(h).length,2);
});
