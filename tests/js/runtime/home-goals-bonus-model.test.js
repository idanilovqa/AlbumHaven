const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = name => import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends', name)).href);
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PERIODS = ['week','month','six-months','year'], GOAL=id(1), ALBUM=id(2), TOP=id(3);
const clone = value => JSON.parse(JSON.stringify(value));
const values = changes => ({enabled:false,source_mode:'all_active',selected_top_refs:[],preferred_top_refs:[],album_mode:'random',unfinished_policy:'carry',...changes});
const settings = changes => ({settings_revision:'1',...values(),selection_algorithm:'active-top-weighted-v1',normal_top_weight:1,preferred_top_weight:3,...changes});
const cycle = n => ({cycle_id:id(n),started_at:'2026-01-01T00:00:00+00:00',start_date:'2026-01-01',due_date:'2026-01-08',timezone_name:'UTC'});
function goal(empty=false) {
  return {goal_ref:empty?null:GOAL,revision:empty?'1':'2',allowed_actions:{can_read:true,can_add:true,can_reset:true,can_complete:true,can_remove:true},
    albums:empty?[]:[{catalog_ref:ALBUM,title:'Retained album',artist_display:'Artist',first_release_date:null,primary_type:null}],
    periods:Object.fromEntries(PERIODS.map((period,i)=>[period,{period,top_ref:empty?null:GOAL,cycle:empty?null:cycle(i+10),
      album_refs:empty?[]:[ALBUM],manual_completed_at:empty?{}:{[ALBUM]:null},total:empty?0:1,completed:0}]))};
}
const capture = c => {const {data,settings,bonus,period}=c.getSnapshot();return {data,settings,bonus,period};};
async function harness(t, {empty=false,enabled=false,source=true,keyHook}={}) {
  const {createGoalsProvider}=await load('goals-provider.mjs');
  const {createGoalsController}=await load('goals-model.mjs');
  const h={data:goal(empty),settings:settings({enabled}),bonus:{cycle_id:empty?null:id(10),bonus:null,manual_count:empty?0:1},calls:[],receipts:new Map(),source,hook:null};
  t.after(()=>{try{h.controller?.dispose();}finally{h.provider?.dispose();}});
  let context='a'.repeat(64), notify, key=100;
  h.invalidate=()=>{context='b'.repeat(64);notify?.();};
  const transport={context:()=>context,subscribe:fn=>{notify=fn;return()=>{notify=null;};},async request(url,options={}) {
    h.calls.push({url,method:options.method||'GET',body:options.body});
    if(options.isCurrent&&!options.isCurrent())throw Object.assign(new Error('retired'),{name:'AbortError'});
    let data;
    if(options.method==='POST') {
      const command=options.body;
      if(url.endsWith('/bonus-settings')) {
        const fields=values(Object.fromEntries(Object.keys(values()).map(name=>[name,command[name]])));
        const changed=JSON.stringify(fields)!==JSON.stringify(values(Object.fromEntries(Object.keys(values()).map(name=>[name,h.settings[name]]))));
        h.settings={...h.settings,...fields,settings_revision:String(BigInt(command.settings_revision)+(changed?1n:0n))};
        data={ok:true,action:'bonus_settings',request_key:command.request_key,changed,settings:clone(h.settings)};
      } else if(url.endsWith('/bonus/draw')) {
        const album=id(20);
        if(h.data.goal_ref===null) {
          h.data=goal(true);h.data.goal_ref=GOAL;
          for(const [i,period] of PERIODS.entries()) {h.data.periods[period].top_ref=GOAL;h.data.periods[period].cycle=cycle(i+10);}
        }
        h.data.revision=String(BigInt(command.revision)+1n);
        h.data.albums.push({catalog_ref:album,title:'Source album',artist_display:'Artist',first_release_date:null,primary_type:null});
        for(const period of PERIODS) {const row=h.data.periods[period];row.album_refs.push(album);row.manual_completed_at[album]=null;row.total++;}
        h.bonus={cycle_id:id(10),bonus:{catalog_ref:album,present:true},manual_count:h.data.periods.week.total-1};
        data={ok:true,action:'bonus_draw',request_key:command.request_key,changed:true,reason:'',goal_ref:GOAL,
          revision:h.data.revision,period:'week',cycle_id:id(10),catalog_ref:album};
      } else if(url.endsWith('/transition')) {
        const row=h.data.periods[command.period];row.cycle=cycle(30);
        h.data.revision=String(BigInt(command.revision)+1n);
        if(command.period==='week')h.bonus.cycle_id=id(30);
        data={ok:true,action:'transition',request_key:command.request_key,changed:true,reason:'',goal_ref:GOAL,revision:h.data.revision,
          period:command.period,previous_cycle_id:command.expected_cycle_id,cycle_id:id(30),settings_revision:command.settings_revision,
          retained_count:row.total,bonus_carried:false,...(command.period==='week'?{manual_count:row.total,manual_slots_available:5-row.total,bonus_slot_available:true}:{})};
      } else throw new Error('Unexpected write '+url);
      h.receipts.set(command.request_key,clone(data));
    } else if(url==='/account/goals')data=clone(h.data);
    else if(url.endsWith('/bonus-settings'))data=clone(h.settings);
    else if(url.endsWith('/bonus'))data=clone(h.bonus);
    else if(url.includes('/operations/')) {const receipt=h.receipts.get(url.split('/').pop());data=receipt?{status:'committed',receipt:clone(receipt)}:{status:'unknown'};}
    else throw new Error('Unexpected route '+url);
    const overridden=await h.hook?.(url,options,data);
    return {status:'ready',context_ref:context,data:overridden===undefined?data:overridden};
  }};
  h.provider=createGoalsProvider(transport);
  h.controller=createGoalsController({provider:h.provider,timezone:'UTC',canDrawBonus:()=>h.source,
    requestKey:()=>{keyHook?.(h);return id(key++);}});
  return h;
}
const posts=h=>h.calls.filter(row=>row.method==='POST');

