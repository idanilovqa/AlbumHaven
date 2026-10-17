'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load} = require('./home-friends-native-app-fixture.cjs');

const visibility = {label:'Visibility',visibility:'private',note:'Owner access'};
const reader = {value:{visibility:'server_shared',can_request_edit:true,request_status:'none'}};
const decision = {request:{display_name:'Member'},role:'editor'};

// Keep the real foundation owners/renderers. Fail only a specified renderer
// invocation after earlier owners have acquired actual DOM listeners.
for (const [name,initial,label,invocation] of [
  ['mountSharingVisibility',visibility,'Private',2],
  ['mountSharingReaderAccess',reader,'Request edit access',2],
  ['mountSharingRequestDecision',decision,'Decline',1],
  ['mountSharingRequestDecision',decision,'Apply',2],
  ['mountSharingRequestDecision',decision,'Decline',2],
]) test(`${name} unwinds partial owners on ${label} renderer failure ${invocation}`,async t=>{
  const h=fixture(t),sharing=await load('resource-sharing.mjs'),baseline=h.listeners().length;
  const renderer=h.runtime.buttonHtml, failure=new Error('deterministic sharing renderer failure');
  let calls=0,retained=[],effects=0;
  h.runtime.buttonHtml=value=>{
    if(value.label===label&&++calls===invocation){retained=h.host.querySelectorAll('button');throw failure;}
    return renderer(value);
  };
  assert.throws(()=>sharing[name](h.host,h.runtime,{...initial,onChange:()=>effects++,onRequest:()=>effects++,onRole:()=>effects++,onDecision:()=>effects++}),error=>error===failure);
  assert.ok(retained.length,'earlier native controls were actually constructed');
  assert.equal(h.host.childNodes.length,0);
  assert.equal(h.listeners().length,baseline,'listeners on detached acquired children are retired');
  for(const button of retained)h.click(button);
  assert.equal(effects,0,'retained controls cannot invoke stale authority');
});

for (const [name,initial] of [['mountSharingVisibility',visibility],['mountSharingReaderAccess',reader],['mountSharingRequestDecision',decision]])
  test(`${name} retires its returned owner if a later native update throws`,async t=>{
    const h=fixture(t),sharing=await load('resource-sharing.mjs'),baseline=h.listeners().length;
    let effects=0;
    const owner=h.own(sharing[name](h.host,h.runtime,{...initial,onChange:()=>effects++,onRequest:()=>effects++,onRole:()=>effects++,onDecision:()=>effects++}));
    const retained=h.host.querySelectorAll('button');assert.ok(h.listeners().length>baseline);
    const renderer=h.runtime.buttonHtml,failure=new Error('later update failed');h.runtime.buttonHtml=()=>{throw failure;};
    assert.throws(()=>owner.update(initial),error=>error===failure);
    assert.equal(h.host.childNodes.length,0);assert.equal(h.listeners().length,baseline);
    h.runtime.buttonHtml=renderer;owner.update(initial);assert.equal(h.host.childNodes.length,0,'failed owner remains retired');
    retained.forEach(button=>h.click(button));assert.equal(effects,0);owner.dispose();assert.equal(h.listeners().length,baseline);
  });

test('sharing member failure removes partial presentation without replacing a surviving actions slot',async t=>{
  const h=fixture(t),{mountSharingMember}=await load('resource-sharing.mjs');
  assert.throws(()=>mountSharingMember(h.host,{person:null}),TypeError);assert.equal(h.host.childNodes.length,0);
  const owner=h.own(mountSharingMember(h.host,{person:{display_name:'First'}})),actions=owner.actions;
  owner.update({person:{display_name:'Second'}});assert.equal(owner.actions,actions);assert.equal(actions.isConnected,true);
  assert.throws(()=>owner.update({person:null}),TypeError);assert.equal(actions.isConnected,false);assert.equal(h.host.childNodes.length,0);
});

test('sharing update failure closes the real choice lease and makes retained selection inert',async t=>{
  const h=fixture(t),{mountSharingRequestDecision}=await load('resource-sharing.mjs');
  const openChoice=h.runtime.openChoice;let lease,select,closes=0,effects=0;
  h.runtime.openChoice=(trigger,options)=>{select=options.onSelect;const native=openChoice(trigger,options);lease=native;return {...native,close(options){closes++;return native.close(options);}};};
  const owner=h.own(mountSharingRequestDecision(h.host,h.runtime,{...decision,onRole:()=>effects++}));
  const choice=h.host.querySelector('[aria-haspopup="menu"]');h.click(choice);assert.ok(lease,'real native dropdown lease opened');
  const renderer=h.runtime.buttonHtml;h.runtime.buttonHtml=value=>{if(value.label==='Apply')throw new Error('apply update failure');return renderer(value);};
  assert.throws(()=>owner.update({...decision,onRole:()=>effects++}),/apply update failure/);
  assert.equal(closes,1);assert.equal(h.host.childNodes.length,0);select('viewer');assert.equal(effects,0);
  owner.dispose();assert.equal(closes,1,'already-retired lease is not disposed twice');
});

test('sharing failure preserves its cause and retires other controls when native choice cleanup throws',async t=>{
  const h=fixture(t),{mountSharingRequestDecision}=await load('resource-sharing.mjs'),openChoice=h.runtime.openChoice;
  h.runtime.openChoice=(trigger,options)=>{const native=openChoice(trigger,options);return {...native,close(options){native.close(options);throw new Error('secondary cleanup failure');}};};
  const owner=h.own(mountSharingRequestDecision(h.host,h.runtime,decision));
  const acquired=h.listeners().filter(listener=>h.host.contains(listener.target));assert.ok(acquired.length>=4);
  h.click(h.host.querySelector('[aria-haspopup="menu"]'));
  const renderer=h.runtime.buttonHtml,cause=new Error('primary update failure');h.runtime.buttonHtml=value=>{if(value.label==='Apply')throw cause;return renderer(value);};
  assert.throws(()=>owner.update(decision),error=>error===cause);
  assert.equal(h.host.childNodes.length,0);for(const listener of acquired)assert.equal(h.listeners().includes(listener),false,'every acquired control listener retired');
  owner.dispose();
});
