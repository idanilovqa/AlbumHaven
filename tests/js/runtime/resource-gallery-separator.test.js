'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture}=require('./home-friends-native-app-fixture.cjs');
const root=path.resolve(process.env.ALBUM_TOP_TEST_ROOT||path.join(__dirname,'../../..'));
const source=fs.readFileSync(path.join(root,'music_app/static/js/runtime/virtual-artist-grid.js'),'utf8');
const album=(key,kind)=>({key,...(kind===undefined?{}:{kind}),value:{title:key}});
const separator=(key='s')=>({key,kind:'separator',value:{artist:'Actual Artist',albumCount:2}});
function setup(t,{withSeparator=true}={}){
  const h=fixture(t),c=h.c;
  for(const id of ['albums-scroll','artist-groups','albums-spacer-top','albums-spacer-bottom'])h.add(id);
  vm.runInContext(source,c,{filename:'runtime/virtual-artist-grid.js'});
  // Whole-file boot creates its idle Artist singleton; release that actual owner before the tested host baseline.
  h.owner('virtualGrid').destroy();const Host=vm.runInContext('ResourceGalleryHost',c);
  const host=h.document.createElement('section');host.clientWidth=980;h.host.append(host);
  let snapshot={scopeKey:'actual-session',resourceKey:'resource',displayMode:'cards',layoutConfig:{cardMinWidth:240},galleryScalePercent:100},valid=true;
  let separatorHook=null;const records=[],actions=[],measurements=[],geometry=c.resolveGalleryColumnGeometry;
  c.resolveGalleryColumnGeometry=function(options){measurements.push({...options});return geometry(options);};
  const render=(row,snap)=>{const element=h.document.createElement('article'),record={key:row.key,element,disposed:0,updates:[],hook:null};
    if(row.kind==='separator'){const holder=h.document.createElement('div');holder.innerHTML=c.buildFamilyArtistHeaderHtml(row.value);element.append(holder.firstElementChild);}
    else{const button=h.document.createElement('button');button.setAttribute('data-gallery-card-intent','details');button.textContent=row.value.title;element.append(button);}
    record.update=(next,nextSnapshot)=>{record.updates.push({row:next,snapshot:nextSnapshot});record.hook?.(next,nextSnapshot);};record.dispose=()=>{record.disposed++;};records.push(record);return record;};
  const options={host,readSnapshot:()=>snapshot,isCurrent:()=>valid,renderCard:render,onAction:(...args)=>actions.push(args),...(withSeparator?{renderSeparator:(row,snapshot)=>{const owner=render(row,snapshot);separatorHook?.(row,snapshot);return owner;}}:{})};
  const baseline=h.listeners(),observerStart=h.observers.length;const owner=h.own(new Host(options));
  return {...h,host,Host,owner,options,records,actions,measurements,baseline,observerStart,
    setSeparatorHook(value){separatorHook=value;},setSnapshot(value){snapshot=value;},snapshot:()=>snapshot,retire(){valid=false;},render,
    click(node){node.dispatchEvent(new c.Event('click',{bubbles:true}));},record:key=>records.find(record=>record.key===key)};
}

test('mixed flat keys preserve exact nodes focus order and native Artist header markup',t=>{
  const h=setup(t),rows=[separator(),album('a'),separator('s2'),album('b','album')];assert.equal(h.owner.update(rows),true);const nodes=[...h.owner.root.children];
  const header=nodes[0].querySelector('.family-artist-header');assert.ok(header);assert.equal(header.getAttribute('data-scroll-artist'),'Actual Artist');assert.equal(header.querySelector('.artist-name').textContent,'Actual Artist');
  const button=nodes[1].querySelector('button');button.focus();assert.equal(h.owner.update(rows),true);assert.deepEqual([...h.owner.root.children],nodes);assert.equal(h.document.activeElement,button);
  assert.equal(h.owner.update([rows[2],rows[3],rows[0],rows[1]]),true);assert.deepEqual([...h.owner.root.children],[nodes[2],nodes[3],nodes[0],nodes[1]]);assert.equal(h.document.activeElement,button);
  assert.equal(h.records.length,4);assert.equal(h.records.every(record=>record.disposed===0),true);
});

test('separator spans the shared grid without applying that span to album cards',t=>{
  const h=setup(t);h.owner.update([separator(),album('a')]);assert.equal(String(h.record('s').element.style.gridColumn).replace(/\s/g,''),'1/-1');assert.notEqual(String(h.record('a').element.style.gridColumn).replace(/\s/g,''),'1/-1');
});

for(const count of [0,1,8])test('native geometry counts albums only with '+count+' separators',t=>{
  const h=setup(t),rows=[];for(let i=0;i<count;i++)rows.push(separator('s'+i));rows.push(album('a'),album('b'));h.owner.update(rows);h.drain();
  assert.ok(h.measurements.length);assert.equal(h.measurements.every(value=>value.itemCount===2),true);
  const before=h.owner.root.style.gridTemplateColumns;h.owner.update([album('a'),album('b')]);h.drain();assert.equal(h.owner.root.style.gridTemplateColumns,before);
});

for(const rows of [[],[separator()],[separator(),separator('s2')]])test('empty and separator-only collections use zero-album geometry safely '+rows.length,t=>{
  const h=setup(t);assert.equal(h.owner.update(rows),true);h.drain();assert.equal(h.measurements.every(value=>value.itemCount===0),true);assert.equal(h.owner.root.children.length,rows.length);
});

