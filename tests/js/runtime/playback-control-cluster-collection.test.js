'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');

// Whole native owners execute unchanged. Only browser timers, media queries and
// input events are supplied here. These contracts do not prove CSS geometry,
// menu behavior or playback; the collection consumer owns those integrations.
function runtime(t, {touch = false} = {}) {
  const env = withDomPlatform(createNativeHomeRuntime());
  const {context, document} = env;
  const timers = new Map(), mediaListeners = new Set(), owners = new Set();
  let now = 0, sequence = 0;
  const media = {
    matches: touch,
    addEventListener(type, listener) {assert.equal(type, 'change'); mediaListeners.add(listener);},
    removeEventListener(type, listener) {assert.equal(type, 'change'); mediaListeners.delete(listener);},
  };
  context.matchMedia = query => {assert.equal(query, '(hover: none), (pointer: coarse)'); return media;};
  context.setTimeout = (callback, delay) => {
    assert.equal(typeof callback, 'function');
    assert.ok(Number.isFinite(delay) && delay >= 0 && delay <= 10000, 'bounded browser timeout');
    assert.ok(timers.size < 10, 'bounded pending work');
    timers.set(++sequence, {callback, due: now + delay});
    return sequence;
  };
  context.clearTimeout = key => timers.delete(key);
  const initialListeners = env.listeners().length;
  t.after(() => {
    for (const owner of owners) owner.destroy();
    assert.equal(timers.size, 0, 'all native timers retired');
    assert.equal(mediaListeners.size, 0, 'media-query listeners retired');
    assert.equal(env.listeners().length, initialListeners, 'all native DOM listeners retired');
    assert.deepEqual(env.forbiddenCalls, [], 'no playback, network, layout or other unowned work');
  });
  for (const file of ['loop-range-controls.js', 'playback-control-cluster.js']) {
    vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context, {filename: file});
  }
  const render = env.owner('renderPlaybackControlCluster');
  const elements = env.owner('getPlaybackControlClusterElements');
  const buildLoop = env.owner('buildLoopEditActionControl');
  const mountLoop = env.owner('mountLoopEditActionControl');
  for (const owner of [render, elements, buildLoop, mountLoop]) assert.equal(typeof owner, 'function');
  const attach = html => {
    const host = document.createElement('section');
    host.innerHTML = html; document.body.append(host);
    return host.firstElementChild;
  };
  const dispatch = (node, type, properties = {}) => {
    const event = new context.Event(type, {bubbles: !['pointerenter', 'pointerleave'].includes(type)});
    Object.assign(event, properties); node.dispatchEvent(event);
  };
  return {
    ...env, render, elements, buildLoop, attach, dispatch, timers, mediaListeners,
    collection(options = {}) {return attach(render({variant: 'collection-play', resourceKind: 'album_top', ownerId: 'top-controls', ...options}));},
    mount(options) {const owner = mountLoop(options); assert.ok(owner); owners.add(owner); return owner;},
    pointer(node, inside) {env.setHoveredElement(inside ? node : null); dispatch(node, inside ? 'pointerenter' : 'pointerleave');},
    touch(value) {media.matches = value; for (const listener of [...mediaListeners]) listener({matches: value});},
    advance(milliseconds) {
      assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 10000);
      const end = now + milliseconds;
      let callbacks = 0;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++callbacks <= 100, 'bounded timer drain');
        timers.delete(next[0]); now = next[1].due; next[1].callback();
      }
      now = end;
    },
  };
}

