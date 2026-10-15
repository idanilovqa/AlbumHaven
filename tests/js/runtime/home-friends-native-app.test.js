'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle, plain} = require('./home-friends-native-app-fixture.cjs');
const target = (kind, ref) => ({kind,ref,allowed_actions:{can_view_details:true}});
const track = (id, artist = 'artist:shared') => ({id,kind:'track',title:`Track ${id}`,artist:'Shared artist',album_title:'Shared album',source_readable:true,availability:'local',listen_count:3,rating:4,duration_seconds:120,
  artist_target:target('artist',artist),album_target:target('album','album:shared')});
const emptyFriends = () => ({profile:{display_name:'Me',handle:'me',bio:'',allowed_actions:{}},friends:[],requests:[],allowed_actions:{}});

// The full mounted screen uses canonical Home controller normalization, detail
// controllers, selection/presentation models and native shared adapters. Only
// transport responses and the native resource-service boundary are controlled.
async function appFixture(t, {rows = [track('a'),track('b')], presentation = {kind:'tracks',kindExplicit:true}, editableProfile = false} = {}) {
  const h = fixture(t), {createHomeFriendsController} = await load('model.mjs'), {mountHomeFriendsView} = await load('app.mjs');
  let activity = {status:'ready',data:{rows,snapshot_ref:'snapshot:one',total_listens:6,range_label:'Last 7 days'}}, friends = {status:'ready',data:emptyFriends()};
  if (editableProfile) friends.data.profile.allowed_actions = {can_edit: true};
  const reads=[],leases=[],retentions=[],saved=[],navigations=[];
  const controller = createHomeFriendsController({readRecent:async()=>({recent_local_albums:[],recent_not_local_albums:[]}),providers:{readActivity:async()=>activity,readFriends:async()=>friends}});
  controller.setScope('scope:one');await controller.loadFriends();
  const readDetail = request => {const pending=deferred(),read={request,...pending};reads.push(read);return pending.promise;};
  Object.assign(h.runtime,{
    readAlbumProjection:readDetail,
    snapshot:()=>({scopeKey:controller.getSnapshot().scopeKey}),
    savePresentation:value=>saved.push(plain(value)),navigate:value=>navigations.push(value),
    // The native bridge owns its own host and status channel. This controlled
    // boundary records the exact lease/disposal/authority options received;
    // it does not replace any DOM consumer, model, or shared adapter.
    mountResourceSelection(node,options){const lease={node,options,disposed:false};leases.push(lease);options.onState('unavailable');return {dispose(){assert.equal(lease.disposed,false,'each native lease retires once');lease.disposed=true;}};},
    retainArtistAlbums(selection,context,data){const retained={selection,context,data,releases:[]};retentions.push(retained);return options=>retained.releases.push(options);},
  });
  let shell={section:'recent',friendRef:'',profileRef:'',accountName:'Me',presentation},props={runtime:h.runtime,controller,state:controller.getSnapshot(),shell,readDetail},owner;
  const update=patch=>{props={...props,...patch,state:controller.getSnapshot()};owner.update(props);};
  const unsubscribe=controller.subscribe(()=>{props={...props,state:controller.getSnapshot()};owner?.update(props);});
  owner=h.own(mountHomeFriendsView(h.host,props));update({});await settle();h.drain();await settle();
  assert.equal(controller.getSnapshot().activity.status,'ready','canonical activity read admitted');
  t.after(()=>{unsubscribe();controller.dispose();});
  function clickRow(id,{toggle=false}={}) {
    const row=h.host.querySelector(`[data-home-activity-row="${id}"]`);assert.ok(row,`mounted activity row ${id}`);
    const event=new h.c.Event('click',{bubbles:true});event.detail=1;event.ctrlKey=toggle;event.metaKey=false;event.altKey=false;event.shiftKey=false;
    row.dispatchEvent(event);
  }
  function latestRead(kind,ref) {return reads.filter(read=>read.request.kind===kind&&(!ref||read.request.ref===ref)).at(-1);}
  function response(read,title) {const request=read.request;return {status:'ready',data:{kind:request.kind,ref:request.ref,title:title||request.ref,origin:request.origin,metadata_state:'current',summary:'Owned detail',
    ...(request.kind==='artist'?{listened_albums:[{id:'child-row',title:'Listened child album',detail_target:target('album','album:child')}],discography:[]}:{artist:'Shared artist',tracks:[]})}};}
  async function ready(read,title) {assert.ok(read,'detail request exists');read.resolve(response(read,title));await settle();h.drain();await settle();}
  return {...h,controller,owner,reads,leases,retentions,saved,navigations,readDetail,update,clickRow,latestRead,response,ready,
    async replaceActivity(next){activity=next;await controller.loadActivity({kind:'tracks',period:'week'});await settle();h.drain();},
    async replaceFriends(next){friends=next;await controller.loadFriends();await settle();h.drain();},
    route(next){shell={...shell,...next};update({shell});},
  };
}

