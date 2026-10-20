'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('./artist-creation-fixtures/facade.cjs');

test('real Artist response supplies one immutable origin independently of Loved grants',async t=>{
  const h=await H.fixture(t),o=h.origin;assert.equal(o.headerRoot,h.header);assert.equal(o.artistLabel,H.ARTIST);assert.deepEqual(H.plain(o.artistScope),{root_artist_id:'3',mode:'artist'});assert.ok(Object.isFrozen(o));assert.ok(Object.isFrozen(o.artistScope));assert.equal(o.phase(),'idle');assert.equal(o.canCreate(),true);assert.equal(o.isCurrent(),true);assert.equal(o.isOwnerCurrent(),true);assert.equal(h.state.view.artist_loved_context_ref,null);
});
test('repeated actual chrome reconciliation preserves exact origin and header identity',async t=>{
  const h=await H.fixture(t),notifications=[];const off=h.namespace.subscribe(()=>notifications.push(h.namespace.snapshot()));t.after(off);
  for(let i=0;i<3;i++)h.context.updateGalleryMainChrome();assert.equal(h.namespace.snapshot(),h.origin);assert.equal(h.origin.headerRoot,h.header);assert.deepEqual(notifications,[]);
});
for(const change of ['actor','library','context','generation'])test('actual private '+change+' retirement never revives captured origin',async t=>{
  const h=await H.fixture(t);if(change==='generation')h.context.AlbumHavenPrivateUITransport.invalidate();else h.change(change);h.context.syncAlbumTopArtistCreationContext();
  assert.equal(h.origin.isCurrent(),false);assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.origin.canCreate(),false);assert.equal(h.namespace.snapshot(),null);assert.equal(H.form(h),false);
});
for(const cause of ['missing','foreign','wrong-root'])test('fresh otherwise valid response cannot admit '+cause+' launch evidence',async t=>{
  const h=await H.fixture(t),value=H.payload();if(cause==='missing'){delete value.artist_listen_through_context_ref;}else if(cause==='foreign'){value.artist_listen_through_context_ref='b'.repeat(64);value.artist_page.artist_listen_through_launch.context_ref='b'.repeat(64);}else value.artist_page.artist_listen_through_launch.artist_scope.root_artist_id='0';
  // Remove group alternatives too: this tests a rejected page receipt, not fallback.
  for(const row of value.artist_groups)delete row.artist_listen_through_launch;
  await h.admit(value);assert.equal(h.origin.isCurrent(),false);assert.equal(h.namespace.snapshot(),null);
});
test('an unrelated new native response retires old cleanup without clearing its successor',async t=>{
  const h=await H.fixture(t);await h.admit(H.payload());const next=h.namespace.snapshot();assert.ok(next);assert.notEqual(next,h.origin);h.origin.dispose();assert.equal(h.namespace.snapshot(),next);assert.equal(next.canCreate(),true);
});
test('native owned form retains origin identity but never admits another Create',async t=>{
  const h=await H.fixture(t),events=[];const off=h.namespace.subscribe(()=>events.push(h.origin.phase()));t.after(off);const owner=H.form(h);assert.ok(owner);assert.equal(h.namespace.snapshot(),h.origin);assert.equal(h.origin.phase(),'child');assert.equal(h.origin.canCreate(),false);assert.equal(h.origin.isOwnerCurrent(),true);assert.equal(H.form(h,{pageId:'duplicate'}),false);assert.ok(events.includes('child'));
  await owner.dismiss('cancel');await H.drain();assert.equal(h.owner('activeAppFormDialog'),null);
});
for(const mobile of [false,true])test('actual native dismissal veto preserves owned Artist child '+mobile,async t=>{
  const h=await H.fixture(t,{mobile}),owner=H.form(h,{beforeDismiss:()=>false});assert.ok(owner);assert.equal(await owner.dismiss('back'),false);assert.equal(h.namespace.snapshot(),h.origin);assert.equal(h.origin.phase(),'child');assert.equal(h.origin.isOwnerCurrent(),true);assert.ok(h.owner('activeAppFormDialog'));
});
test('existing unrelated native form prevents facade fallback or replacement',async t=>{
  const h=await H.fixture(t),existing=h.openForm({title:'Existing child',pageId:'existing-child'}),token=h.owner('activeAppFormDialog').token;assert.ok(existing);assert.equal(H.form(h),false);assert.equal(h.owner('activeAppFormDialog').token,token);
});
test('disposal while native child is active is sticky and cannot reopen it',async t=>{
  const h=await H.fixture(t),owner=H.form(h);assert.ok(owner);h.origin.dispose();await H.drain();assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.origin.canCreate(),false);assert.equal(H.form(h),false);assert.equal(h.namespace.snapshot(),null);
});
test('actual chrome refresh preserves adopted original header controls and their focus/listeners',async t=>{
  const h=await H.fixture(t),{mountSharedHeader}=await H.F.load('home-friends/shared-header.mjs'),original=[...h.header.children],button=h.header.querySelector('[data-gallery-bar-action="artist-family"]');assert.ok(button);let clicks=0;button.addEventListener('click',()=>clicks++);
  for(const node of original)node.remove();const owner=mountSharedHeader(h.header,h.bridge,{id:'artist-origin-contract',adoptRoot:true});owner.slots.identity.append(original[0]);for(const node of original.slice(1))owner.slots.actions.append(node);owner.refresh();button.focus();
  try{h.context.updateGalleryMainChrome();assert.equal(h.namespace.snapshot(),h.origin);assert.equal(h.origin.headerRoot,h.header);for(const node of original)assert.equal(h.header.contains(node),true);assert.equal(h.header.querySelector('[data-gallery-bar-action="artist-family"]'),button);assert.equal(h.document.activeElement,button);h.click(button);assert.equal(clicks,1);}finally{for(const node of original)node.remove();owner.dispose();h.header.append(...original);}
});
test('subscriber disposal during phase notification cannot leave actionable orphan origin',async t=>{
  const h=await H.fixture(t);const off=h.namespace.subscribe(()=>{if(h.origin.phase()==='child')h.origin.dispose();});t.after(off);H.form(h);await H.drain();assert.equal(h.namespace.snapshot(),null);assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.origin.canCreate(),false);
});

for(const accepted of [false,true])test('facade confirmation uses real native confirm under its exact owned form '+accepted,async t=>{
  const h=await H.fixture(t);assert.ok(H.form(h));const pending=h.origin.confirm('Discard these edits?',{acceptLabel:'Discard'});await H.drain();const modal=h.document.getElementById('app-confirm-modal');assert.equal(modal.hidden,false);h.click(h.document.getElementById(accepted?'app-confirm-accept':'app-confirm-cancel'));assert.equal(await pending,accepted);assert.equal(modal.hidden,true);
});
test('late accepted confirmation cannot survive private context retirement',async t=>{
  const h=await H.fixture(t);assert.ok(H.form(h));const pending=h.origin.confirm('Discard?');await H.drain();const accept=h.document.getElementById('app-confirm-accept');h.change('context');h.click(accept);assert.equal(await pending,false);assert.equal(h.origin.isOwnerCurrent(),false);
});