test('separator descendants resembling card actions never dispatch while actual album action remains exact',t=>{
  const h=setup(t),s=separator(),a=album('a');h.owner.update([s,a]);const fake=h.record('s').element.querySelector('button');fake.setAttribute('data-gallery-card-intent','details');h.click(fake);assert.deepEqual(h.actions,[]);
  h.click(h.record('a').element.querySelector('button'));assert.equal(h.actions.length,1);assert.equal(h.actions[0][0],a);assert.equal(h.actions[0][2],h.snapshot());
});

for(const [name,rows]of [['unknown',[{...album('bad'),kind:'header'}]],['null-kind',[{...album('bad'),kind:null}]],['undefined-kind',[{...album('bad'),kind:undefined}]],['duplicate',[separator('x'),album('x')]],['sparse',[separator(),,album('b')]],['retained-change',[separator('a')]]])test('invalid kind/key vector rejects before reconciliation '+name,t=>{
  const h=setup(t);h.owner.update([album('a')]);const record=h.record('a'),before=[...h.owner.root.children],button=record.element.querySelector('button');button.focus();
  assert.throws(()=>h.owner.update(rows),error=>error?.name==='TypeError');assert.deepEqual([...h.owner.root.children],before);assert.equal(record.disposed,0);assert.equal(h.document.activeElement,button);h.click(button);assert.equal(h.actions.length,1);
});

test('missing separator renderer rejects before removing existing album owners',t=>{
  const h=setup(t,{withSeparator:false});h.owner.update([album('a')]);const record=h.record('a');assert.throws(()=>h.owner.update([separator()]),error=>error?.name==='TypeError');assert.equal(record.disposed,0);assert.equal(record.element.parentNode,h.owner.root);
});

test('normalized omitted and explicit album kind keep the same retained owner',t=>{
  const h=setup(t);h.owner.update([album('a')]);const record=h.record('a');h.owner.update([album('a','album')]);assert.equal(h.record('a'),record);assert.equal(h.records.length,1);assert.equal(record.disposed,0);
});

test('separator removal disposes once and whole-host disposal closes frames observers and listeners',t=>{
  const h=setup(t);h.owner.update([separator(),album('a')]);const s=h.record('s');h.owner.update([album('a')]);assert.equal(s.disposed,1);h.owner.dispose();h.owner.dispose();
  assert.equal(s.disposed,1);assert.equal(h.record('a').disposed,1);assert.equal(h.frames.size,0);assert.equal(h.observers.slice(h.observerStart).every(observer=>!observer.connected),true);assert.deepEqual(h.listeners(),h.baseline);
});

for(const phase of ['render','update'])test('separator '+phase+' reentry cannot overwrite a newer host',t=>{
  const h=setup(t);let next,triggered=false;const replace=()=>{if(triggered)return;triggered=true;next=h.own(new h.Host(h.options));next.update([album('winner')]);};
  if(phase==='render'){h.setSeparatorHook(replace);}
  else{h.owner.update([separator()]);h.record('s').hook=replace;}
  assert.equal(h.owner.update([separator()]),false);assert.ok(next);assert.equal(h.record('s').disposed,1);assert.equal(next.root.parentNode,h.host);assert.equal(next.root.children[0],h.record('winner').element);
  h.owner.dispose();assert.equal(next.root.parentNode,h.host);h.click(h.record('winner').element.querySelector('button'));assert.equal(h.actions.length,1);
});

test('stale queued geometry callbacks cannot remove or measure a replacement host',t=>{
  const h=setup(t);h.owner.update([separator(),album('a')]);const queued=[...h.frames.values()];const next=h.own(new h.Host(h.options));next.update([separator('new'),album('winner')]);const before=h.measurements.length;
  for(const callback of queued)callback();assert.equal(next.root.parentNode,h.host);assert.equal(h.measurements.length,before);assert.equal(h.record('s').disposed,1);assert.equal(h.record('new').disposed,0);
});

test('retired snapshot disposes mixed owners and suppresses separator and album actions',t=>{
  const h=setup(t);h.owner.update([separator(),album('a')]);h.retire();h.click(h.record('a').element.querySelector('button'));assert.deepEqual(h.actions,[]);assert.equal(h.record('s').disposed,1);assert.equal(h.record('a').disposed,1);assert.equal(h.owner.root.parentNode,null);
});

test('a key removed by a committed update may return with a new kind and a fresh owner',t=>{
  const h=setup(t);h.owner.update([album('reused')]);const previous=h.record('reused');assert.equal(h.owner.update([]),true);assert.equal(previous.disposed,1);
  assert.equal(h.owner.update([separator('reused')]),true);const next=h.records.filter(row=>row.key==='reused')[1];assert.ok(next);assert.notEqual(next.element,previous.element);assert.equal(next.element.parentNode,h.owner.root);assert.ok(next.element.querySelector('.family-artist-header'));
});

test('separator update that replaces the host and throws cannot dispose the committed successor',t=>{
  const h=setup(t),failure=new Error('retired separator update');h.owner.update([separator()]);let next;
  h.record('s').hook=()=>{next=h.own(new h.Host(h.options));next.update([album('winner')]);throw failure;};
  assert.throws(()=>h.owner.update([separator()]),error=>error===failure);assert.equal(next.root.parentNode,h.host);assert.equal(h.record('winner').disposed,0);h.owner.dispose();assert.equal(next.root.parentNode,h.host);
});
