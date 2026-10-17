'use strict';
const {attentionReadFixture}=require('./goals-attention-read-fixture.cjs');
const {bonusReadFixture}=require('./goals-bonus-read-fixture.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime} = require('./account-goals-dom-platform.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const repo = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8');
const STAMP = 'a'.repeat(64), CSRF = 'template-test-csrf';
const GOAL = '11111111-1111-4111-8111-111111111111';
const ALBUM = '22222222-2222-4222-8222-222222222222';
const CYCLE = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const EVIDENCE = '55555555-5555-4555-8555-555555555555';
const VERSION = 'b'.repeat(64), PERIODS = ['week', 'month', 'six-months', 'year'];
const albumDisplay = title => ({title, artist_display: 'Private artist', first_release_date: '2026-10', primary_type: 'Album'});
function value({full = false, completed = false, revision = full ? '2' : '1'} = {}) {
  return {goal_ref: full ? GOAL : null, revision,
    periods: Object.fromEntries(PERIODS.map((period,index) => [period, {period, top_ref: full ? GOAL : null,
      cycle: full ? {cycle_id: index===0?CYCLE:`33333333-3333-4333-8333-${String(index).padStart(12,'0')}`, started_at: '2026-10-14T00:00:00Z', start_date: '2026-10-14', due_date: '2026-10-21', timezone_name: 'UTC'} : null,
      album_refs: full ? [ALBUM] : [], manual_completed_at: full ? {[ALBUM]: completed ? '2026-10-15T12:00:00Z' : null} : {},
      total: full ? 1 : 0, completed: full && completed ? 1 : 0, percent: full && completed ? 100 : 0}])),
    albums: full ? [{catalog_ref: ALBUM, ...albumDisplay('Stored private album')}] : [],
    allowed_actions: {can_read: true, can_add: true, can_reset: true, can_complete: true, can_remove: true}};
}
const searchValue = () => ({limit: 10, candidates: [{provider: 'musicbrainz', entity_kind: 'release-group', release_group_id: GROUP, ...albumDisplay('Candidate title')}]});
const evidenceValue = () => ({evidence_ref: EVIDENCE, evidence_version: VERSION, expires_at: '2099-10-15T16:00:00Z', album: albumDisplay('Verified exact title')});
const settle = async () => {for (let n = 0; n < 32; n++) await Promise.resolve();};
function templateAssets() {
  const source = read('music_app/templates/account-goals.html');
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attributes, body]) => {
    assert.equal(body.trim(), '', 'The account template declares external entry assets only.');
    const src = attributes.match(/\bsrc="([^"]+)"/)?.[1];
    const type = attributes.match(/\btype="([^"]+)"/)?.[1] || 'classic';
    assert.ok(src?.startsWith('/static/js/'), 'Only local static JavaScript is admitted.');
    assert.ok(['classic', 'module'].includes(type));
    assert.ok(!/\basync(?:\s|$|=)/.test(attributes), 'Template ordering must be deterministic.');
    if (type === 'classic') assert.match(attributes, /\bdefer(?:\s|$|=)/);
    const relative = `music_app${src.split('?')[0]}`;
    assert.ok(!relative.includes('..'));
    return {type, relative};
  });
  const classic = scripts.filter(script => script.type === 'classic').map(script => script.relative);
  const modules = scripts.filter(script => script.type === 'module').map(script => script.relative);
  assert.equal(new Set(classic).size, classic.length, 'Classic assets are never evaluated twice.');
  assert.deepEqual(modules, ['music_app/static/js/home-friends/account-entry.mjs']);
  assert.equal(scripts.at(-1)?.type, 'module');
  return {source, classic, module: modules[0]};
}

