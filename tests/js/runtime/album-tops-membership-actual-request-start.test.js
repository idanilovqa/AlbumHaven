const test = require('node:test'), assert = require('node:assert/strict');
const {fixture, topPayload, abort, outcome, settle, F} = require('./shared-request-unit-fixture.cjs').topRequest();
const target = `/view-data?surface=album_tops&top_ref=${F.OTHER}`;
const source = `/view-data?surface=album_tops&top_ref=${F.TOP}`;
function countStart(h, counts) {return () => {counts.started++; h.events.push('start');};}
async function falseOrAbort(promise) {
  const result = await outcome(promise);
  if (result.error) assert.equal(result.error.name, 'AbortError'); else assert.equal(result.value, false);
}
function blocker(h, url = source, noninterruptible = false) {
  const original = h.context.AbortController;
  if (noninterruptible) h.context.AbortController = undefined;
  // This is a real active request, not a hand-written busy-state substitute.
  const pending = h.read(url, {shouldApplyResponse: () => false});
  h.context.AbortController = original;
  assert.equal(h.requests.length, 1);
  return pending;
}

test('same-URL busy refusal by the actual request owner does not announce another Top start', {timeout: 2000}, async t => {
  const h = fixture(t), active = blocker(h, target), counts = {started: 0};
  assert.equal(await h.navigate({top_ref: F.OTHER, onStart: countStart(h, counts)}), false);
  assert.equal(counts.started, 0, 'The duplicate call did not dispatch a request');
  assert.equal(h.requests.length, 1); assert.equal(h.context.state.ui.pendingViewRequest, null);
  h.respond(0); assert.equal((await active).value, false); await settle();
  assert.equal(counts.started, 0); assert.equal(h.requests.length, 1); assert.equal(h.applied.length, 0);
});

test('genuine noninterruptible queue refusal is unstarted; later current dispatch announces once with its own request', {timeout: 2000}, async t => {
  const h = fixture(t), active = blocker(h, source, true), counts = {started: 0};
  assert.equal(await h.navigate({top_ref: F.OTHER, onStart: countStart(h, counts)}), false);
  assert.equal(counts.started, 0); assert.equal(h.requests.length, 1);
  assert.equal(h.context.state.ui.pendingViewRequest.url, target);
  h.respond(0); assert.equal((await active).value, false); await settle();
  assert.equal(h.requests.length, 2, 'The real finally owner must dispatch its still-current queue');
  assert.equal(h.requests[1].url, target); assert.equal(counts.started, 1);
  assert.notEqual(h.requests[1].requestId, h.requests[0].requestId);
  h.respond(1); await settle();
  assert.equal(h.applied.length, 1); assert.equal(h.context.state.view.top_ref, F.OTHER);
  assert.equal(h.context.state.busy, false); assert.equal(h.context.state.ui.pendingViewRequest, null);
});

for (const change of ['scope', 'generation', 'view', 'currentness', 'view-revision']) {
  test(`a queued Top intent retired by ${change} never starts or fetches later`, {timeout: 2000}, async t => {
    const h = fixture(t), active = blocker(h, source, true), counts = {started: 0}; let current = true;
    assert.equal(await h.navigate({top_ref: F.OTHER, isCurrent: () => current, onStart: countStart(h, counts)}), false);
    assert.equal(counts.started, 0); assert.equal(h.requests.length, 1);
    if (change === 'scope') h.shell.dataset.nativeAccountId = '8';
    else if (change === 'generation') h.shell.dataset.privateUiContext = 'b'.repeat(64);
    else if (change === 'view') h.context.state.view = {...h.context.state.view};
    else if (change === 'view-revision') h.context.state.ui.viewStateRevision = 1;
    else current = false;
    h.respond(0); await active; await settle();
    assert.equal(h.requests.length, 1); assert.equal(counts.started, 0); assert.equal(h.applied.length, 0);
    assert.equal(h.context.state.busy, false); assert.equal(h.context.state.ui.pendingViewRequest, null);
  });
}

