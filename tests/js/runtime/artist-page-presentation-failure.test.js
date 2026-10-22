'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {fixture, artistView, album, group, drain, ROOT} = require('./artist-host-fixtures/actual-artist-runtime.cjs');

const payload = () => artistView({artist_groups: [group(undefined, [album(1), album(2)])],
  primary_artist_groups: [group(undefined, [album(1), album(2)])], album_count: 2});
function addServedAlbumModal(h) {
  // Add the actual served contents to the fixture's existing empty modal slot.
  // This test owns the additive DOM setup; the protected connected fixture and
  // real Album renderer/navigation implementations are unchanged.
  const template = fs.readFileSync(path.join(ROOT, 'music_app/templates/partials/primary-modals.html'), 'utf8');
  const start = template.indexOf('<div class="track-modal" id="track-modal" hidden>');
  const end = template.indexOf('<div class="cover-lookup-modal"', start);
  assert.ok(start >= 0 && end > start, 'exact served Album modal section exists');
  const buttons = [];
  const markup = template.slice(start, end).replace(/{% call action_button\(([\s\S]*?)\) %}([\s\S]*?){% endcall %}/g, (_, args, content) => {
    const label = args.match(/^'([^']+)'/)?.[1], id = args.match(/\bid='([^']+)'/)?.[1];
    const className = args.match(/class_name='([^']+)'/)?.[1], title = args.match(/\btitle='([^']+)'/)?.[1];
    assert.ok(label && id && className); buttons.push(id);
    // Serialize the actual macro's finite literal attributes through the real
    // Button component. Reject unsupported syntax rather than dropping attrs.
    const literal = args.match(/\battributes=\{([^}]*)\}/)?.[1];
    const attributes = {id, ...(title ? {title} : {})};
    if (literal !== undefined) {
      const pairs = [...literal.matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)];
      assert.equal(literal.replace(/'([^']+)'\s*:\s*'([^']*)'/g, '').replace(/[,\s]/g, ''), '');
      for (const [, key, value] of pairs) {
        assert.equal(Object.hasOwn(attributes, key), false, 'no duplicate macro attribute');
        attributes[key] = value;
      }
    }
    return h.context.ButtonComponent.renderActionButton({ariaLabel: label, className,
      disabled: args.includes('disabled=true'), content, attributes});
  });
  assert.deepEqual(buttons, ['track-modal-sheet-toggle', 'track-modal-edit-tags', 'track-modal-folder', 'track-modal-close']);
  assert.doesNotMatch(markup, /{%|{{/);
  const holder = h.document.createElement('div'); holder.innerHTML = markup;
  const served = holder.querySelector('#track-modal'), modal = h.document.getElementById('track-modal');
  assert.ok(served); assert.ok(modal); assert.equal(modal.childNodes.length, 0);
  modal.className = served.className;
  for (const child of [...served.childNodes]) modal.append(child);
  assert.equal(h.document.querySelectorAll('#track-modal').length, 1);
  assert.ok(modal.querySelector(':scope > .track-modal-dialog > .track-modal-header'));
  const toggle = modal.querySelector(':scope > .track-modal-dialog > #track-modal-sheet-toggle');
  assert.ok(toggle, 'sheet toggle is the real dialog child outside header actions');
  assert.equal(toggle.getAttribute('hidden'), 'hidden');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), 'track-modal-list');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand album sheet');
  assert.equal(toggle.disabled, false);
  assert.equal(modal.querySelector('#track-modal-close').getAttribute('data-close-track-modal'), '1');
  for (const [id, label] of [['track-modal-edit-tags', 'Edit album tags unavailable while album details load'],
    ['track-modal-folder', 'Open album folder unavailable while album details load']]) {
    const button = modal.querySelector(`#${id}`);
    assert.equal(button.disabled, true); assert.equal(button.getAttribute('title'), label);
    assert.equal(button.getAttribute('aria-label'), label);
  }
  assert.ok(modal.querySelector('#track-modal-title')); assert.ok(modal.querySelector('#track-modal-list'));
}
async function mounted(t, {servedAlbumModal = false} = {}) {
  const h = fixture(t, {mobile: true});
  if (servedAlbumModal) addServedAlbumModal(h);
  await h.entry(); await h.admit(payload()); h.frame();
  assert.equal(h.runtime().snapshot().actionable, true);
  return h;
}
const openAlbum = (h, id = 1) => {
  const actual = h.context.getIndexedAlbum(`artist-album-${id}`);
  assert.ok(actual, 'album is indexed by the real admitted renderer');
  return h.context.presentMobileAlbumPage(actual);
};
function transition(h) {
  const value = h.mobileState().presentationTransition;
  assert.ok(value?.artistParent, 'real synchronous presentation captured an Artist lease');
  assert.equal(value.artistParent.isCurrent(), true);
  assert.equal(value.artistParent.isOwnerCurrent(), true);
  return value;
}
function released(h, value) {
  assert.ok(value?.artistParent, 'must have observed a real lease');
  assert.equal(h.mobileState().presentationTransition, null, 'no global transition survives synchronous exit');
  assert.equal(value.artistParent.isCurrent(), false, 'origin-receipt lease is irreversibly released');
  assert.equal(value.artistParent.isOwnerCurrent(), false, 'owner-only lease is also released');
  h.runtime().syncPresentation();
  assert.equal(value.artistParent.isCurrent(), false, 'normal reconciliation cannot revive the lease');
}
function noFocus(h, checkpoint) {
  const calls = h.focusLog.slice(checkpoint);
  assert.equal(calls.some(row => ['mobile-page-title', 'mobile-album-identity-title'].includes(row.node.id)
    || row.artistHostAtCall || row.albumKeyAtCall), false,
  'no stale presentation title or retired Artist opener focus (form owns its own initial focus)');
}
function patch(t, object, key, replacement) {
  const original = object[key]; object[key] = replacement;
  t.after(() => {object[key] = original;});
  return original;
}
function beforeDock(t, h, action) {
  const proto = h.context.Element.prototype, original = proto.before;
  const modal = h.document.getElementById('track-modal'); let calls = 0;
  patch(t, proto, 'before', function(...nodes) {
    const result = original.apply(this, nodes);
    if (this === modal && calls++ === 0) action(transition(h));
    return result;
  });
  return () => assert.ok(calls >= 1, 'actual DOM docking callback was reached');
}
async function finishRequest(h, pending) {
  h.reply(pending.index, payload());
  const outcome = await pending.work; assert.equal(outcome.error, undefined); assert.equal(outcome.value, true);
  await drain(); h.frame();
  assert.equal(h.state.busy, false, 'real replacement request settled');
}
function startRequest(h) {
  const index = h.requests.length, previous = h.state.ui.activeViewRequestId;
  const work = h.read(h.context.buildApiUrl(payload()), {preserveScroll: true}, false);
  assert.equal(h.requests.length, index + 1);
  assert.notEqual(h.state.ui.activeViewRequestId, previous, 'actual foreground owner replaced the request');
  return {index, work};
}

