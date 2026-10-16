const nativeTest = require('node:test');
const test = (name, run) => nativeTest(name, {timeout:10000}, run);
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
const completionExpected = before => ({data:before.data,period:before.period,revision:before.data.revision,
  cycle_id:before.data.periods[before.period].cycle.cycle_id});
function assertConfirmedCompletion(h,before) {
 const writes=posts(h),after=h.controller.getSnapshot();assert.equal(writes.length,1);
 assert.equal(before.data.periods[before.period].completed,0);assert.equal(before.data.periods[before.period].manual_completed_at[ALBUM],null);
 assert.equal(writes[0].url,'/account/goals/completion');assert.equal(writes[0].body.catalog_ref,ALBUM);
 assert.equal(writes[0].body.completed,true);assert.equal(writes[0].body.period,before.period);
 assert.equal(writes[0].body.revision,before.data.revision);
 assert.equal(writes[0].body.expected_cycle_id,before.data.periods[before.period].cycle.cycle_id);
 assert.equal(after.status,'ready');assert.equal(after.mutation,'idle');assert.equal(after.error,null);
 assert.notEqual(after.data,before.data);assert.equal(after.data.revision,String(BigInt(before.data.revision)+1n));
 assert.equal(after.data.periods[before.period].completed,1);
 assert.equal(after.data.periods[before.period].cycle.cycle_id,before.data.periods[before.period].cycle.cycle_id);
 assert.equal(after.data.periods[before.period].manual_completed_at[ALBUM],'2026-01-02T00:00:00Z');
}
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
  h.transport={context:()=>context,subscribe:listener=>{notify=listener;return()=>{notify=null;};},
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
      } else if(options.method==='POST'&&url.endsWith('/completion')) {
        const command=options.body;h.data.revision=String(BigInt(h.data.revision)+1n);
        for(const row of Object.values(h.data.periods)){row.manual_completed_at[ALBUM]='2026-01-02T00:00:00Z';row.completed=1;}
        data={ok:true,action:'completion',request_key:command.request_key,changed:true,reason:'',goal_ref:GOAL,
          revision:h.data.revision,period:command.period,cycle_id:h.data.periods[command.period].cycle.cycle_id,catalog_ref:ALBUM};
      } else if(url==='/account/goals/bonus-settings')data={settings_revision:'1',enabled:false,source_mode:'all_active',selected_top_refs:[],preferred_top_refs:[],album_mode:'next',unfinished_policy:'carry',selection_algorithm:'active-top-weighted-v1',normal_top_weight:1,preferred_top_weight:3};
      else if(url==='/account/goals/bonus')data={cycle_id:h.data.periods.week.cycle?.cycle_id??null,bonus:null,manual_count:h.data.periods.week.total};
      else if(url==='/account/goals/attention')data=h.projection();
      else if(url==='/account/goals')data=copy(h.data);
      else if(url.includes('/operations/')) {const receipt=h.receipts.get(url.split('/').pop());data=receipt?{status:'committed',receipt:copy(receipt)}:{status:'unknown'};}
      else throw new Error('Unexpected route '+url);
      const changed=await h.after?.(url,options,data);
      return {status:'ready',context_ref:context,data:changed===undefined?data:changed};
    }};
  h.provider=createGoalsProvider(h.transport);
  h.controller=createGoalsController({provider:h.provider,timezone:'UTC',requestKey:()=>{keyHook?.(h);return id(key++);}});
  h.ready=async()=>{await h.controller.load();await h.controller.loadAttention();};
  h.visit=()=>h.controller.createVisit({isCurrent:()=>h.visible});
  return h;
}


const {fixture: domFixture, settle} = require('./home-friends-native-app-fixture.cjs');
async function presented(t, options={}) {
  const h=await fixture(t,options), dom=domFixture(t), state={pendingToken:null}, notices=[];
  let view, visible=true;
  t.after(()=>view?.dispose());
  const {createGoalsAttentionView}=await load('goals-attention-view.mjs');
  await h.ready();
  view=createGoalsAttentionView({controller:h.controller,visitState:state,document:dom.document,
    isCurrent:()=>visible,notify(message,variant){const notice={message,variant,retired:false,dispose(){this.retired=true;}};notices.push(notice);return notice;}});
  return Object.assign(h,{dom,view,state,notices,setVisible(value){visible=value;view.update();},
    async flush(){await settle();},
    wait(predicate){if(predicate(h.controller.getSnapshot()))return Promise.resolve();let stop;const pending=new Promise(resolve=>{stop=h.controller.subscribe(()=>{if(predicate(h.controller.getSnapshot())){stop();resolve();}});});t.after(()=>stop?.());return pending;}});
}

