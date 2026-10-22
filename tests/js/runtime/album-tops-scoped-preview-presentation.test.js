'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,F,metadata}=require('./scoped-preview-fixtures/preview.cjs');
test('actual native separators preserve contiguous repeated Artist runs and exact Selected order',async t=>{
 const h=await setup(t);assert.deepEqual(h.keys(),[F.A,F.B,F.C]);assert.deepEqual(h.selected(),h.keys());
 assert.deepEqual(h.calls.separators.map(([x])=>({artist:x.artist,count:x.albumCount,info:x.showInfo})),[{artist:'First',count:1,info:false},{artist:'Second',count:1,info:false},{artist:'First',count:1,info:false}]);
 assert.equal(h.host.querySelectorAll('.family-artist-header').length,3);assert.equal(h.host.querySelectorAll('.family-artist-header button').length,0);
 assert.equal(h.calls.galleries.length,1);assert.equal(h.calls.metadata.length,1);assert.equal(h.calls.focus.length,1);
});
test('equal contiguous display labels count both exact identities without merging albums',async t=>{
 const h=await setup(t,{rows:[F.album(11,{artist:' Same '}),F.album(12,{artist:'Same'}),F.album(13,{artist:'Other'})]});
 assert.deepEqual(h.keys(),[F.A,F.B,F.C]);assert.deepEqual(h.calls.separators.map(([x])=>[x.artist,x.albumCount]),[['Same',2],['Other',1]]);assert.equal(h.calls.cards.length,3);
});
for(const artist of ['', '   '])test('empty display label uses Unknown artist without changing membership '+JSON.stringify(artist),async t=>{
 const h=await setup(t,{rows:[F.album(11,{artist})]});assert.equal(h.calls.separators[0][0].artist,'Unknown artist');assert.deepEqual(h.selected(),[F.A]);
});
test('minimal uses native CardInfo and Artbox with no Artist rating listening or media actions',async t=>{
 const h=await setup(t);for(const [x]of h.calls.cards){assert.equal(x.artist,'');assert.equal(x.listeningSummaryHtml,'');assert.equal(x.title.startsWith('Album '),true);assert.equal(x.year,2001);assert.equal(x.displayMode,'cards');assert.ok(x.artboxHtml.includes('artbox'));assert.ok(!x.actions?.open&&!x.actions?.complete);assert.equal(x.completion,undefined);}
 assert.equal(h.calls.ratings.length,0);assert.equal(h.host.querySelectorAll('[data-gallery-card-intent]').length,0);assert.equal(h.host.querySelectorAll('.gallery-card-info').length,3);assert.deepEqual(h.calls.preferences,[]);
});
test('full adds only real known rating and admitted Artist through actual native renderers',async t=>{
 const h=await setup(t,{props:{information:'full'}});assert.deepEqual(h.calls.cards.map(([x])=>x.artist),['First','Second','First']);assert.equal(h.calls.ratings.length,1);
 const rated=h.calls.cards[0][0];assert.ok(rated.ratingHtml);assert.equal(h.calls.cards[1][0].ratingHtml||'','');assert.equal(h.calls.cards[2][0].ratingHtml||'','');for(const [x]of h.calls.cards)assert.equal(x.listeningSummaryHtml,'');assert.deepEqual(h.calls.preferences,[]);
});
test('safe creation artwork is used and unrelated source artwork is ignored',async t=>{
 const url='/album-artwork?album_id=11';const h=await setup(t,{rows:[F.album(11,{creation_metadata:metadata(null,'available',url)}),F.album(12,{artwork_url:'https://untrusted.invalid/image',creation_metadata:metadata()})]});
 assert.equal(h.calls.art[0][0].state,'ready');assert.ok(h.calls.art[0][0].coverHtml.includes(url));assert.equal(h.calls.art[1][0].state,'empty');assert.doesNotMatch(h.host.innerHTML,/untrusted\.invalid/);
});
test('information changes remain local and do not change filters selection or preferences',async t=>{
 const h=await setup(t),before=h.draft.getSnapshot();assert.equal(h.update({information:'full'}),true);assert.equal(h.draft.getSnapshot(),before);assert.equal(h.update({information:'minimal'}),true);assert.equal(h.draft.getSnapshot(),before);assert.deepEqual(h.calls.preferences,[]);assert.deepEqual(h.api.calls.search,[]);
});
test('one whole-collection native geometry uses fixed compact width independent of Artist run count',async t=>{
 const h=await setup(t);const config=h.calls.galleries[0].options.readSnapshot();assert.equal(config.displayMode,'cards');assert.equal(config.layoutConfig.cardMinWidth,145);assert.equal(config.galleryScalePercent,100);
 const owner=h.calls.galleries[0].owner,root=owner.root;assert.ok(root);assert.equal(root.querySelectorAll('.family-artist-header').length,3);
 h.setRows([F.album(11,{artist:'Same'}),F.album(12,{artist:'Same'}),F.album(13,{artist:'Same'})]);await h.draft.refreshArtistPopulation();h.update();assert.equal(h.calls.galleries.length,1);assert.equal(h.calls.galleries[0].options.readSnapshot().layoutConfig.cardMinWidth,145);assert.equal(root.querySelectorAll('.family-artist-header').length,1);
});
test('unchanged update preserves keyed rows native cards controls and focused Move identity',async t=>{
 const h=await setup(t),rows=h.rows(),cards=rows.map(row=>row.querySelector('.album-card')),moves=rows.map(row=>row.querySelector('[data-album-draft-move]')),remove=rows.map(row=>row.querySelector('[data-album-draft-remove]'));assert.ok(moves.every(Boolean)&&remove.every(Boolean));moves[1].focus();
 assert.equal(h.update(),true);assert.deepEqual(h.rows(),rows);assert.deepEqual(h.rows().map(row=>row.querySelector('.album-card')),cards);assert.deepEqual(h.rows().map(row=>row.querySelector('[data-album-draft-move]')),moves);assert.deepEqual(h.rows().map(row=>row.querySelector('[data-album-draft-remove]')),remove);assert.equal(h.document.activeElement,moves[1]);
});
test('genuine metadata refresh reconciles actual content while retaining keyed outer row',async t=>{
 const h=await setup(t),row=h.row(F.A);h.setRows([F.album(11,{title:'Changed title',year:2020,artist:'New Artist',creation_metadata:metadata(9)}),F.album(12),F.album(13)]);await h.draft.refreshArtistPopulation();h.update({information:'full'});assert.equal(h.row(F.A),row);assert.match(row.textContent,/Changed title/);assert.match(row.textContent,/2020/);assert.match(row.textContent,/New Artist/);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
});
test('native Remove delegates exact identity to actual draft and exclusion survives Reset',async t=>{
 const h=await setup(t);h.click(h.row(F.B).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),[F.A,F.C]);h.update();assert.deepEqual(h.keys(),[F.A,F.C]);h.draft.resetArtistFilters();h.update();assert.deepEqual(h.keys(),[F.A,F.C]);
});
test('filter refresh uses authoritative current Selected without retaining filtered rows',async t=>{
 const h=await setup(t);h.draft.setArtistFilters({minRating:7});h.update();assert.deepEqual(h.keys(),[F.A]);h.draft.resetArtistFilters();h.update();assert.deepEqual(h.keys(),[F.A,F.B,F.C]);
});
test('empty current Selected renders no album or separator and never queries search',async t=>{
 const h=await setup(t,{rows:[]});assert.deepEqual(h.rows(),[]);assert.equal(h.host.querySelectorAll('.family-artist-header').length,0);assert.deepEqual(h.api.calls.search,[]);assert.equal(h.update(),true);
});