test('existing compact, expanded and saved-loop variants keep their original action contracts', t => {
  const env = runtime(t);
  const compact = env.attach(env.render({variant: 'compact-player'}));
  const compactParts = env.elements(compact);
  assert.deepEqual(compact.querySelectorAll('button').map(node => node.getAttribute('data-playback-control-action')), ['previous', 'play-pause', 'next']);
  assert.equal(compactParts.previous.getAttribute('aria-label'), 'Previous track');
  assert.equal(compactParts.playPause.getAttribute('aria-label'), 'Play');
  assert.equal(compactParts.next.getAttribute('aria-label'), 'Next track');
  for (const key of ['play', 'loopActions', 'actionRoot', 'optionsTrigger', 'modeBadge']) assert.equal(compactParts[key], null);

  const expanded = env.attach(env.render({variant: 'expanded-player', loopControlStyle: 'companion'}));
  const expandedParts = env.elements(expanded);
  assert.equal(expandedParts.playPause.id, 'player-play');
  assert.equal(expandedParts.loopActions.getAttribute('data-loop-action-mount'), 'global-player');
  assert.equal(expandedParts.actionRoot, null, 'empty expanded-player mount is not an action owner');
  assert.equal(expanded.getAttribute('data-loop-control-style'), 'companion');
  assert.equal(expandedParts.optionsTrigger, null);
  assert.equal(expandedParts.play, null);
  expandedParts.loopActions.innerHTML = env.buildLoop({ownerId: 'global-player'});
  assert.equal(env.elements(expanded).actionRoot, expandedParts.loopActions.firstElementChild);

  const saved = env.attach(env.render({variant: 'saved-loop', ownerId: 'saved-owner', loopId: 'loop<&"', loopControlStyle: 'capsule'}));
  const savedParts = env.elements(saved);
  assert.equal(savedParts.playPause.getAttribute('data-loop-play'), 'loop<&"');
  assert.equal(savedParts.actionRoot.getAttribute('data-loop-action-owner'), 'saved-owner');
  assert.equal(savedParts.actionRoot.querySelector('[data-loop-action="enter"]').getAttribute('aria-label'), 'Create another loop');
  assert.equal(savedParts.actionRoot.querySelector('[data-loop-action="create"]').getAttribute('aria-label'), 'Create loop');
  assert.equal(savedParts.actionRoot.querySelector('[data-loop-action="cancel"]').getAttribute('aria-label'), 'Cancel loop creation');
  assert.equal(savedParts.actionRoot.querySelector('[data-loop-action-expanded]').hidden, true);
  assert.equal(savedParts.optionsTrigger, null);
  assert.equal(savedParts.play, null);
  assert.equal(saved.getAttribute('data-loop-control-style'), 'capsule');
  for (const value of Object.values(env.elements(null))) assert.equal(value, null);
});

test('collection admission is exact: only album_top renders and unknown variants still fail', t => {
  const env = runtime(t);
  for (const resourceKind of [undefined, null, '', 'goal', 'album_goal', 'listening_goal', 'playlist', 'album', 'artist', 'ALBUM_TOP', 'album_top ']) {
    assert.equal(env.render({variant: 'collection-play', resourceKind}), '', `reject ${String(resourceKind)}`);
  }
  assert.ok(env.render({variant: 'collection-play', resourceKind: 'album_top'}));
  assert.throws(() => env.render({variant: 'goal-play', resourceKind: 'album_top'}), /Unknown PlaybackControlCluster variant/);
  assert.throws(() => env.render(), /Unknown PlaybackControlCluster variant/);
});

