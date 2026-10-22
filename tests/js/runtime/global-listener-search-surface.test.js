'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {actionFixture,listenerReady,listenerTrack,submitListener,bindingReply,ROW,ROW2,CURSOR,assertListenerPrivate}=require('./search-native-fixtures/listener-search.cjs');
for(const width of [1100,390,320])test(`native Listener column is visible by default at ${width}px`,async t=>{
  const h=await actionFixture(t,{mobile:width<500});
  if(width<500){
    h.c.innerWidth=width;
    h.dispatch(h.form,'submit');
    assert.equal(h.requests.length,0,'first mobile submit opens Search without a request');
    assert.equal(h.input.inert,false);assert.equal(h.input.getAttribute('aria-hidden'),'false');
    assert.equal(h.document.activeElement,h.input);
  }
  const snapshot=await submitListener(h);h.resize(width);
  assert.equal(snapshot.result.kind,'listener');assert.equal(h.host.querySelectorAll('.compact-data-table').length,1);
  const headers=[...h.host.querySelectorAll('[role="columnheader"][data-cdt-column]')].map(node=>node.getAttribute('data-cdt-column'));
  assert.ok(headers.includes('listener'));assert.equal(headers.indexOf('listener'),headers.indexOf('album')+1);
  const cells=[...h.host.querySelectorAll('[data-cdt-column="listener"]')];assert.ok(cells.length>=3);
  assert.ok(cells.every(node=>!node.hasAttribute('data-cdt-responsive-hidden')&&!node.hidden));
  assert.match(h.host.textContent,/Maya \(@maya\)/);assert.equal(h.host.querySelectorAll('[data-cdt-column="listener"] a').length,0);
  assert.equal(h.host.querySelectorAll('.album-track-table__row').length,2);assert.equal(h.host.querySelectorAll('.album-card--search-match,.album-track-table__row--search-match').length,0);
  assert.equal(h.host.querySelectorAll('[data-in-page-tab="albums"]').length,0);assert.equal(h.host.querySelectorAll('[data-sidebar-artist]').length,0);
  assert.ok(h.host.querySelector('[data-track-table-columns]'),'existing native column picker stays available');assertListenerPrivate(h);
});
test('Listener and historical labels are escaped text, never profile links or markup',async t=>{
  const h=await actionFixture(t),p=listenerReady();p.listener.display_name='<img src=x onerror=alert(1)>';
  p.tracks[0].title='<script>historical</script>';p.tracks[0].artist='<b>Artist</b>';p.tracks[0].album_title='Album & More';
  await submitListener(h,p);assert.match(h.host.textContent,/<img src=x onerror=alert\(1\)>/);assert.match(h.host.textContent,/<script>historical<\/script>/);
  assert.equal(h.host.querySelectorAll('script,[onerror]').length,0);assert.equal(h.host.querySelectorAll('[data-cdt-column="listener"] a').length,0);assertListenerPrivate(h);
});
test('unresolved can mean missing audio for known inventory; display makes no absence or permission claim',async t=>{
  const h=await actionFixture(t),p=listenerReady({tracks:[listenerTrack(ROW,{availability:'unresolved',title:null,artist:null,album_title:null,duration_seconds:null}),listenerTrack(ROW2)]});
  await submitListener(h,p,{bindingOptions:{disabled:[ROW]}});const rows=[...h.host.querySelectorAll('[data-cdt-row-key]')];
  assert.equal(rows.length,2);assert.match(rows[0].textContent,/Local audio unavailable/);assert.doesNotMatch(h.host.textContent,/Not in this library/);
  for(const key of ['title','artist','album','duration']){
    const cell=rows[0].querySelector(`[data-cdt-column="${key}"]`);assert.ok(cell);assert.doesNotMatch(cell.textContent,/undefined|null|Unknown|0:00/);
  }
  assert.equal(rows[0].querySelector('[data-search-track-play]').disabled,true);assert.equal(rows[0].tabIndex,-1);
  assert.equal(h.runtime().canOpenAlbum(h.runtime().snapshot(),h.runtime().snapshot().result.tracks[0]),false);
  assert.equal(h.host.querySelectorAll('[data-track-row-path],[data-track-path]').length,0);assertListenerPrivate(h);
});
test('existing native column picker changes optional columns while Listener stays visible with local overflow',async t=>{
  const h=await actionFixture(t);await submitListener(h);h.resize(1100);const rows=[...h.host.querySelectorAll('[data-cdt-row-key]')];
  const button=h.host.querySelector('[data-track-table-columns]');h.click(button);let menu=h.document.querySelector('.settings-foobar-format-menu');assert.ok(menu);
  const hide=[...menu.querySelectorAll('button')].find(node=>node.textContent.trim()==='Hide Artist');assert.ok(hide);h.click(hide);
  assert.ok(h.host.querySelector('[data-cdt-column="artist"]').hasAttribute('data-cdt-responsive-hidden'));h.resize(390);
  assert.equal(h.host.querySelector('[data-cdt-column="listener"]').hasAttribute('data-cdt-responsive-hidden'),false);
  assert.deepEqual([...h.host.querySelectorAll('[data-cdt-row-key]')],rows);assert.equal(h.requests.length,2);
});