for (const mode of ['undefined-success', 'acknowledged-false', 'native-throw']) {
  test(`nested Artist presentation releases lease on ${mode} history boundary`, async t => {
    const h = await mounted(t), sessionId = h.runtime().snapshot().sessionId;
    assert.equal(openAlbum(h), true); h.frame();
    const checkpoint = h.focusLog.length, historyCount = h.historyCalls.length;
    const originUrl = h.location.href, originPosition = h.history.state.albumHavenNavigationPosition;
    let captured, calls = 0, nativeCalls = 0;
    const nativePush = h.history.pushState, failure = new Error('test browser push failure');
    patch(t, h.history, 'pushState', function(...args) {
      nativeCalls++;
      if (mode === 'native-throw') throw failure;
      const result = nativePush.apply(this, args);
      assert.equal(result, undefined, 'normal browser push has no acknowledged return value');
      return result;
    });
    const navigation = h.context.AlbumHavenSettingsNavigation.instance;
    assert.equal(typeof navigation.pushLibraryHistory, 'function', 'actual callable history writer exists');
    const writer = navigation.pushLibraryHistory;
    patch(t, navigation, 'pushLibraryHistory', function(...args) {
      calls++; captured = transition(h);
      assert.equal(h.mobileState().pages.length, 2, 'live nested child precedes history');
      assert.equal(h.history.state.mobilePages.length, 1);
      assert.equal(h.runtime().snapshot().sessionId, sessionId);
      assert.equal(h.host.inert, true, 'parent is held at live-two/history-one midpoint');
      // A narrow injected writer acknowledgement. Native pushState returning
      // false is insufficient: the actual settings writer discards that result.
      if (mode === 'acknowledged-false') return false;
      return writer.apply(this, args);
    });
    if (mode === 'native-throw') assert.throws(() => h.openForm(), error => error === failure);
    else h.openForm();
    assert.equal(calls, 1); assert.equal(nativeCalls, mode === 'acknowledged-false' ? 0 : 1);
    released(h, captured); await drain(); h.frame(); noFocus(h, checkpoint);
    if (mode === 'undefined-success') {
      assert.equal(h.historyCalls.length, historyCount + 1);
      assert.equal(h.history.state.mobilePages.length, 2);
      assert.equal(h.runtime().snapshot().sessionId, sessionId, 'successful exact child chain retains parent');
      assert.equal(h.runtime().snapshot().actionable, false);
    } else {
      assert.equal(h.historyCalls.slice(historyCount).some(row => row.mode === 'push'), false);
      if (mode === 'acknowledged-false') assert.equal(h.historyCalls.length, historyCount);
      // Throwing form setup additionally runs its real cleanup, which may replace
      // the unchanged album entry. It must never commit the rejected child.
      assert.equal(h.location.href, originUrl); assert.equal(h.history.state.albumHavenNavigationPosition, originPosition);
      assert.equal(h.runtime().snapshot().status, 'inactive', 'failed nested history cannot leave an indefinite presentation hold');
      assert.equal(h.grid._artistPageLease, null);
      assert.equal(h.nodes.viewport.parentElement, h.scroll);
    }
  });
}