test('restored visible Goals never acknowledges or shows ordinary progress',async t=>{
 const h=await presented(t);h.view.update();await h.flush();assert.deepEqual(posts(h),[]);assert.deepEqual(h.notices,[]);
});
test('explicit weekly visit quietly acknowledges exact current event once',async t=>{
 const h=await presented(t);const done=h.wait(s=>s.attention?.weekly_acknowledged===true);h.view.enter({});await done;await h.flush();
 assert.equal(posts(h).length,1);assert.deepEqual(posts(h)[0].body.event,h.projection().weekly_event);assert.deepEqual(h.notices,[]);
 h.view.update();await h.flush();assert.equal(posts(h).length,1);
});
test('explicit month visit does not acknowledge unseen weekly cycle',async t=>{
 const h=await presented(t);h.controller.selectPeriod('month');h.view.enter({});await h.flush();assert.deepEqual(posts(h),[]);
 const done=h.wait(s=>s.attention?.weekly_acknowledged===true);h.controller.selectPeriod('week');h.view.enter({});await done;assert.equal(posts(h).length,1);
});
test('period switch away and back does not revive earlier queued visit',async t=>{
 const h=await presented(t);h.view.enter({});h.controller.selectPeriod('month');h.controller.selectPeriod('week');await h.flush();assert.deepEqual(posts(h),[]);
});
test('blue intent is retired on view disposal before queued dispatch',async t=>{
 const h=await presented(t);h.view.enter({});h.view.dispose();await h.flush();assert.deepEqual(posts(h),[]);
});
test('server due notice is explicit, counted as completed, and owned',async t=>{
 const h=await presented(t);h.after=(url,options,value)=>{if(url==='/account/goals/attention'){value.periods.month.due=true;value.indicator='red';}return value;};
 await h.controller.loadAttention();h.controller.selectPeriod('month');h.view.enter({});await h.flush();
 assert.equal(h.notices.length,1);assert.match(h.notices[0].message,/Monthly.*Completed 0 of 1/);assert.doesNotMatch(h.notices[0].message,/listened/i);
 assert.match(h.notices[0].message,/Reset/);h.setVisible(false);await h.flush();assert.equal(h.notices[0].retired,true);assert.deepEqual(posts(h),[]);
});
test('already achieved explicit visit summarizes once but hydration stays silent',async t=>{
 const h=await presented(t);h.data.periods.month.manual_completed_at[ALBUM]='2026-01-02T00:00:00Z';h.data.periods.month.completed=1;
 await h.ready();h.controller.selectPeriod('month');await h.flush();assert.deepEqual(h.notices,[]);h.view.enter({});await h.flush();
 assert.equal(h.notices.length,1);assert.match(h.notices[0].message,/achieved.*Completed 1 of 1/);h.view.update();await h.flush();assert.equal(h.notices.length,1);
});
test('unknown visit acknowledgment retains exact token after presentation retirement',async t=>{
 const h=await presented(t);h.before=(url,options)=>{if(options.method==='POST')throw new Error('network unavailable');};
 const done=h.wait(s=>s.mutation==='uncertain');h.view.enter({});await done;const token=h.state.pendingToken;assert.ok(token);
 h.view.dispose();assert.equal(h.state.pendingToken,token);assert.equal(h.controller.getSnapshot().mutation,'uncertain');
 assert.equal(h.controller.dismissAttentionAcknowledgment({}),false);assert.equal(h.controller.dismissAttentionAcknowledgment(token),true);assert.equal(h.controller.getSnapshot().mutation,'idle');
});
test('pending domain mutation outranks explicit visit and cannot be dismissed as an ack',async t=>{
 const h=await presented(t);h.before=(url,options)=>{if(options.method==='POST')throw new Error('network unavailable');};
 await h.controller.reset();assert.equal(h.controller.getSnapshot().mutation,'uncertain');h.view.enter({});await h.flush();
 assert.equal(posts(h).length,1);assert.equal(h.view.canDismiss(),false);assert.equal(h.view.dismiss(),false);
});

