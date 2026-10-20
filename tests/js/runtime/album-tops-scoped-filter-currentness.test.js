'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('./home-friends-native-app-fixture.cjs'),F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let create,mount;test.before(async()=>{({createAlbumTopDraft:create}=await F.load('album-tops/draft.mjs'));({mountScopedCreationFilterControls:mount}=await F.load('album-tops/scoped-filter-controls.mjs'));});
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
for(const change of ['busy','denied'])for(const boundary of ['isValid','update','release-menu'])test('actual '+change+' from currentness callback invalidates captured '+boundary+' decision',async t=>{
  const h=N.fixture(t),c=F.controllerFixture(),p=F.providerFixture();p.providers.listScopedAlbums=async()=>({albums:[F.album(11,{creation_metadata:{release_type:'ep',rating:7,rating_state:'available',artwork_url:null}})],next_cursor:null});
  const draft=create({controller:c.controller,providers:p.providers,artistScope:{root_artist_id:'3',mode:'artist'}});t.after(()=>draft.dispose());await tick();
  let armed=false,observations=0,changes=0;const opened=[],rendered=[];const runtime={...h.runtime,openChoice(...args){opened.push(args);return h.runtime.openChoice(...args);},buttonHtml(options){if(changes)rendered.push({...options});return h.runtime.buttonHtml(options);}};
  const owner=h.own(mount(h.host,runtime,{draft,isCurrent(){if(armed&&++observations===(boundary==='isValid'?2:1)){armed=false;changes++;const old=c.controller.getSnapshot();c.replace(change==='busy'?{...old,mutation:{status:'loading'}}:{...old,directory:{status:'denied',data:null}});}return true;}}));
  assert.equal(owner.isValid(),true);const before=structuredClone(draft.getSnapshot().artistFilters);assert.equal(before.minYear,null);assert.equal(h.host.querySelector('input[aria-label="Year from"]').value,'');
  armed=true;
  if(boundary==='isValid')assert.equal(owner.isValid(),false);
  else if(boundary==='update')owner.update();
  else {const button=[...h.host.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')||node.textContent.trim()).startsWith('Release types'));assert.ok(button);h.click(button);h.drain();assert.equal(h.document.querySelector('[role="menu"]'),null);}
  assert.equal(changes,1);assert.equal(owner.isValid(),false);
  if(boundary==='release-menu')assert.equal(opened.length,0,'no transient stale native menu admission');
  if(boundary==='update'){assert.ok(rendered.length,'actual disabled repaint observed');assert.equal(rendered.every(options=>options.disabled===true),true,'no stale enabled render after controller retirement');}assert.deepEqual(draft.getSnapshot().artistFilters,before);
  for(const input of h.host.querySelectorAll('input'))assert.equal(input.disabled,true);
  assert.equal(c.calls.length,0);
});