for(const changes of [{normal_top_weight:2},{preferred_top_weight:2},{selection_algorithm:'unknown'},
  {selected_top_refs:[TOP]},{source_mode:'selected',preferred_top_refs:[TOP]},
  {enabled:1},{settings_revision:'0'},{selected_top_refs:Array(101).fill(TOP)}]) {
  test('settings DTO rejects '+JSON.stringify(changes),async()=>{
    const {normalizeBonusSettings}=await load('goals-provider.mjs');
    assert.throws(()=>normalizeBonusSettings(settings(changes)));
  });
}
for(const value of [{cycle_id:null,bonus:null,manual_count:1},{cycle_id:id(10),bonus:null,manual_count:8},
  {cycle_id:id(10),bonus:{catalog_ref:ALBUM,present:1},manual_count:1}]) {
  test('bonus DTO rejects impossible state '+JSON.stringify(value),async()=>{
    const {normalizeCurrentBonus}=await load('goals-provider.mjs');assert.throws(()=>normalizeCurrentBonus(value));
  });
}

test('read-only coherent load, explicit settings save and no-op keep aggregate revision independent',async t=>{
  const h=await harness(t);await h.controller.loadBonus();
  assert.equal(posts(h).length,0);assert.equal(h.controller.getSnapshot().bonusStatus,'ready');
  const revision=h.controller.getSnapshot().data.revision;
  await h.controller.saveBonusSettings(values({enabled:true}),capture(h.controller));
  assert.equal(h.controller.getSnapshot().settings.settings_revision,'2');
  assert.deepEqual(h.controller.getSnapshot().outcome,{action:'bonus_settings',changed:true,reason:''});
  assert.equal(h.controller.getSnapshot().data.revision,revision);
  await h.controller.saveBonusSettings(values({enabled:true}),capture(h.controller));
  assert.equal(h.controller.getSnapshot().settings.settings_revision,'2');
  assert.deepEqual(h.controller.getSnapshot().outcome,{action:'bonus_settings',changed:false,reason:''});
  assert.deepEqual(posts(h).map(row=>Object.keys(row.body).sort()),Array(2).fill(['request_key','settings_revision',...Object.keys(values())].sort()));
  assert.ok(h.calls.every(row=>!row.url.startsWith('/album-tops')));
});