test('confirmed visible completion can alert on a restored panel without creating a visit',async t=>{
 const h=await presented(t),before=h.controller.getSnapshot();const work=h.controller.setCompletion(ALBUM,true,completionExpected(before));
 h.view.completed(work,before);await work;await h.flush();assert.equal(h.notices.length,1);assert.match(h.notices[0].message,/achieved.*Completed 1 of 1/);
 assert.equal(posts(h).length,1);assert.ok(posts(h)[0].url.endsWith('/completion'));
 assertConfirmedCompletion(h,before);
 assert.equal(h.notices[0].retired,false,'The confirmed restored-panel notice survives settled reconciliation.');
 const data=h.controller.getSnapshot().data,prior=h.calls.length;await h.controller.loadAttention();await h.flush();
 assert.equal(h.notices.length,1);assert.equal(h.notices[0].retired,false,'Attention-only publications preserve the same-period notice.');
 assert.equal(h.controller.getSnapshot().data,data);assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.equal(posts(h).length,1);
});
test('completion settling after leaving the panel cannot emit a private notice',async t=>{
 const h=await presented(t),wait=h.gate();h.before=(url,options)=>options.method==='POST'?wait.promise:undefined;
 const before=h.controller.getSnapshot(),work=h.controller.setCompletion(ALBUM,true,completionExpected(before));h.view.completed(work,before);
 assert.equal(h.controller.getSnapshot().mutation,'submitting');assert.equal(posts(h).length,1);
 assert.equal(posts(h)[0].url,'/account/goals/completion');
 h.setVisible(false);wait.resolve();await work;await h.flush();assert.deepEqual(h.notices,[]);assertConfirmedCompletion(h,before);
});
test('account retirement synchronously retires the visible due notice',async t=>{
 const h=await presented(t);h.after=(url,options,value)=>{if(url==='/account/goals/attention'){value.periods.month.due=true;value.indicator='red';}return value;};
 await h.controller.loadAttention();h.controller.selectPeriod('month');h.view.enter({});await h.flush();assert.equal(h.notices.length,1);
 h.invalidate();assert.equal(h.notices[0].retired,true);assert.equal(h.controller.getSnapshot().data,null);
});
test('shared Goals owner retains the same pending controller when a borrowed panel is disposed',async t=>{
 const h=await presented(t);h.view.dispose();h.controller.dispose();h.provider.dispose();
 const {createGoalsOwner}=await load('goals-owner.mjs'),{mountGoalsPanel}=await load('goals.mjs');let owner,panel;
 t.after(()=>{try{panel?.dispose();}finally{owner?.dispose();}});
 owner=createGoalsOwner({transport:h.transport,isCurrent:()=>true});h.controller=owner.controller;h.provider=owner.provider;
 await owner.controller.loadBonus();const header={actions:h.dom.add('attention-actions'),content:h.dom.add('attention-content')};
 panel=mountGoalsPanel(h.dom.host,h.dom.runtime,{transport:h.transport,owner,header,isCurrent:()=>true});
 h.before=(url,options)=>{if(options.method==='POST')throw new Error('lost response');};await owner.controller.reset();
 const held=owner.controller.getSnapshot();assert.equal(held.mutation,'uncertain');panel.dispose();assert.equal(owner.controller.getSnapshot(),held);
 panel=mountGoalsPanel(h.dom.host,h.dom.runtime,{transport:h.transport,owner,header,isCurrent:()=>true});assert.equal(owner.controller.getSnapshot(),held);
 assert.equal(posts(h).filter(row=>row.url.endsWith('/reset')).length,1);assert.ok(h.dom.named('Retry'));
});
test('canonical attention marker updates preserve tab node, focus, selection and original ordering',async t=>{
 const dom=domFixture(t),{mountTabs}=await load('native-controls.mjs');let tabs;t.after(()=>tabs?.dispose());
 tabs=mountTabs(dom.host,dom.runtime,{id:'attention-tabs',label:'Home',items:[['recent','Recent'],['goals','Goals']],value:'recent'});
 const buttons=dom.host.querySelectorAll('[role="tab"]'),recent=buttons[0],goals=buttons[1];recent.focus();
 tabs.setAttention('goals','red');assert.equal(dom.host.querySelectorAll('[role="tab"]')[1],goals);assert.equal(dom.document.activeElement,recent);
 assert.equal(recent.getAttribute('aria-selected'),'true');assert.equal(goals.getAttribute('aria-label'),'Goals, reset needed');
 assert.equal(goals.querySelector('.in-page-tabs__attention').hidden,false);assert.deepEqual(buttons.map(x=>x.textContent),['Recent','Goals']);
 tabs.setAttention('goals','none');assert.equal(goals.hasAttribute('aria-label'),false);assert.equal(goals.querySelector('.in-page-tabs__attention').hidden,true);
});

