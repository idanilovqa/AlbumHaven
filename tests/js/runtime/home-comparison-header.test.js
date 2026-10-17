const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {requireOwner} = require('./native-home-harness.cjs');
const {fixture: nativeFixture, load, settle} = require('./home-friends-native-app-fixture.cjs');

// Full native Home and canonical controller; only provider responses are controlled.
async function fixture(t, {mode='comparison',kind='albums',friend=true,profile=false,name='Maya'}={}) {
  const h=nativeFixture(t), {createHomeFriendsController}=await load('model.mjs'), {mountHomeFriendsView}=await load('app.mjs');
  // The real Home view also owns its retained Recent widget while Friends is
  // selected. Supply the canonical native dependency, not a successful stub.
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/home-recent.js'),'utf8'),h.context);
  const recent = requireOwner(h,'HomeRecent');
  h.runtime.mountRecent = (host,options) => recent.mount(host,options);
  const navigations=[],saves=[],reads=[];
  const person={account_ref:'friend:one',display_name:name,relationship:'accepted',allowed_actions:{can_compare:true,can_view_activity:true}};
  const controller=createHomeFriendsController({providers:{
    readFriends:async()=>({profile:{display_name:'You'},friends:friend?[person]:[],requests:[]}),
    readComparison:async request=>{reads.push(['comparison',request]);return {rows:[],next_cursor:null};},
    readActivity:async request=>{reads.push(['activity',request]);return {rows:[]};},
    readProfile:async request=>{reads.push(['profile',request]);return {profile:person};},
  }});
  controller.setScope('account:one/library:one');await controller.loadFriends();
  const shell={section:'friends',friendRef:friend&&!profile?person.account_ref:'',profileRef:profile?'member:one':'',presentation:{friendMode:mode,friendKind:kind,friendPeriod:'month'}};
  Object.assign(h.runtime,{savePresentation:(value,expected)=>saves.push({value,expected}),navigate:value=>navigations.push(value)});
  let owner;const props=()=>({runtime:h.runtime,controller,state:controller.getSnapshot(),shell});
  const unsubscribe=controller.subscribe(()=>owner?.update(props()));
  owner= h.own(mountHomeFriendsView(h.host,props()));owner.update(props());await settle();h.drain();await settle();
  const initialReads=reads.slice();reads.length=0;saves.length=0;
  t.after(()=>{owner.dispose();unsubscribe();controller.dispose();});
  return {...h,controller,shell,navigations,saves,reads,initialReads,
    render(){owner.update(props());return h.host;},
    clickNativeButton(button){assert.ok(button);assert.ok(button.querySelector('svg'));h.click(button.querySelector('svg'));return button;}};
}
const header=h=>h.host.querySelector('.home-friends__page-header');
const backButtons=root=>root.querySelectorAll('button').filter(node=>/^(Back to friends|Back to Home)$/.test(node.getAttribute('aria-label')||node.textContent.trim()));

test('comparison places its single Back action beside the identity and hands the header host to the panel', async t=>{
  for(const kind of ['albums','tracks','artists']) {
    const h=await fixture(t,{kind}), page=header(h), back=page.querySelector('[data-home-comparison-back]');
    assert.equal(backButtons(h.host).length,1);assert.equal(backButtons(page).length,1);
    assert.equal(back.getAttribute('aria-label'),'Back to friends');
    assert.ok(page.querySelector('.home-profile__comparison-identity'));assert.equal(page.querySelector('.home-profile__identity:not(.home-profile__comparison-identity)'),null);
    assert.equal(page.querySelector('[data-home-open-friends]'),null);
    const slot=page.querySelector('[data-home-comparison-view-host="true"]');assert.ok(slot);assert.equal(slot.hidden,false);
    const panel=h.host.querySelector('.home-comparison');assert.equal(panel.dataset.comparisonKind,kind);
    assert.equal(h.initialReads.length,1);assert.equal(h.initialReads[0][0],'comparison');
    assert.equal(h.initialReads[0][1].account_ref,'friend:one');assert.equal(h.initialReads[0][1].kind,kind);assert.equal(h.initialReads[0][1].period,'month');
    assert.ok(panel.querySelector('[role="tablist"]'));assert.ok(panel.querySelector('button[aria-label="Period: Last month"]'));
    if(kind==='albums')assert.ok(slot.querySelector('[aria-label="Comparison album view"]'));else assert.equal(slot.querySelector('[aria-label="Comparison album view"]'),null);
    const widget=h.host.querySelector('[data-home-widget="friends"]');assert.equal(backButtons(widget).length,0);
    assert.equal(widget.querySelector('.home-friends__widget-header').hidden,true);
    h.render();assert.strictEqual(page.querySelector('[data-home-comparison-view-host]'),slot);
    assert.deepEqual(h.reads,[],'stable host updates do not acquire a second provider request');
  }
});

