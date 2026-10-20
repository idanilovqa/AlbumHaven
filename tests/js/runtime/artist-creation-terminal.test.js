'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('./artist-host-fixtures/actual-artist-runtime.cjs'),H=require('./artist-creation-fixtures/facade.cjs');

test('real successful Artist fetch automatically publishes its actionable origin to an existing subscriber without polling',async t=>{
 const h=A.fixture(t);await h.entry();const namespace=h.context.AlbumHavenAlbumTopsRuntime.artistCreation,events=[];
 const off=namespace.subscribe(()=>{const origin=namespace.snapshot();events.push({origin,busy:h.state.busy,phase:origin?.phase(),canCreate:origin?.canCreate()});});t.after(off);
 const index=h.requests.length,work=h.read(h.context.buildApiUrl(H.payload()),{},true);assert.equal(h.requests.length,index+1);h.reply(index,H.payload());const result=await work;assert.equal(result.error,undefined);assert.equal(result.value,true);await H.drain();
 // No namespace snapshot/sync call here: only genuine notifications may populate events.
 const admitted=events.filter(value=>value.origin&&value.phase==='idle'&&value.canCreate===true);assert.equal(admitted.length,1);assert.equal(admitted[0].busy,false);assert.equal(admitted[0].origin.headerRoot,h.header);assert.deepEqual(H.plain(admitted[0].origin.artistScope),{root_artist_id:'3',mode:'artist'});H.terminal(h);t.after(()=>admitted[0].origin.dispose());
});

test('ordinary Gallery section with no mounted Artist owner uses its exact registered group through native form and Open',async t=>{
 const h=A.fixture(t);await h.entry();await h.admit(H.payload({selected_artist:'',artist_page:null,primary_artist_groups:[],family_artist_groups:[],related_artists:[]}));assert.equal(h.runtime().snapshot().sessionId??null,null);
 H.ordinaryGalleryLayout(h);
 const context=h.context.galleryArtistLovedHeaderContext();assert.equal(context.kind,'artist');assert.equal(context.sourceSection.group.artist,H.ARTIST);
 const namespace=h.context.AlbumHavenAlbumTopsRuntime.artistCreation,origin=namespace.snapshot();assert.ok(origin);t.after(()=>origin.dispose());const owned={...h,namespace,origin};assert.equal(origin.canCreate(),true);assert.deepEqual(H.plain(origin.artistScope),{root_artist_id:'3',mode:'artist'});
 const ack=await H.acknowledgement(t,owned),form=H.form(owned);assert.ok(form);assert.equal(origin.phase(),'child');assert.equal(origin.canCreate(),false);
 const before=h.requests.length,settled=[],work=origin.openCreatedTop(ack.receipt,{isCurrent:ack.isCurrent,onSettled:value=>settled.push(value)});await H.drain();
 const request=h.requests.slice(before).find(row=>!row.settled&&new URL(row.url,h.location.href).searchParams.get('surface')==='album_tops');assert.ok(request,'actual Top foreground request');assert.equal(h.owner('activeAppFormDialog'),null);request.resolve(H.top(h));assert.equal(await work,true);assert.equal(settled.length,1);assert.equal(settled[0].opened,true);assert.equal(h.state.view.top_ref,H.F.TOP);assert.equal(ack.calls.length,1);assert.equal(namespace.snapshot(),null);
});

test('rejected mounted Artist page receipt cannot fall back to a valid registered ordinary group receipt',async t=>{
 const h=A.fixture(t);await h.entry();const value=H.payload();value.artist_page={...value.artist_page,artist_listen_through_launch:{...H.wire(),artist_scope:{root_artist_id:'0',mode:'artist'}}};
 await h.admit(value);const mounted=h.runtime().snapshot();assert.ok(mounted.sessionId);assert.equal(mounted.mounted,true);assert.equal(mounted.actionable,true);
 const group=h.state.view.artist_groups[0];assert.ok(group.artist_listen_through_launch);assert.equal(h.context.artistListenThroughLaunchIsCurrent(group.artist_listen_through_launch),true);assert.equal(h.context.galleryArtistLovedHeaderContext().kind,'artist-page');assert.equal(h.context.AlbumHavenAlbumTopsRuntime.artistCreation.snapshot(),null);assert.equal(h.owner('activeAppFormDialog'),null);
});
