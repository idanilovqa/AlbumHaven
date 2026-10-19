'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {id, TOP, OTHER, ALBUM, SCOPE, deferred, detail, sharing, service, preparedController, connectedView}
  = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');

// Delayed transport/clipboard/history promises are explicit external boundaries.
// Native dialog teardown, confirmations, tabs, controls and controller remain real.
const ITEM = id(21), SOURCE = id(31), SHARE = id(41), PUBLICATION = id(42), EVIDENCE = 'a'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));
const identity = () => ({item_ref: ITEM, album_ref: ALBUM});
const selection = () => ({...identity(), selected_local_album_id: 101, selected_source_ref: SOURCE});
const saved = patch => detail({items: [{...identity(), title: 'Saved album', artist: 'Saved artist', year: 2001, position: 1}],
  edit_draft: {items: [identity()], publication_preview_required: false}, ...patch});
function publication(state = 'enabled', patch = {}) {
  const enabled = state === 'enabled', path = enabled ? `/public/album-tops/${SHARE}` : null;
  return {state, share_ref: state === 'unpublished' ? null : SHARE,
    link_revision: state === 'unpublished' ? null : enabled ? '2' : '3',
    publication_ref: enabled ? PUBLICATION : null, publication_revision: enabled ? '1' : null,
    public_path: path, public_url: path ? `https://saved.example.test${path}` : null,
    deployment_available: true, can_enable_external: true, can_revoke_external: enabled, ...patch};
}
function source(ref = TOP, revision = '7') {
  return {top_ref: ref, revision, item_ref: ITEM, album_ref: ALBUM, sources: [{selected_local_album_id: 101,
    selected_source_ref: SOURCE, title: 'Source album', artist: 'Source artist', year: 2001}], next_cursor: null};
}
function backend({owner = publication(), handlers = {}} = {}) {
  let result; const live = {publication: owner, canManage: true}, control = {...handlers};
  const defaults = {
    readSharing: ref => sharing({top_ref: ref, revision: result.data.detail.revision,
      publication: plain(live.publication), can_manage: live.canManage}),
    readPublicationSources: ref => source(ref, result.data.detail.revision),
    preview: (ref, payload) => ({top_ref: ref, revision: payload.revision, evidence_revision: EVIDENCE,
      items: payload.items.map(item => ({...item, title: 'Approved album', artist: 'Approved artist', year: null, track_count: 4}))}),
    execute: (action, command) => {
      const revision = String(BigInt(command.revision) + 1n);
      result.data.detail = {...result.data.detail, revision};
      live.publication = publication(action === 'revoke_external' ? 'revoked' : 'enabled');
      const {state, share_ref, link_revision, publication_ref, publication_revision} = live.publication;
      return {action, top_ref: command.top_ref, request_key: command.request_key, revision,
        publication: {state, share_ref, link_revision, publication_ref, publication_revision}};
    },
  };
  result = service(Object.fromEntries(['readSharing', 'execute', ...Object.keys(handlers)
    .filter(key => !['readPublicationSources', 'preview', 'readSharing', 'execute'].includes(key))]
    .map(method => [method, (...args) => (control[method] || defaults[method])(...args)])));
  result.data.detail = saved();
  for (const method of ['readPublicationSources', 'preview']) result.providers[method] = (...args) => {
    result.calls.push({method, args}); return (control[method] || defaults[method])(...args);
  };
  return {...result, live, control, defaults, last: method => result.calls.filter(call => call.method === method).at(-1)};
}
const visible = node => Boolean(node?.isConnected && !node.closest('[hidden],[inert]'));
const findButton = (root, label) => [...root.querySelectorAll('button')].find(node => visible(node)
  && (node.getAttribute('aria-label') || node.textContent.trim()) === label);