function assertRetired(lease) {assert.equal(lease.disposed,true,'old native lease disposed');lease.options.onState('ready');lease.options.onError(new Error('late old-owner error'));}
function currentNative(h,kind) {return h.host.querySelector(`[data-home-widget="${kind}"] [data-native-ready]`);}
function detailLease(h,kind) {return h.leases.filter(lease=>lease.options.selection.kind===kind).at(-1);}

test('full Home remounts ready same-target details when multi-selection generation changes',async t=>{
  const h=await appFixture(t);h.clickRow('a');await settle();
  const firstArtist=h.latestRead('artist'),firstAlbum=h.latestRead('album'),oldArtistLease=detailLease(h,'artist'),oldAlbumLease=detailLease(h,'album');
  await h.ready(firstArtist,'First artist owner');await h.ready(firstAlbum,'First album owner');
  const oldRetention=h.retentions.at(-1);assert.ok(oldRetention);assert.match(h.host.textContent,/First artist owner/);
  h.clickRow('b',{toggle:true});await settle();
  assert.deepEqual(h.saved.at(-1).selectionPresentation[0].tracks.rowIds,['a','b']);
  const nextArtist=h.latestRead('artist'),nextAlbum=h.latestRead('album');assert.notEqual(nextArtist,firstArtist);assert.notEqual(nextAlbum,firstAlbum);
  assert.equal(nextArtist.request.ref,firstArtist.request.ref);assert.equal(nextAlbum.request.ref,firstAlbum.request.ref);
  assertRetired(oldArtistLease);assertRetired(oldAlbumLease);assert.deepEqual(oldRetention.releases,[{retire:true}]);
  assert.equal(currentNative(h,'artist').dataset.nativeReady,'false');assert.doesNotMatch(h.host.textContent,/late old-owner error/);
  await h.ready(nextArtist,'Second artist owner');await h.ready(nextAlbum,'Second album owner');
  const child=h.host.querySelector('[data-home-widget="artist"] [data-gallery-card-intent="select"]');assert.ok(child,'new owner provides listened-album action');h.click(child);await settle();
  assert.equal(h.latestRead('album').request.ref,'album:child','new artist notification establishes child authority');
  await h.ready(h.latestRead('album'),'Selected listened album');assert.match(h.host.querySelector('[data-home-widget="album"]').textContent,/Selected listened album/);
});

test('full Home aborts pending same-target details and ignores all late old-owner work',async t=>{
  const h=await appFixture(t);h.clickRow('a');await settle();
  const firstArtist=h.latestRead('artist'),firstAlbum=h.latestRead('album'),oldLeases=h.leases.slice();
  h.clickRow('b',{toggle:true});await settle();
  assert.equal(firstArtist.request.signal.aborted,true);assert.equal(firstAlbum.request.signal.aborted,true);oldLeases.forEach(assertRetired);
  const freshArtist=h.latestRead('artist'),freshAlbum=h.latestRead('album');
  firstArtist.resolve(h.response(firstArtist,'STALE ARTIST'));firstAlbum.resolve(h.response(firstAlbum,'STALE ALBUM'));await settle();
  assert.doesNotMatch(h.host.textContent,/STALE ARTIST|STALE ALBUM/);assert.equal(currentNative(h,'artist').dataset.nativeReady,'false');assert.equal(h.retentions.length,0);
  await h.ready(freshArtist,'Current artist');await h.ready(freshAlbum,'Current album');
  assert.equal(h.retentions.length,1);assert.match(h.host.textContent,/Current artist/);
  h.click(h.host.querySelector('[data-home-widget="artist"] [data-gallery-card-intent="select"]'));await settle();assert.equal(h.latestRead('album').request.ref,'album:child');
});

test('full Home restarts the unchanged album target when artist consensus disappears',async t=>{
  const h=await appFixture(t,{rows:[track('a'),track('b','artist:other')]});h.clickRow('a');await settle();
  const firstAlbum=h.latestRead('album'),firstArtist=h.latestRead('artist'),albumLease=detailLease(h,'album'),artistLease=detailLease(h,'artist');
  await h.ready(firstArtist,'Before consensus change');const retention=h.retentions.at(-1);
  h.clickRow('b',{toggle:true});await settle();
  assert.equal(firstAlbum.request.signal.aborted,true);assertRetired(albumLease);assertRetired(artistLease);assert.deepEqual(retention.releases,[{retire:true}]);
  const album=h.latestRead('album');assert.notEqual(album,firstAlbum);assert.equal(album.request.ref,'album:shared');
  assert.match(h.host.querySelector('[data-home-widget="artist"]').textContent,/do not share one available artist/);
  await h.ready(album,'Album owner after consensus change');assert.match(h.host.querySelector('[data-home-widget="album"]').textContent,/Album owner after consensus change/);
});

