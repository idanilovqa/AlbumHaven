'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const repo = path.resolve(__dirname, '../../..');
const base = path.join(repo, 'music_app/static/js/home-friends');
const load = name => import(pathToFileURL(path.join(base, name)).href);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const settle = async () => {for (let n = 0; n < 8; n++) await Promise.resolve();};
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const env = withDomPlatform(createNativeHomeRuntime()), {context: c, document} = env;
  const frames = new Map(), timers = new Map(), owners = []; let sequence = 0;
  document.defaultView = c; c.innerWidth = 1600; c.innerHeight = 1000;
  const media = new Map();
  c.matchMedia = query => {if (!media.has(query)) media.set(query, {matches:false, listeners:new Set(),addEventListener(_name,listener){this.listeners.add(listener);},removeEventListener(_name,listener){this.listeners.delete(listener);}});return media.get(query);};
  const observers=[];
  const Observer=class {constructor(callback){this.callback=callback;this.connected=false;this.disconnects=0;observers.push(this);}observe(){this.connected=true;}disconnect(){this.connected=false;this.disconnects++;}};
  c.MutationObserver=Observer;c.ResizeObserver=Observer;
  c.NodeFilter = {SHOW_TEXT:4};
  document.createTreeWalker = root => {const nodes=[];const collect=node=>{for(const child of node.childNodes){if(child.nodeType===3)nodes.push(child);else collect(child);}};collect(root);let at=-1;return {currentNode:null,nextNode(){this.currentNode=nodes[++at]||null;return !!this.currentNode;}};};
  document.createRange = () => {let node;return {selectNodeContents(value){node=value;},getBoundingClientRect(){return {width:(node?.textContent.length||0)*7,height:16};}};};
  c.Element.prototype.replaceWith = function(...nodes){const parent=this.parentNode;if(!parent)return;for(const node of nodes)parent.insertBefore(node,this);this.remove();};
  c.Element.prototype.before = function(...nodes){if(this.parentNode)for(const node of nodes)this.parentNode.insertBefore(node,this);};
  c.requestAnimationFrame = fn => {const id = ++sequence; frames.set(id, fn); return id;}; c.cancelAnimationFrame = id => frames.delete(id);
  c.setTimeout = fn => {const id = ++sequence; timers.set(id, fn); return id;}; c.clearTimeout = id => timers.delete(id);
  c.getComputedStyle = element => ({display:element.hidden?'none':'block',columnGap:'8',zIndex: element.style.zIndex || 'auto', backgroundColor: 'white', getPropertyValue: key => element.style.getPropertyValue(key)});
  c.Element.prototype.focus = function() {if (!this.isConnected || this.disabled || this.closest('[hidden], [inert]') || document.activeElement===this)return;const previous=document.activeElement;document.activeElement=this;previous?.dispatchEvent(new c.Event('blur',{bubbles:false}));previous?.dispatchEvent(new c.Event('focusout',{bubbles:true}));this.dispatchEvent(new c.Event('focus',{bubbles:false}));if(document.activeElement===this&&this.isConnected)this.dispatchEvent(new c.Event('focusin',{bubbles:true}));};
  c.Element.prototype.blur = function() {if (document.activeElement === this) document.activeElement = document.body;};
  const scrollCalls = [];
  // Add platform behavior locally; the historical harness stays immutable.
  c.Element.prototype.scrollIntoView = function(options = {}) {
    scrollCalls.push({target: this, options});
    if (!this.isConnected) return;
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
  c.Element.prototype.select = function() {this.selectionStart = 0; this.selectionEnd = String(this.value || '').length;};
  c.Element.prototype.getClientRects = function() {return this.isConnected && !this.closest('[hidden]') ? [{width: 100, height: 32}] : [];};
  c.addEventListener = document.addEventListener.bind(document); c.removeEventListener = document.removeEventListener.bind(document);
  const run = file => vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js', file), 'utf8'), c, {filename: file});
  for (const file of ['runtime/compact-data-table.js', 'runtime/album-track-table.js', 'runtime/in-page-tabs.js', 'runtime/trigger-anchor.js', 'runtime/library-settings.js', 'runtime/browser-dialog-helpers.js', 'unfolding-action-button.js']) run(file);
  const add = (id, tag = 'div') => {const element = document.createElement(tag); element.id = id; document.body.append(element); return element;};
  const template = add('navigation-tree-item-template', 'script'); template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8'); run('navigation-tree.js');
  const shell = add('app-shell'); shell.dataset.nativeAccountId = '4'; shell.dataset.nativeLibraryId = '5';
  const form = add('app-form-modal'); form.hidden = true; form.className = 'confirm-modal';
  form.innerHTML = '<div class="confirm-modal-dialog" role="dialog" aria-modal="true"><h2 id="app-form-title"></h2><button id="app-form-close" hidden></button><div id="app-form-content"></div><p id="app-form-error"></p><div class="confirm-modal-actions"><button id="app-form-cancel"></button><button id="app-form-submit"></button></div></div>';
  const runtime = {
    buttonHtml: value => c.ButtonComponent.renderButton(value), actionHtml: value => c.ButtonComponent.renderActionButton(value), iconHtml: name => c.ButtonComponent.renderIconSvg(name),
    alertHtml: value => c.buildOnPageAlertHtml(value), artboxHtml: value => c.buildAlbumArtboxHtml(value), escapeHtml: c.escapeHtml,
    tableHtml: value => c.buildCompactDataTable(value), galleryCardHtml: value => c.buildGalleryCardHtml(value), switchHtml: value => c.buildGallerySwitchHtml(value), ratingHtml: value => c.buildGalleryRatingHtml(value),
    navigationItemHtml: value => c.NavigationTree.renderItem(value), tabsHtml: value => c.buildInPageTabsHtml(value), mountTabs: element => c.mountInPageTabs(element),
    openChoice: (trigger, options) => c.openUtilityChoiceDropdown(trigger, options), openForm: options => c.openReactFormDialog(options, () => true),
    albumTrackRow: (track,index) => c.buildAlbumTrackTableRow(track,index,{readOnly:true}),
    detailHeaderHtml: value => c.buildAlbumDetailsHeaderHtml(value),
    viewChooserHtml: value => c.UnfoldingActionButton.render(value),
    mountViewChooser: (element,options) => c.UnfoldingActionButton.mount(element,options),
    viewIconHtml: value => {
      if (!['list', 'cards', 'covers'].includes(value)) return '';
      const existing = document.querySelector(`[data-gallery-view-choice="${value}"] svg`);
      if (existing) return existing.outerHTML;
      const fallback = document.createElement('div'); fallback.innerHTML = c.buildGalleryBarHtml({});
      return fallback.querySelector(`[data-gallery-view-choice="${value}"] svg`)?.outerHTML || '';
    },
    canTrackIntent: () => false, canResourceIntent: () => false,
    openAvatar() {},
  };
  function drain() {let turns = 0; while (frames.size || timers.size) {assert.ok(turns++ < 40, 'Native platform queue should settle'); const pending = [...frames.values(), ...timers.values()]; frames.clear(); timers.clear(); for (const fn of pending) fn(0);}}
  function own(owner) {owners.push(owner); return owner;}
  t.after(() => {for (const owner of owners.reverse()) owner.dispose(); drain();});
  const host = add('native-people-test');
  const named = (label, root = document) => root.querySelectorAll('button').find(node => !node.closest('[hidden], [inert]') && (node.getAttribute('aria-label') || node.textContent.trim()) === label);
  const input = (element, value) => {element.value = value; element.dispatchEvent(new c.Event('input', {bubbles: true}));};
  return {...env, c, document, host, form, runtime, add, own, named, input, drain, frames, timers, media, observers, scrollCalls};
}

module.exports = {fixture,load,deferred,settle,plain};
