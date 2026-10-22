'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,load,settle:microtasks,plain}=require('./home-friends-native-app-fixture.cjs');
const ownProfile = {display_name: 'Current listener', handle: 'listener', bio: 'My profile', allowed_actions: {can_edit: true}};
const activityOrigin = {source: 'activity', account_ref: null, kind: 'tracks', period: 'week'};
const activityTarget = kind => ({kind, ref: `recent:${kind}`, allowed_actions: {can_view_details: true}, origin: activityOrigin});
const homeState = () => ({scopeKey: 'account/library', selectedFriendRef: null,
  friends: {status: 'ready', data: {profile: ownProfile, friends: [], requests: []}}, members: {status: 'unavailable', data: null},
  recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}},
  activity: {status: 'ready', data: {rows: [{id: 'recent:one', kind: 'track', title: 'Recent track', source_readable: true,
    album_target: activityTarget('album'), artist_target: activityTarget('artist')}], snapshot_ref: null}},
  activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}},
  comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}});

function queuedSource() {
  const listeners = new Set(), reads = [];
  let value = {enabled: true, revision: 1, entries: [{id: 'queue:one', sourceReadable: true, title: 'Queued track'}]};
  const api = {getSnapshot: () => value,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async details(id, kind) {
      reads.push([id, kind]);
      return {target: {kind, ref: `queue:${kind}`, allowed_actions: {can_view_details: true}},
        data: {kind, ref: `queue:${kind}`, title: `Queued ${kind}`, tracks: null, listened_albums: null, discography: null},
        isCurrent: () => value.entries.some(row => row.id === id && row.sourceReadable)};
    },
  };
  return {api, reads, listeners, replace(patch) {value = {...value, ...patch, revision: value.revision + 1}; for (const listener of [...listeners]) listener();}};
}