function unavailable(root, label) {const node = findButton(root, label); assert.ok(!node || node.disabled, `${label} is unavailable`);}
async function fixture(t, data = backend(), {open = true} = {}) {
  const env = actualChoiceEnvironment(), controller = await preparedController(data), owner = await connectedView(env, data, controller);
  t.after(async () => {owner.dispose(); await settle(); env.assertClean(); env.host.remove();});
  if (open) {env.click(env.button(env.host, 'Share')); await settle(); assert.equal(env.content().querySelector('#album-top-share-public').hidden, false); await settle();}
  return {...env, controller, viewOwner: owner, backend: data};
}
async function selectAndPreview(env) {
  const row = env.content().querySelector(`[data-item-ref="${ITEM}"]`); assert.ok(row);
  env.click(env.button(row, 'Choose source')); await settle();
  const candidate = env.content().querySelector(`[data-source-ref="${SOURCE}"]`); assert.ok(candidate);
  env.click(candidate.tagName === 'BUTTON' ? candidate : candidate.querySelector('button')); await settle();
  env.click(env.button(env.content(), 'Preview publication')); await settle();
  assert.equal(env.controller.getSnapshot().preparation.status, 'ready');
}
function accept(env) {
  assert.equal(env.document.getElementById('app-confirm-modal').hidden, false, 'actual native confirmation opened');
  env.click(env.document.getElementById('app-confirm-accept'));
}
function failedHost(env) {
  const fallback = env.host.querySelector('[data-album-top-dialog-fallback]');
  const host = fallback && /not available|unavailable|could not/i.test(fallback.textContent) ? fallback : env.content();
  assert.match(host.textContent, /not available|unavailable|could not/i);
  assert.ok(host.querySelector('[role="alert"], [role="status"]')); return host;
}

for (const retirement of ['revoke', 'close', 'actor', 'top', 'saved-link-change']) {
  test(`pending native Copy cannot announce success after ${retirement}`, async t => {
    const data = backend(), env = await fixture(t, data), clipboard = deferred(), copied = [];
    env.context.navigator = {...env.context.navigator, clipboard: {writeText: value => {copied.push(value); return clipboard.promise;}}};
    env.click(env.button(env.content(), 'Copy link')); await settle();
    assert.deepEqual(copied, [data.live.publication.public_url]);
    assert.doesNotMatch(env.content().textContent, /link copied/i, 'unsettled clipboard does not report success');
    if (retirement === 'revoke') {
      env.click(env.button(env.content(), 'Revoke public link')); await settle(); accept(env); await settle();
      assert.equal(env.controller.getSnapshot().publication.data.state, 'revoked');
    } else if (retirement === 'close') {
      env.click(env.button(env.content(), 'Close')); await settle();
      assert.equal(env.modal().hidden, true);
      env.click(env.button(env.host, 'Share')); await settle(); assert.equal(env.content().querySelector('#album-top-share-public').hidden, false); await settle();
    } else if (retirement === 'actor') env.controller.setScope(`${SCOPE}:next-actor`);
    else if (retirement === 'top') await env.controller.open(OTHER);
    else {
      data.live.publication = publication('enabled', {link_revision: '4', publication_ref: id(43), publication_revision: '2',
        public_url: `https://new.example.test/public/album-tops/${SHARE}`});
      await env.controller.readSharing();
    }
    clipboard.resolve(); await settle();
    assert.doesNotMatch(env.content().textContent, /link copied/i, 'obsolete clipboard completion remains silent');
    assert.equal(copied.length, 1, 'retirement does not restart clipboard work');
    assert.equal(data.count('execute'), retirement === 'revoke' ? 1 : 0);
    if (retirement === 'actor' || retirement === 'top') assert.equal(env.modal().hidden, true);
  });
}

test('a current saved URL alone does not copy until an explicit gesture; clipboard failure is recoverable', async t => {
  const data = backend(), env = await fixture(t, data), copied = []; let fail = true;
  env.context.navigator = {...env.context.navigator, clipboard: {writeText: value => {
    copied.push(value); return fail ? Promise.reject(new Error('clipboard denied')) : Promise.resolve();
  }}};
  assert.deepEqual(copied, []);
  env.click(env.button(env.content(), 'Copy link')); await settle();
  assert.doesNotMatch(env.content().textContent, /link copied/i); assert.match(env.content().textContent, /copy|clipboard/i);
  fail = false; env.click(env.button(env.content(), 'Copy link')); await settle();
  assert.deepEqual(copied, [data.live.publication.public_url, data.live.publication.public_url]);
  assert.match(env.content().textContent, /copied/i); assert.equal(data.count('execute'), 0);
});

for (const retirement of ['close', 'actor', 'top', 'saved-link-change']) {
  test(`native Revoke confirmation cannot dispatch after ${retirement}`, async t => {
    const data = backend(), env = await fixture(t, data);
    env.click(env.button(env.content(), 'Revoke public link')); await settle();
    const acceptButton = env.document.getElementById('app-confirm-accept');
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    assert.equal(data.count('execute'), 0);
    if (retirement === 'close') {env.click(env.button(env.content(), 'Close')); await settle();}
    else if (retirement === 'actor') env.controller.setScope(`${SCOPE}:next-actor`);
    else if (retirement === 'top') await env.controller.open(OTHER);
    else {
      data.live.publication = publication('enabled', {link_revision: '9', publication_ref: id(49), publication_revision: '3'});
      await env.controller.readSharing();
    }
    // The canonical accept element is persistent. Its old listener is retired
    // on close; an open confirmation still has to pass current owner checks.
    env.click(acceptButton); await settle();
    assert.equal(data.count('execute'), 0);
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, true);
  });
}

