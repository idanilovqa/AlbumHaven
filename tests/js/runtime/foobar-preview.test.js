const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const STAMP='d'.repeat(64);
function transportFixture(initial=STAMP) {
  const shell={dataset:{privateUiContext:initial}};
  const context=vm.createContext({document:{getElementById:()=>shell},URLSearchParams});context.window=context;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/private-ui-transport.js'),'utf8'),context);
  const transport=context.AlbumHavenPrivateUITransport;
  return {transport,shell,setContext(next){shell.dataset.privateUiContext=next;transport.generation();}};
}
const {pathToFileURL} = require('node:url');
const moduleURL = name => pathToFileURL(path.join(__dirname,'../../../music_app/static/js/foobar-preview',name)).href;
const modules = () => Promise.all([import(moduleURL('contract.mjs')),import(moduleURL('controller.mjs'))]);
const capability = status => ({protocol:'foobar_preview_v1',status,context_ref:STAMP,mapping:'foobar_text_tools_snapshot_v1',max_input_bytes:67108864,max_response_bytes:262144,max_window_rows:100});
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const file = name => Object.defineProperty(new Blob(['path\tplay_count\n/music/a.flac\t2\n'],{type:'text/tab-separated-values'}),'name',{value:name});
function page(offset=0,total=1) {
  const count=Math.min(100,Math.max(0,total-offset));
  return {protocol:'foobar_preview_v1',status:'preview_only',context_ref:STAMP,mapping:'foobar_text_tools_snapshot_v1',source_sha256:'a'.repeat(64),inventory_revision:'b'.repeat(64),offset,total_rows:total,returned_rows:count,next_offset:offset+count<total?offset+count:null,
    summary:{rows_total:total,exact_unique_rows:total,ambiguous_rows:0,unmatched_rows:0,identity_conflict_rows:0,duplicate_target_groups:0,duplicate_target_rows:0,rows_with_field_errors:0,unsupported_nonempty_field_count:0},
    rows:Array.from({length:count},(_,i)=>({ordinal:offset+i+1,line_number:offset+i+2,match_status:'exact_unique',candidate_count:1,candidates_truncated:false,duplicate_target:false,fields:[{name:'play_count',category:'aggregate_count',state:'valid'}]}))};
}

test('closed preview grammar rejects raw fields, wrong mapping, invalid ordinals and import success',async()=>{
  const [contract]=await modules();
  assert.equal(contract.validatePage(page(),0,STAMP).status,'preview_only');
  for(const mutate of [p=>p.raw_cells=[],p=>p.status='imported',p=>p.mapping='custom',p=>p.rows[0].ordinal=0,p=>p.rows[0].fields[0].value=2]) {
    const value=page();mutate(value);assert.throws(()=>contract.validatePage(value,0,STAMP));
  }
  assert.throws(()=>contract.validateCapabilities({...capability('available'),receipt:'invented'},STAMP));
});

test('file selection checks size and TSV type without reading file bytes',async()=>{
  const [contract]=await modules(); const selected=file('local.tsv');
  assert.equal(contract.validateFile(selected),selected);
  for(const candidate of [{name:'bad.xml',size:10},{name:'empty.tsv',size:0},{name:'large.tsv',size:67108865}]) assert.throws(()=>contract.validateFile(candidate));
});

test('browse denial cannot fetch capabilities or upload',async()=>{
  const [,{createPreviewController}]=await modules();
  const owner=createPreviewController({transport:transportFixture().transport,fetch:()=>assert.fail('denied fetch'),allows:()=>false,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('x.tsv'));await owner.preview();
  assert.equal(owner.getState().phase,'denied');owner.dispose();
});

test('real unavailable capability never enables file upload',async()=>{
  const [,{createPreviewController}]=await modules();let calls=0;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:async url=>{calls++;assert.equal(url,'/integrations/foobar/preview-capabilities');return response(capability('unavailable'));},allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('x.tsv'));await owner.preview();
  assert.equal(calls,1);assert.equal(owner.getState().available,false);owner.dispose();
});

test('preview uses selected Blob, declared byte size and real same-origin protocol without persistence',async()=>{
  const [,{createPreviewController}]=await modules();const selected=file('x.tsv');let posted;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:async(url,init)=>{if(init.method==='GET')return response(capability('available'));posted={url,init};return response(page());},allows:action=>action==='library.browse.read',isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(selected);await owner.preview();
  assert.equal(posted.url,'/integrations/foobar/preview?offset=0');assert.equal(posted.init.body,selected);
  assert.equal(posted.init.headers['X-Album-Haven-Foobar-Bytes'],String(selected.size));assert.equal(posted.init.credentials,'same-origin');assert.equal(posted.init.redirect,'error');
  assert.equal(posted.init.headers['X-AlbumHaven-Context'],STAMP);
  assert.equal(owner.getState().phase,'ready');assert.equal(owner.getState().page.status,'preview_only');owner.dispose();
});