for (const mode of ['success', 'http-error', 'network-error', 'wrong-resource']) {
  test(`actual ${mode} fetch signals once at dispatch and preserves real failure retry`, {timeout: 2000}, async t => {
    const h = fixture(t), counts = {started: 0};
    const pending = outcome(h.navigate({top_ref: F.OTHER, onStart: countStart(h, counts)}));
    assert.equal(h.requests.length, 1); assert.equal(counts.started, 1);
    assert.equal(h.events.indexOf('start') + 1, h.events.indexOf('fetch'), 'Start is the genuine dispatch boundary');
    if (mode === 'network-error') h.requests[0].reject(new TypeError('Synthetic destination unavailable'));
    else h.respond(0, mode === 'http-error' ? {error: 'Synthetic destination unavailable'} : topPayload(mode === 'wrong-resource' ? F.TOP : F.OTHER), mode === 'http-error' ? 503 : 200);
    const result = await pending;
    if (mode.endsWith('error')) assert.match(result.error?.message || '', /Synthetic destination unavailable/);
    else {assert.ifError(result.error); assert.equal(result.value, mode === 'success');}
    assert.equal(h.context.state.busy, false);
    if (mode !== 'success') {
      assert.equal(h.applied.length, 0);
      const retry = h.navigate({top_ref: F.OTHER, onStart: countStart(h, counts)});
      assert.equal(h.requests.length, 2); assert.equal(h.requests[1].url, h.requests[0].url); assert.equal(counts.started, 2);
      h.respond(1); assert.equal(await retry, true); assert.equal(h.applied.length, 1);
    }
  });
}

for (const change of ['scope', 'generation', 'view', 'currentness', 'new-request']) {
  test(`start callback reentry changing ${change} prevents the stale actual fetch`, {timeout: 2000}, async t => {
    const h = fixture(t); let current = true, started = 0;
    const pending = h.navigate({top_ref: F.OTHER, isCurrent: () => current, onStart() {
      started++;
      if (change === 'scope') h.shell.dataset.nativeAccountId = '8';
      else if (change === 'generation') h.shell.dataset.privateUiContext = 'b'.repeat(64);
      else if (change === 'view') h.context.state.view = {...h.context.state.view};
      else if (change === 'new-request') h.context.state.ui.activeViewRequestId += 1;
      else current = false;
    }});
    await falseOrAbort(pending); assert.equal(started, 1); assert.equal(h.requests.length, 0); assert.equal(h.applied.length, 0);
    if (change !== 'new-request') {assert.equal(h.context.state.busy, false); assert.equal(h.context.state.ui.pendingViewTransition, false);}
  });
}

for (const change of ['scope', 'currentness']) {
  test(`synchronous pre-dispatch paint retirement of ${change} never announces start`, {timeout: 2000}, async t => {
    const h = fixture(t); let current = true, started = 0;
    h.context.renderRelated = () => {if (change === 'scope') h.shell.dataset.nativeAccountId = '8'; else current = false;};
    const pending = h.navigate({top_ref: F.OTHER, isCurrent: () => current, onStart() {started++;}});
    assert.equal(started, 0); assert.equal(h.requests.length, 0);
    await falseOrAbort(pending); assert.equal(h.applied.length, 0);
    assert.equal(h.context.state.busy, false);
  });
}

for (const change of ['scope', 'generation', 'view', 'currentness']) {
  test(`started response retired by ${change} never applies or pushes destination history`, {timeout: 2000}, async t => {
    const h = fixture(t); let current = true, started = 0;
    const historyBefore = structuredClone(h.calls.history);
    const pending = h.navigate({top_ref: F.OTHER, isCurrent: () => current, onStart() {started++;}});
    assert.equal(h.requests.length, 1); assert.equal(started, 1);
    if (change === 'scope') h.shell.dataset.nativeAccountId = '8';
    else if (change === 'generation') h.shell.dataset.privateUiContext = 'b'.repeat(64);
    else if (change === 'view') h.context.state.view = {...h.context.state.view};
    else current = false;
    h.respond(0); await falseOrAbort(pending);
    assert.equal(h.applied.length, 0); assert.deepEqual(h.calls.history, historyBefore);
  });
}