test('repeated active album exits without history and releases its actual captured lease', async t => {
  const h = await mounted(t); assert.equal(openAlbum(h), true); h.frame();
  const sessionId = h.runtime().snapshot().sessionId, historyCount = h.historyCalls.length;
  const active = h.mobileState().pages.at(-1), checkpoint = h.focusLog.length;
  const classes = h.main.classList, toggle = classes.toggle; let captured, calls = 0;
  patch(t, classes, 'toggle', function(name, ...args) {
    if (name === 'has-mobile-page' && h.mobileState().presentationTransition) {calls++; captured = transition(h);}
    return toggle.call(this, name, ...args);
  });
  assert.equal(openAlbum(h), true); assert.equal(calls, 1); released(h, captured);
  assert.equal(h.mobileState().pages.at(-1), active); assert.equal(h.historyCalls.length, historyCount);
  assert.equal(h.runtime().snapshot().sessionId, sessionId);
  await drain(); h.frame(); noFocus(h, checkpoint);
});

for (const kind of ['scope', 'request']) {
  test(`${kind} replacement at real pre-docking callback aborts old presentation and clears lease`, async t => {
    const h = await mounted(t), historyCount = h.historyCalls.length, checkpoint = h.focusLog.length;
    let captured, pending;
    const observed = beforeDock(t, h, value => {
      captured = value;
      if (kind === 'scope') h.change('actor', '8'); else pending = startRequest(h);
      assert.equal(captured.artistParent.isOwnerCurrent(), false);
    });
    assert.equal(openAlbum(h), false); observed(); released(h, captured);
    assert.equal(h.historyCalls.length, historyCount); assert.equal(h.mobileState().pages.length, 0);
    await drain(); h.frame(); noFocus(h, checkpoint);
    if (pending) {
      await finishRequest(h, pending);
      assert.equal(h.runtime().snapshot().actionable, true, 'settled replacement resumes normal parent actionability');
      assert.equal(h.host.inert, false);
    } else {
      assert.equal(h.runtime().snapshot().status, 'inactive'); assert.equal(h.grid._artistPageLease, null);
    }
    noFocus(h, checkpoint);
  });
}

