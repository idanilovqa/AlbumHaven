'use strict';
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const F = require('./foobar-account-import-fixture.cjs');

async function native(t, transport = F.wire(), {sibling = false, library = '', allowed = true, current = true, initialize = true} = {}) {
  const {mountFoobarImport} = await F.load('index.mjs');
  const env = createNativeHomeRuntime(), {context: c, document} = env, proto = c.Element.prototype;
  const time = F.clock(), intervals = new Map(), observers = [], windowListeners = [], tables = []; let next = 0;
  document.defaultView = c; c.innerWidth = 390; c.innerHeight = 844;
  // Platform-only additions remain local to this new fixture. The historical
  // native-home harness and all protected published fixtures are unchanged.
  const queryAll = proto.querySelectorAll;
  proto.querySelectorAll = function (selector) {
    if (!selector.includes('>')) return queryAll.call(this, selector);
    // One bounded child-combinator shape used by the actual CompactDataTable.
    const match = /^(\.[a-zA-Z_][\w-]*)\s*>\s*(\[role="row"\])$/.exec(selector);
    if (!match) throw new Error(`Unsupported native Foobar fixture child selector: ${selector}`);
    return queryAll.call(this, match[2]).filter(node => node.parentElement?.matches(match[1]));
  };
  proto.querySelector = function (selector) {return this.querySelectorAll(selector)[0] || null;};
  proto.focus = function () {if (!this.isConnected || this.disabled || this.closest('[hidden],[inert]')) return; document.activeElement = this;};
  proto.click = function () {if (!this.disabled) this.dispatchEvent(new c.Event('click'));};
  for (const property of ['type', 'value']) Object.defineProperty(proto, property, {configurable: true, get() {return this['_' + property] || '';}, set(value) {this['_' + property] = String(value);}});
  c.setInterval = callback => {const id = ++next; intervals.set(id, callback); return id;}; c.clearInterval = id => intervals.delete(id);
  c.addEventListener = (type, callback) => {windowListeners.push({type, callback});};
  c.removeEventListener = (type, callback) => {const index = windowListeners.findIndex(row => row.type === type && row.callback === callback); if (index >= 0) windowListeners.splice(index, 1);};
  c.dispatchEvent = event => {for (const row of [...windowListeners]) if (row.type === event.type && windowListeners.includes(row)) row.callback(event);};
  c.MutationObserver = class {
    constructor(callback) {this.callback = callback; this.active = false; this.observations = []; observers.push(this);}
    observe(target, options) {this.active = true; this.observations.push({target, options});}
    disconnect() {this.active = false;}
  };
  F.vm.runInContext(F.read('music_app/static/js/runtime/compact-data-table.js'), c, {filename: 'compact-data-table.js'});
  const tableOwner = env.owner('buildCompactDataTable'); assert.equal(typeof tableOwner, 'function');
  const root = document.createElement('main'); root.id = 'app-shell';
  root.dataset.accountFoobarContext = F.STAMP; root.dataset.accountFoobarScope = F.SCOPE;
  root.dataset.accountFoobarMatchingLibraryId = library; document.body.append(root);
  const host = document.createElement('section'); (sibling ? document.body : root).append(host);
  const baseline = env.listeners(); let owner;
  if (initialize) transport.enqueue('/ui/source', F.source());
  owner = mountFoobarImport(host, {fetch: transport.fetch, contextRoot: root,
    allows: action => allowed && action === 'account.self.foobar.write', isCurrent: () => current,
    renderButton: options => c.ButtonComponent.renderButton(options),
    renderTable: options => {tables.push(options); return tableOwner(options);},
  });
  const clean = () => {
    try {
      owner.dispose(); assert.equal(intervals.size, 0); assert.equal(time.tasks.size, 0);
      assert.ok(observers.every(observer => !observer.active)); assert.equal(windowListeners.length, 0);
      assert.deepEqual(env.listeners(), baseline, 'Every listener added by the component is released, including detached nodes');
    } finally {time.restore();}
  };
  t.after(clean); await F.settle();
  const action = name => {const node = host.querySelector(`[data-foobar-import-action="${name}"]`); assert.ok(node, `Real shared Button action ${name}`); return node;};
  const field = suffix => {
    const section = host.querySelector('.foobar-import'), title = section?.getAttribute('aria-labelledby') || '';
    assert.match(title, /^foobar-import-\d+-title$/, 'Exact native component-owned title identity');
    const id = title.slice(0, -'-title'.length) + '-' + suffix;
    const nodes = section.querySelectorAll(suffix === 'mapping' ? 'select' : 'input').filter(node => node.id === id);
    assert.equal(nodes.length, 1, `Exactly one native field ${suffix}`);
    return nodes[0];
  };
  const change = node => node.dispatchEvent(new c.Event('change'));
  const choose = selected => {const input = field('file'); input.files = [selected]; input.value = 'C:\\fakepath\\' + selected.name; change(input);};
  const key = (node, value) => {const event = new c.Event('keydown', {key: value}); node.dispatchEvent(event); return event;};
  const mutation = (target, attributeName) => {for (const observer of observers) if (observer.active) observer.callback([{type: 'attributes', target, attributeName}]);};
  return {...env, c, root, host, owner, wire: transport, time, tables, intervals, observers, action, field, change, choose, key, mutation,
    allow(value) {allowed = value;}, current(value) {current = value;}, idleCheck() {for (const callback of [...intervals.values()]) callback();}};
}
async function reviewed(f, {selected = F.file(), proposal = F.proposal()} = {}) {
  f.choose(selected); await F.settle(); f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: proposal}));
  f.action('preview').focus(); f.click(f.action('preview')); await F.settle(); await f.time.tick();
  assert.equal(f.action('confirm').disabled, true); return selected;
}
async function recover(f, state = F.job()) {
  f.field('recover-source').value = F.SOURCE; f.field('recover-job').value = F.JOBREF;
  f.wire.enqueue('/job/status', state); f.click(f.action('recover')); await F.settle();
}
module.exports = {native, reviewed, recover};