for(const [hasMore,total,expected]of [[true,null,/No matches in this page\. Continue searching\./],
  [false,null,/No matches in this page/],[false,0,/No matching tracks/]])test(`empty page has_more=${hasMore}, total=${total} is truthful`,async t=>{
  const h=await actionFixture(t),p=listenerReady({tracks:[]});p.page={limit:100,returned_count:0,candidates_examined:100,has_more:hasMore,next_cursor:hasMore?CURSOR:null,total_matches:total};
  await submitListener(h,p);assert.match(h.host.textContent,expected);assert.equal(h.requests.length,1);
  if(total===null)assert.doesNotMatch(h.host.textContent,/No matching tracks|230 matching|900 matching|\d+%/);
  if(hasMore)assert.ok(h.button(/^Continue$/));else assert.equal([...h.host.querySelectorAll('button')].some(node=>/^Continue$/.test(node.textContent.trim())),false);
  assert.equal(h.host.querySelectorAll('[data-cdt-row-key]').length,0);assertListenerPrivate(h);
});
test('filtered unknown total is not replaced by history totals or invented progress',async t=>{
  const h=await actionFixture(t),p=listenerReady({query:'@maya :loved',include:['loved']});p.page={...p.page,has_more:true,next_cursor:CURSOR,total_matches:null,candidates_examined:100};
  const snapshot=await submitListener(h,p);assert.equal(snapshot.result.page.totalMatches,null);assert.equal(snapshot.result.page.candidatesExamined,100);
  assert.doesNotMatch(h.host.textContent,/230 matching|900 matching|\d+%/);assert.match(h.host.textContent,/complete historical coverage is not known/i);
  assert.equal(h.requests.length,2,'no automatic history drain');assertListenerPrivate(h);
});
test('binding publication does not expose raw history, criteria, tokens or native identities',async t=>{
  const h=await actionFixture(t),before=await submitListener(h,listenerReady(),{bindings:false});
  assert.ok(Object.isFrozen(before.result));assert.ok(before.result.tracks.every(Object.isFrozen));
  const keys=before.result.tracks.map(row=>row.rowKey);assert.equal(new Set(keys).size,2);assert.ok(keys.every(key=>!key.startsWith('activity_')));
  h.reply(1,bindingReply(h,1));await h.flush();const after=h.runtime().snapshot();assert.ok(Object.isFrozen(after.result));
  assert.notEqual(after.sourceIdentity,before.sourceIdentity);assert.notEqual(after.result,before.result);assertListenerPrivate(h);
  assert.equal(Object.hasOwn(after.result,'criteria'),false);assert.equal(Object.hasOwn(after.result,'native'),false);
});