for (const kind of ['scope', 'request']) {
  test(`${kind} replacement inside actual native history callback suppresses predecessor focus`, async t => {
    const h = await mounted(t), checkpoint = h.focusLog.length;
    const push = h.history.pushState; let captured, pending, calls = 0;
    patch(t, h.history, 'pushState', function(...args) {
      calls++; captured = transition(h);
      const result = push.apply(this, args);
      assert.equal(result, undefined);
      if (kind === 'scope') h.change('actor', '8'); else pending = startRequest(h);
      return result;
    });
    assert.equal(openAlbum(h), false); assert.equal(calls, 1); released(h, captured);
    await drain(); h.frame(); noFocus(h, checkpoint);
    if (pending) await finishRequest(h, pending);
    else assert.equal(h.runtime().snapshot().status, 'inactive');
    noFocus(h, checkpoint);
  });
}

test('reentrant successor at pre-docking callback independently commits and predecessor cannot focus', async t => {
  const h = await mounted(t), sessionId = h.runtime().snapshot().sessionId;
  const historyCount = h.historyCalls.length, checkpoint = h.focusLog.length;
  let predecessor, successor, successorResult;
  const nativePush = h.history.pushState;
  patch(t, h.history, 'pushState', function(...args) {
    successor = transition(h); assert.notEqual(successor, predecessor);
    assert.equal(predecessor.artistParent.isCurrent(), false);
    assert.equal(predecessor.artistParent.isOwnerCurrent(), false);
    return nativePush.apply(this, args);
  });
  const observed = beforeDock(t, h, value => {
    predecessor = value; successorResult = openAlbum(h, 2);
  });
  assert.equal(openAlbum(h, 1), false); observed(); assert.equal(successorResult, true);
  released(h, predecessor); released(h, successor);
  assert.equal(h.historyCalls.length, historyCount + 1);
  assert.equal(h.mobileState().pages.at(-1).albumKey, 'artist-album-2');
  assert.equal(h.history.state.mobilePages.at(-1).albumKey, 'artist-album-2');
  assert.equal(h.runtime().snapshot().sessionId, sessionId);
  await drain(); h.frame();
  const calls = h.focusLog.slice(checkpoint);
  assert.equal(calls.length, 1, 'only successful successor owns title focus');
  assert.ok(['mobile-page-title', 'mobile-album-identity-title'].includes(calls[0].node.id));
  assert.equal(calls[0].connectedAtCall, true);
});

test('reentry at uncommitted nested history cannot borrow predecessor hold', async t => {
  const h = await mounted(t); assert.equal(openAlbum(h), true); h.frame();
  const historyCount = h.historyCalls.length, checkpoint = h.focusLog.length;
  const navigation = h.context.AlbumHavenSettingsNavigation.instance;
  let predecessor, successorResult, calls = 0;
  patch(t, navigation, 'pushLibraryHistory', function() {
    calls++; predecessor = transition(h);
    assert.equal(h.mobileState().pages.length, 2); assert.equal(h.history.state.mobilePages.length, 1);
    successorResult = openAlbum(h, 2);
    assert.equal(predecessor.artistParent.isOwnerCurrent(), false);
    return false;
  });
  h.openForm(); assert.equal(calls, 1); assert.equal(successorResult, false);
  released(h, predecessor); assert.equal(h.historyCalls.length, historyCount);
  assert.equal(h.runtime().snapshot().status, 'inactive'); assert.equal(h.grid._artistPageLease, null);
  await drain(); h.frame(); noFocus(h, checkpoint);
});

for (const kind of ['scope', 'request']) {
  test(`successful presentation queued title focus becomes stale after ${kind} replacement`, async t => {
    const h = await mounted(t), checkpoint = h.focusLog.length;
    assert.equal(openAlbum(h), true); assert.equal(h.mobileState().presentationTransition, null);
    assert.ok(h.frames.size > 0, 'real presentation queued frame work');
    let pending;
    if (kind === 'scope') h.change('actor', '8'); else pending = startRequest(h);
    await drain(); h.frame(); noFocus(h, checkpoint);
    if (pending) await finishRequest(h, pending);
    noFocus(h, checkpoint);
  });
}

