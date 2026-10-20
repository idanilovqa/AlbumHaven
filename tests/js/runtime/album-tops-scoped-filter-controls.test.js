'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('./home-friends-native-app-fixture.cjs'),F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let create,mount;test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));({mountScopedCreationFilterControls:mount}=await F.load('album-tops/scoped-filter-controls.mjs'));});
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const meta=(release_type=null,rating=null,rating_state='available')=>({release_type,rating,rating_state,artwork_url:null});
const rows=()=>[F.album(11,{year:2001,creation_metadata:meta('ep',7)}),F.album(12,{year:1999,creation_metadata:meta('single',null)}),F.album(13,{year:null,creation_metadata:meta(null,null,'unavailable')})];
const selected=d=>d.getSnapshot().items.map(row=>row.album_ref),filters=d=>d.getSnapshot().artistFilters;
async function setup(t,options={}){
  const h=N.fixture(t),controller=F.controllerFixture(),provider=F.providerFixture();let population=options.rows||rows();
  provider.providers.listScopedAlbums=async()=>({albums:population,next_cursor:null});
  const draft=create({controller:controller.controller,providers:provider.providers,...(options.ordinary?{}:{artistScope:{root_artist_id:'3',mode:'artist'}})});
  t.after(()=>draft.dispose());await tick();let current=true;const validity=[],host=h.document.createElement('section');h.host.append(host);
  const props={draft,isCurrent:()=>current,onValidityChange:value=>{validity.push(value);options.onValidity?.(value);}};
  const owner=options.noMount?null:h.own(mount(host,h.runtime,props));
  return {...h,...controller,nativeListeners:h.listeners,host,draft,owner,props,validity,providers:provider.providers,setCurrent(value){current=value;},setRows(value){population=value;},
    field(label){const node=host.querySelector(`input[aria-label="${label}"]`);assert.ok(node,label);return node;},
    button(label){const found=[...host.querySelectorAll('button')].find(node=>{const text=node.getAttribute('aria-label')||node.textContent.trim();return text===label||text.startsWith(label+': ');});assert.ok(found,label);return found;},
    enter(label,value,badInput=false){const node=this.field(label);Object.defineProperty(node,'validity',{configurable:true,value:{badInput}});h.input(node,value);},
    choose(label,item){h.click(this.button(label));h.drain();const menu=h.document.querySelector('[role="menu"]');assert.ok(menu,label+' native menu');const row=[...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].find(node=>node.textContent.trim()===item);assert.ok(row,item);h.click(row);h.drain();return row;}};
}