test('new file selection aborts and discards delayed old preview',async()=>{
  const [,{createPreviewController}]=await modules();let finish,signal;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:(url,init)=>init.method==='GET'?Promise.resolve(response(capability('available'))):new Promise(resolve=>{finish=resolve;signal=init.signal;}),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('old.tsv'));const pending=owner.preview();
  owner.choose(file('new.tsv'));assert.equal(signal.aborted,true);finish(response(page()));await pending;
  assert.equal(owner.getState().filename,'new.tsv');assert.equal(owner.getState().page,null);owner.dispose();
});

test('leaving or disposing the owner cannot publish a delayed page',async()=>{
  const [,{createPreviewController}]=await modules();let finish,current=true,publications=0;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:(url,init)=>init.method==='GET'?Promise.resolve(response(capability('available'))):new Promise(resolve=>{finish=resolve;}),allows:()=>true,isCurrent:()=>current,onChange(){publications++;}});
  await owner.initialize();owner.choose(file('x.tsv'));const pending=owner.preview();const before=publications;current=false;owner.dispose();finish(response(page()));await pending;
  assert.equal(publications,before);assert.equal(owner.getState().phase,'disposed');assert.equal(owner.getState().filename,'');
});

test('changed inventory between pages requires a fresh preview',async()=>{
  const [,{createPreviewController}]=await modules();let posts=0;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:async(url,init)=>{if(init.method==='GET')return response(capability('available'));const value=page(posts++?100:0,101);if(value.offset)value.inventory_revision='c'.repeat(64);return response(value);},allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('x.tsv'));await owner.preview();await owner.preview(100);
  assert.equal(owner.getState().phase,'error');assert.equal(owner.getState().page,null);assert.match(owner.getState().error,/changed/);owner.dispose();
});