for (const nested of [false, true]) {
  test(`focused restoring precondition releases ${nested ? 'nested' : 'first-child'} lease without a history write`, async t => {
    const h = await mounted(t);
    if (nested) {assert.equal(openAlbum(h, 1), true); h.frame();}
    const historyCount = h.historyCalls.length, state = h.mobileState(), wasRestoring = state.restoring;
    const classes = h.main.classList, toggle = classes.toggle; let captured;
    patch(t, classes, 'toggle', function(name, ...args) {
      if (name === 'has-mobile-page' && state.presentationTransition) captured = transition(h);
      return toggle.call(this, name, ...args);
    });
    // Explicit unit-level branch precondition, NOT an end-to-end history restore.
    // This changes only the existing restoring flag; it does not invent an
    // admission, lease, request ID, descriptor, or browser receipt.
    let result;
    state.restoring = true;
    try {result = openAlbum(h, nested ? 2 : 1);} finally {state.restoring = wasRestoring;}
    assert.equal(result, true); released(h, captured);
    assert.equal(state.restoring, wasRestoring); assert.equal(h.historyCalls.length, historyCount);
    const checkpoint = h.focusLog.length;
    if (nested) {
      assert.equal(h.runtime().snapshot().status, 'inactive', 'mismatched unchanged history cannot retain a presentation hold');
      assert.equal(h.grid._artistPageLease, null);
    } else {
      assert.equal(h.runtime().snapshot().retained, true, 'normal first-child lineage still owns parent entry');
      // Change actual browser location before the queued focus runs. The hold
      // must not conceal an unrelated browser receipt after synchronous exit.
      h.history.pushState({albumHavenNavigationPosition: 900, mobilePages: []}, '', '/?surface=albums&artist=Unrelated');
      assert.equal(h.runtime().snapshot().status, 'inactive');
    }
    await drain(); h.frame(); noFocus(h, checkpoint);
  });
}

test('real browser Back and Forward restoration uses no presentation history push and leaves no transition', async t => {
  const h = await mounted(t, {servedAlbumModal: true}); assert.equal(openAlbum(h), true); h.frame();
  const childUrl = h.location.href, childPosition = h.history.state.albumHavenNavigationPosition;
  const requestIndex = h.requests.length, invocationIndex = h.invocations.length;
  h.rawHistoryGo(-1); await drain();
  assert.equal(h.mobileState().pages.length, 0);
  assert.equal(h.requests.length, requestIndex + 1, 'real Back requests its parent hydration');
  assert.equal(h.invocations.length, invocationIndex + 1);
  h.reply(requestIndex, payload());
  const outcome = await h.invocations[invocationIndex].outcome;
  assert.equal(outcome.error, undefined); assert.equal(outcome.value, true);
  await drain(); h.frame(); assert.equal(h.runtime().snapshot().actionable, true);
  const historyCount = h.historyCalls.length;
  const classes = h.main.classList, toggle = classes.toggle, observed = [];
  patch(t, classes, 'toggle', function(name, ...args) {
    const current = h.mobileState().presentationTransition;
    if (name === 'has-mobile-page' && current) {
      assert.equal(h.mobileState().restoring, true, 'real restore owner sets the no-history precondition');
      observed.push(current);
    }
    return toggle.call(this, name, ...args);
  });
  h.rawHistoryGo(1); await drain();
  assert.ok(observed.length > 0, 'Forward actually called the real presentation owner');
  assert.equal(h.mobileState().presentationTransition, null);
  assert.equal(h.mobileState().restoring, false);
  for (const current of observed) if (current.artistParent) released(h, current);
  assert.equal(h.location.href, childUrl); assert.equal(h.history.state.albumHavenNavigationPosition, childPosition);
  assert.equal(h.mobileState().pages.at(-1).albumKey, 'artist-album-1');
  assert.equal(h.historyCalls.slice(historyCount).some(row => row.mode === 'push'), false);
  // Forward can correctly retire the old Artist admission before restoration.
  // Do not manufacture a replacement lease to claim retained-parent coverage.
  assert.notEqual(h.runtime().snapshot().actionable, true);
  h.frame(); assert.equal(h.mobileState().presentationTransition, null);
});
