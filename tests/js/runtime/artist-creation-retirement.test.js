'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('./artist-host-fixtures/actual-artist-runtime.cjs'),H=require('./artist-creation-fixtures/facade.cjs');
for(const mobile of [false,true])test('repeated actual pre-ack Cancel admits fresh origin without another response or automatic form '+mobile,async t=>{
 const h=await H.fixture(t,{mobile}),launch=h.state.view.artist_page.artist_listen_through_launch,count=h.requests.length;let origin=h.origin;
 for(let i=0;i<2;i++){const old=origin,form=old.openForm({title:'Unsaved Listen-through',pageId:'cancel-cycle-'+i});assert.ok(form);assert.equal(old.phase(),'child');assert.equal(await form.dismiss('cancel'),true);await H.drain();
  assert.equal(old.isOwnerCurrent(),false);assert.equal(old.canCreate(),false);old.dispose();origin=h.namespace.snapshot();assert.ok(origin);assert.notEqual(origin,old);assert.equal(origin.phase(),'idle');assert.equal(origin.canCreate(),true);assert.equal(h.owner('activeAppFormDialog'),null);assert.equal(h.requests.length,count);assert.equal(h.state.view.artist_page.artist_listen_through_launch,launch);
 }t.after(()=>origin.dispose());
});
async function gallery(t){const h=A.fixture(t);await h.entry();await h.admit(H.payload({selected_artist:'',artist_page:null,primary_artist_groups:[],family_artist_groups:[],related_artists:[]}));const layout=H.ordinaryGalleryLayout(h),position=layout.position;const namespace=h.context.AlbumHavenAlbumTopsRuntime.artistCreation,origin=namespace.snapshot();assert.ok(origin);t.after(()=>namespace.snapshot()?.dispose());return {...h,namespace,origin,position,scrollTo:layout.scroll};}
test('ordinary Gallery scroll departure and return revalidate same evidence into distinct origin',async t=>{
 const h=await gallery(t),launch=h.context.galleryArtistLovedHeaderContext().sourceSection.group.artist_listen_through_launch,count=h.requests.length;h.scrollTo(0);assert.equal(h.namespace.snapshot(),null);assert.equal(h.origin.isCurrent(),false);h.origin.dispose();h.scrollTo(h.position);const next=h.namespace.snapshot();assert.ok(next);assert.notEqual(next,h.origin);assert.equal(next.canCreate(),true);assert.equal(h.context.galleryArtistLovedHeaderContext().sourceSection.group.artist_listen_through_launch,launch);assert.equal(h.requests.length,count);assert.equal(h.owner('activeAppFormDialog'),null);
});
test('intentional live origin disposal suppresses immediate re-admission from exact response launch',async t=>{
 const h=await H.fixture(t);h.origin.dispose();for(let i=0;i<3;i++){h.context.updateGalleryMainChrome();assert.equal(h.namespace.snapshot(),null);}assert.equal(H.form(h),false);assert.equal(h.origin.isOwnerCurrent(),false);
});
test('old cancelled form callbacks and dispose cannot retire or steal focus from a new native child',async t=>{
 const h=await H.fixture(t),old=h.origin,form=H.form(h);assert.ok(form);assert.equal(await form.dismiss('cancel'),true);await H.drain();const next=h.namespace.snapshot();assert.ok(next);assert.notEqual(next,old);const child=next.openForm({title:'New child',pageId:'new-child'});assert.ok(child);const token=h.owner('activeAppFormDialog').token,button=h.document.createElement('button');button.textContent='New child focus';h.document.getElementById('app-form-content').append(button);button.focus();
 old.dispose();assert.equal(old.openForm({title:'Stale'}),false);assert.equal(await old.confirm('Stale confirmation'),false);await form.dismiss('cancel');await H.drain();assert.equal(h.namespace.snapshot(),next);assert.equal(next.phase(),'child');assert.equal(h.owner('activeAppFormDialog').token,token);assert.equal(h.document.activeElement,button);t.after(()=>next.dispose());
});
test('same evidence cannot re-admit after ordinary departure when actual private generation retires',async t=>{
 const h=await gallery(t);h.scrollTo(0);assert.equal(h.namespace.snapshot(),null);h.context.AlbumHavenPrivateUITransport.invalidate();h.scrollTo(h.position);assert.equal(h.namespace.snapshot(),null);assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.owner('activeAppFormDialog'),null);
});
test('acknowledged failed Open recovery dismissal still requires fresh response before another Create',async t=>{
 const h=await H.fixture(t),ack=await H.acknowledgement(t,h);assert.ok(H.form(h));const before=h.requests.length,work=h.origin.openCreatedTop(ack.receipt,{isCurrent:ack.isCurrent});await H.drain();
 let request;for(let i=0;i<4&&!request;i++){await H.drain();const pending=h.requests.slice(before).filter(row=>!row.settled);request=pending.find(row=>new URL(row.url,h.location.href).searchParams.get('surface')==='album_tops');if(!request)for(const row of pending){const url=new URL(row.url,h.location.href);assert.equal(url.pathname,'/view-data');assert.equal(url.searchParams.get('artist'),H.ARTIST);row.resolve(H.payload());}}assert.ok(request);request.resolve({error:'unavailable'},503);assert.equal(await work,false);await H.drain();assert.equal(h.origin.phase(),'recovery');assert.equal(h.origin.canCreate(),false);h.origin.dispose();for(let i=0;i<3;i++){h.context.updateGalleryMainChrome();assert.equal(h.namespace.snapshot(),null);}assert.equal(ack.calls.length,1);assert.equal(H.form(h),false);
});
