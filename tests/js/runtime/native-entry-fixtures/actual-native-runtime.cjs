'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime, readRepo} = require('../native-home-harness.cjs');
const {withPlaylistDomPlatform} = require('../playlist-dom-platform.cjs');
const root = path.resolve(__dirname, '../../../..');
const load = name => import(pathToFileURL(path.join(root, 'music_app/static/js', name)).href);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
// This is a bounded microtask drain, not a wait for external work. Deferred
// providers and navigation must be explicitly resolved by each test.
async function drain() {for (let n = 0; n < 20; n++) await Promise.resolve();}
function nativeEnvironment() {
  const env = withPlaylistDomPlatform(createNativeHomeRuntime()), {document, context} = env;
  const frames = new Map(), observers = [], windowListeners = []; let sequence = 0;
  // Browser platform only: no consumer/domain/native helper is replaced.
  const platform = {
    innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({display: 'block', columnGap: '8', overflowY: 'visible'}),
    requestAnimationFrame(callback) {frames.set(++sequence, callback); return sequence;}, cancelAnimationFrame: key => frames.delete(key),
    addEventListener(type, callback, capture = false) {windowListeners.push({type, callback, capture});},
    removeEventListener(type, callback, capture = false) {const index = windowListeners.findIndex(row => row.type === type && row.callback === callback && row.capture === capture); if (index >= 0) windowListeners.splice(index, 1);},
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.retired = true;}},
    ResizeObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.retired = true;}},
  };
  Object.assign(context, platform); document.defaultView = context; env.installWindow(document.defaultView); document.documentElement.clientWidth = 1000;
  const proto = context.Element.prototype;
  proto.focus = function () {if (this.disabled || !this.isConnected) return; document.activeElement = this; this.dispatchEvent(new context.Event('focusin'));};
  proto.scrollIntoView = function () {};
  // Geometry signals focus eligibility only. These tests make no layout claim.
  proto.getClientRects = function () {return this.isConnected && !this.closest('[hidden],[inert]') ? [{width: 10, height: 10}] : [];};
  for (const name of ['name', 'type']) Object.defineProperty(proto, name, {configurable: true, get() {return this.getAttribute(name) || '';}, set(value) {this.setAttribute(name, value);}});
  Object.defineProperty(proto, 'tabIndex', {configurable: true, get() {return Number(this.getAttribute('tabindex') || 0);}, set(value) {this.setAttribute('tabindex', value);}});
  // Instantiate the exact default branch of the server SearchInput macro; no
  // independent fixture control markup or behavior is supplied.
  const macro = readRepo('music_app/templates/partials/search-input.html').match(/{% macro search_input\([\s\S]*?-\s*%}([\s\S]*?){%- endmacro %}/);
  assert.ok(macro, 'canonical search_input macro exists');
  const substitutions = {name: 'q', input_id: 'native-top-search', value: '', placeholder: 'Search', label: 'Search', button_type: 'button', button_label: 'Search'};
  const searchHtml = macro[1].replace(/{% if [\s\S]*?{% endif %}/g, '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => {assert.ok(Object.hasOwn(substitutions, key), `known macro field ${key}`); return substitutions[key];});
  assert.doesNotMatch(searchHtml, /{%|{{/);
  const searchTemplate = document.createElement('template'); searchTemplate.id = 'native-search-field-template'; searchTemplate.innerHTML = searchHtml; document.body.append(searchTemplate);
  const navigationTemplate = document.createElement('script'); navigationTemplate.id = 'navigation-tree-item-template';
  navigationTemplate.textContent = readRepo('music_app/templates/components/navigation-tree-item.html'); document.body.append(navigationTemplate);
  const buttons = context.ButtonComponent;
  const modals = readRepo('music_app/templates/partials/confirm-modals.html');
  const marker = '<div class="confirm-modal" id="app-confirm-modal" hidden>';
  assert.ok(modals.includes(marker));
  const modalHtml = modals.slice(modals.indexOf(marker)).replace("{{ action_button('Close dialog', id='app-form-close', icon='close', hidden=true) }}",
    buttons.renderActionButton({id: 'app-form-close', icon: 'close', ariaLabel: 'Close dialog', hidden: true}));
  assert.doesNotMatch(modalHtml, /{%|{{/); document.body.insertAdjacentHTML('beforeend', modalHtml);
  for (const file of ['search-input.js', 'in-page-tabs.js', 'browser-dialog-helpers.js']) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context, {filename: file});
  vm.runInContext(readRepo('music_app/static/js/navigation-tree.js'), context, {filename: 'navigation-tree.js'});
  const host = document.createElement('section'); document.body.append(host);
  const opens = [], runtime = {
    buttonHtml: buttons.renderButton, actionHtml: buttons.renderActionButton, iconHtml: buttons.renderIconSvg,
    alertHtml: env.owner('buildOnPageAlertHtml'), galleryCardHtml: env.owner('buildGalleryCardHtml'), artboxHtml: env.owner('buildAlbumArtboxHtml'),
    tabsHtml: env.owner('buildInPageTabsHtml'), mountTabs: env.owner('mountInPageTabs'), searchHtml: env.owner('buildSearchInputHtml'),
    navigationItemHtml: context.NavigationTree.renderItem,
    openForm(options) {opens.push(options); return env.owner('openReactFormDialog')(options, () => true);},
    confirm(message, options = {}) {return env.owner('showAppConfirmDialog')({...options, message});},
    confirmRetryOriginal() {return env.owner('showAppConfirmDialog')({message: 'Retry exact original request?', acceptLabel: 'Retry'});},
  };
  const baselineListeners = env.listeners().length;
  const input = (node, value) => {assert.ok(node, 'input exists'); node.value = value; node.dispatchEvent(new context.Event('input'));};
  const button = (root, label) => {const result = root.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label && !node.closest('[hidden]')); assert.ok(result, `visible button ${label}`); return result;};
  const modal = () => document.getElementById('app-form-modal');
  const content = () => document.getElementById('app-form-content');
  function assertClean() {
    assert.equal(windowListeners.length, 0, 'native global header/gesture listeners retired');
    assert.equal(frames.size, 0, 'native scheduled frames cancelled');
    assert.ok(observers.every(owner => owner.retired), 'native observers disconnected');
    // Native tabs own listeners on detached tablists. Assert no extra connected
    // listeners rather than claiming their garbage collection has been observed.
    assert.equal(env.listeners().filter(row => row.target.isConnected).length, baselineListeners, 'connected listeners restored');
  }
  return {...env, host, runtime, opens, input, button, modal, content, frames, observers, assertClean};
}
// Entry-specific extension. Product owners are always loaded unchanged. Shell,
// provider and notification-registry seams are controlled inputs; renderers,
// modal/choice owners, controllers and consumer modules are never substituted.
function entryEnvironment(t) {
  const env = nativeEnvironment(), c = env.context, doc = env.document;
  const events = new Map(), timers = new Map(); let timerId = 0;
  c.addEventListener = (type, fn) => {if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn);};
  c.removeEventListener = (type, fn) => events.get(type)?.delete(fn);
  c.dispatchEvent = event => {for (const fn of [...(events.get(event.type) || [])]) fn(event); return true;};
  c.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  c.setTimeout = fn => {timers.set(++timerId, fn); return timerId;}; c.clearTimeout = key => timers.delete(key);
  c.queueMicrotask = queueMicrotask; c.AbortController = AbortController;
  c.crypto = require('node:crypto').webcrypto;
  c.getComputedStyle = () => ({display: 'block', columnGap: '8', overflowY: 'visible', getPropertyValue: () => ''});
  c.Element.prototype.select = function() {this.selectionStart = 0; this.selectionEnd = String(this.value || '').length;};
  c.Element.prototype.blur = function() {if (doc.activeElement === this) doc.activeElement = doc.body;};
  for (const file of ['runtime/compact-data-table.js', 'runtime/album-track-table.js', 'runtime/trigger-anchor.js', 'runtime/library-settings.js', 'runtime/home-recent.js']) {
    vm.runInContext(readRepo(`music_app/static/js/${file}`), c, {filename: file});
  }
  Object.assign(env.runtime, {
    escapeHtml: c.escapeHtml, tableHtml: env.owner('buildCompactDataTable'),
    ratingHtml: env.owner('buildGalleryRatingHtml'), albumTrackRow: (track,index) => env.owner('buildAlbumTrackTableRow')({...track,duration:track.duration_display},index,{readOnly:true}),
    detailHeaderHtml: env.owner('buildAlbumDetailsHeaderHtml'),
    openChoice: (anchor, options) => env.owner('openUtilityChoiceDropdown')(anchor, options),
    mountRecent: (host, options) => env.owner('HomeRecent').mount(host, options),
  });
  const add = id => {const node = doc.createElement('div'); node.id = id; doc.body.append(node); return node;};
  const app = add('app-shell'); app.dataset.nativeAccountId = '1'; app.dataset.nativeLibraryId = '1';
  const savedGlobals = new Map();
  for (const [name, value] of Object.entries({window:c,document:doc,Event:c.Event,crypto:c.crypto})) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable:true,writable:true,value});
  }
  t.after(() => {for (const [name, descriptor] of savedGlobals) {if (descriptor) Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  return {...env, add, events, timers};
}
function nativeShell(env, initial = {}) {
  let value = {authenticated:true,visible:false,inLibrary:true,scopeKey:'account:one:library',entryKey:'entry:one',section:'recent',friendRef:'',profileRef:'',presentation:null,payload:null,...initial};
  const listeners = new Set(), calls = {recent:[],navigate:[],presentation:[],retired:[]};
  const runtime = {...env.runtime, snapshot:()=>value, subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    readRecent:options=>{calls.recent.push(options);return Promise.resolve({recent_local_albums:[],recent_not_local_albums:[]});},
    configureActivityProvider:({readActivity})=>readActivity || null,
    retireFriendActivity:(...args)=>calls.retired.push(args),
    savePresentation:(...args)=>calls.presentation.push(args),
    navigate:options=>{calls.navigate.push(options);return Promise.resolve(true);},
    readPlaylists:()=>Promise.resolve(playlistPayload()),
    notificationRegistry:()=>null, subscribeNotificationRegistry:()=>()=>{},
  };
  const change = patch => {value={...value,...patch};for(const listener of [...listeners]) listener();};
  return {runtime,change,listeners,calls};
}
function friendsPayload(name = 'Owner') {return {friends:[],requests:[],profile:{display_name:name,handle:'owner',bio:'',allowed_actions:{}},allowed_actions:{}};}
function playlistPayload(selected = null, patch = {}) {
  const actions = {can_open:true,can_copy:true,can_delete:true,can_edit:true,can_rename:true};
  const items = ['one','two'].map(playlist_id=>({playlist_id,title:playlist_id,item_count:0,allowed_actions:actions}));
  return {playlist_sidebar:{active_playlist_id:selected||'',items},playlist_actions:{can_create:false},
    ...(selected ? {playlist_detail:{playlist_id:selected,title:selected,description:'',visibility:'private',revision:'1',items_complete:true,active_sort:{key:'playlist_position',direction:'asc'},track_rows:[],allowed_actions:actions,...patch}} : {playlist_index:{playlists:items}})};
}
function registry() {
  const sources=[];
  return {sources,registerSource(options){const record={options,disposed:false,replacements:[],replace(rows,status){this.replacements.push({rows,status});},dispose(){this.disposed=true;}};sources.push(record);return record;}};
}
module.exports = {entryEnvironment,nativeShell,friendsPayload,playlistPayload,registry,load,deferred,drain};
