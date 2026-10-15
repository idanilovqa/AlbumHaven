const test=require('node:test'),assert=require('node:assert/strict');
const {nativeDialogFixture}=require('./playlist-native-dialog-fixture.cjs');
const {fixture}=require('./playlist-native-review-fixture.cjs');
const setup=()=>import('../../../music_app/static/js/playlists/native-library-mix.mjs');
for(const delayed of [false,true])test(`Library Mix releases partial actual owners before ${delayed?'deferred mobile':'desktop'} fallback Close`,async()=>{
 const {mountLibraryMixSetup}=await setup(),h=nativeDialogFixture({delayed}),original=h.runtime.buttonHtml,baseline=h.listeners().length;let buttonCalls=0,subscriptions=0,prepares=0,closes=0;
 const listeners=new Set(),controller={getSnapshot:()=>({resource:{status:'unavailable'}}),subscribe(fn){subscriptions++;listeners.add(fn);return()=>listeners.delete(fn);},prepare(){prepares++;return false;}};
 h.runtime.buttonHtml=value=>{buttonCalls++;if(buttonCalls===2){const trigger=h.document.getElementById('app-form-content').querySelector('button');assert.ok(trigger);trigger.focus();h.click(trigger);assert.equal(h.menus.length,1);throw new Error('injected second control failure');}return original(value);};
 const owner=mountLibraryMixSetup(h.host,h.runtime,{controller,onReady:assert.fail,onClose(){closes++;}});
 assert.equal(subscriptions,0);assert.equal(listeners.size,0);assert.equal(prepares,0);assert.equal(closes,0);assert.equal(h.menus[0].isOpen,false);assert.equal(h.menus[0].closes,1);assert.equal(h.closeAttempts,1);assert.equal(h.listeners().length,baseline+1,'only explicit fallback Close listener survives');assert.match(h.host.textContent,/not available/);
 owner.update({controller,onReady:assert.fail,onClose(){closes++;}});assert.equal(subscriptions,0);assert.equal(prepares,0);await h.settle();assert.equal(closes,0);assert.match(h.host.textContent,/not available/);const close=h.host.querySelector('button');h.click(close);h.click(close);assert.equal(closes,1);owner.dispose();owner.dispose();assert.equal(h.listeners().length,baseline);assert.equal(listeners.size,0);
});
test('Library Mix null native open has no operational subscription and fallback reports Close once',async()=>{
 const {mountLibraryMixSetup}=await setup(),h=nativeDialogFixture();let subscriptions=0,prepares=0,closes=0;h.runtime.openForm=()=>null;
 const controller={getSnapshot:()=>({resource:{status:'unavailable'}}),subscribe(){subscriptions++;return()=>{};},prepare(){prepares++;}},owner=mountLibraryMixSetup(h.host,h.runtime,{controller,onReady:assert.fail,onClose:()=>closes++});
 assert.equal(subscriptions,0);assert.equal(prepares,0);assert.equal(closes,0);owner.update({controller,onReady:assert.fail,onClose:()=>closes++});const close=h.host.querySelector('button');assert.ok(close);h.click(close);h.click(close);assert.equal(closes,1);owner.dispose();owner.dispose();assert.equal(subscriptions,0);
});
test('playtable selection releases first native button if a later native button renderer throws',async()=>{
 const {mountPlaytableSelection}=await import('../../../music_app/static/js/playtables/native-selection.mjs'),h=fixture(),actions=h.document.createElement('div');h.document.body.append(actions);const original=h.runtime.buttonHtml,baseline=h.listeners().length;let calls=0;
 h.runtime.buttonHtml=value=>{if(++calls===2)throw new Error('second selection button failed');return original(value);};
 assert.throws(()=>mountPlaytableSelection(h.host,{runtime:h.runtime,actionsHost:actions,sourceAdapter:{snapshot:()=>null,subscribe:()=>()=>{}}}),/second selection button failed/);assert.equal(h.listeners().length,baseline);assert.equal(actions.childNodes.length,0);
});
test('filter constructor releases a successful native Choice before another renderer fails',async()=>{
 const {mountPlaylistFilterControls}=await import('../../../music_app/static/js/playlists/native-directory-filters.mjs'),{defaultFilters}=await import('../../../music_app/static/js/playlists/model.mjs'),h=fixture(),original=h.runtime.buttonHtml,baseline=h.listeners().length;let calls=0;
 h.runtime.buttonHtml=value=>{if(++calls===2){h.click(h.host.querySelector('button'));throw new Error('second filter failed');}return original(value);};
 assert.throws(()=>mountPlaylistFilterControls(h.host,h.runtime,{filters:defaultFilters,rows:[],onChange:assert.fail}),/second filter failed/);assert.equal(h.listeners().length,baseline);assert.equal(h.menus[0].isOpen,false);assert.equal(h.host.childNodes.length,0);
});
test('selection panel releases native Close if initial native tabs construction fails',async()=>{
 const {mountPlaylistSelectionPanel}=await import('../../../music_app/static/js/playlists/native-selection.mjs'),h=fixture(),baseline=h.listeners().length;
 h.runtime.tabsHtml=()=>{throw new Error('tabs construction failed');};assert.throws(()=>mountPlaylistSelectionPanel(h.host,h.runtime,{scopeKey:'s',row:{row_key:'one',source_readable:true},onClose:assert.fail}),/tabs construction failed/);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
test('mutation status releases the already mounted retry owner when initial alert rendering fails',async()=>{
 const {mountMutationStatus}=await import('../../../music_app/static/js/playlists/native-mutation-status.mjs'),h=fixture(),baseline=h.listeners().length;
 h.runtime.alertHtml=()=>{throw new Error('initial mutation alert failed');};assert.throws(()=>mountMutationStatus(h.host,h.runtime,{value:{status:'error'},controller:{getSnapshot:()=>({scopeKey:'s'})}}),/initial mutation alert failed/);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
