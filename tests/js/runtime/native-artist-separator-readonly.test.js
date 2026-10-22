'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./home-friends-native-app-fixture.cjs');
// Frozen public811 presentation oracle; the actual renderer is always invoked
// separately. Shared escaping/glyph/plural owners remain the real VM owners.
function legacy(c,config={}) {
  return `<div class="family-artist-header" data-scroll-artist="${c.escapeHtml(config.artist || '')}" data-gallery-album-count="${Math.max(0, Number(config.albumCount || 0))}"><h2 class="artist-name">${c.escapeHtml(config.artist || '')}</h2><button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${c.escapeHtml(config.infoArtist || config.artist || '')}" aria-label="Information about ${c.escapeHtml(config.infoArtist || config.artist || '')}" aria-expanded="false">${c.buildGalleryInfoGlyphHtml()}</button><span class="gallery-divider__line"></span><span>${c.escapeHtml(c.galleryMainPlural(config.albumCount, 'album'))}</span></div>`;
}
const withoutButton=html=>html.replace(/<button class="gallery-info-button"[\s\S]*?<\/button>/,'');
for(const [name,extra] of [['omitted',{}],['undefined',{showInfo:undefined}],['true',{showInfo:true}],['null',{showInfo:null}],['zero',{showInfo:0}],['string',{showInfo:'false'}]])test('native Artist separator retains exact inherited output: '+name,t=>{
  const h=fixture(t),config={artist:'Main Artist',infoArtist:'Canonical Artist',albumCount:3,...extra};
  const html=h.c.buildFamilyArtistHeaderHtml(config);assert.equal(html,legacy(h.c,config));h.host.innerHTML=html;
  const button=h.host.querySelector('[data-artist-info-trigger]');assert.ok(button);assert.equal(button.getAttribute('data-artist'),'Canonical Artist');const glyph=button.querySelector('span.gallery-info-button__glyph');assert.ok(glyph);assert.equal(glyph.textContent,'i');
});
for(const count of [0,1,7])test('readonly separator removes only native info control and preserves count '+count,t=>{
  const h=fixture(t),config={artist:'Main Artist',infoArtist:'Canonical Artist',albumCount:count,showInfo:false};
  const html=h.c.buildFamilyArtistHeaderHtml(config);assert.equal(html,withoutButton(legacy(h.c,config)));h.host.innerHTML=html;
  assert.equal(h.host.querySelector('[data-artist-info-trigger]'),null);assert.equal(h.host.querySelector('button'),null);assert.equal(h.host.querySelector('svg'),null);
  const root=h.host.querySelector('.family-artist-header');assert.ok(root);assert.equal(root.getAttribute('data-scroll-artist'),'Main Artist');assert.equal(root.getAttribute('data-gallery-album-count'),String(count));
  assert.equal(root.querySelector('h2.artist-name').textContent,'Main Artist');assert.ok(root.querySelector('.gallery-divider__line'));assert.equal(root.lastElementChild.textContent,`${count} album${count===1?'':'s'}`);
});
for(const showInfo of [false,true])test('native separator safely escapes artist and information labels with showInfo='+showInfo,t=>{
  const h=fixture(t),artist='A "<img src=x onerror=bad()> & B',infoArtist='I "<script>bad()</script> & Q',config={artist,infoArtist,albumCount:2,showInfo};
  const html=h.c.buildFamilyArtistHeaderHtml(config);assert.equal(html,showInfo?legacy(h.c,config):withoutButton(legacy(h.c,config)));h.host.innerHTML=html;
  assert.equal(h.host.querySelector('img'),null);assert.equal(h.host.querySelector('script'),null);assert.equal(h.host.querySelector('[onerror]'),null);
  assert.equal(h.host.querySelector('.artist-name').textContent,artist);assert.equal(h.host.firstElementChild.getAttribute('data-scroll-artist'),artist);
  if(showInfo){const button=h.host.querySelector('button');assert.equal(button.getAttribute('data-artist'),infoArtist);assert.equal(button.getAttribute('aria-label'),'Information about '+infoArtist);}else assert.equal(h.host.querySelector('button'),null);
});
test('readonly rendering cannot change a later ordinary native Artist separator',t=>{
  const h=fixture(t),config={artist:'Artist',albumCount:1};const before=h.c.buildFamilyArtistHeaderHtml(config);
  assert.equal(h.c.buildFamilyArtistHeaderHtml({...config,showInfo:false}),withoutButton(before));assert.equal(h.c.buildFamilyArtistHeaderHtml(config),before);assert.equal(before,legacy(h.c,config));
});