test('Home blur before queued acknowledgment retains intent but sends nothing until focused',async t=>{
 const h=await presented(t);h.view.enter({});h.dom.document.dispatchEvent(new h.dom.c.Event('blur'));await h.flush();assert.deepEqual(posts(h),[]);
 const done=h.wait(s=>s.attention?.weekly_acknowledged===true);h.dom.document.dispatchEvent(new h.dom.c.Event('focus'));await done;assert.equal(posts(h).length,1);
});
test('borrowed panel remount exposes exact stale visit dismissal while preserving domain data',async t=>{
 const h=await presented(t);h.view.dispose();h.controller.dispose();h.provider.dispose();
 const {createGoalsOwner}=await load('goals-owner.mjs'),{mountGoalsPanel}=await load('goals.mjs');let owner,panel;
 t.after(()=>{try{panel?.dispose();}finally{owner?.dispose();}});
 owner=createGoalsOwner({transport:h.transport,isCurrent:()=>true});h.controller=owner.controller;h.provider=owner.provider;
 h.before=(url,options)=>{if(options.method==='POST'&&url.endsWith('/attention/ack'))throw new Error('response lost');};
 const header={actions:h.dom.add('ack-actions'),content:h.dom.add('ack-content')};
 const uncertain=h.wait(s=>s.mutation==='uncertain');
 panel=mountGoalsPanel(h.dom.host,h.dom.runtime,{transport:h.transport,owner,header,visitIntent:{},isCurrent:()=>true});
 await uncertain;await h.flush();const token=owner.visitState.pendingToken;assert.ok(token);panel.dispose();
 panel=mountGoalsPanel(h.dom.host,h.dom.runtime,{transport:h.transport,owner,header,isCurrent:()=>true});await h.flush();
 const dismiss=h.dom.named('Dismiss visit acknowledgment');assert.ok(dismiss);h.dom.click(dismiss);await h.flush();
 assert.equal(owner.controller.getSnapshot().mutation,'idle');assert.equal(owner.visitState.pendingToken,null);assert.match(h.dom.host.textContent,/Retained album/);
 assert.equal(posts(h).length,1);assert.equal(h.dom.named('Dismiss visit acknowledgment'),undefined);
});
test('attention-only publication leaves borrowed panel card and control nodes intact',async t=>{
 const h=await presented(t);h.view.dispose();const {mountGoalsPanel}=await load('goals.mjs');let panel;
 t.after(()=>panel?.dispose());await h.controller.loadBonus();
 const owner={provider:h.provider,controller:h.controller,visitState:{pendingToken:null}},header={actions:h.dom.add('stable-actions'),content:h.dom.add('stable-content')};
 panel=mountGoalsPanel(h.dom.host,h.dom.runtime,{transport:h.transport,owner,header,isCurrent:()=>true});
 const card=h.dom.host.querySelector('.album-card'),add=h.dom.named('Add'),prior=h.calls.length;
 await h.controller.loadAttention();await h.flush();assert.equal(h.dom.host.querySelector('.album-card'),card);assert.equal(h.dom.named('Add'),add);
 assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.deepEqual(posts(h),[]);
});

