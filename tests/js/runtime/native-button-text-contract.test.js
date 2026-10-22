const test = require('node:test');
const assert = require('node:assert/strict');
const {nativeEnvironment,load} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
test('native button rejects object labels before rendering or acquiring listeners',async()=>{
 const {mountButton}=await load('home-friends/native-controls.mjs'),h=nativeEnvironment();
 for(const label of [h.document.createElement('em'),{},()=>{},['text']])assert.throws(()=>mountButton(h.host,h.runtime,{label}),/expects text labels/);
 assert.equal(h.host.childNodes.length,0);h.assertClean();
});
test('invalid label update preserves the existing button and last valid callback',async()=>{
 const {mountButton}=await load('home-friends/native-controls.mjs'),h=nativeEnvironment(),calls=[];
 const owner=mountButton(h.host,h.runtime,{label:0,onClick:()=>calls.push('valid')}),button=h.host.firstElementChild;
 assert.equal(button.textContent,'0');
 assert.throws(()=>owner.update({label:h.document.createElement('em'),onClick:()=>calls.push('invalid')}),/expects text labels/);
 assert.equal(h.host.firstElementChild,button);h.click(button);assert.deepEqual(calls,['valid']);owner.dispose();h.assertClean();
});