test('account-only default cannot draw but retains preference/transition reads and writes',async t=>{
  const h=await harness(t,{enabled:true,source:false});await h.controller.loadBonus();
  await h.controller.drawBonus(capture(h.controller));assert.equal(posts(h).length,0);
  await h.controller.transition(capture(h.controller));
  assert.equal(posts(h)[0].url,'/account/goals/transition');
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle.cycle_id,id(30));
});

test('initial null Goal draw targets week regardless of selected period and refreshes captured role',async t=>{
  const h=await harness(t,{empty:true,enabled:true});await h.controller.loadBonus();h.controller.selectPeriod('month');
  await h.controller.drawBonus(capture(h.controller));
  assert.equal(posts(h)[0].body.expected_cycle_id,null);assert.equal(Object.hasOwn(posts(h)[0].body,'period'),false);
  assert.equal(h.controller.getSnapshot().bonus.bonus.catalog_ref,id(20));
  assert.equal(h.controller.getSnapshot().bonus.manual_count,0);
  await h.controller.drawBonus(capture(h.controller));assert.equal(posts(h).length,1);
});

test('captured removed bonus prevents reroll and source loss does not clear retained reads',async t=>{
  const h=await harness(t,{enabled:true});h.bonus.bonus={catalog_ref:id(20),present:false};
  await h.controller.loadBonus();h.source=false;
  await h.controller.drawBonus(capture(h.controller));assert.equal(posts(h).length,0);
  assert.deepEqual(h.controller.getSnapshot().bonus.bonus,{catalog_ref:id(20),present:false});
  assert.equal(h.controller.getSnapshot().data.albums[0].catalog_ref,ALBUM);
});

for(const action of ['bonus_settings','bonus_draw','transition']) {
  test(action+' uncertain outcome recovers exact receipt without duplicate write',async t=>{
    const h=await harness(t,{enabled:true});await h.controller.loadBonus();let lost=false;
    h.hook=(url,options)=>{if(options.method==='POST'&&!lost){lost=true;throw new Error('connection lost after commit');}};
    const expected=capture(h.controller);
    await (action==='bonus_settings'?h.controller.saveBonusSettings(values({enabled:true,album_mode:'next'}),expected)
      :action==='bonus_draw'?h.controller.drawBonus(expected):h.controller.transition(expected));
    assert.equal(h.controller.getSnapshot().mutation,'uncertain');
    await h.controller.reset();await h.controller.saveBonusSettings(values(),expected);assert.equal(posts(h).length,1);
    await h.controller.retry();
    assert.equal(posts(h).length,1);assert.equal(h.controller.getSnapshot().mutation,'idle');
    assert.equal(h.calls.filter(row=>row.url.includes('/operations/')).length,1);
  });
}

test('acknowledged settings with failed refresh retries reads only',async t=>{
  const h=await harness(t);await h.controller.loadBonus();let saved=false,failed=false;
  h.hook=(url,options)=>{if(options.method==='POST')saved=true;else if(saved&&!failed){failed=true;throw new Error('read failed');}};
  await h.controller.saveBonusSettings(values({enabled:true}),capture(h.controller));
  assert.equal(h.controller.getSnapshot().error.kind,'acknowledged-refresh');
  await h.controller.retry();assert.equal(posts(h).length,1);
  assert.equal(h.calls.filter(row=>row.url.includes('/operations/')).length,0);
  assert.equal(h.controller.getSnapshot().settings.enabled,true);
});

