'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {actionFixture}=require('./playlist-native-actions-fixture.cjs');
const {installNativeSearch}=require('./native-search-harness.cjs');
test('actual Playlist filters give canonical search its fixed accessible metadata on acquisition and retain it through updates',async t=>{
  const h=actionFixture();let search,owner,cleaned=false;
  const cleanup=()=>{
    if(cleaned)return;cleaned=true;
    try {owner?.dispose();}
    finally {
      try {(search?.template||h.document.querySelector('#native-search-field-template'))?.remove();}
      finally {try {h.host.remove();} finally {h.modal.remove();}}
    }
  };
  t.after(cleanup);
  search=installNativeSearch(h);h.runtime.searchHtml=search.render;
  const {mountPlaylistFilters}=await import(pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/playlists/native-app.mjs')).href);
  const changes=[],props=(query,availability,disabled=false)=>({filters:{query,availability},disabled,onChange:value=>changes.push(value)});
  owner=mountPlaylistFilters(h.host,h.runtime,props('','unresolved'));
  try {
    const input=h.host.querySelector('input[type="search"]');assert.ok(input);
    const metadata=()=>{assert.equal(input.getAttribute('aria-label'),'Find tracks');assert.equal(input.getAttribute('placeholder'),'Track, artist or album');assert.equal(h.host.querySelector('input[type="search"]'),input);};
    metadata();owner.update(props('Miles','missing',true));metadata();assert.equal(input.value,'Miles');assert.equal(input.disabled,true);
    owner.update(props('Coltrane','all'));metadata();assert.equal(input.value,'Coltrane');assert.equal(input.disabled,false);
    input.value='Kind of Blue';input.dispatchEvent(new h.context.Event('input',{bubbles:true}));assert.deepEqual(changes,[{query:'Kind of Blue'}]);
    owner.dispose();assert.equal(h.host.childNodes.length,0);input.dispatchEvent(new h.context.Event('input',{bubbles:true}));assert.equal(changes.length,1);
  } finally {cleanup();}
});
