'use strict';
const assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs');
const {createNativeHomeRuntime, buttonNamed} = require('./native-home-harness.cjs');
async function platform(t, {entry = false, scrollOwner = 'inner', variable = false} = {}) {
  const env = createNativeHomeRuntime(), {document, context: c} = env, proto = c.Element.prototype;
  document.defaultView = c; c.innerHeight = 400;
  const listeners = [], observers = [];
  c.addEventListener = (type, callback) => listeners.push({type, callback});
  c.removeEventListener = (type, callback) => {const i = listeners.findIndex(x => x.type === type && x.callback === callback); if (i >= 0) listeners.splice(i, 1);};
  c.dispatchEvent = event => {for (const x of [...listeners]) if (x.type === event.type) x.callback(event);};
  c.MutationObserver = class {constructor(callback) {this.callback = callback; this.active = false; observers.push(this);} observe() {this.active = true;} disconnect() {this.active = false;}};
  c.getComputedStyle = element => ({overflowY: scrollOwner !== 'document' && (element.id === 'albums-scroll' || scrollOwner === 'inner' && element.id === 'history-scroller') ? 'auto' : 'visible'});
  proto.focus = function () {document.activeElement = this;};
  Object.defineProperty(proto, 'value', {configurable: true, get() {return this._value || '';}, set(value) {this._value = String(value);}});
  const outer = document.createElement('div'); outer.id = 'albums-scroll'; document.body.append(outer);
  const inner = document.createElement('div'); inner.id = 'history-scroller'; outer.append(inner);
  const scroller = scrollOwner === 'document' ? document.documentElement : scrollOwner === 'outer' ? outer : inner;
  document.scrollingElement = document.documentElement;
  for (const element of [outer, inner, document.documentElement]) element.scrollTop = 0;
  const rowHeight = element => variable ? 35 + (Number(element.querySelector('h4')?.textContent.match(/(\d+)$/)?.[1] || 0) % 4) * 15 : 50;
  const offset = element => element.parentNode.children.slice(0, element.parentNode.children.indexOf(element)).reduce((sum, row) => sum + rowHeight(row), 0);
  proto.getBoundingClientRect = function () {
    if (this === scroller) return {top: 0, bottom: 400, height: 400};
    if (this.classList.contains('foobar-history__row')) {const top = offset(this)-scroller.scrollTop, height = rowHeight(this); return {top, bottom: top+height, height};}
    if (this.classList.contains('foobar-history__rows')) {const height = this.children.reduce((sum, row) => sum + rowHeight(row), 0); return {top: -scroller.scrollTop, bottom: height-scroller.scrollTop, height};}
    return {top: 0, bottom: 20, height: 20};
  };
  const root = document.createElement('main'); root.id = 'account-foobar-history'; root.dataset.accountFoobarContext = H.STAMP; root.dataset.accountFoobarScope = H.SCOPE; root.dataset.accountFoobarHistoryAllowed = 'true'; inner.append(root);
  const host = document.createElement('section'); host.setAttribute('data-foobar-history-host', ''); root.append(host);
  const wire = H.wire({initialList: false}); wire.enqueue('/history/sources', H.sources()); c.fetch = wire.fetch;
  const baseline = env.listeners(); let owner, view, restoreGlobals = () => {};
  if (entry) {
    const descriptors = ['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.window = c; globalThis.document = document;
    restoreGlobals = () => {for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}};
    try {await H.load('account-entry.mjs'); await H.settle();} catch (error) {restoreGlobals(); throw error;}
  } else {
    const {createFoobarHistoryOwner} = await H.load('owner.mjs'), {mountFoobarHistoryPanel} = await H.load('panel.mjs');
    owner = createFoobarHistoryOwner({fetch: wire.fetch, contextRoot: root, allows: action => root.dataset.accountFoobarHistoryAllowed === 'true' && action === 'account.self.foobar.read', isCurrent: () => true});
    view = mountFoobarHistoryPanel(host, {buttonHtml: options => c.ButtonComponent.renderButton(options)}, {owner, isCurrent: () => true}); await H.settle();
  }
  t.after(() => {try {if (entry) c.dispatchEvent(new c.Event('pagehide')); else {view.dispose(); owner.dispose();} assert.ok(observers.every(x => !x.active)); assert.equal(listeners.length, 0); assert.deepEqual(env.listeners(), baseline); assert.equal(env.forbiddenCalls.length, 0);} finally {restoreGlobals();}});
  const change = element => element.dispatchEvent(new c.Event('change'));
  const choose = async (page = H.page()) => {wire.enqueue('/history/list', page); const select = host.querySelectorAll('select')[0]; select.value = H.SOURCE; change(select); await H.settle();};
  return {...env, c, root, host, wire, owner, view, scroller, outer, inner, observers, choose, change, button: text => buttonNamed(host, new RegExp('^' + text + '$')), scroll(position) {scroller.scrollTop = position; (scrollOwner === 'document' ? c : scroller).dispatchEvent(new c.Event('scroll'));}};
}
module.exports = {platform};