test('stale dialog identities and key-generation reentrancy cannot send',async t=>{
  let reenter=false;
  const h=await harness(t,{enabled:true,keyHook:h=>{if(reenter)h.controller.selectPeriod('month');}});
  await h.controller.loadBonus();const stale=capture(h.controller);await h.controller.loadBonus();
  await h.controller.saveBonusSettings(values(),stale);assert.equal(posts(h).length,0);
  reenter=true;await h.controller.drawBonus(capture(h.controller));assert.equal(posts(h).length,0);
});

test('incoherent bonus cycles retry reads boundedly and never create a write',async t=>{
  const h=await harness(t);h.bonus.cycle_id=id(99);await h.controller.loadBonus();
  assert.equal(h.controller.getSnapshot().bonusStatus,'unavailable');
  assert.equal(h.calls.filter(row=>row.url.endsWith('/bonus')).length,2);assert.equal(posts(h).length,0);
});

test('context retirement clears personal DTOs and invalidates old expectations',async t=>{
  const h=await harness(t,{enabled:true});await h.controller.loadBonus();const expected=capture(h.controller);
  h.invalidate();await h.controller.drawBonus(expected);await h.controller.saveBonusSettings(values(),expected);
  assert.equal(posts(h).length,0);assert.equal(h.controller.getSnapshot().settings,null);assert.equal(h.controller.getSnapshot().bonus,null);
});

async function submit(h,action) {
  const expected=capture(h.controller);
  return action==='bonus_settings'?h.controller.saveBonusSettings(values({enabled:true,album_mode:'next'}),expected)
    :action==='bonus_draw'?h.controller.drawBonus(expected):h.controller.transition(expected);
}
for(const [action,patch] of [
  ['bonus_settings',row=>({...row,request_key:id(99)})],
  ['bonus_settings',row=>({...row,settings:{...row.settings,settings_revision:'99'}})],
  ['bonus_settings',row=>({...row,settings:{...row.settings,album_mode:'random'}})],
  ['bonus_draw',row=>({...row,action:'add'})],
  ['bonus_draw',row=>({...row,goal_ref:id(99)})],
  ['bonus_draw',row=>({...row,revision:'99'})],
  ['bonus_draw',row=>({...row,catalog_ref:ALBUM})],
  ['bonus_draw',row=>({...row,cycle_id:id(99)})],
  ['transition',row=>({...row,previous_cycle_id:id(99)})],
  ['transition',row=>({...row,settings_revision:'99'})],
  ['transition',row=>({...row,retained_count:0,manual_count:0,manual_slots_available:5})],
  ['transition',row=>({...row,bonus_carried:true,manual_count:0,manual_slots_available:5,bonus_slot_available:false})],
]) {
  test(action+' rejects malformed receipt '+String(patch),async t=>{
    const h=await harness(t,{enabled:true});await h.controller.loadBonus();
    h.hook=(url,options,row)=>options.method==='POST'?patch(row):undefined;
    await submit(h,action);assert.equal(h.controller.getSnapshot().mutation,'uncertain');
    h.hook=null;await h.controller.retry();assert.equal(h.controller.getSnapshot().mutation,'idle');
    assert.equal(posts(h).length,1);
  });
}

test('exhausted pool outcome remains visible after successful account refresh without reroll',async t=>{
  const h=await harness(t,{enabled:true});await h.controller.loadBonus();
  const original=clone(h.data),originalBonus=clone(h.bonus);
  h.hook=(url,options)=>{
    if(url.endsWith('/bonus/draw')&&options.method==='POST') {
      h.data=clone(original);h.bonus=clone(originalBonus);
      const receipt={ok:true,action:'bonus_draw',request_key:options.body.request_key,changed:false,reason:'no_eligible_source',
        goal_ref:GOAL,revision:original.revision,period:'week',cycle_id:id(10),catalog_ref:null};
      h.receipts.set(options.body.request_key,receipt);return receipt;
    }
  };
  await h.controller.drawBonus(capture(h.controller));
  assert.deepEqual(h.controller.getSnapshot().outcome,{action:'bonus_draw',changed:false,reason:'no_eligible_source'});
  assert.equal(posts(h).length,1);assert.equal(h.controller.getSnapshot().mutation,'idle');
});

