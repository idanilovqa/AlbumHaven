'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {appFixture,visible,settle}=require('./home-history-header-native-fixture.cjs');
const header=(h,id)=>h.host.querySelector(`[data-shared-header="${id}"]`);
const dashboard=h=>h.host.querySelector('[data-dashboard]');
const widget=(h,key)=>h.host.querySelector(`[data-home-widget="${key}"]`);
const badges=h=>[...h.host.querySelectorAll('.home-header__listens')];
const friend=()=>({account_ref:'friend:one',display_name:'Friend',relationship:'accepted',allowed_actions:{can_view_activity:true,can_compare:true}});

test('native Home headers retain one dashboard and one owner for each shared header',async t=>{
  const h=await appFixture(t),initialDashboard=dashboard(h);
  assert.equal(h.host.querySelectorAll('[data-dashboard]').length,1);assert.equal(initialDashboard.dataset.dashboardLayout,'single');
  const headers=[...h.host.querySelectorAll('[data-shared-header]')];assert.ok(headers.length>=3);
  for(const node of headers)assert.equal(h.host.querySelectorAll(`[data-shared-header="${node.getAttribute('data-shared-header')}"]`).length,1);
  h.update();assert.equal(dashboard(h),initialDashboard);for(const node of headers)assert.equal(header(h,node.getAttribute('data-shared-header')),node,'update retains actual shared-header owner');
});

test('own header exposes one authorized period count beside the identity',async t=>{
  const h=await appFixture(t);assert.equal(badges(h).length,1);assert.equal(badges(h)[0].textContent,'73');
  const identity=header(h,'home-page').querySelector('.home-header__identity');assert.ok(identity);assert.match(identity.textContent,/Owner/);assert.equal(identity.querySelectorAll('.home-header__listens').length,1);
  const recent=header(h,'home-recent'),period=recent.querySelector('.home-friends__period button');assert.ok(period);assert.equal(period.getAttribute('aria-label'),'Period: Last week');
  h.choosePeriod('Last month',recent);await settle();assert.equal(recent.querySelector('.home-friends__period button').getAttribute('aria-label'),'Period: Last month');
});

test('friend header count belongs to selected friend and disappears when activity permission is revoked',async t=>{
  const selected=friend(),h=await appFixture(t,{section:'friends',friend:selected,total:19,presentation:{friendKind:'tracks',friendPeriod:'month'}});
  assert.match(header(h,'home-page').querySelector('.home-header__identity').textContent,/Friend/);assert.equal(badges(h).length,1);assert.equal(badges(h)[0].textContent,'19');
  await h.replaceFriends({profile:{display_name:'Owner',allowed_actions:{}},friends:[{...selected,allowed_actions:{...selected.allowed_actions,can_view_activity:false}}],requests:[]});
  assert.equal(badges(h).some(node=>node.textContent==='19'),false,'raw DOM cannot retain a private count after permission loss');assert.doesNotMatch(header(h,'home-page').textContent,/\b19\b/);
});

test('denied recent payload never discloses a stale supplied count',async t=>{
  const h=await appFixture(t,{status:'denied',total:99999});assert.equal(badges(h).some(node=>node.textContent==='99999'),false);assert.doesNotMatch(h.host.textContent,/99999/,'includes all hidden retained DOM');
});

test('Missing remains native and last ordinary action; View is the only outside action in Home',async t=>{
  const h=await appFixture(t),recent=header(h,'home-recent'),missing=recent.querySelector('[data-home-inspect-missing]');assert.ok(missing,'canonical Missing owner completed eligibility');assert.equal(missing.classList.contains('action-button'),true);
  const actions=recent.querySelector('.home-header__primary-actions'),buttons=[...actions.querySelectorAll('button')];assert.equal(buttons.at(-1),missing);
  const outside=recent.querySelector('.home-header__outside');assert.equal(outside.children.length,1);assert.ok(outside.querySelector('[data-unfolding-action-button], .unfolding-action-button, button'),'actual View chooser owns the outside slot');
});

async function selectedTrackFixture(t){const h=await appFixture(t);h.clickRow();await settle();assert.equal(widget(h,'artist').hidden,false);assert.equal(widget(h,'album').hidden,false);assert.equal(h.reads.length,2,'both canonical detail owners request their projections');return h;}

test('native Full size and Back controls operate one retained dashboard',async t=>{
  const h=await selectedTrackFixture(t),original=dashboard(h);
  for(const key of ['recent','artist','album']){
    assert.equal(dashboard(h).dataset.dashboardLayout,'ordinary');const expand=header(h,`home-${key}`).querySelector('[data-dashboard-action="expand"]');assert.ok(expand);h.click(expand);await settle();
    assert.equal(dashboard(h),original);assert.equal(dashboard(h).dataset.dashboardLayout,'expanded');assert.equal(dashboard(h).dataset.dashboardExpandedKey,key);
    for(const name of ['recent','artist','album'])assert.equal(widget(h,name).dataset.dashboardWidgetState,name===key?'expanded':'suppressed');
    const back=header(h,'home-page').querySelector('[data-dashboard-action="back"]');assert.ok(back);assert.equal(h.host.querySelectorAll('[data-dashboard-action="back"]').length,1);h.click(back);await settle();
    assert.equal(dashboard(h).dataset.dashboardLayout,'ordinary');assert.equal(dashboard(h).dataset.dashboardExpandedKey,undefined);
  }
});

test('Queue navigation retains shared Home header while retiring Recent detail and gallery controls',async t=>{
  const h=await selectedTrackFixture(t),page=header(h,'home-page'),recent=header(h,'home-recent');
  const queue=recent.querySelector('[data-in-page-tab="queue"]');assert.ok(queue);h.click(queue);await settle();
  assert.equal(header(h,'home-page'),page);assert.equal(header(h,'home-recent'),recent);assert.equal(widget(h,'recent').getAttribute('aria-label'),'Queued tracks');
  assert.ok(widget(h,'recent').querySelector('.album-track-table--collection'),'actual Queue panel owns content');assert.equal(h.host.querySelector('[data-home-activity-row]'),null);
  assert.equal([...h.host.querySelectorAll('.home-friends__period')].filter(visible).length,0);assert.equal(recent.querySelector('.home-header__outside').children.length,0);
  assert.equal(widget(h,'artist').hidden,true);assert.equal(widget(h,'album').hidden,true);assert.equal(widget(h,'artist').querySelector('[data-dashboard-action="expand"]'),null);assert.equal(widget(h,'album').querySelector('[data-dashboard-action="expand"]'),null);assert.equal(dashboard(h).dataset.dashboardLayout,'single');
  h.route({section:'friends'});await settle();assert.equal(widget(h,'recent').hidden,true);assert.equal([...widget(h,'recent').querySelectorAll('.album-track-table--collection')].filter(visible).length,0);
});

test('retired Full size controls cannot expand stale detail after source or route changes',async t=>{
  const h=await selectedTrackFixture(t),retired=header(h,'home-artist').querySelector('[data-dashboard-action="expand"]');assert.ok(retired);
  await h.replaceActivity({status:'denied',data:null});assert.equal(widget(h,'artist').hidden,true);assert.equal(retired.isConnected,false);h.click(retired);await settle();
  assert.equal(dashboard(h).dataset.dashboardLayout,'single');assert.equal(dashboard(h).dataset.dashboardExpandedKey,undefined);assert.equal(h.host.querySelector('[data-dashboard-action="back"]'),null);
});