for (const action of ['enable_external', 'revoke_external']) {
  test(`joined unknown ${action} refreshes detail and sharing then replays only the exact original command`, async t => {
    const data = backend({owner: publication(action === 'enable_external' ? 'unpublished' : 'enabled')}), env = await fixture(t, data);
    let attempt = 0;
    data.control.execute = (nextAction, command) => {
      if (++attempt === 1) {
        data.data.detail = {...data.data.detail, revision: '8'};
        data.live.publication = publication(action === 'enable_external' ? 'enabled' : 'revoked', action === 'revoke_external'
          ? {deployment_available: false, can_enable_external: false, public_url: null} : {});
        if (action === 'revoke_external') {
          data.data.detail = {...data.data.detail, allowed_actions: {...data.data.detail.allowed_actions, can_edit: false}};
          data.live.canManage = false;
        }
        throw new Error('server committed but acknowledgment was lost');
      }
      return data.defaults.execute(nextAction, command);
    };
    if (action === 'enable_external') {await selectAndPreview(env); env.click(env.button(env.content(), 'Publish'));}
    else {env.click(env.button(env.content(), 'Revoke public link')); await settle(); accept(env);}
    await settle(); assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
    const original = plain(data.last('execute').args[1]); assert.equal(data.count('execute'), 1);
    unavailable(env.content(), 'Publish'); unavailable(env.content(), 'Republish'); unavailable(env.content(), 'Revoke public link');
    const reads = data.calls.length;
    env.click(env.button(env.content(), 'Refresh Album Top')); await settle();
    const refreshCalls = data.calls.slice(reads).map(call => call.method);
    assert.ok(refreshCalls.indexOf('read') >= 0); assert.ok(refreshCalls.indexOf('readSharing') > refreshCalls.indexOf('read'), 'detail precedes owner sharing observation');
    assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain', 'current projection is not the acknowledgment');
    assert.equal(env.controller.canRetryMutation(), true); assert.equal(data.count('execute'), 1);
    assert.equal(env.button(env.content(), 'Close').disabled, true, 'original pending mutation dismissal guard is retained');
    env.click(env.button(env.content(), 'Retry original request')); await settle();
    assert.equal(data.count('execute'), 1, 'exact recovery still asks through the native confirmation owner');
    accept(env); await settle();
    assert.equal(data.count('execute'), 2); assert.deepEqual(data.last('execute').args[1], original);
    assert.equal(data.last('execute').args[0], action);
    assert.equal(data.count('preview'), action === 'enable_external' ? 1 : 0, 'replay never rebuilds the original preview or request');
    assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
  });
}

for (const retirement of ['close', 'actor', 'top']) {
  test(`pending source page is aborted and cannot restore rows after ${retirement}`, async t => {
    const pending = deferred(), data = backend({owner: publication('unpublished'), handlers: {readPublicationSources: () => pending.promise}});
    const env = await fixture(t, data);
    env.click(env.button(env.content().querySelector(`[data-item-ref="${ITEM}"]`), 'Choose source')); await settle();
    const read = data.last('readPublicationSources'); assert.ok(read);
    if (retirement === 'close') {env.click(env.button(env.content(), 'Close')); await settle();}
    else if (retirement === 'actor') env.controller.setScope(`${SCOPE}:next-actor`);
    else await env.controller.open(OTHER);
    assert.equal(read.args[2].signal.aborted, true);
    const late = source(); late.sources[0].title = 'Late private source'; pending.resolve(late); await settle();
    assert.equal(env.modal().hidden, true); assert.doesNotMatch(env.document.body.textContent, /Late private source/);
    assert.equal(data.count('preview'), 0); assert.equal(data.count('execute'), 0);
  });
}

