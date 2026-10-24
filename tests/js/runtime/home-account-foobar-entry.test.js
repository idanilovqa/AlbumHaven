'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const F=require('./foobar-account-import-fixture.cjs');
const M=require('./foobar-maintenance-fixture.cjs');
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
let serial=0;
async function page(t,{allowed=true,scope=F.SCOPE}={}) {
  const env=createNativeHomeRuntime(),{document,context:c}=env,proto=c.Element.prototype;
  const time=F.clock(),wire=F.wire(),observers=[],events=[],intervals=new Map();let next=0;
  document.defaultView=c;c.Headers=Headers;c.location={href:'https://albumhaven.invalid/account/integrations/foobar',origin:'https://albumhaven.invalid'};
  c.setTimeout=(...args)=>globalThis.setTimeout(...args);c.clearTimeout=(...args)=>globalThis.clearTimeout(...args);
  c.setInterval=callback=>{const id=++next;intervals.set(id,callback);return id;};c.clearInterval=id=>intervals.delete(id);
  c.addEventListener=(type,callback)=>events.push({type,callback});
  c.removeEventListener=(type,callback)=>{const n=events.findIndex(x=>x.type===type&&x.callback===callback);if(n>=0)events.splice(n,1);};
  c.dispatchEvent=event=>{for(const row of [...events])if(row.type===event.type&&events.includes(row))row.callback(event);};
  c.MutationObserver=class{constructor(callback){this.callback=callback;this.active=false;this.targets=[];observers.push(this);}observe(target){this.active=true;this.targets.push(target);}disconnect(){this.active=false;}};
  proto.focus=function(){if(this.isConnected&&!this.disabled&&!this.closest('[hidden],[inert]'))document.activeElement=this;};
  for(const key of ['value','type'])Object.defineProperty(proto,key,{configurable:true,get(){return this['_'+key]||'';},set(value){this['_'+key]=String(value);}});
  const queryAll=proto.querySelectorAll;
  proto.querySelectorAll=function(selector){if(!selector.includes('>'))return queryAll.call(this,selector);const match=/^(\.[a-zA-Z_][\w-]*)\s*>\s*(\[role="row"\])$/.exec(selector);if(!match)throw Error('Unsupported platform selector: '+selector);return queryAll.call(this,match[2]).filter(n=>n.parentElement?.matches(match[1]));};
  proto.querySelector=function(selector){return this.querySelectorAll(selector)[0]||null;};
  const root=document.createElement('main');root.id='account-foobar';Object.assign(root.dataset,{accountFoobarContext:F.STAMP,accountFoobarScope:scope,accountFoobarAllowed:String(allowed),accountFoobarMatchingLibraryId:''});document.body.append(root);
  const host=document.createElement('section');host.setAttribute('data-foobar-import-host','');root.append(host);
  c.fetch=(...args)=>wire.fetch(...args);document.cookie='__Host-album_haven_csrf=synthetic-home-account-csrf';
  for(const name of ['compact-data-table.js','session-csrf-fetch.js'])F.vm.runInContext(F.read('music_app/static/js/runtime/'+name),c,{filename:name});
  const keys=['document','window','MutationObserver'],saved=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]),baseline=env.listeners();
  Object.assign(globalThis,{document,window:c,MutationObserver:c.MutationObserver});
  const close=()=>c.dispatchEvent(new c.Event('pagehide'));
  t.after(async()=>{try{close();await F.settle();assert.equal(intervals.size,0);assert.equal(events.length,0);assert.equal(time.tasks.size,0);assert.ok(observers.every(o=>!o.active));assert.deepEqual(env.listeners(),baseline);assert.equal(env.forbiddenCalls.length,0);}finally{time.restore();for(const [key,desc]of saved){if(desc)Object.defineProperty(globalThis,key,desc);else delete globalThis[key];}}});
  if(allowed&&scope===F.SCOPE)wire.enqueue('/ui/source',F.source());
  const url=pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/foobar-import/account-entry.mjs'));url.searchParams.set('home-account-case',String(++serial));
  await import(url.href);await F.settle();
  return {...env,c,root,host,wire,close,controls:()=>M.controls(host),click:node=>node.dispatchEvent(new c.Event('click')),mutate:target=>{for(const o of [...observers])if(o.active&&o.targets.includes(target))o.callback([{type:'attributes',target}]);}};
}
test('HA01 actual Home account Settings entry mounts genuine importer maintenance and no eager cleanup',async t=>{
  const f=await page(t);assert.ok(f.host.querySelector('.foobar-import'));assert.equal(f.controls().start.disabled,false);assert.deepEqual(f.wire.calls.map(x=>x.route),['/job/list','/ui/source']);
});
test('HA02 actual Home account Settings denies missing write capability before any network',async t=>{
  const f=await page(t,{allowed:false});assert.equal(f.wire.calls.length,0);assert.equal(f.host.querySelector('.foobar-import'),null);assert.match(f.host.textContent,/unavailable/);
});
test('HA03 actual Home account Settings denies foreign scope before any network',async t=>{
  const f=await page(t,{scope:'foreign'});assert.equal(f.wire.calls.length,0);assert.equal(f.host.querySelector('.foobar-import'),null);
});
test('HA04 actual Home account Settings maintenance uses genuine session CSRF and current source',async t=>{
  const f=await page(t);f.wire.enqueue('/maintenance',M.payload());f.click(f.controls().start);await F.settle();const call=M.calls(f)[0];assert.ok(call);
  assert.deepEqual(JSON.parse(call.init.body),{version:M.VERSION,source_ref:F.SOURCE,cursor:null});assert.equal(new Headers(call.init.headers).get('X-Album-Haven-CSRF'),'synthetic-home-account-csrf');assert.equal(new Headers(call.init.headers).get('X-AlbumHaven-Foobar-Context'),F.STAMP);
});
test('HA05 actual Home account Settings pagehide aborts pending cleanup and fences delayed result',async t=>{
  const f=await page(t),pending=F.deferred();f.wire.enqueue('/maintenance',()=>pending.promise);f.click(f.controls().start);await F.settle();f.close();assert.equal(M.calls(f)[0].init.signal.aborted,true);
  pending.resolve(F.response(M.payload()));await F.settle();assert.match(f.host.textContent,/closed/);assert.doesNotMatch(f.host.textContent,/This pass inspected/);
});
test('HA06 actual Home account Settings account marker change retires current importer and cleanup',async t=>{
  const f=await page(t),button=f.controls().start;f.root.dataset.accountFoobarContext='b'.repeat(64);f.mutate(f.root);f.click(button);await F.settle();assert.equal(M.calls(f).length,0);assert.match(f.host.textContent,/closed/);
});
test('HA07 actual Home account Settings write-grant withdrawal retires before detached actions',async t=>{
  const f=await page(t),button=f.controls().start;f.root.dataset.accountFoobarAllowed='false';f.mutate(f.root);f.click(button);await F.settle();assert.equal(M.calls(f).length,0);assert.equal(button.isConnected,false);
});
test('HA08 actual Home account Settings removed root cannot dispatch cleanup without observer delivery',async t=>{
  const f=await page(t),button=f.controls().start;f.root.remove();f.click(button);await F.settle();assert.equal(M.calls(f).length,0);
});