test('comparison Back and long identity occupy separate horizontal tracks in the existing header context',async t=>{
  const name='A very long friend name that must wrap within the available identity track',h=await fixture(t,{name}),page=header(h);
  const back=page.querySelector('[data-home-comparison-back]'),identity=page.querySelector('.home-profile__comparison-identity');
  assert.ok(back);assert.ok(identity);assert.ok(identity.querySelector('h1').textContent.includes(name));
  assert.notEqual(back.parentNode,identity.parentNode,'native leading and identity slots are independent');
  assert.equal(identity.contains(back),false);assert.equal(page.querySelectorAll('[data-home-comparison-back]').length,1);
  const leading=back.closest('.home-header__leading'), identitySlot=identity.closest('.home-header__identity'), controls=page.querySelector('.home-header__controls');
  assert.strictEqual(leading.parentNode,page);assert.strictEqual(identitySlot.parentNode,page);assert.strictEqual(controls.parentNode,page);
  assert.ok(page.children.indexOf(leading)<page.children.indexOf(identitySlot));
  assert.ok(page.children.indexOf(identitySlot)<page.children.indexOf(controls));
  assert.equal(identity.closest('[hidden], [inert], [aria-hidden="true"]'),null);
  assert.equal(back.closest('[hidden], [inert], [aria-hidden="true"]'),null);
  const css=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/css/runtime/home-friends.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  const rule=selector=>{
    const entry=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match=>match[1].trim()===selector);
    assert.ok(entry,`current native header rule: ${selector}`);return entry[2];
  };
  const shared=rule('.gallery-bar.home-header');
  assert.match(shared,/display:\s*flex/);assert.match(shared,/flex-direction:\s*row/);assert.match(shared,/min-width:\s*0/);
  const identityRule=rule('.home-header__identity');
  assert.match(identityRule,/min-width:\s*0/);assert.match(identityRule,/max-width:\s*100%/);
  assert.match(rule('.home-friends__page-header h1'),/overflow-wrap:\s*anywhere/);
  const controlsRule=rule('.home-header__controls');
  assert.match(controlsRule,/flex:\s*0\s+0\s+auto/);
  assert.match(controlsRule,/margin-inline-start:\s*auto/);
  const actionRule=rule('.home-header__actions, .home-header__outside');
  assert.match(actionRule,/width:\s*max-content/);assert.match(actionRule,/flex:\s*0\s+0\s+auto/);
  // Default flex-wrap is nowrap: desktop controls remain one horizontal group.
  assert.doesNotMatch(controlsRule+actionRule,/flex-wrap:\s*wrap/);
  assert.ok(controls.querySelector('[data-home-comparison-view-host]'));

});

test('the header Back native icon preserves the Friends destination and does not start a comparison read',async t=>{
  const h=await fixture(t),button=h.clickNativeButton(header(h).querySelector('[data-home-comparison-back]'));
  assert.equal(button.getAttribute('data-home-comparison-back'),'true');assert.equal(button.getAttribute('aria-label'),'Back to friends');
  assert.deepEqual(h.navigations,[{section:'friends',friend:'',profile:''}]);assert.equal(h.saves.length,1);assert.strictEqual(h.saves[0].expected,h.shell);
  assert.equal(h.saves[0].value.friendMode,'comparison');assert.deepEqual(h.reads,[]);assert.deepEqual(h.forbiddenCalls,[]);
});

test('activity, directory and profile routes retain the Friends header action and their existing widget Back destinations',async t=>{
  for(const [options,destination] of [[{mode:'activity'},'friends'],[{friend:false},'recent'],[{profile:true},'friends']]) {
    const h=await fixture(t,options),page=header(h);
    assert.ok(page.querySelector('.home-profile__identity'));assert.equal(page.querySelector('.home-profile__comparison-identity'),null);
    assert.equal(page.querySelector('[data-home-comparison-view-host]').hidden,true);
    assert.ok(page.querySelector('[data-home-open-friends="true"]'));assert.equal(backButtons(page).length,0);assert.equal(backButtons(h.host).length,1);
    h.clickNativeButton(backButtons(h.host)[0]);assert.deepEqual(h.navigations,[{section:destination,friend:'',profile:''}]);assert.deepEqual(h.reads,[]);
  }
});