for(const action of ['bonus_settings','bonus_draw','transition']) {
  test(action+' unknown operation retries original bytes and key only',async t=>{
    const h=await harness(t,{enabled:true});await h.controller.loadBonus();
    const original=clone(h.data),originalBonus=clone(h.bonus),originalSettings=clone(h.settings);
    let failed=false;
    h.hook=(url,options)=>{if(options.method==='POST'&&!failed){
      failed=true;h.data=clone(original);h.bonus=clone(originalBonus);h.settings=clone(originalSettings);
      h.receipts.clear();throw new Error('no commit');
    }};
    await submit(h,action);assert.equal(h.controller.getSnapshot().mutation,'uncertain');
    await h.controller.retry();assert.equal(posts(h).length,2);
    assert.deepEqual(posts(h)[0].body,posts(h)[1].body);
    assert.equal(h.controller.getSnapshot().mutation,'idle');
  });
}

for(const kind of ['substituted','reordered']) {
  test('transition exact-revision refresh rejects '+kind+' carried members',async t=>{
    const h=await harness(t,{enabled:true});
    if(kind==='reordered') {
      h.data.albums.push({...h.data.albums[0],catalog_ref:id(21)});
      for(const row of Object.values(h.data.periods)){row.album_refs.push(id(21));row.manual_completed_at[id(21)]=null;row.total++;}
      h.bonus.manual_count=2;
    }
    await h.controller.loadBonus();
    h.hook=(url,options)=>{if(options.method==='POST') {
      const row=h.data.periods.week;
      if(kind==='substituted') {
        h.data.albums.push({...h.data.albums[0],catalog_ref:id(22)});
        row.album_refs=[id(22)];row.manual_completed_at={[id(22)]:null};
      } else row.album_refs.reverse();
    }};
    await h.controller.transition(capture(h.controller));
    assert.equal(h.controller.getSnapshot().error.kind,'acknowledged-refresh');
    assert.equal(posts(h).length,1);
  });
}

test('source-context loss during key generation prevents new draw without deleting personal snapshot',async t=>{
  const h=await harness(t,{enabled:true,keyHook:h=>{h.source=false;}});await h.controller.loadBonus();
  await h.controller.drawBonus(capture(h.controller));assert.equal(posts(h).length,0);
  assert.equal(h.controller.getSnapshot().status,'ready');assert.equal(h.controller.getSnapshot().data.goal_ref,GOAL);
});

test('context invalidation during auxiliary read prevents stale settings delivery',async t=>{
  const h=await harness(t);
  h.hook=url=>{if(url.endsWith('/bonus-settings'))h.invalidate();};
  await h.controller.loadBonus();assert.equal(h.controller.getSnapshot().settings,null);
  assert.equal(h.controller.getSnapshot().bonus,null);assert.equal(posts(h).length,0);
});

for(const committed of [true,false]) {
  test('source loss after uncertain draw '+(committed?'recovers saved receipt':'holds exact unknown intent'),async t=>{
    const h=await harness(t,{enabled:true});await h.controller.loadBonus();
    const old=clone(h.data),oldBonus=clone(h.bonus);let once=false;
    h.hook=(url,options)=>{if(options.method==='POST'&&!once){once=true;
      if(!committed){h.receipts.clear();h.data=clone(old);h.bonus=clone(oldBonus);}
      throw new Error('uncertain');
    }};
    await h.controller.drawBonus(capture(h.controller));h.source=false;
    await h.controller.retry();assert.equal(posts(h).length,1);
    if(committed)assert.equal(h.controller.getSnapshot().mutation,'idle');
    else {
      assert.equal(h.controller.getSnapshot().error.kind,'source-unavailable');
      h.source=true;await h.controller.retry();assert.equal(posts(h).length,2);
      assert.deepEqual(posts(h)[0].body,posts(h)[1].body);assert.equal(h.controller.getSnapshot().mutation,'idle');
    }
  });
}

