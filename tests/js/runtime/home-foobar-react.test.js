'use strict';
// Authored, UNRUN. Actual React host + provider/controller/panel, bounded hook/DOM
// and pending transport doubles only. No browser reconciliation or live reads.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const React=require('react'),{buildSync}=require('esbuild');
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
const {viewFixture,elements,find}=require('./home-foobar-react-app-fixture.cjs');
const root=path.resolve(__dirname,'../../..');
const allowed=()=>({isConnected:true,dataset:{accountFoobarContext:'a'.repeat(64),accountFoobarScope:'account-foobar-v1',accountFoobarHistoryAllowed:'true'}});
function compile(react=React,globals={}){
 const code=buildSync({entryPoints:[path.join(root,'music_app/static/js/home-friends/foobar-history.jsx')],bundle:true,
  platform:'node',format:'cjs',write:false,external:['react','react-dom']}).outputFiles[0].text;
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,AbortController,TextDecoder,TextEncoder,Uint8Array,URL,console,
  require:n=>n==='react'?react:require(n),...globals});return module.exports;
}
function hostFixture(t){
 const env=createNativeHomeRuntime(),{document,context:window}=env,slots=[],observers=[],requests=[];
 document.defaultView=window;document.scrollingElement=document.documentElement;
 window.addEventListener=()=>{};window.removeEventListener=()=>{};window.getComputedStyle=()=>({overflowY:'visible'});
 window.MutationObserver=class{constructor(callback){this.callback=callback;this.active=false;observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}};
 window.fetch=(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}));
 const account=document.createElement('div');account.id='app-shell';Object.assign(account.dataset,allowed().dataset);document.body.append(account);
 const node=document.createElement('div');document.body.append(node);let cursor=0,effects=[],tree;
 const shell={authenticated:true,visible:true,scopeKey:'own:library',entryKey:'entry:one',section:'recent'};
 const runtime={snapshot:()=>shell,buttonHtml:value=>window.ButtonComponent.renderButton(value)};
 const hooks={...React,useRef(value){return slots[cursor++]||={current:value};},
  useState(value){const i=cursor++;slots[i]||={value};return [slots[i].value,value=>{slots[i].value=value;}];},
  useLayoutEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:effect()};});}};
 const module=compile(hooks,{document});
 const render=()=>{cursor=0;effects=[];tree=module.FoobarHistory({runtime,shell,scopeKey:shell.scopeKey});
  const element=elements(tree).find(e=>e.props['data-home-foobar-history']);if(element)element.props.ref.current=node;
  for(const effect of effects)effect();return tree;};
 const dispose=()=>{for(const slot of slots)slot?.cleanup?.();};t.after(dispose);
 return {render,dispose,account,node,shell,runtime,requests,observers,module,window};
}
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('Home Foobar React source tab is own-authorized and leaves Recent and Queue owners intact',()=>{
 const f=viewFixture({authenticated:true,accountRoot:allowed()});let tree=f.render();
 const tabs=find(tree,e=>e.props.id==='home-recent-sections');assert.deepEqual(JSON.parse(JSON.stringify(tabs.props.items.map(x=>x[0]))),['recent','news','queue','foobar']);
 tabs.props.onChange('foobar');tree=f.render();assert.ok(find(tree,e=>e.type?.name==='FoobarHistory'));
 assert.equal(find(tree,e=>e.type?.name==='ActivityPanel'),undefined);assert.equal(find(tree,e=>e.props.id==='home-selected-sections'),undefined);
 find(tree,e=>e.props.id==='home-recent-sections').props.onChange('queue');tree=f.render();assert.ok(find(tree,e=>e.type?.name==='QueuePanel'));
 find(tree,e=>e.props.id==='home-recent-sections').props.onChange('recent');tree=f.render();assert.ok(find(tree,e=>e.type?.name==='RecentAlbums'));f.dispose();
});
test('Home Foobar React source is absent for unauthenticated missing-marker and denied readers',()=>{
 for(const accountRoot of [null,{...allowed(),dataset:{...allowed().dataset,accountFoobarHistoryAllowed:'false'}},
  {...allowed(),dataset:{...allowed().dataset,accountFoobarContext:''}}]){
  const f=viewFixture({authenticated:true,accountRoot});assert.equal(find(f.render(),e=>e.props.id==='home-recent-sections').props.items.some(x=>x[0]==='foobar'),false);f.dispose();}
 const f=viewFixture({authenticated:false,accountRoot:allowed()});assert.equal(find(f.render(),e=>e.props.id==='home-recent-sections').props.items.some(x=>x[0]==='foobar'),false);f.dispose();
});
test('Home Foobar React host mounts genuine account source read only with no native action grants',async t=>{
 const f=hostFixture(t);f.render();await settle();assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/\/history\/sources$/);
 assert.match(f.node.textContent,/Last.fm and Album Haven listening stay separate/);assert.doesNotMatch(f.node.textContent,/Check and play/);
 assert.equal(f.requests[0].options.method,'POST');assert.equal(f.requests[0].options.headers['X-AlbumHaven-Context'],undefined);
});
test('Home Foobar React host cleanup aborts pending read clears owned DOM and rejects late response',async t=>{
 const f=hostFixture(t);f.render();await settle();const pending=f.requests[0];f.dispose();assert.equal(pending.options.signal.aborted,true);
 assert.equal(f.node.childNodes.length,0);assert.ok(f.observers.every(x=>!x.active));pending.resolve({ok:true,status:200});await settle();assert.equal(f.node.childNodes.length,0);
});
test('Home Foobar React marker revocation retires genuine provider and removes retained history',async t=>{
 const f=hostFixture(t);f.render();await settle();f.account.dataset.accountFoobarHistoryAllowed='false';
 for(const observer of f.observers)observer.callback([{type:'attributes'}]);await settle();assert.equal(f.requests[0].options.signal.aborted,true);
 assert.equal(f.render(),null);assert.doesNotMatch(f.node.textContent,/Source title/);
});
test('Home Foobar React navigation scope replacement disposes old owner before a new explicit mount',async t=>{
 const f=hostFixture(t);f.render();await settle();const first=f.requests[0];f.shell.scopeKey='own:new-library';f.shell.entryKey='entry:two';f.render();await settle();
 assert.equal(first.options.signal.aborted,true);assert.equal(f.requests.length,2);assert.equal(f.requests[1].options.signal.aborted,false);
 f.shell.section='friends';assert.equal(f.render(),null);assert.equal(f.requests[1].options.signal.aborted,true);
});

test('Home Foobar React genuine empty source reply stays explicit without creating imports or sending plays',async t=>{
 const f=hostFixture(t);f.render();await settle();
 f.requests[0].resolve(new Response(JSON.stringify({protocol:'foobar_account_history_v1',operation:'sources',context_ref:'a'.repeat(64),
  context_scope:'account-foobar-v1',result:{items:[],next_cursor:null}}),{status:200,headers:{'Content-Type':'application/json'}}));
 await settle();await new Promise(resolve=>setImmediate(resolve));await settle();
 assert.match(f.node.textContent,/No imported Foobar sources are available/);assert.match(f.node.textContent,/does not create a source/);
 assert.equal(f.requests.length,1);assert.doesNotMatch(f.node.textContent,/Send|accepted scrobble/);
});
