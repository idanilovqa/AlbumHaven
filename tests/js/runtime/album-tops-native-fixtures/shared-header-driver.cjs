'use strict';
const assert = require('node:assert/strict');
const actual = require('./actual-native-runtime.cjs');
const {load, TOP, detail, service, preparedController, nativeEnvironment, drain} = actual;
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
const ACTIONS = ['Edit Album Top', 'Share', 'Save a copy', 'Delete Album Top'];
const labels = root => [...root.querySelectorAll('button')].filter(node => !node.closest('[hidden]')).map(node => node.getAttribute('aria-label') || node.textContent.trim()).filter(label => label !== 'Tools');
async function fixture(t, {selected = true, grants = {}, editDraft = false, inlineNavigation = false, patch = {}} = {}) {
  const env = nativeEnvironment({inlineNavigation}), backend = service();
  backend.data.detail = detail({title: 'Top <safe>', ...(editDraft ? {edit_draft: {items: [], publication_preview_required: false}} : {}), ...patch});
  const controller = await preparedController(backend, {selected: selected ? TOP : null, scopeKey: env.runtime.snapshot().scopeKey});
  let state = controller.getSnapshot();
  if (selected) state = {...state, detail: {...state.detail, data: {...state.detail.data, allowed_actions: {...state.detail.data.allowed_actions, ...grants}}}};
  // State projections are test input (including deliberately malformed grants),
  // not replacement successful UI owners. All controller operations remain real.
  controller.getSnapshot = () => state;
  const calls = {opens: [], confirms: [], mutations: []};
  const confirm = env.runtime.confirm, mutate = controller.mutate;
  env.runtime.confirm = (...args) => {calls.confirms.push(args); return confirm(...args);};
  controller.mutate = (...args) => {calls.mutations.push(args); return mutate(...args);};
  const {mountAlbumTopsView} = await load('album-tops/app.mjs');
  const props = () => ({controller, providers: backend.providers, state, onOpen: ref => calls.opens.push(ref)});
  const view = mountAlbumTopsView(env.host, env.runtime, props());
  t.after(async () => {view.dispose(); controller.dispose(); await actual.nextTask(); env.assertClean();});
  return {...env, backend, controller, calls, view, state: () => state,
    replace(next, reconcile = true) {state = next; if (reconcile) view.update(props());}, render() {view.update(props());},
    header() {const roots = env.host.querySelectorAll('[data-shared-header]'); assert.equal(roots.length, 1); assert.equal(env.host.querySelectorAll('header').length, 1); return roots[0];}};
}
// Explicit geometry inputs to the actual measurement owner. Not a browser
// layout claim; the native header decides compactness and moves focus itself.
function measure(h, width) {
  const root = h.header ? h.header() : h.host.querySelector('[data-shared-header]');
  for (const node of [root, ...root.querySelectorAll('*')]) {
    node.scrollWidth = 0; node.scrollHeight = 24; node.offsetHeight = 24; node.clientHeight = 24;
    h.setRect(node, {width: 0, height: 24});
  }
  h.setRect(root, {width, height: 40});
  for (const [selector, w] of [['.home-header__content', 100], ['.home-header__leading', 40], ['.home-header__tools', 34]]) h.setRect(root.querySelector(selector), {width: w, height: 24});
  for (const node of root.querySelector('.home-header__primary-actions').children) h.setRect(node, {width: 100, height: 24});
  for (const observer of h.observers) if (!observer.retired) observer.callback([]);
  const pending = [...h.frames.values()]; h.frames.clear(); for (const callback of pending) callback();
  return root;
}
function navigation(h) {
  let guard = null; const state = {allow: false, calls: 0, callbacks: 0};
  h.runtime.registerDraftNavigation = next => {guard = next; return () => {if (guard === next) guard = null;};};
  h.runtime.deferDraftNavigation = async callback => {
    state.calls++; if (!state.allow || !guard?.isCurrent()) return false;
    const current = guard; state.callbacks++; const result = await callback(); current.onDiscard(); return result;
  };
  return state;
}
module.exports = {...actual, ACTIONS, labels, fixture, measure, navigation};
