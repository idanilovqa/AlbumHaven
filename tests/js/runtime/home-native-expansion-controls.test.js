const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {homeFixture,assertOwnQueue}=require('./widget-native-home-fixture.cjs');
const {buttonNamed}=require('./native-home-harness.cjs');
function suppressionSelectors(){
  const css=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/css/runtime/home-friends.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  const media=css.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1];assert.ok(media);
  return [...media.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, ,declarations])=>/\bdisplay:\s*none\s*(?:!important)?\s*;/.test(declarations))
    .flatMap(([,selectors])=>selectors.split(',').map(selector=>selector.trim())).filter(selector=>selector.includes('[data-dashboard-action]'));
}
test('actual Home retains nonexpanded widget controls while Album expansion owns Back',async t=>{
  const h=await homeFixture(t);h.section('queue');h.selectQueue('queue:one');await h.settle();
  const recent=buttonNamed(h.nodes.get('recent'),/^Full size$/),artist=buttonNamed(h.nodes.get('artist'),/^Full size$/);
  h.env.click(buttonNamed(h.nodes.get('album'),/^Full size$/));h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'album');
  assert.equal(buttonNamed(h.nodes.get('recent'),/^Full size$/),recent,'original source regression: nonexpanded Recent control must remain mounted');
  assert.equal(buttonNamed(h.nodes.get('artist'),/^Full size$/),artist);assert.equal(buttonNamed(h.nodes.get('album'),/^Full size$/,false),null);
  const back=buttonNamed(h.pageHeader,/^Back$/);assert.equal(h.pageHeader.querySelector('.home-header__leading').contains(back),true);
  assert.equal(h.nodes.get('recent').getAttribute('data-dashboard-widget-state'),'suppressed');
  h.render();assert.equal(buttonNamed(h.nodes.get('recent'),/^Full size$/),recent);
  h.resize(390);const selectors=suppressionSelectors();
  assert.ok(selectors.some(selector=>recent.matches(selector)));assert.ok(selectors.some(selector=>back.matches(selector)));
  h.selectPane('artist');h.render();assert.equal(h.page.getAttribute('data-home-pane'),'artist');
  h.env.click(buttonNamed(h.page.querySelector('.home-friends__pane-navigation'),/^Back to Queue$/));h.render();
  assert.equal(h.page.getAttribute('data-home-pane'),'recent');assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'album');
  h.resize(1200);assertOwnQueue(h.page);assert.equal(buttonNamed(h.pageHeader,/^Back$/),back);assert.equal(buttonNamed(h.nodes.get('recent'),/^Full size$/),recent);
  assert.deepEqual(h.navigation,[]);assert.deepEqual(h.env.forbiddenCalls,[]);
  h.dispose();assert.equal(recent.isConnected,false);assert.equal(artist.isConnected,false);assert.equal(back.isConnected,false);
});
test('actual Home switches retained nonexpanded Full size control to the one current Back owner',async t=>{
  const h=await homeFixture(t);h.section('queue');h.selectQueue('queue:one');await h.settle();
  h.env.click(buttonNamed(h.nodes.get('album'),/^Full size$/));h.render();
  const recent=buttonNamed(h.nodes.get('recent'),/^Full size$/);h.env.click(recent);h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'recent');assert.equal(buttonNamed(h.nodes.get('recent'),/^Full size$/,false),null);
  assert.equal(h.pageHeader.querySelectorAll('[data-dashboard-action="back"]').length,1);
  assert.ok(buttonNamed(h.nodes.get('album'),/^Full size$/));
  h.env.click(buttonNamed(h.pageHeader,/^Back$/));h.render();assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),null);
  assert.equal(buttonNamed(h.pageHeader,/^Back$/,false),null);
  for(const key of ['recent','artist','album'])assert.equal(h.nodes.get(key).querySelectorAll('[data-dashboard-action="expand"]').length,1);
  assert.deepEqual(h.navigation,[]);assert.deepEqual(h.env.forbiddenCalls,[]);
});