for(const code of ['source_context_unavailable','forbidden']) {
  test('server403 '+code+' distinguishes source loss from account denial',async t=>{
    const h=await harness(t,{enabled:true});await h.controller.loadBonus();
    const original=clone(h.data),oldBonus=clone(h.bonus);
    h.hook=(url,options)=>{if(options.method==='POST'){
      h.data=clone(original);h.bonus=clone(oldBonus);h.receipts.clear();
      throw Object.assign(new Error('rejected'),{status:403,code,responseRejected:true});
    }};
    await h.controller.drawBonus(capture(h.controller));
    if(code==='source_context_unavailable') {
      assert.equal(h.controller.getSnapshot().status,'ready');
      assert.equal(h.controller.getSnapshot().data.goal_ref,GOAL);
      assert.equal(h.controller.getSnapshot().settings.enabled,true);
      assert.equal(h.controller.getSnapshot().error.kind,'source-unavailable');
    } else {
      assert.equal(h.controller.getSnapshot().status,'denied');assert.equal(h.controller.getSnapshot().data,null);
      assert.equal(h.controller.getSnapshot().settings,null);
    }
    assert.equal(posts(h).length,1);
  });
}

test('source403 followed by account-read403 clears retained data',async t=>{
  const h=await harness(t,{enabled:true});await h.controller.loadBonus();let rejected=false;
  h.hook=(url,options)=>{
    if(options.method==='POST'){rejected=true;throw Object.assign(new Error('source rejected'),{status:403,code:'source_context_unavailable',responseRejected:true});}
    if(rejected)throw Object.assign(new Error('account rejected'),{status:403,code:'forbidden',responseRejected:true});
  };
  await h.controller.drawBonus(capture(h.controller));
  assert.equal(h.controller.getSnapshot().status,'denied');assert.equal(h.controller.getSnapshot().data,null);
});

test('submitting observer source loss stops dispatch and retains single exact pending key',async t=>{
  const h=await harness(t,{enabled:true});await h.controller.loadBonus();
  const expected=capture(h.controller);
  const unsubscribe=h.controller.subscribe(snapshot=>{if(snapshot.mutation==='submitting')h.source=false;});
  t.after(unsubscribe);
  await h.controller.drawBonus(expected);assert.equal(posts(h).length,0);
  assert.equal(h.controller.getSnapshot().mutation,'uncertain');
  await h.controller.saveBonusSettings(values(),expected);await h.controller.reset();assert.equal(posts(h).length,0);
  unsubscribe();h.source=true;await h.controller.retry();assert.equal(posts(h).length,1);
  assert.equal(posts(h)[0].body.request_key,id(100));assert.equal(h.controller.getSnapshot().mutation,'idle');
});

