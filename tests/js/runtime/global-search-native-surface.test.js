'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,admit,source,read,ready,pending,firstWitness,child,album,ordinary,mainUrl}=require('./search-native-fixtures/actual-runtime.cjs');

// All renderers, controls, table measurement, menus and Search consumers are
// production modules. Rectangle/text-range values are browser environment input;
// these bounded DOM tests do not claim real-browser visual/layout acceptance.
test('served template, actual native entry and runtime manifest connect one Search host and owner',()=>{
  const template=read('music_app/templates/index.html'),entry=read('music_app/static/js/home-friends/index-native.mjs'),build=read('scripts/build-runtime-bundle.cjs');
  assert.equal((template.match(/id=["']search-results-root["']/g)||[]).length,1);
  const tag=template.match(/<[^>]*id=["']search-results-root["'][^>]*>/);assert.ok(tag);assert.match(tag[0],/\bhidden\b/);
  assert.match(template,/js\/home-friends\/index-native\.mjs/);assert.match(template,/js\/runtime-bundle\.js/);
  assert.match(entry,/import\s*\{\s*mountSearchResults\s*\}\s*from\s*['"]\.\.\/search-results\/native\.mjs['"]/);
  assert.match(entry,/albumhaven:search-runtime-ready/);assert.match(entry,/mountSearchResults\(\{host, runtime\}\)/);
  const list=[...build.matchAll(/['"](js\/runtime\/[^'"]+\.js)['"]/g)].map(x=>x[1]);
  const position=list.indexOf('js/runtime/search-results-runtime.js');assert.ok(position>=0);assert.equal(list.filter(x=>x==='js/runtime/search-results-runtime.js').length,1);
  for(const dependency of ['private-ui-transport.js','gallery-refresh-and-status.js','album-track-table.js','playtable-source.js','home-friends-bridge.js','playlists-react-bridge.js'])assert.ok(list.indexOf('js/runtime/'+dependency)<position,dependency);
  assert.ok(position<list.indexOf('js/runtime/bootstrap-init.js'));
  assert.doesNotMatch(read('music_app/static/js/search-results/native.mjs'),/from\s*['"](?:react|react-dom)/);
});

for(const order of ['runtime-first','module-first'])test(`actual entry mounts exactly one Search consumer with ${order} delivery`,async t=>{
  const h=fixture(t,{holdRuntime:order==='module-first'});await h.entry();if(order==='module-first')h.loadRuntime();
  await admit(h);assert.equal(h.host.hidden,false);assert.equal(h.host.querySelectorAll('[data-search-results-content]').length,1);
  assert.equal(h.host.querySelectorAll('[role="tablist"]').length,1);
  const before=h.host.querySelector('[data-search-results-content]');h.c.dispatchEvent(new h.c.Event('albumhaven:search-runtime-ready'));
  assert.equal(h.host.querySelector('[data-search-results-content]'),before,'duplicate ready event cannot remount exact host/runtime pair');
  // Capture the exact singleton owner for teardown; this does not remount it.
  await h.mount();assert.equal(h.host.querySelector('[data-search-results-content]'),before);
});

test('actual native Tracks consumer renders one flat selectable table with Artist/Album/duration and no track-match paint',async t=>{
  const h=fixture(t);await h.mount();const payload=ready({presentation:'tracks'});payload.tracks[0].title='<Private & title>';payload.tracks[0].matches_search=true;
  await admit(h,payload);h.resize(1100);
  assert.equal(h.host.querySelectorAll('.compact-data-table').length,1);assert.equal(h.host.querySelectorAll('.album-track-table__row').length,2);
  assert.equal(h.host.querySelectorAll('.album-track-table__disc').length,0,'different parent albums remain flat');
  assert.match(h.host.textContent,/<Private & title>/);assert.match(h.host.textContent,/Witness Artist/);assert.match(h.host.textContent,/Witness album 12/);assert.match(h.host.textContent,/1:30/);
  for(const key of ['title','artist','album','duration'])assert.ok(h.host.querySelector(`[data-cdt-column="${key}"]`),`native ${key} cell exists`);
  assert.equal(h.host.querySelectorAll('.album-track-table__row--search-match,[data-track-search-match="true"],.album-card--search-match').length,0);
  assert.equal(h.host.querySelectorAll('.play-track-button,[data-open-tracklist],[data-track-row-path],[data-track-path]').length,0);
  const selectableRows=[...h.host.querySelectorAll('.album-track-table__row')];
  for(const row of selectableRows){assert.equal(row.tabIndex,0,'native selectable rows are keyboard reachable');assert.equal(row.getAttribute('aria-selected'),null);}
  selectableRows[0].focus();h.dispatch(selectableRows[0],'keydown',{key:' ',ctrlKey:true});
  assert.equal(selectableRows[0].getAttribute('aria-selected'),'true','actual keyboard selection paints only the selected row');
  assert.equal(selectableRows[1].getAttribute('aria-selected'),null);
  h.dispatch(selectableRows[1],'keydown',{key:' ',ctrlKey:true});
  assert.ok(selectableRows.every(row=>row.getAttribute('aria-selected')==='true'),'native multiselection retains both rows');
  assert.equal(h.requests.length,1,'selection alone grants no native action request');
  assert.equal(h.host.innerHTML.includes('inventory-track:'),false,'display never publishes inventory track authority');
  assert.equal(h.host.innerHTML.includes('listener-history-v1'),false);
});

test('gallery-only matching requires an admitted album witness; no query-text inference',async t=>{
  const h=fixture(t);await h.mount();await admit(h,ready({patch:{artist_groups:[{artist:'Witness Artist',artist_display:'Witness Artist',albums:[album(11,{name:'Name unrelated to query'})]}]}}));
  assert.equal(h.host.querySelectorAll('.album-card--search-match').length,1);assert.match(h.host.textContent,/Name unrelated to query/);
  const payload=ready({query:':obsessed',patch:{artist_groups:[{artist:'Witness Artist',albums:[album(11,{name:':obsessed',matches_search:false})]}]}}),work=h.read(mainUrl(payload));h.reply(1,payload);await work;
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.host.querySelectorAll('.album-card').length,0,'query text cannot supply a missing witness');
});

test('native tabs activate genuine presentation read, preserve query/selection and synchronously remove old controls',async t=>{
  const h=fixture(t);await h.mount();const before=await admit(h),old=h.host.querySelector('[data-search-results-content]');
  const tracks=h.host.querySelector('[data-in-page-tab="tracks"]');assert.ok(tracks);h.click(tracks);
  assert.equal(h.runtime().isCurrent(before),false);assert.ok(!old.isConnected||old.hidden&&old.inert);assert.equal(h.requests.length,2);
  const url=new URL(h.requests[1].url,h.location);assert.equal(url.searchParams.get('q'),':loved');assert.equal(url.searchParams.get('artist'),'Witness Artist');assert.equal(url.searchParams.get('search_presentation'),'tracks');
  assert.equal(h.runtime().snapshot().status,'loading');h.reply(1,ready({presentation:'tracks'}));await h.invocations.at(-1).outcome;
  assert.equal(h.host.querySelector('[data-in-page-tab="tracks"]').getAttribute('aria-selected'),'true');
});

test('real measured columns and native menu choices preserve same-source cells and focus through Sidebar publications',async t=>{
  const h=fixture(t);await h.mount();const payload=ready({presentation:'tracks'}),snapshot=await admit(h,payload);h.resize(1100);
  const cells=[...h.host.querySelectorAll('[data-cdt-column]')],row=h.host.querySelector('.album-track-table__row');
  const columns=h.host.querySelector('[data-track-table-columns]');assert.ok(columns);columns.focus();h.click(columns);
  const menu=h.document.querySelector('.settings-foobar-format-menu');assert.ok(menu,'actual native choice owner opened a menu');
  const hideArtist=[...menu.querySelectorAll('button')].find(node=>node.textContent.trim()==='Hide Artist');assert.ok(hideArtist);h.click(hideArtist);
  assert.equal(h.document.activeElement,columns,'native choice restores focus to real trigger');
  assert.equal(row,h.host.querySelector('.album-track-table__row'));assert.deepEqual([...h.host.querySelectorAll('[data-cdt-column]')],cells);
  assert.ok(h.host.querySelector('[data-cdt-column="artist"]').hasAttribute('data-cdt-responsive-hidden'));
  h.click(h.button(/^Continue artists$/));assert.equal(h.runtime().snapshot().sourceIdentity,snapshot.sourceIdentity);assert.equal(h.document.activeElement,columns);
  h.reply(1,child(payload,{cursor:null}));await h.flush();assert.deepEqual([...h.host.querySelectorAll('[data-cdt-column]')],cells);assert.equal(h.document.activeElement,columns);
  assert.ok(h.host.querySelector('[data-cdt-column="artist"]').hasAttribute('data-cdt-responsive-hidden'),'explicit choices survive same-result notification');
  h.resize(320);assert.ok(h.host.querySelector('[data-cdt-column="album"]').hasAttribute('data-cdt-responsive-hidden'));
  h.resize(1100);assert.ok(h.host.querySelector('[data-cdt-column="artist"]').hasAttribute('data-cdt-responsive-hidden'),'choice survives measured resizing');
});

for(const kind of ['empty','selected-pending','first-witness'])test(`native ${kind} state presents status and only bounded applicable controls`,async t=>{
  const h=fixture(t);await h.mount();const payload=kind==='empty'?ready({patch:{selected_artist:null,selection_state:'empty',artist_groups:[],tracks:[],page:{limit:50,returned_count:0,has_more:false,next_cursor:null},sidebar:{artists:[],returned_count:0,has_more:false,next_cursor:null}}}):kind==='selected-pending'?pending():firstWitness('albums',{page:{limit:50,returned_count:0,has_more:false,next_cursor:null}});
  const snapshot=await admit(h,payload);assert.equal(h.host.querySelectorAll('.album-card,.album-track-table__row').length,0);assert.ok(h.host.querySelector('[role="status"]'));
  if(kind==='empty'){assert.match(h.host.textContent,/No matching albums/);assert.equal(h.host.querySelectorAll('[data-track-table-columns]').length,0);}
  else{assert.equal(snapshot.actionable,false);assert.equal(snapshot.sourceIdentity,null);assert.match(h.host.textContent,/Still checking/);const button=h.button(/^Continue$/);h.click(button);assert.equal(h.requests.length,2,'one explicit bounded read');
    h.reply(1,ready({patch:kind==='selected-pending'?{sidebar:null}:{}}));await h.invocations.at(-1).outcome;}
});

test('native transient failure shows Retry; retry obtains fresh response without reusing old source or cursor',async t=>{
  const h=fixture(t);await h.mount();const before=await admit(h,ready({presentation:'tracks'})),lease=source(h,before);
  h.click(h.host.querySelector('[data-in-page-tab="albums"]'));h.requests[1].reject(new Error('Network unavailable'));await h.invocations.at(-1).outcome;await h.flush();
  assert.equal(lease.snapshot(),null);assert.equal(h.runtime().snapshot().status,'error');const retry=h.button(/^Retry$/);h.click(retry);
  assert.equal(h.requests.length,3);const url=new URL(h.requests[2].url,h.location);assert.equal(url.searchParams.get('search_cursor'),null);assert.equal(url.searchParams.get('search_sidebar_cursor'),null);
  h.reply(2,ready());await h.invocations.at(-1).outcome;assert.equal(h.runtime().snapshot().status,'ready');assert.notEqual(h.runtime().snapshot().sourceIdentity,before.sourceIdentity);
});

test('disposal and detached controls cannot navigate; actual table observers and menus are retired',async t=>{
  const h=fixture(t),consumer=await h.mount(),snapshot=await admit(h,ready({presentation:'tracks'})),lease=source(h,snapshot);h.resize(1000);
  const columns=h.host.querySelector('[data-track-table-columns]'),continueButton=h.button(/^Continue$/),content=h.host.querySelector('[data-search-results-content]');
  h.click(columns);assert.ok(h.document.querySelector('.settings-foobar-format-menu'));const activeResize=h.resizers.filter(x=>!x.retired&&[...x.nodes].some(node=>node===h.host||h.host.contains(node))),count=h.requests.length;
  consumer.dispose();assert.equal(h.host.hidden,true);assert.equal(h.runtime().isCurrent(snapshot),false);assert.equal(lease.snapshot(),null);
  assert.equal(content.isConnected,false);assert.ok(activeResize.every(x=>x.retired));assert.equal(h.document.querySelector('.settings-foobar-format-menu'),null);
  h.click(continueButton);h.click(columns);assert.equal(h.requests.length,count,'detached native handlers hold no request authority');
});

test('reentrant real native renderer cannot publish stale cells over a successor request',async t=>{
  const h=fixture(t);await h.mount();const original=h.c.buildCompactDataTable;let once=false,successor;
  h.c.buildCompactDataTable=function(...args){const html=original.apply(this,args);if(!once){once=true;successor=h.read(mainUrl(ready({query:':obsessed'})));}return html;};
  const old=h.read(mainUrl(ready({presentation:'tracks'})));h.reply(0,ready({presentation:'tracks'}));await old;
  assert.equal(once,true,'actual renderer seam ran');assert.ok(successor);assert.equal(h.host.querySelectorAll('.album-track-table__row').length,0);
  assert.equal(h.state.busy,true);h.reply(1,ready({query:':obsessed'}));await successor;assert.equal(h.host.querySelectorAll('.album-card').length,1);
});

test('removing the exact mounted host retires the consumer and old native source',async t=>{
  const h=fixture(t);await h.mount();const snapshot=await admit(h,ready({presentation:'tracks'})),lease=source(h,snapshot);
  h.host.remove();await h.flush();assert.equal(h.runtime().isCurrent(snapshot),false);assert.equal(lease.snapshot(),null);
});

test('actual gallery display transition updates Search presentation without replacing current flat-table cells or focus',async t=>{
  const h=fixture(t);await h.mount();const snapshot=await admit(h,ready({presentation:'tracks'}));h.resize(1000);
  const cells=[...h.host.querySelectorAll('[data-cdt-column]')],columns=h.host.querySelector('[data-track-table-columns]');columns.focus();
  h.c.transitionGalleryMain({type:'set-view',view:'covers'});
  assert.equal(h.runtime().snapshot().galleryDisplayMode,'covers');assert.equal(h.runtime().snapshot().sourceIdentity,snapshot.sourceIdentity);
  assert.deepEqual([...h.host.querySelectorAll('[data-cdt-column]')],cells);assert.equal(h.document.activeElement,columns);assert.equal(h.requests.length,1);
});

test('old host disposal cannot retire the exact same-runtime successor host publication',async t=>{
  const h=fixture(t),oldOwner=await h.mount(),snapshot=await admit(h,ready({presentation:'tracks'})),lease=source(h,snapshot);
  const successor=h.document.createElement('section');successor.id='search-results-root';h.host.remove();h.main.append(successor);
  const nextOwner=await h.mount(successor);assert.ok(nextOwner);assert.notEqual(nextOwner,oldOwner);await h.flush();oldOwner.dispose();
  assert.equal(h.runtime().isCurrent(snapshot),true);assert.ok(lease.snapshot());assert.equal(successor.hidden,false);
  assert.equal(successor.querySelectorAll('.album-track-table__row').length,2);assert.equal(h.requests.length,1);
});

test('old consumer disposal cannot retire a newly installed actual runtime and admitted successor',async t=>{
  const h=fixture(t),oldOwner=await h.mount(),oldRuntime=h.runtime();await admit(h,ready({presentation:'tracks'}));
  const replacement=h.replaceRuntime();assert.notEqual(replacement,oldRuntime);await h.mount();const snapshot=await admit(h,ready({query:':obsessed'}));
  oldOwner.dispose();oldRuntime.retire('obsolete-runtime');await h.flush();
  assert.equal(h.runtime(),replacement);assert.equal(replacement.isCurrent(snapshot),true);
  assert.equal(h.host.hidden,false);assert.equal(h.host.querySelectorAll('.album-card').length,1);
});
