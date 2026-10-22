'use strict';
const assert = require('node:assert/strict');
// Additive bounded DOM platform support adapted from the frozen Album sheet fixture.
// Attributes, child lists and explicit text-node changes retain observer delivery.
// No scope, Search, form, focus or lifecycle policy is implemented here.
function installAttributeObservers(h) {
  const observers = new Set(), errors = [];
  let scheduled = false, deliveryCount = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      for (const observer of [...observers]) {
        const records = observer.takeRecords();
        observer.transient = [];
        if (!records.length) continue;
        deliveryCount++;
        try {observer.callback(records, observer);} catch (error) {errors.push(error);}
      }
    });
  };
  class MutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError('Observer callback must be a function');
      this.callback = callback; this.bindings = new Map(); this.records = []; this.transient = [];
      observers.add(this);
    }
    observe(target, options = {}) {
      if (!(target instanceof h.context.Node)) throw new TypeError('Observer target must be a Node');
      const config = {...options};
      if (config.attributes === undefined && (config.attributeFilter !== undefined || config.attributeOldValue !== undefined)) config.attributes = true;
      if (config.characterData === undefined && config.characterDataOldValue !== undefined) config.characterData = true;
      if (!config.attributes && !config.childList && !config.characterData) throw new TypeError('A mutation type is required');
      if (config.attributes === false && (config.attributeOldValue || config.attributeFilter !== undefined)) throw new TypeError('Attribute options require attributes');
      if (config.characterData === false && config.characterDataOldValue) throw new TypeError('Character data options require character data');
      config.attributeFilter = config.attributeFilter === undefined ? null : [...config.attributeFilter].map(String);
      this.bindings.set(target, config);
      this.transient = this.transient.filter(binding => binding.source !== target);
      observers.add(this);
    }
    disconnect() {this.bindings.clear(); this.records = []; this.transient = []; observers.delete(this);}
    takeRecords() {const records = this.records; this.records = []; return records;}
  }
  const bindings = observer => [...observer.bindings].map(([root, config]) => ({root, config, source: root})).concat(observer.transient);
  const covers = (binding, target) => binding.root === target || binding.config.subtree && binding.root.contains(target);
  const enqueue = record => {
    for (const observer of observers) {
      const matching = bindings(observer).filter(binding => covers(binding, record.target)
        && (record.type === 'childList' ? binding.config.childList : record.type === 'characterData' ? binding.config.characterData : binding.config.attributes
          && (!binding.config.attributeFilter || binding.config.attributeFilter.includes(record.attributeName))));
      if (!matching.length) continue;
      const keepOld = record.type === 'attributes' ? matching.some(binding => binding.config.attributeOldValue)
        : record.type === 'characterData' && matching.some(binding => binding.config.characterDataOldValue);
      observer.records.push({...record, oldValue: keepOld ? record.oldValue : null});
      schedule();
    }
  };
  const proto = h.context.Element.prototype, set = proto.setAttribute, remove = proto.removeAttribute;
  proto.setAttribute = function (name, value) {
    const key = String(name), oldValue = this.getAttribute(key), result = set.call(this, key, value);
    enqueue({type: 'attributes', target: this, attributeName: key, attributeNamespace: null, oldValue,
      addedNodes: [], removedNodes: [], previousSibling: null, nextSibling: null});
    return result;
  };
  proto.removeAttribute = function (name) {
    const key = String(name), oldValue = this.getAttribute(key), result = remove.call(this, key);
    if (oldValue !== null) enqueue({type: 'attributes', target: this, attributeName: key, attributeNamespace: null, oldValue,
      addedNodes: [], removedNodes: [], previousSibling: null, nextSibling: null});
    return result;
  };
  // Existing DOM primitives remain authoritative. append/prepend, remove,
  // replaceChildren, textContent and innerHTML delegate to these primitives.
  // Fragment/replaceChildren operations retain the harness's per-child records.
  // Shared consumers use notifications rather than compound-record cardinality.
  const nodeProto = h.context.Node.prototype, insert = nodeProto.insertBefore, detach = nodeProto.removeChild;
  nodeProto.insertBefore = function (node, before) {
    const noOp = node === before, fragment = node?.nodeType === 11;
    const result = insert.call(this, node, before);
    if (!noOp && !fragment) {
      const index = this.childNodes.indexOf(node);
      enqueue({type: 'childList', target: this, addedNodes: [node], removedNodes: [],
        previousSibling: this.childNodes[index - 1] || null, nextSibling: this.childNodes[index + 1] || null,
        attributeName: null, attributeNamespace: null, oldValue: null});
    }
    return result;
  };
  nodeProto.removeChild = function (node) {
    const index = this.childNodes.indexOf(node), previousSibling = this.childNodes[index - 1] || null, nextSibling = this.childNodes[index + 1] || null;
    const transient = [...observers].map(observer => ({observer, inherited: bindings(observer).filter(binding => binding.config.subtree && covers(binding, this))}));
    const result = detach.call(this, node);
    enqueue({type: 'childList', target: this, addedNodes: [], removedNodes: [node], previousSibling, nextSibling,
      attributeName: null, attributeNamespace: null, oldValue: null});
    // Detached descendants stay observable until the removal delivery checkpoint.
    for (const {observer, inherited} of transient) {
      for (const binding of inherited) observer.transient.push({...binding, root: node});
      if (inherited.length) schedule();
    }
    return result;
  };
  h.characterDataChanged = (target, oldValue) => enqueue({type: 'characterData', target, oldValue, addedNodes: [], removedNodes: []});
  h.context.MutationObserver = MutationObserver;
  return {
    async flush() {
      for (let turn = 0; turn < 32; turn++) {
        await Promise.resolve();
        assert.equal(errors.length, 0, errors[0]?.stack);
        if (!scheduled && [...observers].every(observer => observer.records.length === 0)) return;
      }
      assert.fail('mutation observer queue did not quiesce');
    },
    deliveries: () => deliveryCount,
    dispose() {for (const observer of [...observers]) observer.disconnect();},
  };
}
module.exports = {installAttributeObservers};