test('actual scoped draft starts unrestricted with four shared numeric fields and no validity notification',async t=>{
  const h=await setup(t);assert.deepEqual(selected(h.draft),[F.A,F.B,F.C]);assert.equal(h.owner.isValid(),true);assert.deepEqual(h.validity,[]);
  for(const [label,max]of [['Year from',9999],['Year to',9999],['Rating from',10],['Rating to',10]]){const node=h.field(label);assert.equal(node.value,'');assert.equal(node.getAttribute('type'),'number');assert.ok(node.classList.contains('ui-numeric-input'));assert.equal(node.getAttribute('min'),'1');assert.equal(node.getAttribute('max'),String(max));assert.equal(node.getAttribute('step'),'1');}
  h.button('Release types');h.button('Include rated albums');
});
for(const [label,key,value]of [['Year from','minYear','1'],['Year to','maxYear','9999'],['Rating from','minRating','1'],['Rating to','maxRating','10']])test('valid native numeric endpoint commits then blank removes '+label,async t=>{
  const h=await setup(t);h.enter(label,value);assert.equal(filters(h.draft)[key],Number(value));assert.equal(h.owner.isValid(),true);h.enter(label,'');assert.equal(filters(h.draft)[key],null);assert.deepEqual(selected(h.draft),[F.A,F.B,F.C]);
});
for(const [label,value]of [['Year from','0'],['Year to','10000'],['Rating from','0'],['Rating to','11'],['Year from','1.5'],['Year from','-1'],['Year from','+1'],['Year from','1e3'],['Year from',' 1'],['Year from','1 '],['Rating from','Infinity'],['Year from','9999999999999999999999999']])test('invalid raw numeric edit is atomic '+label+' '+value,async t=>{
  const h=await setup(t),before=filters(h.draft),items=selected(h.draft);h.enter(label,value);assert.deepEqual(filters(h.draft),before);assert.deepEqual(selected(h.draft),items);assert.equal(h.owner.isValid(),false);assert.deepEqual(h.validity,[false]);assert.equal(h.field(label).value,value);assert.ok(h.host.querySelector('[role="alert"]'),'existing alert presentation');
});
test('native badInput cannot be interpreted as intentional blank',async t=>{
  const h=await setup(t);h.enter('Rating from','7');const before=filters(h.draft),items=selected(h.draft);h.enter('Rating from','',true);assert.deepEqual(filters(h.draft),before);assert.deepEqual(selected(h.draft),items);assert.equal(h.owner.isValid(),false);
  h.enter('Rating from','',false);assert.equal(filters(h.draft).minRating,null);assert.equal(h.owner.isValid(),true);assert.deepEqual(h.validity,[false,true]);
});
for(const [low,high,first,second]of [['Year from','Year to','2002','2001'],['Rating from','Rating to','8','7']])test('inverted complete numeric vector rejects '+low,async t=>{
  const h=await setup(t);h.enter(low,first);const before=filters(h.draft),items=selected(h.draft);h.enter(high,second);assert.deepEqual(filters(h.draft),before);assert.deepEqual(selected(h.draft),items);assert.equal(h.owner.isValid(),false);h.enter(high,first);assert.equal(h.owner.isValid(),true);
});
test('invalid raw text and focused node survive unrelated actual draft notifications',async t=>{
  const h=await setup(t),node=h.field('Year from');node.focus();h.enter('Year from','-');h.draft.edit({title:'New title'});h.owner.update();assert.equal(h.field('Year from'),node);assert.equal(node.value,'-');assert.equal(h.document.activeElement,node);assert.equal(h.owner.isValid(),false);assert.deepEqual(h.validity,[false]);
});
test('external authoritative numeric change clears old invalid editing and retains node focus',async t=>{
  const h=await setup(t),node=h.field('Year from');node.focus();h.enter('Year from','-');assert.equal(h.draft.setArtistFilters({minYear:1999}),true);assert.equal(node.value,'1999');assert.equal(h.owner.isValid(),true);assert.equal(h.document.activeElement,node);assert.deepEqual(h.validity,[false,true]);
});
test('no-op update retains every numeric node and avoids duplicate validity publication',async t=>{
  const h=await setup(t),nodes=[...h.host.querySelectorAll('input')];nodes[0].focus();h.owner.update();h.draft.edit({description:'Description'});assert.deepEqual([...h.host.querySelectorAll('input')],nodes);assert.equal(h.document.activeElement,nodes[0]);assert.deepEqual(h.validity,[]);
});
test('release checkbox toggles preserve null versus six-known versus empty semantics',async t=>{
  const h=await setup(t);h.choose('Release types','EP');assert.deepEqual(filters(h.draft).releaseTypes,['studio','live','demo','compilation','single']);assert.deepEqual(selected(h.draft),[F.B]);
  h.choose('Release types','EP');assert.deepEqual(filters(h.draft).releaseTypes,['studio','ep','live','demo','compilation','single']);assert.deepEqual(selected(h.draft),[F.A,F.B]);
  for(const label of ['Studio','EP','Live','Demo','Compilation','Single'])h.choose('Release types',label);assert.deepEqual(filters(h.draft).releaseTypes,[]);assert.deepEqual(selected(h.draft),[]);
  h.choose('Release types','All types');assert.equal(filters(h.draft).releaseTypes,null);assert.deepEqual(selected(h.draft),[F.A,F.B,F.C]);
});
test('include rated uses actual Yes No Choice and unknown evidence stays distinct',async t=>{
  const h=await setup(t);h.choose('Include rated albums','No');assert.equal(filters(h.draft).includeRated,false);assert.deepEqual(selected(h.draft),[F.B]);h.choose('Include rated albums','Yes');assert.equal(filters(h.draft).includeRated,true);assert.deepEqual(selected(h.draft),[F.A,F.B,F.C]);
});
test('Reset clears invalid text while preserving exclusions order and Family mode',async t=>{
  const h=await setup(t);await h.draft.setArtistFamily(true);h.draft.remove(F.B);h.draft.reorder([F.C,F.A]);h.enter('Year from','2000');h.enter('Rating to','-');h.click(h.button('Reset'));h.drain();assert.equal(h.owner.isValid(),true);assert.equal(h.field('Year from').value,'');assert.equal(h.field('Rating to').value,'');assert.deepEqual(selected(h.draft),[F.C,F.A]);assert.equal(h.draft.getSnapshot().artistScope.mode,'family');
});
for(const cause of ['busy','denied','scope'])test('actual controller '+cause+' prevents field and Reset mutations',async t=>{
  const h=await setup(t);h.enter('Year from','-');const before=filters(h.draft),snapshot=h.controller.getSnapshot();
  h.replace(cause==='busy'?{...snapshot,mutation:{status:'loading'}}:cause==='denied'?{...snapshot,directory:{status:'denied',data:null}}:{...snapshot,scopeKey:'other'});h.owner.update();
  const node=h.field('Year from');assert.equal(node.disabled,true);h.enter('Year from','2000');const reset=h.named('Reset',h.host);if(reset)h.click(reset);assert.deepEqual(filters(h.draft),before);assert.equal(h.owner.isValid(),false);
});
test('retired explicit currentness blocks a detached previously opened menu callback',async t=>{
  const h=await setup(t);h.click(h.button('Include rated albums'));h.drain();const old=[...h.document.querySelectorAll('[role="menuitemradio"]')].find(node=>node.textContent.trim()==='No');assert.ok(old);h.setCurrent(false);h.owner.update();h.click(old);assert.equal(filters(h.draft).includeRated,true);
});
test('valid host replacement retires old fields and stale methods cannot affect successor',async t=>{
  const h=await setup(t),old=h.owner,node=h.field('Year from');const next=h.own(mount(h.host,h.runtime,h.props));const replacement=h.field('Year from');assert.notEqual(replacement,node);old.dispose();old.update();h.input(node,'2000');assert.equal(filters(h.draft).minYear,null);h.enter('Year from','1999');assert.equal(filters(h.draft).minYear,1999);assert.equal(next.isValid(),true);
});
test('invalid successor dependency leaves existing fields and callbacks intact',async t=>{
  const h=await setup(t),node=h.field('Year from');assert.throws(()=>mount(h.host,h.runtime,{...h.props,isCurrent:null}),TypeError);assert.equal(h.field('Year from'),node);h.enter('Year from','2000');assert.equal(filters(h.draft).minYear,2000);
});
test('ordinary unscoped draft rejects before changing host',async t=>{
  const h=await setup(t,{ordinary:true,noMount:true});h.host.textContent='existing';assert.throws(()=>mount(h.host,h.runtime,h.props),TypeError);assert.equal(h.host.textContent,'existing');
});
test('disposal removes handlers without disposing the caller draft',async t=>{
  const h=await setup(t),node=h.field('Year from');h.owner.dispose();const calls=h.validity.length;h.input(node,'-');assert.equal(h.validity.length,calls);assert.equal(filters(h.draft).minYear,null);assert.equal(h.draft.setArtistFilters({minYear:2000}),true);
});

