const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
function fixture() {
  const env = withDomPlatform(createNativeHomeRuntime());
  env.context.Element.prototype.focus = function () {env.document.activeElement = this;};
  vm.runInContext(readRepo('music_app/static/js/runtime/in-page-tabs.js'), env.context);
  const host = env.document.createElement('section'); env.document.body.append(host);
  return {...env, host, runtime: {tabsHtml: env.owner('buildInPageTabsHtml'), mountTabs: env.owner('mountInPageTabs')}};
}
const props = {id: 'lifecycle-tabs', label: 'Views', value: 'a', items: [['a','A'],['b','B'],['c','C',{disabled:true}]]};
test('canonical tabs retain one owner and release listeners before remount', () => {
  const h=fixture(); h.host.innerHTML=h.runtime.tabsHtml({id:'tabs',label:'Views',selectedKey:'a',tabs:[{key:'a',label:'A'},{key:'b',label:'B'}]});
  const list=h.host.firstElementChild, a=list.children[0], b=list.children[1];
  const first=h.runtime.mountTabs(list); assert.equal(h.runtime.mountTabs(list),first); assert.equal(list.listeners.length,2);
  a.dispatchEvent(new h.context.Event('keydown',{key:'ArrowRight'})); assert.equal(b.getAttribute('aria-selected'),'true');
  first.dispose();first.dispose();assert.equal(list.listeners.length,0);
  a.dispatchEvent(new h.context.Event('click')); assert.equal(b.getAttribute('aria-selected'),'true');
  const next=h.runtime.mountTabs(list);assert.notEqual(next,first);assert.equal(list.listeners.length,2);
  first.dispose();assert.equal(list.listeners.length,2);a.dispatchEvent(new h.context.Event('click'));assert.equal(a.getAttribute('aria-selected'),'true');
  next.dispose();assert.equal(list.listeners.length,0);
});
test('native tabs wrapper disposes previous canonical owner on replacement and final teardown', async () => {
  const {mountTabs}=await import('../../../music_app/static/js/home-friends/native-controls.mjs');
  const h=fixture(),values=[],owner=mountTabs(h.host,h.runtime,{...props,onChange:v=>values.push(v)});
  const list=h.host.firstElementChild,a=list.children[0],b=list.children[1];
  a.focus();a.dispatchEvent(new h.context.Event('keydown',{key:'End'}));assert.equal(h.document.activeElement,b);assert.deepEqual(values,['b']);
  owner.update({...props,value:'b',onChange:v=>values.push(v)});assert.equal(list.listeners.length,0);assert.equal(h.document.activeElement.dataset.inPageTab,'b');
  const current=h.host.firstElementChild;assert.equal(current.listeners.length,2);a.dispatchEvent(new h.context.Event('click'));assert.deepEqual(values,['b']);
  owner.dispose();owner.dispose();assert.equal(current.listeners.length,0);assert.equal(h.host.listeners.length,0);assert.equal(h.host.childNodes.length,0);
  current.children[0].dispatchEvent(new h.context.Event('click'));assert.deepEqual(values,['b']);
});

for (const transition of ['dispose','replace']) test(`tabs renderer ${transition} cannot resurrect a retired update`, async () => {
  const {mountTabs}=await import('../../../music_app/static/js/home-friends/native-controls.mjs');
  const h=fixture(),render=h.runtime.tabsHtml;let owner,armed=false;
  h.runtime.tabsHtml=config=>{const html=render(config);if(armed){armed=false;if(transition==='dispose')owner.dispose();else owner.update({...props,value:'b',label:'Newest'});}return html;};
  owner=mountTabs(h.host,h.runtime,props);const old=h.host.firstElementChild;armed=true;
  owner.update({...props,label:'Obsolete'});
  assert.equal(old.listeners.length,0);
  if(transition==='dispose'){assert.equal(h.host.childNodes.length,0);assert.equal(h.host.listeners.length,0);}
  else{assert.equal(h.host.firstElementChild.getAttribute('aria-label'),'Newest');assert.equal(h.host.querySelector('[aria-selected="true"]').dataset.inPageTab,'b');}
  const latest=h.host.firstElementChild;owner.dispose();assert.equal(latest?.listeners.length||0,0);
});
test('tabs late canonical mount after disposal is released exactly once',async()=>{
  const {mountTabs}=await import('../../../music_app/static/js/home-friends/native-controls.mjs');
  const h=fixture(),mount=h.runtime.mountTabs;let owner,armed=false,late;
  h.runtime.mountTabs=list=>{const result=mount(list);if(armed){armed=false;late=list;owner.dispose();}return result;};
  owner=mountTabs(h.host,h.runtime,props);armed=true;owner.update({...props,value:'b'});
  assert.equal(late.listeners.length,0);assert.equal(h.host.childNodes.length,0);assert.equal(h.host.listeners.length,0);owner.dispose();
});

test('tabs same-HTML update during canonical acquisition preserves listeners and newest callback',async()=>{
  const {mountTabs}=await import('../../../music_app/static/js/home-friends/native-controls.mjs');
  const h=fixture(),mount=h.runtime.mountTabs,calls=[];let owner,armed=false;
  const next={...props,value:'b',onChange:value=>calls.push(value)};
  h.runtime.mountTabs=list=>{const result=mount(list);if(armed){armed=false;owner.update({...next});}return result;};
  owner=mountTabs(h.host,h.runtime,props);armed=true;owner.update(next);
  const list=h.host.firstElementChild;assert.equal(list.listeners.length,2);list.children[0].dispatchEvent(new h.context.Event('click'));assert.deepEqual(calls,['a']);
  owner.dispose();assert.equal(list.listeners.length,0);assert.equal(h.host.listeners.length,0);
});