// Faithful, deliberately bounded expansion of the guarded Jinja close macro.
// This is template text processing, not an application renderer substitute.
// Every conditional is accounted for using this call's explicit/default values;
// an unfamiliar macro construct fails rather than silently inventing markup.
function renderCloseButton() {
  const source = read('music_app/templates/partials/button.html');
  const once = (text, pattern, replacement) => {
    const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))];
    assert.equal(matches.length, 1, `Expected one guarded macro construct: ${pattern}`);
    return text.replace(pattern, replacement);
  };
  let icon = source.match(/<svg class="ui-icon[\s\S]*?<\/svg>/)?.[0]; assert.ok(icon);
  icon = once(icon, /\{% if class_name %\} \{\{ class_name \}\}\{% endif %\}/, ' action-button__icon ui-icon--close');
  const closePath = source.match(/'close': '([^']+)'/)?.[1]; assert.ok(closePath);
  icon = once(icon, /\{\{ icons\.get\(name, ''\) \| safe \}\}/, closePath);
  let button = source.match(/\{% macro action_button\([^\n]+\) -%\}([\s\S]*?)\{%- endmacro %\}/)?.[1]; assert.ok(button);
  button = once(button, /\{%- set is_toggle = pressed is sameas true or pressed is sameas false -%\}/, '');
  button = once(button, /\{% for attribute_name, attribute_value[\s\S]*?\{% endfor %\}/, '');
  button = once(button, /\{% if icon %\}[\s\S]*?\{% elif caller is defined %\}[\s\S]*?\{% endif %\}/, icon);
  const truth = new Map([["shape != 'default'", false], ["semantic != 'default'", false],
    ["presentation != 'outlined'", false], ['is_toggle', false], ['class_name', false],
    ['id', true], ['title', false], ['disabled', false], ['hidden', true]]);
  button = button.replace(/\{% if ([^%]+) %\}([\s\S]*?)\{% endif %\}/g, (_all, condition, content) => {
    assert.ok(truth.has(condition), `Unhandled action_button condition: ${condition}`);
    return truth.get(condition) ? content : '';
  });
  button = once(button, /\{\{ id \}\}/, 'app-form-close');
  button = once(button, /\{\{ aria_label \}\}/, 'Close dialog');
  assert.doesNotMatch(button, /\{%|\{\{/); return button.trim();
}

async function fixture(t, {full = false} = {}) {
  // Register all resource retirement before DOM creation, script evaluation,
  // module acquisition, network gates, or mounting can fail.
  let env, c, owner, data = value({full});
  const frames = new Map(), timers = new Map(), gates = [], tasks = [], observers = [];
  const calls = [], script = [], loaded = [];
  const bonusReads=bonusReadFixture(t,()=>data),attentionReads=attentionReadFixture(t,()=>data);
  let sequence = 0;
  function drain() {
    let turns = 0;
    while (frames.size || timers.size) {
      assert.ok(turns++ < 40, 'Platform scheduler should settle.');
      const pending = [...frames.values(), ...timers.values()]; frames.clear(); timers.clear();
      for (const callback of pending) callback(0);
    }
  }
  t.after(async () => {
    let failure;
    try {owner?.dispose();} catch (error) {failure ||= error;}
    try {c?.AlbumHavenPrivateUITransport?.dispose();} catch (error) {failure ||= error;}
    for (const gate of gates) gate.resolve(value());
    await Promise.allSettled([...gates.map(gate => gate.promise), ...tasks]);
    await settle();
    try {drain();} catch (error) {failure ||= error;}
    const leaked = observers.filter(observer => observer.connected);
    for (const observer of leaked) observer.disconnect();
    frames.clear(); timers.clear();
    if (failure) throw failure;
    assert.equal(leaked.length, 0, 'Every acquired native observer is retired.');
    assert.deepEqual(env?.forbiddenCalls || [], [], 'No unsupported platform operation was used.');
  });
  env = withDomPlatform(createNativeHomeRuntime()); c = env.context;
  const {document} = env;
  for (const name of ['ButtonComponent', 'openTrackModal', 'playAlbum', 'scheduleBrowserAnimationFrame', 'scheduleBrowserTimeout', 'openReactFormDialog', 'openUtilityChoiceDropdown']) {
    assert.equal(env.owner(name), undefined, `${name} must not be preinstalled by the DOM fixture.`);
  }
  // Bounded platform behavior follows home-friends-native-app-fixture.cjs.
  // Application functions and renderers are never supplied by this fixture.
  document.defaultView = c; c.innerWidth = 1600; c.innerHeight = 1000;
  c.location = new URL('https://albumhaven.test/account/goals/view');
  c.Headers = Headers; c.URLSearchParams = URLSearchParams;
  document.cookie = `__Host-album_haven_csrf=${CSRF}`;
  Object.defineProperty(document, 'visibilityState', {value: 'visible', writable: true, configurable: true});
  c.MutationObserver = c.ResizeObserver = class {
    constructor(callback) {this.callback = callback; this.connected = false; observers.push(this);}
    observe() {this.connected = true;}
    disconnect() {this.connected = false;}
  };
  c.requestAnimationFrame = callback => {const id = ++sequence; frames.set(id, callback); return id;};
  c.cancelAnimationFrame = id => frames.delete(id);
  c.setTimeout = callback => {const id = ++sequence; timers.set(id, callback); return id;};
  c.clearTimeout = id => timers.delete(id);
  c.getComputedStyle = element => ({display: element.hidden ? 'none' : 'block', columnGap: '8', direction: 'ltr',
    zIndex: element.style.zIndex || 'auto', backgroundColor: 'white', getPropertyValue: key => element.style.getPropertyValue(key)});
  c.Element.prototype.focus = function() {
    if (!this.isConnected || this.disabled || this.closest('[hidden], [inert]') || document.activeElement === this) return;
    const previous = document.activeElement; document.activeElement = this;
    previous?.dispatchEvent(new c.Event('blur', {bubbles: false})); previous?.dispatchEvent(new c.Event('focusout', {bubbles: true}));
    this.dispatchEvent(new c.Event('focus', {bubbles: false}));
    if (document.activeElement === this && this.isConnected) this.dispatchEvent(new c.Event('focusin', {bubbles: true}));
  };
  c.Element.prototype.blur = function() {if (document.activeElement === this) document.activeElement = document.body;};
  const scrollCalls = [];
  c.Element.prototype.scrollIntoView = function(options = {}) {
    scrollCalls.push({target: this, options}); if (!this.isConnected) return;
    const box = this.getBoundingClientRect();
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      const viewport = parent.getBoundingClientRect();
      if (parent.scrollHeight > parent.clientHeight) {
        const delta = options.block === 'end' ? box.bottom - viewport.bottom
          : options.block === 'center' ? (box.top + box.bottom - viewport.top - viewport.bottom) / 2
          : options.block === 'nearest' ? box.top < viewport.top ? box.top - viewport.top : box.bottom > viewport.bottom ? box.bottom - viewport.bottom : 0
          : box.top - viewport.top;
        parent.scrollTop = Math.max(0, Math.min(parent.scrollHeight - parent.clientHeight, parent.scrollTop + delta));
      }
    }
  };
  c.Element.prototype.getClientRects = function() {return this.isConnected && !this.closest('[hidden]') ? [{width: 100, height: 32}] : [];};
  c.addEventListener = document.addEventListener.bind(document); c.removeEventListener = document.removeEventListener.bind(document);
  c.fetch = (route, options = {}) => {
    const attention=attentionReads.dispatch(route,options);if(attention.handled)return Promise.resolve({ok:true,status:200,json:async()=>({status:"ready",context_ref:STAMP,context_scope:"account-goals-v1",data:attention.data})});
    const bonus=bonusReads.dispatch(route,options);if(bonus.handled)return Promise.resolve({ok:true,status:200,json:async()=>({status:"ready",context_ref:STAMP,context_scope:"account-goals-v1",data:bonus.data})});
    calls.push({route, options});
    const task = (async () => {
      let next;
      if (script.length) {
        const reply = script.shift(); assert.equal(route, reply.route, 'Network fixtures preserve request ordering.'); next = reply.reply;
      } else {assert.equal(route, '/account/goals', 'Unexpected transport request.'); next = data;}
      const result = await (typeof next === 'function' ? next(options) : next);
      if (result instanceof Error) throw result;
      return {ok: true, status: 200, json: async () => ({status: 'ready', context_ref: STAMP, context_scope: 'account-goals-v1', data: result})};
    })();
    tasks.push(task); task.catch(() => {}); return task;
  };
  const assets = templateAssets();
  // Parse the actual body before evaluating deferred assets, matching browser
  // DOM presence. Only fixed account values and the exact close macro expand.
  const importMacro = "{% from 'partials/button.html' import action_button %}";
  const closeMacro = "{{ action_button('Close dialog', id='app-form-close', icon='close', hidden=true) }}";
  let modal = read('music_app/templates/partials/app-form-modal.html');
  assert.equal(modal.split(importMacro).length, 2); assert.equal(modal.split(closeMacro).length, 2);
  modal = modal.replace(importMacro, '').replace(closeMacro, renderCloseButton());
  let body = assets.source.match(/<body>([\s\S]*?)<\/body>/)?.[1]; assert.ok(body);
  body = body.replace('{% include "partials/app-form-modal.html" %}', modal)
    .replaceAll('{{ account_goals_context }}', STAMP).replaceAll('{{ account_name }}', 'member.one').replaceAll('{{ csrf_token }}', CSRF);
  assert.doesNotMatch(body, /\{%|\{\{/); document.body.innerHTML = body;
  const host = document.getElementById('account-home'), form = document.getElementById('app-form-modal');
  assert.ok(host && form); assert.equal(document.getElementById('app-shell'), null);
  for (const relative of assets.classic) {
    vm.runInContext(read(relative), c, {filename: relative}); loaded.push(relative);
  }
  const entry = await import(pathToFileURL(path.join(repo, assets.module)).href);
  owner = entry.mountAccountGoalsEntry(host, entry.accountGoalsRuntime(c), c.createAlbumHavenPrivateUITransport);
  await bonusReads.ready;await attentionReads.ready;await settle(); drain();bonusReads.assertInitial();attentionReads.assertInitial();
  const named = (label, root = document) => root.querySelectorAll('button').find(node => !node.closest('[hidden], [inert]')
    && (node.getAttribute('aria-label') || node.textContent.trim()) === label);
  const input = (element, text) => {element.value = text; element.dispatchEvent(new c.Event('input', {bubbles: true}));};
  function enqueue(route, reply) {script.push({route, reply});}
  function deferred(route) {
    let resolve; const promise = new Promise(yes => {resolve = yes;}); const gate = {promise, resolve};
    gates.push(gate); enqueue(route, () => promise); return gate;
  }
  return {...env, lookup: env.owner, c, host, form, owner, calls, loaded, assets, bonusReads, attentionReads, allRequests:attentionReads.allRequests, named, input, enqueue, deferred, scrollCalls,
    setData: next => {data = next;}, async flush() {await settle(); drain(); await settle();},
    submit(element) {element.dispatchEvent(new c.Event('submit', {bubbles: true, cancelable: true}));}};
}
module.exports = {fixture, templateAssets, read, value, searchValue, evidenceValue, STAMP, CSRF, GOAL, ALBUM, CYCLE, GROUP, EVIDENCE, VERSION};