test('explicit empty visit never creates an event or achievement notice',async t=>{
 const h=await presented(t,{empty:true});h.view.enter({});await h.flush();assert.deepEqual(posts(h),[]);assert.deepEqual(h.notices,[]);assert.equal(h.controller.getSnapshot().attention.indicator,'none');
});
test('reentrant notice renderer cannot retain prior account counts after invalidation',async t=>{
 const h=await presented(t);h.view.dispose();h.data.periods.month.completed=1;h.data.periods.month.manual_completed_at[ALBUM]='2026-01-02T00:00:00Z';await h.ready();h.controller.selectPeriod('month');
 const {createGoalsAttentionView}=await load('goals-attention-view.mjs');let view,disposed=0;t.after(()=>view?.dispose());
 view=createGoalsAttentionView({controller:h.controller,visitState:{pendingToken:null},document:h.dom.document,isCurrent:()=>true,
  notify(){h.invalidate();return {dispose(){disposed++;}};}});view.enter({});await h.flush();assert.equal(disposed,1);assert.equal(h.controller.getSnapshot().data,null);assert.deepEqual(posts(h),[]);
});

test('canonical current-tab activation is explicit and disabled/tab-focus events do not activate',async t=>{
 const dom=domFixture(t),{mountTabs}=await load('native-controls.mjs');let tabs,activated=[];t.after(()=>tabs?.dispose());
 tabs=mountTabs(dom.host,dom.runtime,{id:'visit-tabs',label:'Home',items:[['news','News',{disabled:true}],['goals','Goals']],value:'goals',onActivate:value=>activated.push(value)});
 const goals=dom.host.querySelector('[data-in-page-tab="goals"]'),news=dom.host.querySelector('[data-in-page-tab="news"]');
 dom.click(news);assert.deepEqual(activated,[]);const focus=new dom.c.Event('keydown',{bubbles:true});focus.key='Tab';goals.dispatchEvent(focus);assert.deepEqual(activated,[]);
 dom.click(goals);assert.deepEqual(activated,['goals']);
});
test('request-key reentrant account invalidation prevents any visit POST',async t=>{
 const h=await presented(t,{keyHook:value=>value.invalidate()});h.view.enter({});await h.flush();assert.deepEqual(posts(h),[]);assert.equal(h.controller.getSnapshot().data,null);assert.deepEqual(h.notices,[]);
});
test('reentrant visibility callback disposing its owner cannot issue notices or acknowledgment',async t=>{
 const h=await presented(t);h.view.dispose();const {createGoalsAttentionView}=await load('goals-attention-view.mjs');let view,notices=0;t.after(()=>view?.dispose());
 view=createGoalsAttentionView({controller:h.controller,visitState:{pendingToken:null},document:h.dom.document,
  isCurrent(){view.dispose();return true;},notify(){notices++;return {dispose(){}};}});view.enter({});await h.flush();assert.deepEqual(posts(h),[]);assert.equal(notices,0);
});

