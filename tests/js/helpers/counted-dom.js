'use strict';

// Minimal fake DOM for bounded-interaction contracts. Real runtime code runs
// against these nodes; every query, mutation, node creation, listener, and
// generated markup byte is reported to an interaction counter.

function createCountedDom(counter) {
  const count = (field, amount) => counter.count(field, amount);

  class CountedElement {
    // `matching` lists the selectors this node matches; `selectors` maps a
    // query selector to its result (`all:<selector>` for querySelectorAll).
    constructor(tagName = 'DIV', { rect, matching = [], selectors = {}, ...properties } = {}) {
      this.tagName = String(tagName).toUpperCase();
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this.parentElement = null;
      this.hidden = false;
      this.isConnected = true;
      this.listeners = new Map();
      this.rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, ...rect };
      this.matching = new Set(matching);
      this.selectors = new Map(Object.entries(selectors));
      this.classes = new Set();
      this.markup = '';
      this.text = '';
      const element = this;
      this.classList = {
        add(...names) { count('domMutations'); names.forEach(name => element.classes.add(name)); },
        remove(...names) { count('domMutations'); names.forEach(name => element.classes.delete(name)); },
        toggle(name, force) {
          count('domMutations');
          const enabled = force ?? !element.classes.has(name);
          if (enabled) element.classes.add(name);
          else element.classes.delete(name);
          return enabled;
        },
        contains: name => element.classes.has(name),
      };
      const styles = new Map();
      this.style = {
        setProperty(name, value) { count('domMutations'); styles.set(name, String(value)); },
        removeProperty(name) { count('domMutations'); styles.delete(name); },
        getPropertyValue: name => styles.get(name) || '',
      };
      Object.assign(this, properties);
    }

    get childNodes() { return this.children; }
    get innerHTML() { return this.markup; }
    set innerHTML(value) {
      count('renderCommits');
      count('domMutations');
      count('markupBytes', String(value).length);
      this.markup = String(value);
    }
    get textContent() { return this.text; }
    set textContent(value) { count('domMutations'); this.text = String(value); }

    setAttribute(name, value) { count('domMutations'); this.attributes[name] = String(value); }
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
    matches(selector) { return this.matching.has(selector); }
    closest(selector) {
      let node = this;
      while (node && !node.matches(selector)) node = node.parentElement;
      return node;
    }
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return false;
    }
    querySelector(selector) { count('domQueries'); return this.selectors.get(selector) || null; }
    querySelectorAll(selector) { count('domQueries'); return this.selectors.get(`all:${selector}`) || []; }
    getBoundingClientRect() { return { ...this.rect }; }
    focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
    addEventListener(type, listener, options) {
      count('listeners');
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
      if (typeof options === 'object') options?.signal?.addEventListener?.('abort', () => this.removeEventListener(type, listener));
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
    }
    dispatch(type, event = {}) {
      const payload = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
      for (const listener of [...(this.listeners.get(type) || [])]) listener.call(this, payload);
      return payload;
    }
    appendChild(node) {
      count('domMutations');
      node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1);
      node.parentElement = this;
      this.children.push(node);
      return node;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    replaceChildren(...nodes) {
      count('domMutations');
      this.children.forEach((node) => { node.parentElement = null; });
      this.children = [];
      nodes.forEach(node => this.appendChild(node));
    }
    remove() {
      count('domMutations');
      this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
  }

  const createElement = (tagName) => {
    count('nodesCreated');
    return new CountedElement(tagName);
  };
  return { CountedElement, createElement };
}

module.exports = { createCountedDom };
