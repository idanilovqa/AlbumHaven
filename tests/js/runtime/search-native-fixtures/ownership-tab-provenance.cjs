'use strict';
// Entropy is captured at the browser primitive, never obtained from storage,
// channel messages or the player's ownership state. This is an oracle witness,
// not a substitute ownership implementation.
const assert=require('node:assert/strict');
const {randomUUID,webcrypto}=require('node:crypto');
const witnessed=new WeakMap(),devices=new WeakMap();
function createTabProvenancePlatform(){
  const calls=[];
  function install({c}){
    c.crypto=Object.freeze({getRandomValues:array=>webcrypto.getRandomValues(array),
      randomUUID(){const value=randomUUID(),stack=new Error().stack;calls.push(Object.freeze({value,stack}));return value;}});
  }
  function capture(){
    const ownership=calls.filter(call=>/\bat createPlaybackOwnershipTabId \([^\n]*playback-ownership-helpers\.js:\d+:\d+\)/.test(call.stack));
    assert.equal(ownership.length,1,'exactly one independently witnessed ownership-tab generation');
    const witness=Object.freeze({tabId:ownership[0].value});witnessed.set(witness,ownership[0]);return witness;
  }
  function captureDevice(){
    const generated=calls.filter(call=>/\bat newMeasuredPlaybackId \([^\n]*player-listen-session-helpers\.js:\d+:\d+\)/.test(call.stack)
      && /\bat getMeasuredPlaybackDeviceId \([^\n]*player-listen-session-helpers\.js:\d+:\d+\)/.test(call.stack));
    assert.equal(generated.length,1,'exactly one independently witnessed playback-device generation');
    const witness=Object.freeze({deviceId:generated[0].value});devices.set(witness,generated[0]);return witness;
  }
  return {install,capture,captureDevice,calls};
}
function requireTabWitness(witness){
  assert.ok(witness&&witnessed.has(witness),'ownership tab allowance requires witnessed local entropy provenance');
  const call=witnessed.get(witness);assert.equal(witness.tabId,call.value);return call.value;
}
function requireDeviceWitness(witness){
  assert.ok(witness&&devices.has(witness),'playback device allowance requires witnessed local entropy provenance');
  const call=devices.get(witness);assert.equal(witness.deviceId,call.value);return call.value;
}
module.exports={createTabProvenancePlatform,requireTabWitness,requireDeviceWitness};