async function sharedAttention(t, {failInitial=false}={}) {
 const h=await fixture(t),dom=domFixture(t);h.controller.dispose();h.provider.dispose();
 const {createGoalsOwner}=await load('goals-owner.mjs');let time=10000,sequence=0;const timers=new Map();
 Object.defineProperty(dom.document,'visibilityState',{value:'visible',writable:true,configurable:true});
 Object.defineProperty(dom.document,'hasFocus',{value:()=>true,configurable:true});
 if(failInitial)h.before=url=>{if(url==='/account/goals/attention')throw new Error('temporary read failure');};
 const owner=createGoalsOwner({transport:h.transport,document:dom.document,isCurrent:()=>true,now:()=>time,
  setTimer(fn,delay){const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id)});
 t.after(()=>owner.dispose());h.controller=owner.controller;h.provider=owner.provider;
 await owner.controller.loadBonus();await settle();
 return Object.assign(h,{dom,owner,timers,advance(value){time+=value;},
  async tick(){const entries=[...timers.entries()];assert.equal(entries.length,1);const [id,task]=entries[0];timers.delete(id);assert.equal(task.delay,300000);time+=task.delay;task.fn();await settle();},
  visibility(value){dom.document.visibilityState=value;dom.document.dispatchEvent(new dom.c.Event('visibilitychange'));}});
}
test('failed attention read stays bounded and explicit retry recovers without domain reads or writes',async t=>{
 const h=await sharedAttention(t,{failInitial:true});assert.equal(h.controller.getSnapshot().attentionStatus,'unavailable');
 const prior=h.calls.length;await settle();await settle();assert.equal(h.calls.length,prior);
 h.before=null;await h.owner.refreshAttention({immediate:true});await settle();
 assert.equal(h.controller.getSnapshot().attentionStatus,'ready');assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.deepEqual(posts(h),[]);
});
test('dismissal reconciles same-data attention once and never resubmits the acknowledgment',async t=>{
 const h=await sharedAttention(t),{createGoalsAttentionView}=await load('goals-attention-view.mjs');let view;
 t.after(()=>view?.dispose());const token=h.controller.createVisit({isCurrent:()=>true});assert.ok(token);
 h.owner.visitState.pendingToken=token;h.before=(url,options)=>{if(options.method==='POST')throw new Error('lost response');};
 await h.controller.acknowledgeVisit(token);assert.equal(h.controller.getSnapshot().mutation,'uncertain');
 const data=h.controller.getSnapshot().data,prior=h.calls.length;
 view=createGoalsAttentionView({controller:h.controller,visitState:h.owner.visitState,document:h.dom.document,isCurrent:()=>true,
  refreshAttention:options=>h.owner.refreshAttention(options)});
 assert.equal(view.dismiss(),true);await settle();assert.equal(h.controller.getSnapshot().data,data);
 assert.equal(h.controller.getSnapshot().attentionStatus,'ready');assert.equal(h.owner.visitState.pendingToken,null);
 assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.equal(posts(h).length,1);
});
test('visible calendar freshness reads only attention and updates due without a mutation',async t=>{
 const h=await sharedAttention(t),prior=h.calls.length,data=h.controller.getSnapshot().data;
 h.after=(url,options,value)=>{if(url==='/account/goals/attention'){value.periods.month.due=true;value.indicator='red';}return value;};
 await h.tick();assert.equal(h.controller.getSnapshot().attention.indicator,'red');assert.equal(h.controller.getSnapshot().data,data);
 assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.deepEqual(posts(h),[]);
 h.owner.dispose();assert.equal(h.timers.size,0);
});
test('hidden owner cancels freshness and resume coalesces a bounded read without a visit',async t=>{
 const h=await sharedAttention(t),prior=h.calls.length;h.visibility('hidden');assert.equal(h.timers.size,0);await settle();assert.equal(h.calls.length,prior);
 h.advance(2000);h.visibility('visible');h.dom.document.dispatchEvent(new h.dom.c.Event('focus'));await settle();
 assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.equal(h.timers.size,1);assert.deepEqual(posts(h),[]);
});
test('document hiding retires queued visit unlike transient blur and returning cannot acknowledge',async t=>{
 const h=await presented(t);Object.defineProperty(h.dom.document,'visibilityState',{value:'visible',writable:true,configurable:true});
 const original={};h.view.enter(original);h.dom.document.visibilityState='hidden';h.dom.document.dispatchEvent(new h.dom.c.Event('visibilitychange'));await h.flush();
 h.dom.document.visibilityState='visible';h.dom.document.dispatchEvent(new h.dom.c.Event('visibilitychange'));h.dom.document.dispatchEvent(new h.dom.c.Event('focus'));h.view.enter(original);h.view.update();await h.flush();
 assert.deepEqual(posts(h),[]);assert.deepEqual(h.notices,[]);
 const done=h.wait(s=>s.attention?.weekly_acknowledged===true);h.view.enter({});await done;assert.equal(posts(h).length,1);
});
test('explicit re-entry refreshes unavailable attention while repeated updates do not read',async t=>{
 const h=await sharedAttention(t,{failInitial:true}),{createGoalsAttentionView}=await load('goals-attention-view.mjs');let view;
 t.after(()=>view?.dispose());h.controller.selectPeriod('month');h.before=null;h.advance(2000);const prior=h.calls.length;
 view=createGoalsAttentionView({controller:h.controller,visitState:h.owner.visitState,document:h.dom.document,isCurrent:()=>true,
  refreshAttention:options=>h.owner.refreshAttention(options)});
 view.enter({});await settle();view.update();view.update();await settle();
 assert.equal(h.controller.getSnapshot().attentionStatus,'ready');assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.deepEqual(posts(h),[]);
});
test('entry first mounted in a hidden document cannot become a visit on resume',async t=>{
 const h=await presented(t);Object.defineProperty(h.dom.document,'visibilityState',{value:'hidden',writable:true,configurable:true});
 const intent={};h.view.enter(intent);await h.flush();h.dom.document.visibilityState='visible';
 h.dom.document.dispatchEvent(new h.dom.c.Event('focus'));h.view.enter(intent);h.view.update();await h.flush();assert.deepEqual(posts(h),[]);
});
test('completion arriving after a hidden-and-visible round trip cannot revive an owned notice',async t=>{
 const h=await presented(t),gate=h.gate();Object.defineProperty(h.dom.document,'visibilityState',{value:'visible',writable:true,configurable:true});
 h.before=(url,options)=>options.method==='POST'?gate.promise:undefined;
 const before=h.controller.getSnapshot(),work=h.controller.setCompletion(ALBUM,true,completionExpected(before));h.view.completed(work,before);
 assert.equal(h.controller.getSnapshot().mutation,'submitting');assert.equal(posts(h).length,1);
 assert.equal(posts(h)[0].url,'/account/goals/completion');
 h.dom.document.visibilityState='hidden';h.dom.document.dispatchEvent(new h.dom.c.Event('visibilitychange'));
 h.dom.document.visibilityState='visible';h.dom.document.dispatchEvent(new h.dom.c.Event('focus'));gate.resolve();await work;await h.flush();assert.deepEqual(h.notices,[]);
 assertConfirmedCompletion(h,before);
});
test('attention retry control recovers the existing owner without replacing cards',async t=>{
 const h=await sharedAttention(t,{failInitial:true}),{mountGoalsPanel}=await load('goals.mjs');let panel;t.after(()=>panel?.dispose());
 panel=mountGoalsPanel(h.dom.host,h.dom.runtime,{transport:h.transport,owner:h.owner,
  header:{actions:h.dom.add('retry-attention-actions'),content:h.dom.add('retry-attention-content')},isCurrent:()=>true});
 await settle();const card=h.dom.host.querySelector('.album-card'),retry=h.dom.named('Retry goal attention');assert.ok(retry);
 h.before=null;const prior=h.calls.length;h.dom.click(retry);await settle();await settle();
 assert.equal(h.controller.getSnapshot().attentionStatus,'ready');assert.equal(h.dom.host.querySelector('.album-card'),card);
 assert.equal(h.dom.named('Retry goal attention'),undefined);assert.deepEqual(h.calls.slice(prior).map(x=>x.url),['/account/goals/attention']);assert.deepEqual(posts(h),[]);
});
test('freshness and explicit attention refresh never steal an uncertain domain mutation',async t=>{
 const h=await sharedAttention(t);h.before=(url,options)=>{if(options.method==='POST')throw new Error('uncertain reset');};
 await h.controller.reset();const held=h.controller.getSnapshot();assert.equal(held.mutation,'uncertain');const prior=h.calls.length;
 await h.tick();await h.owner.refreshAttention({immediate:true});await settle();
 assert.equal(h.controller.getSnapshot(),held);assert.equal(h.calls.length,prior);assert.equal(posts(h).length,1);
});

