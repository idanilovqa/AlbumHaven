'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {fixture,load} = require('./home-friends-native-app-fixture.cjs');
const source = name => path.resolve(__dirname, '../../../music_app/static/js/home-friends', name);
// This is pure arithmetic over measured inputs, never simulated DOM geometry.
test('header fit uses measured content budgets including every inter-group gap', async () => {
  assert.ok(fs.existsSync(source('header-layout.mjs')), 'PRODUCT_NOT_IMPLEMENTED: measured header budget owner');
  const {headerActionsFit: fit} = await import(pathToFileURL(source('header-layout.mjs')).href);
  assert.equal(typeof fit, 'function');
  for (const [input, expected] of [
    [{availableWidth: 308, identityWidth: 100, actionsWidth: 200, gap: 8}, true],
    [{availableWidth: 307.99, identityWidth: 100, actionsWidth: 200, gap: 8}, false],
    [{availableWidth: 356, identityWidth: 100, actionsWidth: 200, outsideWidth: 40, gap: 8}, true],
    [{availableWidth: 355.99, identityWidth: 100, actionsWidth: 200, outsideWidth: 40, gap: 8}, false],
    [{availableWidth: 700, identityWidth: 420, actionsWidth: 300, gap: 8}, false],
    [{availableWidth: 300, identityWidth: 40, actionsWidth: 100, gap: 8}, true],
    [{availableWidth: 0, identityWidth: 0, actionsWidth: 0, gap: 0}, false],
    [{availableWidth: 250.5, identityWidth: 50.25, actionsWidth: 190.25, gap: 10}, true],
  ]) assert.equal(fit(input), expected, JSON.stringify(input));
});

test('header fit rejects unusable measurement inputs rather than declaring room', async () => {
  assert.ok(fs.existsSync(source('header-layout.mjs')), 'PRODUCT_NOT_IMPLEMENTED: measured header budget owner');
  const {headerActionsFit: fit} = await import(pathToFileURL(source('header-layout.mjs')).href);
  const valid = {availableWidth: 1000, identityWidth: 100, actionsWidth: 200, outsideWidth: 40, gap: 8};
  for (const field of Object.keys(valid)) for (const value of [NaN, Infinity, -1]) {
    assert.equal(fit({...valid, [field]: value}), false, `${field}: ${value}`);
  }
});

async function headerFixture(t,id,tail=['Collapse']) {
  const h=fixture(t),{mountSharedHeader}=await load('shared-header.mjs');
  const owner=h.own(mountSharedHeader(h.host,h.runtime,{id}));
  const mark=label=>{const button=h.document.createElement('button');button.type='button';button.setAttribute('data-test-slot',label);button.textContent=label;return button;};
  const original=new Map();
  for(const [slot,labels] of Object.entries({identity:['identity'],leading:['leading'],actions:['Reset','Missing'],outsideActions:['View'],finalAction:tail}))for(const label of labels){const node=mark(label);original.set(label,node);owner.slots[slot].append(node);}
  owner.refresh();h.drain();return {...h,owner,original,header:owner.element};
}

test('SharedHeader owns one native Tools disclosure and mounts each original slot once',async t=>{
  const h=await headerFixture(t,'recent'),header=h.header;assert.equal(header.getAttribute('data-shared-header'),'recent');
  const trigger=header.querySelector('[data-header-tools]');assert.ok(trigger);assert.equal(trigger.getAttribute('type'),'button');assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.ok(trigger.getAttribute('aria-controls'));
  const capsule=header.querySelector('[data-header-action-capsule]');assert.ok(capsule);assert.equal(capsule.id,trigger.getAttribute('aria-controls'));
  for(const [label,node] of h.original){assert.equal(h.host.querySelectorAll(`[data-test-slot="${label}"]`).length,1);assert.equal(h.host.querySelector(`[data-test-slot="${label}"]`),node,'original consumer node survives');}
  assert.equal(capsule.querySelectorAll('[data-test-slot="Reset"]').length,1);assert.equal(capsule.querySelectorAll('[data-test-slot="Missing"]').length,1);assert.equal(capsule.querySelectorAll('[data-test-slot="identity"]').length,0);
});

test('Period closed control is icon-only while native choice retains readable selected option',async t=>{
  const h=fixture(t),{mountPeriod}=await load('period.mjs');
  const owner=h.own(mountPeriod(h.host,h.runtime,{value:'week',total:99,range:'Server private range',onChange(){}}));
  for(const [value,label] of [['week','Last week'],['month','Last month'],['six','Last 6 months'],['year','Last year'],['all','All time']]){
    owner.update({value,total:99,range:'Server private range',onChange(){}});const button=h.host.querySelector('button');assert.ok(button);assert.equal(button.textContent.trim(),'');assert.match(button.getAttribute('aria-label'),new RegExp(label));assert.equal(button.getAttribute('aria-haspopup'),'menu');assert.ok(button.querySelector('svg'));assert.equal(h.host.querySelectorAll('.home-friends__range').length,0);assert.equal(h.host.querySelectorAll('.home-friends__listens').length,0);
    h.click(button);h.drain();const selected=h.document.querySelector('[role="menuitemradio"][aria-checked="true"]');assert.ok(selected);assert.equal(selected.textContent.trim(),label);
  }
});

test('listens badge keeps zero distinct from unknown and escapes server labels',async t=>{
  const h=fixture(t),{mountListensBadge}=await load('shared-header.mjs'),owner=h.own(mountListensBadge(h.host,h.runtime,{total:0,range:'Range <safe>'}));
  for(const [total,expected] of [[0,'0'],[124,'124'],[null,'–'],[undefined,'–']]){owner.update({total,range:'Range <safe>'});assert.equal(h.host.textContent,expected);assert.ok(h.host.querySelector('svg'));assert.equal(h.host.querySelectorAll('safe').length,0);assert.equal(h.host.title,'Range <safe>');}
});

test('SharedHeader preserves caller-selected final action priority without inspecting or duplicating controls',async t=>{
  for(const order of [['Collapse'],['Collapse','More actions'],['Collapse','More actions','Close']]){
    const h=await headerFixture(t,'tail',order),capsule=h.header.querySelector('[data-header-action-capsule]');assert.ok(capsule);const actual=[...capsule.querySelectorAll('[data-test-slot]')].map(node=>node.getAttribute('data-test-slot'));assert.deepEqual(actual.slice(-order.length),order);assert.equal(capsule.querySelectorAll('[data-test-slot="leading"]').length,0);
    for(const [label,node] of h.original){assert.equal(h.host.querySelectorAll(`[data-test-slot="${label}"]`).length,1);assert.equal(h.host.querySelector(`[data-test-slot="${label}"]`),node);}
  }
});