test('full Home retires source and provider authority and requires deliberate reselection',async t=>{
  const h=await appFixture(t);h.clickRow('a');await settle();const pending=h.latestRead('album'),lease=detailLease(h,'album');
  await h.replaceActivity({status:'ready',data:{rows:[track('a'),track('b')],snapshot_ref:'snapshot:two'}});
  assert.equal(pending.request.signal.aborted,true);assertRetired(lease);assert.equal(h.host.querySelector('[data-home-widget="album"]').hidden,true);
  pending.resolve(h.response(pending,'OLD SOURCE'));await settle();assert.doesNotMatch(h.host.textContent,/OLD SOURCE/);
  h.clickRow('a');await settle();const before=h.latestRead('artist'),native=detailLease(h,'artist');
  const replacementReads=[],replacement=request=>{const held=deferred();replacementReads.push({request,...held});return held.promise;};
  h.update({readDetail:replacement});await settle();assert.equal(before.request.signal.aborted,true);assertRetired(native);
  assert.equal(h.host.querySelector('[data-home-widget="artist"]').hidden,true);assert.equal(replacementReads.length,0,'changed provider cannot resurrect retired selection');
  h.clickRow('a');await settle();assert.ok(replacementReads.some(read=>read.request.kind==='artist'));
  h.controller.setScope('scope:two');await settle();for(const read of replacementReads)assert.equal(read.request.signal.aborted,true);
  assert.equal(h.host.querySelector('[data-home-widget="album"]').hidden,true);
});

