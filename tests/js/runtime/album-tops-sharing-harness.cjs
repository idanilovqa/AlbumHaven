'use strict';
const assert = require('node:assert/strict');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const {load, nextTask} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
let mountAlbumTopsView, mountSharePlaylist, mountAlbumTops;
async function loadOwners() {
  if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
  ({mountAlbumTopsView} = await load('album-tops/app.mjs'));
  ({mountSharePlaylist} = await load('playlists/native-sharing.mjs'));
  ({mountAlbumTops} = await load('album-tops/index.mjs'));
}
const visible = node => Boolean(node?.isConnected && !node.closest('[hidden],[inert]'));
const button = (root, label) => [...root.querySelectorAll('button')].find(node => {
  const text = node.getAttribute('aria-label') || node.textContent.trim();
  return visible(node) && (typeof label === 'string' ? text === label : label.test(text));
});
const buttons = root => [...root.querySelectorAll('button')].filter(visible);
const click = node => {assert.ok(node, 'actual DOM control exists'); return node.dispatchEvent(new node.ownerDocument.defaultView.Event('click'));};
const textContent = node => node?.textContent || '';
const choice = (root, label) => [...root.querySelectorAll('.ui-choice')].find(node => node.querySelector('.ui-choice__label')?.textContent === label)?.querySelector('button');
function choiceValue(node) {
  assert.ok(node, 'actual native Choice exists');
  const label = node.getAttribute('aria-label').split(': ').at(-1);
  return ({Viewer: 'viewer', Editor: 'editor', Private: 'private', 'Shared with this server': 'server_shared', 'Public link unavailable': 'link'})[label] ?? label;
}
function menuRows(node) {click(node); return [...node.ownerDocument.querySelectorAll('[role="menu"] [data-foobar-format]')];}
function closeMenu(node) {
  const menu = node.ownerDocument.querySelector('[role="menu"]');
  assert.ok(menu, 'canonical menu is current');
  menu.dispatchEvent(new node.ownerDocument.defaultView.Event('keydown', {key: 'Tab'}));
  assert.equal(node.ownerDocument.querySelector('[role="menu"]'), null, 'canonical Tab handler retires the menu');
}
function choiceOptions(node) {
  const rows = menuRows(node); assert.ok(rows.length, 'canonical native Choice menu opens');
  const result = rows.map(row => [row.getAttribute('data-foobar-format'), row.textContent.trim(), ...(row.disabled ? [true] : [])]);
  closeMenu(node); return result;
}
function selectChoice(node, value) {
  const rows = menuRows(node);
  if (!visible(node) || node.disabled) {assert.equal(rows.length, 0, 'retired/disabled Choice does not acquire a menu'); return false;}
  const row = rows.find(row => row.getAttribute('data-foobar-format') === value);
  assert.ok(row, `actual native Choice option ${value}`); click(row); return !row.disabled;
}
function search(root, value) {
  const input = root.querySelector('input[type="search"]') || root.querySelector('.search-input input');
  assert.ok(input, 'canonical SearchInput exists'); input.value = value;
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input'));
}
function nativeRuntime(t, options = {}) {
  const native = actualChoiceEnvironment(options), calls = {owners: [], closes: [], confirms: []};
  const open = native.runtime.openForm;
  native.runtime.openForm = options => {
    const owner = open({...options, onMount(host, close) {
      return options.onMount?.(host, (value, closeOptions) => {calls.closes.push(closeOptions); return close(value, closeOptions);});
    }}), record = {owner: null, options, dismissDisabled: options.dismissDisabled};
    const observed = {...owner,
      setDismissDisabled(value) {record.dismissDisabled = value; return owner.setDismissDisabled(value);},
      close(value, closeOptions) {calls.closes.push(closeOptions); return owner.close(value, closeOptions);}
    };
    record.owner = observed; calls.owners.push(record); return observed;
  };
  native.runtime.confirm = async (...args) => {calls.confirms.push(args); return false;};
  native.runtime.confirmRetryOriginal = async () => false;
  const owners = [];
  if (t) t.after(async () => {
    let failure;
    try {
      for (const owner of owners.reverse()) {try {owner.dispose();} catch (error) {failure ??= error;}}
      // The persistent modal shell resets pointer origin after the click task.
      // Let that zero-delay task complete naturally; do not clear timers in the fixture.
      await nextTask();
      native.assertClean(); if (failure) throw failure;
    } finally {native.host.remove();}
  });
  return {...native, native, calls, own(owner) {owners.push(owner); return owner;}};
}
function acquire(env, mount) {
  let owner; env.own({dispose() {owner?.dispose();}}); owner = mount(); return owner;
}
function viewOwner(env, props) {return acquire(env, () => mountAlbumTopsView(env.host, env.runtime, props));}
function playlistShareOwner(env, props) {return acquire(env, () => mountSharePlaylist(env.host, env.runtime, props));}
function sessionOwner(env, props) {return acquire(env, () => mountAlbumTops({host: env.host, runtime: env.runtime, ...props}));}
module.exports = {plain, deferred, settle, loadOwners, nativeRuntime, viewOwner, playlistShareOwner, sessionOwner,
  button, buttons, click, textContent, choice, choiceValue, choiceOptions, selectChoice, search, visible};