test('restored completion notice still retires synchronously when the selected period changes',async t=>{
 const h=await presented(t),before=h.controller.getSnapshot(),work=h.controller.setCompletion(ALBUM,true,completionExpected(before));
 h.view.completed(work,before);await work;await h.flush();assertConfirmedCompletion(h,before);
 assert.equal(h.notices.length,1);assert.equal(h.notices[0].retired,false);
 h.controller.selectPeriod('month');assert.equal(h.notices[0].retired,true);await h.flush();assert.equal(h.notices.length,1);
});
test('restored completion notice still retires synchronously on blur and does not revive on focus',async t=>{
 const h=await presented(t),before=h.controller.getSnapshot(),work=h.controller.setCompletion(ALBUM,true,completionExpected(before));
 h.view.completed(work,before);await work;await h.flush();assertConfirmedCompletion(h,before);
 assert.equal(h.notices.length,1);assert.equal(h.notices[0].retired,false);
 h.dom.document.dispatchEvent(new h.dom.c.Event('blur'));assert.equal(h.notices[0].retired,true);
 h.dom.document.dispatchEvent(new h.dom.c.Event('focus'));await h.controller.loadAttention();await h.flush();
 assert.equal(h.notices.length,1);assert.equal(h.notices[0].retired,true);assert.equal(posts(h).length,1);
});