test('own acknowledgement keeps leading zero editing while external numeric change wins',async t=>{
  const h=await setup(t),node=h.field('Rating from');node.focus();h.enter('Rating from','0007');assert.equal(filters(h.draft).minRating,7);assert.equal(node.value,'0007');assert.deepEqual(selected(h.draft),[F.A]);assert.equal(h.document.activeElement,node);
  h.draft.setArtistFilters({minRating:8});assert.equal(node.value,'8');assert.deepEqual(selected(h.draft),[]);
});
test('reentrant draft subscriber authoritative numeric change beats own edit acknowledgement',async t=>{
  const h=await setup(t);let changed=false;const off=h.draft.subscribe(()=>{if(!changed&&filters(h.draft).minRating===7){changed=true;h.draft.setArtistFilters({minRating:8});}});t.after(off);
  h.enter('Rating from','0007');assert.equal(changed,true);assert.equal(filters(h.draft).minRating,8);assert.equal(h.field('Rating from').value,'8');assert.deepEqual(selected(h.draft),[]);
});
test('validity observer disposal prevents later callbacks and focus restoration',async t=>{
  let h;h=await setup(t,{onValidity(value){if(value===false)h.owner.dispose();}});const node=h.field('Year from'),external=h.document.createElement('button');h.document.body.append(external);external.focus();
  h.enter('Year from','-');assert.deepEqual(h.validity,[false]);h.input(node,'2000');assert.deepEqual(h.validity,[false]);assert.equal(filters(h.draft).minYear,null);assert.equal(h.document.activeElement,external);
});
test('validity observer replacement preserves successor owner and its validity',async t=>{
  let h,next;h=await setup(t,{onValidity(value){if(value===false&&!next)next=h.own(mount(h.host,h.runtime,{...h.props,onValidityChange:()=>{}}));}});const oldNode=h.field('Year from');h.enter('Year from','-');assert.ok(next);assert.notEqual(h.field('Year from'),oldNode);assert.equal(next.isValid(),true);h.owner.dispose();h.owner.update();h.enter('Year from','2000');assert.equal(filters(h.draft).minYear,2000);assert.equal(next.isValid(),true);
});
test('constructor native rendering failure releases resources and permits genuine remount',async t=>{
  const h=await setup(t,{noMount:true}),before=h.nativeListeners(),failure=new Error('native field rendering failed');const runtime={...h.runtime,buttonHtml(){throw failure;},actionHtml(){throw failure;}};
  assert.throws(()=>mount(h.host,runtime,h.props),error=>error===failure);assert.deepEqual(h.nativeListeners(),before);const next=h.own(mount(h.host,h.runtime,h.props));h.enter('Year from','2000');assert.equal(filters(h.draft).minYear,2000);assert.equal(next.isValid(),true);
});
test('validity bridge cannot approve a Create attempt with visible invalid values',async t=>{
  const h=await setup(t);h.draft.edit({title:'Actual scoped draft'});h.enter('Year from','-');const before=h.calls.length;
  const submit=()=>h.owner.isValid()?h.draft.submit():Promise.resolve(false);assert.equal(await submit(),false);assert.equal(h.calls.length,before);assert.equal(filters(h.draft).minYear,null);
  h.enter('Year from','2000');assert.equal(h.owner.isValid(),true);await submit();assert.equal(h.calls.length,before+1);assert.equal(h.calls.at(-1).action,'create');
});