test('closing a pending preview retires the token and does not bring back Publish when the response arrives', async t => {
  const pending = deferred(), data = backend({owner: publication('unpublished')}), env = await fixture(t, data);
  const row = env.content().querySelector(`[data-item-ref="${ITEM}"]`);
  env.click(env.button(row, 'Choose source')); await settle();
  const candidate = env.content().querySelector(`[data-source-ref="${SOURCE}"]`);
  env.click(candidate.tagName === 'BUTTON' ? candidate : candidate.querySelector('button')); await settle();
  data.control.preview = () => pending.promise;
  env.click(env.button(env.content(), 'Preview publication')); await settle();
  const read = data.last('preview'); assert.deepEqual(read.args[1].items, [selection()]);
  env.click(env.button(env.content(), 'Close')); await settle();
  assert.equal(read.args[2].signal.aborted, true); assert.equal(env.controller.getSnapshot().preparation.token, undefined);
  pending.resolve(data.defaults.preview(...read.args)); await settle();
  assert.equal(env.modal().hidden, true); assert.equal(data.count('execute'), 0);
  env.click(env.button(env.host, 'Share')); await settle(); assert.equal(env.content().querySelector('#album-top-share-public').hidden, false); await settle();
  unavailable(env.content(), 'Publish'); assert.equal(env.controller.getSnapshot().preparation.token, undefined);
});

test('post-open publication source renderer failure clears its review and retires joined private readers before fallback Close', async t => {
  const grants = deferred(), candidates = deferred(), page = deferred();
  const data = backend({owner: publication('unpublished'), handlers: {
    readAccessGrants: () => grants.promise, readAccessCandidates: () => candidates.promise,
  }}), env = await fixture(t, data), actualButton = env.runtime.buttonHtml;
  t.after(() => {env.runtime.buttonHtml = actualButton;});
  await selectAndPreview(env); const token = env.controller.getSnapshot().preparation.token; assert.ok(token);
  data.control.readPublicationSources = () => page.promise;
  env.click(env.button(env.content().querySelector(`[data-item-ref="${ITEM}"]`), 'Change source')); await settle();
  env.runtime.buttonHtml = config => {
    if (String(config.label).startsWith('Use source ')) throw new Error('Injected partial source renderer failure');
    return actualButton(config);
  };
  page.resolve(source()); await settle();
  const fallback = failedHost(env);
  assert.equal(env.controller.getSnapshot().preparation.token, undefined);
  assert.equal(env.controller.getSnapshot().publication.data, null);
  for (const read of data.calls.filter(call => ['readAccessGrants', 'readAccessCandidates'].includes(call.method))) {
    assert.equal(read.args[1].signal.aborted, true, 'outstanding joined private reader was aborted');
  }
  grants.resolve({top_ref: TOP, revision: '7', grants: [], next_cursor: null});
  candidates.resolve({top_ref: TOP, revision: '7', candidates: [{display_name: 'Late private member'}], next_cursor: null});
  await settle(); assert.doesNotMatch(env.document.body.textContent, /Late private member/); assert.equal(data.count('execute'), 0);
  env.runtime.buttonHtml = actualButton;
  env.click(env.button(fallback, 'Close')); await settle();
  env.click(env.button(env.host, 'Share')); await settle();
  assert.equal(env.modal().hidden, false); assert.ok(env.button(env.content(), 'Save visibility'));
});

for (const returned of [true, false]) {
  test(`partial publication mount failure cannot let a delayed native mobile return (${returned}) retire its replacement`, async t => {
    const history = deferred(), data = backend({owner: publication('unpublished')}), env = await fixture(t, data, {open: false});
    await env.controller.readSharing(); const actualButton = env.runtime.buttonHtml; let first = true;
    env.context.retireMobileAppFormPage = () => first ? (first = false, history.promise) : Promise.resolve(true);
    env.runtime.buttonHtml = config => {
      if (config.label === 'Preview publication') throw new Error('Injected publication mount failure');
      return actualButton(config);
    };
    t.after(() => {history.resolve(returned); env.runtime.buttonHtml = actualButton;});
    env.click(env.button(env.host, 'Share')); await settle(); const fallback = failedHost(env);
    assert.equal(env.controller.getSnapshot().preparation.token, undefined); assert.equal(data.count('execute'), 0);
    env.runtime.buttonHtml = actualButton;
    env.click(env.button(fallback, 'Close')); await settle();
    env.click(env.button(env.host, 'Share')); await settle();
    assert.equal(env.modal().hidden, false); const current = env.content().firstElementChild;
    assert.equal(env.content().querySelector('#album-top-share-public').hidden, false); await settle();
    history.resolve(returned); await settle();
    assert.equal(env.modal().hidden, false); assert.equal(env.content().firstElementChild, current);
    assert.ok(env.button(env.content(), 'Preview publication')); assert.equal(env.opens.length, 2);
    assert.equal(data.count('execute'), 0);
  });
}