for(const accountGoals of [false,true]) {
  test('actual shared transport '+(accountGoals?'account privacy retirement':'Home structured source failure')+' preserves its authority boundary',async t=>{
    const fs=require('node:fs'),vm=require('node:vm');
    const {createGoalsProvider}=await load('goals-provider.mjs');
    const {createGoalsController}=await load('goals-model.mjs');
    const marker='a'.repeat(64),root={dataset:{privateUiContext:marker,accountGoalsContext:marker}};
    let transport,provider,controller,context,denialBodies=0,writes=0;
    t.after(()=>{try{controller?.dispose();}finally{try{provider?.dispose();}finally{
      try{transport?.dispose();}finally{context?.AlbumHavenPrivateUITransport?.dispose();}
    }}});
    context={URL,Headers,URLSearchParams,document:{cookie:'',getElementById:()=>root},
      location:{href:'https://music.test/',origin:'https://music.test'},
      MutationObserver:class{observe(){}disconnect(){}},
      fetch:async(url,options)=>{
        if(options.method==='POST'){writes++;return {ok:false,status:403,json:async()=>{denialBodies++;return {error:'source_context_unavailable'};}};}
        const data=url==='/account/goals'?goal():url.endsWith('/bonus-settings')?settings({enabled:true}):{cycle_id:id(10),bonus:null,manual_count:1};
        return {ok:true,status:200,json:async()=>({status:'ready',context_ref:marker,
          ...(accountGoals?{context_scope:'account-goals-v1'}:{}),data})};
      }};
    context.window=context;vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/private-ui-transport.js'),'utf8'),context);
    transport=context.createAlbumHavenPrivateUITransport({root,accountGoals});
    provider=createGoalsProvider(transport);
    controller=createGoalsController({provider,requestKey:()=>id(100),timezone:'UTC',canDrawBonus:()=>true});
    await controller.loadBonus();await controller.drawBonus(capture(controller));
    assert.equal(writes,1);
    if(accountGoals){assert.equal(denialBodies,0);assert.equal(controller.getSnapshot().data,null);assert.throws(()=>transport.context());}
    else {assert.equal(denialBodies,1);assert.equal(controller.getSnapshot().status,'ready');assert.equal(controller.getSnapshot().error.kind,'source-unavailable');}
  });
}

for(const action of ['drawBonus','transition']) {
  test(action+' acknowledged refresh rejects older settings and retries only reads',async t=>{
    const h=await harness(t,{enabled:true});h.settings.settings_revision='2';
    await h.controller.loadBonus();let stale=true;
    h.hook=(url,options,data)=>url.endsWith('/bonus-settings')&&options.method!=='POST'&&stale
      ? {...data,settings_revision:'1'}:undefined;
    await h.controller[action](capture(h.controller));
    assert.equal(posts(h).length,1);
    assert.equal(h.controller.getSnapshot().error.kind,'acknowledged-refresh');
    stale=false;await h.controller.retry();
    assert.equal(posts(h).length,1);assert.equal(h.controller.getSnapshot().mutation,'idle');
    assert.equal(h.controller.getSnapshot().settings.settings_revision,'2');
  });
}

test('weekly transition accepts distinct carried-suggestion provenance and configurable manual limit',async t=>{
  const h=await harness(t);await h.controller.loadBonus();
  h.hook=(url,_options,row)=>url.endsWith('/transition')?{...row,manual_limit:4,weekly_suggestions_carried:1,manual_count:0,manual_slots_available:4}:undefined;
  await h.controller.transition(capture(h.controller));
  assert.equal(h.controller.getSnapshot().status,'ready');assert.equal(h.controller.getSnapshot().mutation,'idle');
});
test('weekly transition rejects a partial new provenance contract',async t=>{
  const h=await harness(t);await h.controller.loadBonus();
  h.hook=(url,_options,row)=>url.endsWith('/transition')?{...row,manual_limit:4}:undefined;
  await h.controller.transition(capture(h.controller));assert.equal(h.controller.getSnapshot().mutation,'uncertain');
});
test('rated weekly members are not expected to roll over as unfinished albums',async t=>{
  const h=await harness(t);h.data.albums[0].completion_mode='rating';
  h.data.periods.week.rated_at={[ALBUM]:'2026-01-02T00:00:00Z'};h.data.periods.week.completed=1;
  await h.controller.loadBonus();h.hook=(url,_options,row)=>{
    if(!url.endsWith('/transition'))return undefined;
    Object.assign(h.data.periods.week,{album_refs:[],manual_completed_at:{},rated_at:{},total:0,completed:0});h.bonus.manual_count=0;
    return {...row,retained_count:0,manual_limit:5,weekly_suggestions_carried:0,manual_count:0,manual_slots_available:5};
  };
  await h.controller.transition(capture(h.controller));assert.equal(h.controller.getSnapshot().status,'ready');assert.equal(h.controller.getSnapshot().data.periods.week.total,0);
});