test('unauthorized response clears selected file and does not manufacture success',async()=>{
  const [,{createPreviewController}]=await modules();
  const owner=createPreviewController({transport:transportFixture().transport,fetch:async(url,init)=>init.method==='GET'?response(capability('available')):response({protocol:'foobar_preview_v1',error:'preview_denied'},403),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('x.tsv'));await owner.preview();
  assert.equal(owner.getState().available,false);assert.equal(owner.getState().filename,'');assert.equal(owner.getState().page,null);owner.dispose();
});

test('response byte ceiling rejects oversized and malformed protocol payloads',async()=>{
  const [contract]=await modules();
  await assert.rejects(contract.readBoundedJSON(response({padding:'x'.repeat(262145)})));
  await assert.rejects(contract.readBoundedJSON(new Response('not-json',{headers:{'Content-Type':'text/html'}})));
});

test('missing initial membership never fetches a capability or sends a selected file',async()=>{
  const [,{createPreviewController}]=await modules();const fixture=transportFixture('');
  const owner=createPreviewController({transport:fixture.transport,fetch:()=>assert.fail('membership not ready'),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('x.tsv'));await owner.preview();
  assert.equal(owner.getState().phase,'retired');assert.equal(owner.getState().filename,'');owner.dispose();
});

test('first capability response must belong to the actual shell context',async()=>{
  const [,{createPreviewController}]=await modules();const fixture=transportFixture();let calls=0;
  const owner=createPreviewController({transport:fixture.transport,fetch:async()=>{calls++;return response({...capability('available'),context_ref:'e'.repeat(64)});},allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('x.tsv'));await owner.preview();
  assert.equal(calls,1);assert.equal(owner.getState().phase,'retired');assert.equal(fixture.transport.peekGeneration(),null);owner.dispose();
});

test('same-user library switch retires selected file and rejects a late old-library response',async()=>{
  const [,{createPreviewController}]=await modules();const fixture=transportFixture();let finish,signal;
  const owner=createPreviewController({transport:fixture.transport,fetch:(url,init)=>init.method==='GET'?Promise.resolve(response(capability('available'))):new Promise(resolve=>{finish=resolve;signal=init.signal;}),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('old-library.tsv'));const pending=owner.preview();fixture.setContext('e'.repeat(64));
  assert.equal(signal.aborted,true);assert.equal(owner.getState().filename,'');assert.equal(owner.getState().phase,'retired');finish(response(page()));await pending;
  assert.equal(owner.getState().page,null);owner.dispose();
});

test('session replacement retires an already displayed report and cannot silently reuse its File',async()=>{
  const [,{createPreviewController}]=await modules();const fixture=transportFixture();let posts=0;
  const owner=createPreviewController({transport:fixture.transport,fetch:async(url,init)=>{if(init.method==='GET')return response(capability('available'));posts++;return response(page());},allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('session.tsv'));await owner.preview();assert.equal(owner.getState().phase,'ready');
  fixture.setContext('f'.repeat(64));assert.equal(owner.getState().page,null);assert.equal(owner.getState().filename,'');await owner.preview();assert.equal(posts,1);owner.dispose();
});

test('a consumed late denial revokes the real context even after newer file selection',async()=>{
  const [,{createPreviewController}]=await modules();const fixture=transportFixture();let finish;
  const owner=createPreviewController({transport:fixture.transport,fetch:(url,init)=>init.method==='GET'?Promise.resolve(response(capability('available'))):new Promise(resolve=>{finish=resolve;}),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();owner.choose(file('old.tsv'));const pending=owner.preview();owner.choose(file('new.tsv'));
  finish(new Response('Denied',{status:403,headers:{'Content-Type':'text/html'}}));await pending;
  assert.equal(owner.getState().phase,'retired');assert.equal(owner.getState().filename,'');assert.equal(fixture.transport.peekGeneration(),null);owner.dispose();
});

test('explicit capability Retry recovers network and transient server failure without enabling upload early',async()=>{
  const [,{createPreviewController}]=await modules();
  for(const failure of [()=>Promise.reject(new TypeError('network')),()=>Promise.resolve(response({protocol:'foobar_preview_v1',error:'preview_unavailable'},503))]) {
    let calls=0;
    const owner=createPreviewController({transport:transportFixture().transport,fetch:(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.headers['X-AlbumHaven-Context'],STAMP);return ++calls===1?failure():Promise.resolve(response(capability('available')));},allows:()=>true,isCurrent:()=>true,onChange(){}});
    await owner.initialize();assert.equal(owner.getState().phase,'capability-error');assert.equal(owner.getState().available,false);assert.equal(calls,1);
    await owner.retryCapabilities();assert.equal(calls,2);assert.equal(owner.getState().phase,'empty');assert.equal(owner.getState().available,true);
    await owner.retryCapabilities();assert.equal(calls,2);owner.dispose();
  }
});

test('capability Retry suppresses duplicate clicks synchronously while checking',async()=>{
  const [,{createPreviewController}]=await modules();let calls=0,finish;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:()=>++calls===1?Promise.reject(new TypeError('network')):new Promise(resolve=>{finish=resolve;}),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();const pending=owner.retryCapabilities();assert.equal(owner.getState().phase,'checking');
  await owner.retryCapabilities();await owner.initialize();assert.equal(calls,2);assert.equal(owner.getState().available,false);
  finish(response(capability('available')));await pending;assert.equal(owner.getState().available,true);owner.dispose();
});

test('capability denials, unavailable capacity and lost permission never offer a retry bypass',async()=>{
  const [,{createPreviewController}]=await modules();
  for(const result of [()=>new Response('Denied',{status:401}),()=>new Response('Denied',{status:403}),()=>response(capability('unavailable')),()=>response({protocol:'foobar_preview_v1',error:'preview_capacity_unavailable'},503)]) {
    let calls=0;
    const owner=createPreviewController({transport:transportFixture().transport,fetch:async()=>{calls++;return result();},allows:()=>true,isCurrent:()=>true,onChange(){}});
    await owner.initialize();await owner.retryCapabilities();assert.equal(calls,1);assert.equal(owner.getState().available,false);owner.dispose();
  }
  let allowed=true,calls=0;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:async()=>{calls++;throw new TypeError('network');},allows:()=>allowed,isCurrent:()=>true,onChange(){}});
  await owner.initialize();allowed=false;await owner.retryCapabilities();assert.equal(calls,1);assert.equal(owner.getState().phase,'denied');owner.dispose();
});

test('context changes before or during capability Retry retire its late success',async()=>{
  const [,{createPreviewController}]=await modules();
  for(const during of [false,true]) {
    const fixture=transportFixture();let calls=0,finish,signal;
    const owner=createPreviewController({transport:fixture.transport,fetch:(url,init)=>++calls===1?Promise.reject(new TypeError('network')):new Promise(resolve=>{finish=resolve;signal=init.signal;}),allows:()=>true,isCurrent:()=>true,onChange(){}});
    await owner.initialize();const pending=during?owner.retryCapabilities():null;
    fixture.setContext('e'.repeat(64));await owner.retryCapabilities();assert.equal(calls,during?2:1);
    if(during){assert.equal(signal.aborted,true);finish(response(capability('available')));await pending;}
    assert.equal(owner.getState().phase,'retired');assert.equal(owner.getState().available,false);assert.equal(owner.getState().filename,'');owner.dispose();
  }
});

test('disposing during capability Retry aborts and discards its late response',async()=>{
  const [,{createPreviewController}]=await modules();let calls=0,finish,signal,publications=0;
  const owner=createPreviewController({transport:transportFixture().transport,fetch:(url,init)=>++calls===1?Promise.reject(new TypeError('network')):new Promise(resolve=>{finish=resolve;signal=init.signal;}),allows:()=>true,isCurrent:()=>true,onChange(){publications++;}});
  await owner.initialize();const pending=owner.retryCapabilities();owner.dispose();const before=publications;
  await owner.retryCapabilities();assert.equal(calls,2);assert.equal(signal.aborted,true);finish(response(capability('available')));await pending;
  assert.equal(publications,before);assert.equal(owner.getState().phase,'disposed');assert.equal(owner.getState().available,false);
});

test('401 or 403 during capability Retry retires membership and forbids another GET',async()=>{
  const [,{createPreviewController}]=await modules();
  for(const status of [401,403]) {
    const fixture=transportFixture();let calls=0;
    const owner=createPreviewController({transport:fixture.transport,fetch:async()=>{if(++calls===1)throw new TypeError('network');return new Response('Denied',{status});},allows:()=>true,isCurrent:()=>true,onChange(){}});
    await owner.initialize();await owner.retryCapabilities();await owner.retryCapabilities();
    assert.equal(calls,2);assert.equal(owner.getState().phase,'retired');assert.equal(owner.getState().available,false);assert.equal(fixture.transport.peekGeneration(),null);owner.dispose();
  }
});

test('mid-body capability transport interruption enables one explicit Retry and recovery',async()=>{
  const [,{createPreviewController}]=await modules();let calls=0,pulls=0;
  const interrupted=()=>new Response(new ReadableStream({pull(controller){if(pulls++===0)controller.enqueue(new TextEncoder().encode('{"protocol":'));else controller.error(new TypeError('connection lost'));}}),{headers:{'Content-Type':'application/json'}});
  const owner=createPreviewController({transport:transportFixture().transport,fetch:async()=>++calls===1?interrupted():response(capability('available')),allows:()=>true,isCurrent:()=>true,onChange(){}});
  await owner.initialize();assert.equal(pulls,2);assert.equal(calls,1);assert.equal(owner.getState().phase,'capability-error');assert.equal(owner.getState().available,false);
  await owner.retryCapabilities();assert.equal(calls,2);assert.equal(owner.getState().phase,'empty');assert.equal(owner.getState().available,true);owner.dispose();
});

test('malformed UTF-8, JSON, schema and oversized capability bodies remain nonretryable',async()=>{
  const [,{createPreviewController}]=await modules();
  for(const bad of [()=>new Response(new Uint8Array([0xc3,0x28]),{headers:{'Content-Type':'application/json'}}),()=>new Response('{bad-json',{headers:{'Content-Type':'application/json'}}),()=>response({...capability('available'),extra:true}),()=>response({padding:'x'.repeat(262145)})]) {
    let calls=0;
    const owner=createPreviewController({transport:transportFixture().transport,fetch:async()=>{calls++;return bad();},allows:()=>true,isCurrent:()=>true,onChange(){}});
    await owner.initialize();assert.equal(owner.getState().phase,'error');assert.equal(owner.getState().available,false);
    await owner.retryCapabilities();assert.equal(calls,1);owner.dispose();
  }
});

test('late body transport failure after disposal or context change cannot enable Retry',async()=>{
  const [,{createPreviewController}]=await modules();
  for(const changeContext of [false,true]) {
    const fixture=transportFixture();let failStream,entered,calls=0,publications=0;
    const reading=new Promise(resolve=>{entered=resolve;});
    const owner=createPreviewController({transport:fixture.transport,fetch:async()=>{calls++;return new Response(new ReadableStream({pull(controller){failStream=()=>controller.error(new TypeError('late connection loss'));entered();}}),{headers:{'Content-Type':'application/json'}});},allows:()=>true,isCurrent:()=>true,onChange(){publications++;}});
    const pending=owner.initialize();await reading;
    if(changeContext)fixture.setContext('e'.repeat(64));else owner.dispose();
    const before=publications;failStream();await pending;await owner.retryCapabilities();
    assert.equal(calls,1);assert.equal(publications,before);assert.equal(owner.getState().phase,changeContext?'retired':'disposed');assert.equal(owner.getState().available,false);owner.dispose();
  }
});