async function homeFixture(t,presentation={kind:'tracks'},queue=queuedSource()) {
  const env=fixture(t),{mountHomeFriendsView}=await load('app.mjs');
  env.context.AbortController=AbortController;
  for(const file of ['resource-selection.js','queue-resource-selection.js'])vm.runInContext(
    fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime',file),'utf8'),env.context,{filename:file});
  const saves=[],navigation=[],reads=[],queueOwners=[];
  let state=homeState();
  const listeners=new Set(),subscriptions=[],publication={count:0,deliveries:0};
  const h={shell:{section:'recent',friendRef:null,accountName:'Current listener',presentation},readDetail(){},listeners,subscriptions,publication};
  Object.defineProperty(h,'state',{get:()=>state,set(next){
    if(Object.is(next,state))return;
    state=next;publication.count++;
    const targets=[...listeners],before=publication.deliveries;
    for(const listener of targets){
      assert.equal(listeners.has(listener),true,'publication keeps each captured owner current');
      const record=subscriptions.find(entry=>entry.listener===listener&&entry.releases===0);
      assert.ok(record,'delivery belongs to a live acquired owner');record.deliveries++;publication.deliveries++;listener();
    }
    assert.equal(publication.deliveries-before,targets.length,'complete snapshot reaches every live owner exactly once');
  }});
  const controller={getSnapshot:()=>h.state,
    subscribe(listener){
      if(typeof listener!=='function')throw new TypeError('A snapshot listener is required.');
      assert.equal(listeners.has(listener),false,'one distinct subscription per native owner');
      listeners.add(listener);const record={listener,releases:0,deliveries:0};subscriptions.push(record);
      return()=>{record.releases++;assert.equal(record.releases,1,'each native owner releases its subscription exactly once');assert.equal(listeners.delete(listener),true,'released subscription was live');};
    },selectFriend:()=>true,selectProfile:()=>true,
    loadActivity(value){reads.push(value);},loadFriends(){},loadRecent(){},loadProfile(){}};
  const runtime={...env.runtime,snapshot:()=>({scopeKey:h.state.scopeKey}),savePresentation:value=>saves.push(plain(value)),
    navigate:value=>navigation.push(value),explicitQueue:()=>queue.api,
    createQueueResourceSelection(options){const owner=env.context.window.AlbumHavenQueueResourceSelection.create(options);queueOwners.push(owner);return owner;}};
  const page=env.host;let disposed=false,owner;
  const props=()=>({runtime,controller,state:h.state,shell:h.shell,readDetail:h.readDetail});
  const assertSubscriptions=()=>{
    const owned=page.querySelectorAll('[data-home-friends-directory]').length+page.querySelectorAll('.home-member-profile').length;
    assert.equal(listeners.size,owned,'one live subscription per mounted directory/member owner, including hidden owners');
    assert.equal(subscriptions.filter(entry=>entry.releases===0).length,owned);
  };
  try{owner=env.own(mountHomeFriendsView(page,props()));assertSubscriptions();}
  catch(error){owner?.dispose();assert.equal(listeners.size,0,'failed mount retires every acquired subscription');assert.ok(subscriptions.every(entry=>entry.releases===1));throw error;}
  h.render=()=>{if(!disposed){owner.update(props());assertSubscriptions();}return page;};
  h.settle=async()=>{await microtasks();env.drain();await microtasks();return page;};
  h.resize=width=>{env.context.innerWidth=width;for(const [query,media] of env.media){media.matches=/max-width:\s*900px/.test(query)?width<=900:/max-width:\s*600px/.test(query)?width<=600:false;for(const listener of [...media.listeners])listener();}return h.render();};
  h.section=value=>{const button=page.querySelector(`#home-recent-sections [data-in-page-tab="${value}"]`);assert.ok(button);env.click(button);return page;};
  const event=(node,toggle=false)=>{assert.ok(node);const e=new env.context.Event('click',{bubbles:true});e.detail=1;e.ctrlKey=toggle;e.metaKey=false;e.altKey=false;e.shiftKey=false;node.dispatchEvent(e);};
  h.selectQueue=id=>event(page.querySelector(`[data-queue-row="${id}"]`),true);
  h.inspectQueue=id=>event(page.querySelector(`[data-queue-row="${id}"]`));
  h.selectRecent=id=>event(page.querySelector(`[data-home-activity-row="${id}"]`),true);
  h.selectPane=key=>env.click(page.querySelector(`#home-selected-sections [data-in-page-tab="${key}"]`));
  h.selection=section=>saves.at(-1)?.selectionPresentation?.find(entry=>(entry.query.homeSection==='queue'?'queue':'recent')===section)?.tracks?.rowIds||[];
  h.queueSnapshot=()=>queueOwners.at(-1)?.getSnapshot();
  h.retiredRow=()=>{const row=page.querySelector('[data-queue-row="queue:one"]');assert.ok(row);return()=>event(row);};
  h.dispose=()=>{if(disposed)return;disposed=true;owner.dispose();
    assert.equal(listeners.size,0,'view teardown releases all controller subscriptions');
    assert.ok(subscriptions.every(entry=>entry.releases===1),'every acquired owner retires exactly once');
    const before=publication.deliveries;h.state={...h.state};assert.equal(publication.deliveries,before,'post-disposal publication cannot reach retired owners');
    assert.equal(queue.listeners.size,0);for(const media of env.media.values())assert.equal(media.listeners.size,0);};
  t.after(h.dispose);
  const dashboard=page.querySelector('[data-dashboard]'),pageHeader=page.querySelector('[data-shared-header="home-page"]');
  const nodes=new Map(['recent','friends','artist','album'].map(key=>[key,page.querySelector(`[data-home-widget="${key}"]`)]));
  return Object.assign(h,{runtime,controller,env,queue,page,pageHeader,dashboard,nodes,saves,navigation,reads});
}
function assertOwnQueue(page) {
  const headers=page.querySelectorAll('.home-friends__page-header');assert.equal(headers.length,1);
  const header=headers[0];assert.match(header.textContent,/Current listener/);assert.match(header.textContent,/@listener/);assert.match(header.textContent,/My profile/);
  assert.equal(header.querySelectorAll('[data-home-profile-edit]').filter(node=>!node.closest('[hidden]')).length,1,'own editable identity keeps its edit action');
  assert.equal(page.querySelectorAll('h1,h2').some(node=>node.textContent==='Queue'),false);
  assert.equal(page.querySelectorAll('[data-home-widget="queue"]').length,0);
  assert.equal(page.getAttribute('data-home-section'),'recent');assert.ok(page.querySelector('[data-home-widget="recent"] .album-track-table'),'actual Queue panel exists even with zero entries');
  assert.equal(page.querySelectorAll('[data-home-activity-row]').length,0);
  for(const label of ['Period:','Track grouping','Missing'])assert.equal(page.querySelectorAll('button').some(node=>(node.getAttribute('aria-label')||node.textContent).startsWith(label)),false);
  assert.equal(page.querySelector('#home-recent-kinds'),null);assert.equal(page.querySelector('.home-friends__catalog-controls'),null);
}
module.exports={homeFixture,assertOwnQueue,queuedSource,ownProfile};
