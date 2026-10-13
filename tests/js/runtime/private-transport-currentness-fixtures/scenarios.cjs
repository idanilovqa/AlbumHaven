'use strict';
const assert = require('node:assert/strict');
const {fixture, assertAbort, assertAvailable, A, B, READ_URL} = require('./fixture.cjs');
async function success(t, {guarded = true, post = false, explicitUndefined = false} = {}) {
  const h = fixture(t), controller = new AbortController();
  const options = {...(guarded ? {isCurrent: () => true} : explicitUndefined ? {isCurrent: undefined} : {}),
    ...(post ? {method: 'POST', body: {value: 'bounded'}, signal: controller.signal, expected: A} : {})};
  const pending = h.read(options), r = h.requestAt(0);
  assert.equal(h.requests.length, 1); assert.equal(r.url, READ_URL);
  assert.equal(r.options.method, post ? 'POST' : 'GET');
  assert.equal(r.options.credentials, 'same-origin'); assert.equal(r.options.cache, 'no-store');
  assert.equal(r.options.headers.Accept, 'application/json');
  assert.equal(r.options.headers['X-AlbumHaven-Context'], A);
  if (post) {
    assert.equal(r.options.body, JSON.stringify({value: 'bounded'}));
    assert.equal(r.options.headers['Content-Type'], 'application/json');
    assert.equal(r.options.signal, controller.signal);
  } else {
    assert.equal(Object.hasOwn(r.options, 'body'), false);
    assert.equal(Object.hasOwn(r.options.headers, 'Content-Type'), false);
  }
  const payload = h.valid(); h.respond(0, payload); const result = await pending;
  assert.equal(result.error, undefined); assert.equal(result.value, payload);
  assert.equal(r.jsonCalls, 1); assertAvailable(h);
}
async function currentMalformed(t, guarded, explicitUndefined = false, generationAware = false) {
  const h = fixture(t), capturedGeneration = h.transport.generation();
  const options = guarded ? {isCurrent: () => !generationAware || h.transport.generation() === capturedGeneration}
    : explicitUndefined ? {isCurrent: undefined} : {};
  const pending = h.read(options);
  h.respond(0, h.malformed()); const result = await pending;
  assert.equal(result.error?.status, 409); assert.equal(result.error?.code, 'stale_context');
  assert.notEqual(result.error?.name, 'AbortError');
  if (generationAware) assert.equal(options.isCurrent(), false,
    'accept denial itself retired the generation-aware caller, but remains stale_context');
  assert.equal(h.transport.generation(), 1); assert.equal(h.notices.length, 1);
  assert.throws(() => h.transport.context(), error => error.code === 'stale_context');
  const next = await h.read(options);
  assert.equal(next.error?.code, 'stale_context'); assert.equal(h.requests.length, 1);
  assert.equal(h.transport.generation(), 1); assert.equal(h.notices.length, 1);
}
async function prefetchRetired(t, mode) {
  const h = fixture(t), isCurrent = mode === 'throw' ? () => {throw new Error('Retired caller');}
    : mode === 'truthy' ? () => 'true' : () => false;
  const pending = h.read({isCurrent});
  // Settle an erroneous dispatch so baseline failure cannot hang the test.
  if (h.requests.length) h.respond(0, h.valid());
  const result = await pending; assertAbort(result);
  assert.equal(h.requests.length, 0, 'retired caller never dispatches network I/O'); assertAvailable(h);
}
async function staleMalformed(t, {stage, replacement}) {
  const h = fixture(t); let current = true;
  const pending = h.read({isCurrent: () => current});
  if (stage === 'json') {const r = h.headers(0); await r.started.promise; assert.equal(r.jsonCalls, 1);}
  current = false;
  // Replacement is the same opaque context, but has an independent live caller.
  // Admit it before the old malformed response to expose global poisoning.
  const newer = replacement ? h.read({isCurrent: () => true}) : null;
  let newerPayload;
  if (newer) {newerPayload = h.valid('new detail'); h.respond(1, newerPayload);
    assert.equal((await newer).value, newerPayload); assertAvailable(h);}
  if (stage === 'json') h.decoded(0, h.malformed()); else h.respond(0, h.malformed());
  assertAbort(await pending); assertAvailable(h);
  assert.equal(h.requestAt(0).jsonCalls, stage === 'json' ? 1 : 0,
    'retirement before response decoding prevents even reading its JSON');
  // A fresh ordinary caller also remains usable after the retired settlement.
  const index = h.requests.length, healthy = h.read(), payload = h.valid('current ordinary owner');
  h.respond(index, payload); assert.equal((await healthy).value, payload); assertAvailable(h);
}
async function callerABA(t, stage) {
  const h = fixture(t); let key = 'album:A', epoch = 1;
  const capturedKey = key, capturedEpoch = epoch;
  const pending = h.read({isCurrent: () => key === capturedKey && epoch === capturedEpoch});
  if (stage === 'json') {const r = h.headers(0); await r.started.promise;}
  key = 'album:B'; epoch++; key = 'album:A'; epoch++;
  assert.equal(key, capturedKey, 'visible identity returns to A');
  assert.notEqual(epoch, capturedEpoch, 'original caller lifetime never returns');
  if (stage === 'json') h.decoded(0, h.malformed()); else h.respond(0, h.malformed());
  assertAbort(await pending); assertAvailable(h);
}
async function callbackThrow(t, stage) {
  const h = fixture(t); let shouldThrow = false;
  const pending = h.read({isCurrent: () => {if (shouldThrow) throw new Error('Caller disposed'); return true;}});
  if (stage === 'json') {const r = h.headers(0); await r.started.promise;}
  shouldThrow = true;
  if (stage === 'json') h.decoded(0, h.malformed()); else h.respond(0, h.malformed());
  assertAbort(await pending); assertAvailable(h);
  assert.equal(h.requestAt(0).jsonCalls, stage === 'json' ? 1 : 0);
}
async function ioFailure(t, {stage, retired = false, guarded = true, explicitUndefined = false}) {
  const h = fixture(t); let current = true;
  const pending = h.read(guarded ? {isCurrent: () => current} : explicitUndefined ? {isCurrent: undefined} : {});
  const r = h.requestAt(0), failure = new Error(`Original ${stage} failure`);
  if (stage === 'json') {h.headers(0); await r.started.promise;}
  if (retired) {
    current = false;
    // Omitted-callback controls preserve the established rejected-await behavior,
    // even after a genuine private-context switch. No hidden legacy normalization.
    if (!guarded) h.move(B);
  }
  if (stage === 'json') r.body.reject(failure); else r.network.reject(failure);
  const result = await pending;
  if (guarded && retired) assertAbort(result); else assert.equal(result.error, failure);
  assertAvailable(h, !guarded && retired ? {stamp: B, generation: 1, notices: 1} : {});
}
async function rejectedAwaitFence(t, {stage, kind}) {
  const h = fixture(t), controller = new AbortController(); let calls = 0;
  const pending = h.read({signal: controller.signal, isCurrent: () => {calls++; return true;}});
  const r = h.requestAt(0), failure = new Error(`Original ${stage} failure before ${kind} retirement`);
  if (stage === 'json') {h.headers(0); await r.started.promise;}
  if (kind === 'signal') controller.abort(); else h.move(B);
  if (stage === 'json') r.body.reject(failure); else r.network.reject(failure);
  assertAbort(await pending);
  assert.ok(calls >= 1, 'explicit current caller predicate ran and always returned true');
  assert.equal(h.requests.length, 1, 'no retry or substitute request');
  assert.equal(r.jsonCalls, stage === 'json' ? 1 : 0);
  assertAvailable(h, kind === 'context' ? {stamp: B, generation: 1, notices: 1} : {});
}
async function prefetchFence(t, kind) {
  const h = fixture(t), controller = new AbortController();
  if (kind === 'signal') controller.abort(); else h.move(B);
  const pending = h.read({expected: A, signal: controller.signal, isCurrent: () => true});
  if (h.requests.length) h.respond(0, h.valid());
  assertAbort(await pending); assert.equal(h.requests.length, 0);
  assertAvailable(h, kind === 'context' ? {stamp: B, generation: 1, notices: 1} : {});
}
async function pendingFence(t, {stage, kind}) {
  const h = fixture(t), controller = new AbortController();
  const pending = h.read({signal: controller.signal, isCurrent: () => true});
  if (stage === 'json') {const r = h.headers(0); await r.started.promise;}
  if (kind === 'signal') controller.abort(); else h.move(B);
  if (stage === 'json') h.decoded(0, h.malformed()); else h.respond(0, h.malformed());
  assertAbort(await pending);
  assert.equal(h.requestAt(0).jsonCalls, stage === 'json' ? 1 : 0);
  assertAvailable(h, kind === 'context' ? {stamp: B, generation: 1, notices: 1} : {});
}
async function reentrantCallback(t, {stage, kind}) {
  const h = fixture(t), controller = new AbortController();
  const targetPhase = stage === 'fetch' ? 'initial' : stage === 'headers' ? 'headers' : 'decoded';
  let fired = false;
  const pending = h.read({signal: controller.signal, isCurrent: () => {
    if (!fired && h.phase === targetPhase) {
      fired = true; if (kind === 'signal') controller.abort(); else h.move(B);
    }
    return true;
  }});
  if (stage !== 'fetch') {
    const r = h.headers(0);
    if (stage === 'json') {await r.started.promise; h.decoded(0, h.malformed());}
    else r.body.resolve(h.malformed());
  } else if (h.requests.length) h.respond(0, h.valid());
  assertAbort(await pending); assert.equal(fired, true, 'target callback actually ran');
  assert.equal(h.requests.length, stage === 'fetch' ? 0 : 1);
  if (stage !== 'fetch') assert.equal(h.requestAt(0).jsonCalls, stage === 'json' ? 1 : 0);
  assertAvailable(h, kind === 'context' ? {stamp: B, generation: 1, notices: 1} : {});
}
async function postAcceptFence(t, kind) {
  const h = fixture(t), controller = new AbortController(); let current = true, inspected = 0;
  const pending = h.read({isCurrent: () => current, signal: controller.signal});
  const payload = {label: 'synchronous accessor reentrancy', get context_ref() {
    inspected++;
    if (kind === 'caller') current = false;
    if (kind === 'signal') controller.abort();
    if (kind === 'context') h.move(B);
    return A;
  }};
  h.respond(0, payload); assertAbort(await pending);
  assert.ok(inspected >= 1, 'real accept inspected the response continuity stamp');
  assertAvailable(h, kind === 'context' ? {stamp: B, generation: 1, notices: 1} : {});
}
async function staleServerFailure(t, {stage, status}) {
  const h = fixture(t); let current = true;
  const pending = h.read({isCurrent: () => current});
  if (stage === 'json') {const r = h.headers(0, status); await r.started.promise;}
  current = false;
  const payload = {error_code: 'private_search_forbidden', error: 'Retired denial'};
  if (stage === 'json') h.decoded(0, payload); else h.respond(0, payload, status);
  assertAbort(await pending); assertAvailable(h);
  assert.equal(h.requestAt(0).jsonCalls, stage === 'json' ? 1 : 0);
}
async function currentServerFailure(t, {status, errorCode, code, guarded = true, includeCode = true}) {
  const h = fixture(t), payload = {error: 'legacy_error_token', ...(includeCode ? {error_code: errorCode} : {})};
  const pending = h.read(guarded ? {isCurrent: () => true} : {});
  h.respond(0, payload, status); const result = await pending;
  assert.equal(result.error?.status, status); assert.equal(result.error?.code, code);
  assert.equal(result.error?.responseRejected, true);
  assert.equal(result.error?.message, 'The request could not be completed.');
  assert.notEqual(result.error?.name, 'AbortError'); assertAvailable(h);
  assert.equal(h.requests.length, 1, 'transport never invents retry, broader request or navigation');
}
module.exports = {success, currentMalformed, prefetchRetired, staleMalformed, callerABA,
  callbackThrow, ioFailure, rejectedAwaitFence, prefetchFence, pendingFence, reentrantCallback, postAcceptFence,
  staleServerFailure, currentServerFailure};