test('full Home restores source scroll and pane focus without reviving denied detail',async t=>{
  const h=await appFixture(t,{presentation:{kind:'tracks',kindExplicit:true,scroll:{recent:125,friends:0,page:0}}});
  const source=h.host.querySelector('.home-friends__scroll');assert.equal(source.scrollTop,125);
  h.clickRow('a');await settle();await h.ready(h.latestRead('artist'));await h.ready(h.latestRead('album'));
  const expand=h.host.querySelector('[data-home-widget="album"] [data-dashboard-action="expand"]');assert.ok(expand);h.click(expand);await settle();
  const back=h.host.querySelector('[data-dashboard-action="back"]');assert.equal(h.document.activeElement,back);h.click(back);await settle();
  assert.equal(h.document.activeElement,h.host.querySelector('[data-home-widget="album"] [data-dashboard-action="expand"]'));
  const lease=detailLease(h,'album');await h.replaceActivity({status:'denied'});assertRetired(lease);assert.equal(h.host.querySelector('[data-home-widget="album"]').hidden,true);
  assert.match(h.host.textContent,/don't have access/);
  h.route({section:'friends'});await settle();assert.equal(h.host.dataset.homeSection,'friends');assert.equal(h.host.querySelector('[data-home-widget="recent"]').hidden,true);
  h.route({section:'recent'});await settle();assert.equal(h.host.dataset.homeSection,'recent');assert.equal(h.host.querySelector('[data-home-widget="album"]').hidden,true);
});

test('full Home retries a failed current detail without granting stale-owner work',async t=>{
  const h=await appFixture(t);h.clickRow('a');await settle();
  const failed=h.latestRead('album');failed.reject(new Error('transport failed'));await settle();
  const pane=h.host.querySelector('[data-home-widget="album"]');assert.match(pane.textContent,/could not be loaded/);
  const retry=h.named('Retry details',pane);assert.ok(retry);h.click(retry);await settle();
  const retried=h.latestRead('album');assert.notEqual(retried,failed);assert.equal(retried.request.ref,failed.request.ref);
  await h.ready(retried,'Recovered current album');assert.match(pane.textContent,/Recovered current album/);assert.equal(h.named('Retry details',pane),undefined);
  h.clickRow('b',{toggle:true});await settle();assert.doesNotMatch(pane.textContent,/Recovered current album/);
});


for (const stage of ['before-mount','after-mount']) test(`full Home failed Friends dialog ${stage} retires content and preserves fallback Close`,async t=>{
  const h=await appFixture(t),nativeOpen=h.runtime.openForm;
  let opens=0,nativeOwner;
  h.runtime.openForm=options=>{opens++;if(stage==='before-mount')return null;nativeOwner=nativeOpen(options);return null;};
  h.click(h.host.querySelector('[data-home-open-friends]'));await settle();
  const fallback=h.host.querySelector('[data-slot="dialogs"]');assert.match(fallback.textContent,/not available right now/);
  assert.ok(h.named('Close',fallback));
  const before=h.listeners().length;h.update({});await settle();assert.equal(opens,1,'failed intent does not automatically reopen');assert.equal(h.listeners().length,before);
  h.click(h.named('Close',fallback));await settle();assert.equal(fallback.childNodes.length,0,'fallback closes the failed intent');
  h.runtime.openForm=nativeOpen;h.click(h.host.querySelector('[data-home-open-friends]'));await settle();assert.equal(h.form.hidden,false,'a deliberate subsequent open works');
  h.owner.dispose();nativeOwner?.close(null,{force:true,restoreFocus:false});
});

test('full Home rejects a resource lease returned after native resource focus retires its parent',async t=>{
  const h=await appFixture(t),mount=h.runtime.mountResourceSelection;let focused=0;
  const listener=event=>{if(event.target.hasAttribute('data-resource-focus-test')){focused++;h.owner.dispose();}};
  h.document.addEventListener('focusin',listener);t.after(()=>h.document.removeEventListener('focusin',listener));
  h.runtime.mountResourceSelection=(host,options)=>{const lease=mount(host,options),button=h.document.createElement('button');button.setAttribute('data-resource-focus-test','');host.append(button);button.focus();return lease;};
  h.clickRow('a');await settle();assert.equal(focused,1);assert.equal(h.reads.length,0,'no detail provider read after synchronous parent retirement');
  assert.equal(h.leases.length,1);assert.equal(h.leases[0].disposed,true);assert.equal(h.host.childNodes.length,0);
  h.leases[0].options.onState('ready');await settle();assert.equal(h.host.childNodes.length,0);assert.equal(h.reads.length,0);
});

for(const replacement of ['provider','route']) test(`full Home native resource focus retires a live frame on ${replacement} replacement`,async t=>{
  const h=await appFixture(t),mount=h.runtime.mountResourceSelection,replacementReads=[];let focused=0;
  const nextProvider=request=>{replacementReads.push(request);return deferred().promise;};
  const listener=event=>{if(!event.target.hasAttribute('data-live-resource-focus'))return;focused++;if(replacement==='provider')h.update({readDetail:nextProvider});else h.route({section:'friends'});};
  h.document.addEventListener('focusin',listener);t.after(()=>h.document.removeEventListener('focusin',listener));
  h.runtime.mountResourceSelection=(host,options)=>{const lease=mount(host,options),button=h.document.createElement('button');button.setAttribute('data-live-resource-focus','');host.append(button);button.focus();return lease;};
  const saves=h.saved.length;h.clickRow('a');
  assert.equal(focused,1);assert.equal(h.reads.length,0,'obsolete provider never starts during native focus continuation');
  assert.equal(h.leases[0].disposed,true,'late old-frame native lease retired');assert.equal(h.saved.length,saves,'old frame never saves selection presentation');
  await settle();assert.equal(replacementReads.length,0,'provider replacement does not revive retired selection');assert.equal(h.reads.length,0);
  if(replacement==='route')assert.equal(h.host.dataset.homeSection,'friends');
  h.leases[0].options.onState('ready');await settle();assert.equal(h.reads.length,0);
});

test('full Home same-ownership publication during native focus keeps one current resource acquisition',async t=>{
  const h=await appFixture(t),mount=h.runtime.mountResourceSelection;let focused=0;
  const listener=event=>{if(event.target.hasAttribute('data-benign-resource-focus')){focused++;h.update({});}};
  h.document.addEventListener('focusin',listener);t.after(()=>h.document.removeEventListener('focusin',listener));
  h.runtime.mountResourceSelection=(host,options)=>{const lease=mount(host,options),button=h.document.createElement('button');button.setAttribute('data-benign-resource-focus','');host.append(button);button.focus();return lease;};
  h.clickRow('a');await settle();assert.equal(focused,2);assert.equal(h.leases.length,2);assert.equal(h.reads.length,2);assert.ok(h.leases.every(lease=>!lease.disposed));
  h.update({});await settle();assert.equal(h.leases.length,2,'unchanged publication does not remount or loop');
});

test('full Home native form focus replacing the route rejects the old dialog and continuation',async t=>{
  const h=await appFixture(t,{editableProfile:true});let focused=0;
  const listener=event=>{if(!h.form.contains(event.target)||focused)return;focused++;h.route({section:'friends'});};
  h.document.addEventListener('focusin',listener);t.after(()=>h.document.removeEventListener('focusin',listener));
  const edit=h.named('Edit profile',h.host);assert.ok(edit,'canonical editable profile exposes its real edit trigger');
  const saves=h.saved.length;h.click(edit);
  assert.equal(focused,1);assert.equal(h.form.hidden,true,'late dialog closed before old frame resumes');assert.equal(h.saved.length,saves,'old route continuation cannot save');
  await settle();assert.equal(h.host.dataset.homeSection,'friends');assert.equal(h.form.hidden,true);
});