test('Top collection exposes play plus one options trigger and safe optional modes', t => {
  const env = runtime(t), ownerId = 'Top & "owner" <aside>', badge = '<img src=x onerror="bad()"> & S', modeLabel = 'Shuffle & "selection" <script>';
  const cluster = env.collection({ownerId, modeBadge: badge, modeLabel, loopControlStyle: 'companion'});
  const parts = env.elements(cluster);
  assert.equal(cluster.getAttribute('data-collection-resource-kind'), 'album_top');
  assert.equal(cluster.getAttribute('data-loop-control-style'), 'capsule');
  assert.equal(parts.playPause, null);
  assert.equal(parts.previous, null);
  assert.equal(parts.next, null);
  assert.equal(cluster.querySelectorAll('button').length, 2);
  assert.equal(parts.play.getAttribute('aria-label'), `Play Top from the beginning: ${modeLabel}`);
  assert.equal(parts.play.disabled, false);
  assert.equal(parts.modeBadge.textContent, badge);
  assert.equal(parts.modeBadge.getAttribute('aria-hidden'), 'true');
  assert.equal(parts.actionRoot.getAttribute('data-loop-action-owner'), ownerId);
  assert.equal(parts.optionsTrigger.getAttribute('data-loop-action'), 'enter');
  assert.equal(parts.optionsTrigger.getAttribute('aria-label'), 'Top playback options');
  assert.equal(parts.optionsTrigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(parts.optionsTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(parts.optionsTrigger.hasAttribute('aria-pressed'), false);
  assert.equal(parts.actionRoot.querySelector('[data-loop-action-expanded]'), null);
  assert.equal(parts.actionRoot.querySelector('[data-loop-action="create"]'), null);
  assert.equal(parts.actionRoot.querySelector('[data-loop-action="cancel"]'), null);
  assert.equal(cluster.querySelectorAll('img,script,aside').length, 0, 'untrusted labels remain text');
  for (const button of [parts.play, parts.optionsTrigger]) {
    assert.equal(button.querySelectorAll('svg.ui-icon').length, 1, 'complete shared icon renderer supplies the icon');
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  }
  const empty = env.elements(env.collection({modeBadge: '', modeLabel: '', showOptions: false, disabled: true}));
  assert.equal(empty.play.getAttribute('aria-label'), 'Play Top from the beginning');
  assert.equal(empty.play.disabled, true);
  assert.equal(empty.play.getAttribute('aria-disabled'), 'true');
  assert.equal(empty.modeBadge, null);
  assert.equal(empty.optionsTrigger, null);
  assert.equal(empty.actionRoot, null);
});

test('options labels and owner attributes escape independently while default loop presentation stays intact', t => {
  const env = runtime(t), label = 'Options & "label" <img src=x>', ownerId = 'owner" data-injected="true';
  const root = env.attach(env.buildLoop({presentation: 'options', ownerId, enterLabel: label}));
  const enter = root.querySelector('[data-loop-action="enter"]');
  assert.equal(root.getAttribute('data-loop-action-owner'), ownerId);
  assert.equal(root.hasAttribute('data-injected'), false);
  assert.equal(enter.getAttribute('aria-label'), label);
  assert.equal(enter.getAttribute('title'), label);
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelectorAll('button').length, 1);
  assert.throws(() => env.buildLoop({presentation: 'unknown'}), /Unknown loop action presentation/);
  const normal = env.attach(env.buildLoop());
  assert.equal(normal.getAttribute('data-loop-action-presentation'), null);
  assert.equal(normal.querySelectorAll('button').length, 3);
  assert.equal(normal.querySelector('[data-loop-action="enter"]').getAttribute('aria-pressed'), 'false');
});

test('native default loop owner preserves enter, active create/cancel and busy guards', t => {
  const env = runtime(t), root = env.attach(env.buildLoop()), calls = [];
  const enter = root.querySelector('[data-loop-action="enter"]'), create = root.querySelector('[data-loop-action="create"]'), cancel = root.querySelector('[data-loop-action="cancel"]');
  const owner = env.mount({root, onEnter: () => calls.push('enter'), onCreate: () => calls.push('create'), onCancel: () => calls.push('cancel')});
  env.click(enter); assert.deepEqual(calls, ['enter']);
  owner.update({active: true});
  assert.equal(enter.hidden, true); assert.equal(enter.getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('[data-loop-action-expanded]').hidden, false);
  env.pointer(root, true); assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  env.pointer(root, false); env.advance(499);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true', 'active loops retain their 500 ms fold delay');
  env.pointer(root, true); env.advance(1);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true', 'reentry cancels the pending fold');
  env.pointer(root, false); env.advance(499);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  env.advance(1); assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');
  env.dispatch(enter, 'click'); assert.deepEqual(calls, ['enter'], 'active loop rejects enter');
  env.click(create); env.click(cancel); assert.deepEqual(calls, ['enter', 'create', 'cancel']);
  owner.update({busy: true});
  assert.equal(create.disabled, true); assert.equal(cancel.disabled, true);
  env.dispatch(create, 'click'); env.dispatch(cancel, 'click'); assert.equal(calls.length, 3);
  owner.update({busy: false, active: false});
  assert.equal(enter.hidden, false); assert.equal(enter.getAttribute('aria-pressed'), 'false');
  assert.equal(root.querySelector('[data-loop-action-expanded]').hidden, true);
  env.dispatch(create, 'click'); env.dispatch(cancel, 'click'); assert.equal(calls.length, 3);
});

test('native Top options require a full 300 ms mouse dwell after every inactive exit', t => {
  const env = runtime(t), cluster = env.collection(), parts = env.elements(cluster), calls = [];
  env.mount({root: parts.actionRoot, interactionRoot: cluster, onEnter: () => calls.push('options')});
  assert.equal(parts.optionsTrigger.getAttribute('tabindex'), '-1');
  env.pointer(cluster, true); env.advance(299);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(1); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  assert.equal(parts.actionRoot.getAttribute('data-loop-action-engaged'), 'true');
  assert.equal(parts.optionsTrigger.getAttribute('tabindex'), '0');
  env.pointer(cluster, false);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  assert.equal(env.timers.size, 0);
  env.pointer(cluster, true); env.advance(200); env.pointer(cluster, false); env.advance(100);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false', 'exited dwell cannot reveal');
  env.pointer(cluster, true); env.advance(299);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(1); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  assert.deepEqual(calls, [], 'revealing does not activate the menu');
  env.click(parts.optionsTrigger); assert.deepEqual(calls, ['options']);
  env.click(parts.play); assert.deepEqual(calls, ['options'], 'shared action owner does not own playback');
});

test('native options context/reset and permission restoration cancel stale dwell and start fresh', t => {
  const env = runtime(t), cluster = env.collection(), parts = env.elements(cluster);
  const owner = env.mount({root: parts.actionRoot, contextKey: 'top:one'});
  env.pointer(cluster, true); env.advance(200); owner.update({contextKey: 'top:two'});
  env.advance(100); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(199); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(1); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  owner.update({reset: true});
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(299); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(1); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  owner.update({canCreate: false});
  assert.equal(parts.actionRoot.hidden, true); assert.equal(parts.optionsTrigger.disabled, true);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false'); assert.equal(env.timers.size, 0);
  owner.update({canCreate: true});
  assert.equal(parts.actionRoot.hidden, false);
  env.advance(299); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.advance(1); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
});

test('native options disable and busy guards reject activation without taking menu ARIA ownership', t => {
  const env = runtime(t), cluster = env.collection(), parts = env.elements(cluster), calls = [];
  const owner = env.mount({root: parts.actionRoot, enabled: false, onEnter: () => calls.push('options')});
  assert.equal(parts.optionsTrigger.disabled, true);
  assert.equal(parts.optionsTrigger.getAttribute('aria-disabled'), 'true');
  assert.equal(parts.actionRoot.classList.contains('is-disabled'), true);
  env.dispatch(parts.optionsTrigger, 'click'); assert.deepEqual(calls, []);
  // This value is input from the separate menu owner, not a simulated menu.
  parts.optionsTrigger.setAttribute('aria-expanded', 'true');
  owner.update({enabled: true, busy: true});
  assert.equal(parts.actionRoot.getAttribute('aria-busy'), 'true');
  env.dispatch(parts.optionsTrigger, 'click'); assert.deepEqual(calls, []);
  owner.update({busy: false, reset: true}); env.click(parts.optionsTrigger);
  assert.deepEqual(calls, ['options']);
  assert.equal(parts.optionsTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(parts.optionsTrigger.hasAttribute('aria-pressed'), false);
  parts.optionsTrigger.setAttribute('aria-expanded', 'false'); owner.update({enabled: false});
  assert.equal(parts.optionsTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(parts.optionsTrigger.hasAttribute('aria-pressed'), false);
});

test('native options retain keyboard focus within the capsule and distinguish pointer focus', t => {
  const env = runtime(t), cluster = env.collection(), parts = env.elements(cluster);
  env.mount({root: parts.actionRoot});
  env.dispatch(env.document, 'keydown', {key: 'Tab'});
  env.document.activeElement = parts.play; env.dispatch(parts.play, 'focusin');
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  env.pointer(cluster, false);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  env.document.activeElement = parts.optionsTrigger;
  env.dispatch(parts.play, 'focusout', {relatedTarget: parts.optionsTrigger}); env.dispatch(parts.optionsTrigger, 'focusin');
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  assert.equal(env.timers.size, 0);
  env.dispatch(cluster, 'pointerdown'); env.dispatch(parts.optionsTrigger, 'focusin'); env.pointer(cluster, false);
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false', 'pointer focus does not retain the reveal');
  env.dispatch(env.document, 'keydown', {key: 'Tab'}); env.dispatch(parts.optionsTrigger, 'focusin');
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  env.document.activeElement = env.document.body;
  env.dispatch(parts.optionsTrigger, 'focusout', {relatedTarget: env.document.body});
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  assert.equal(parts.optionsTrigger.getAttribute('tabindex'), '-1');
});

test('native options remain reachable on touch and react to pointer capability changes', t => {
  const env = runtime(t, {touch: true}), cluster = env.collection(), parts = env.elements(cluster);
  const owner = env.mount({root: parts.actionRoot});
  assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  assert.equal(parts.optionsTrigger.getAttribute('tabindex'), '0');
  env.pointer(cluster, false); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  env.touch(false); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  env.touch(true); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  owner.update({canCreate: false}); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'false');
  owner.update({canCreate: true}); assert.equal(cluster.getAttribute('data-loop-action-engaged'), 'true');
  assert.equal(env.timers.size, 0);
});

test('native options teardown cancels pending dwell and retires DOM and media listeners', t => {
  const env = runtime(t), cluster = env.collection(), parts = env.elements(cluster), calls = [];
  const owner = env.mount({root: parts.actionRoot, onEnter: () => calls.push('options')});
  env.pointer(cluster, true); env.advance(150); assert.equal(env.timers.size, 1);
  owner.destroy(); owner.destroy();
  assert.equal(env.timers.size, 0); assert.equal(env.mediaListeners.size, 0); assert.equal(env.listeners().length, 0);
  const before = cluster.outerHTML;
  env.advance(1000); env.pointer(cluster, true); env.dispatch(env.document, 'keydown', {key: 'Tab'});
  env.dispatch(parts.optionsTrigger, 'focusin'); env.click(parts.optionsTrigger); env.touch(true);
  owner.update({canCreate: false, enabled: false, reset: true});
  assert.equal(env.timers.size, 0); assert.equal(cluster.outerHTML, before); assert.deepEqual(calls, []);
});
