const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const readRepo = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const decode = value => String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[entity.toLowerCase()];
});
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// A deliberately bounded DOM ownership fixture, following the native tests' VM
// pattern. It executes whole published helpers and component files unchanged.
// No transport, history, player, focus, layout or scheduling runtime is stubbed.
function createNativeHomeRuntime({ home = false, dashboard = false } = {}) {
  const mutations = [], attributeMutations = [], registered = new Set(), forbiddenCalls = [];
  const forbidden = name => () => { forbiddenCalls.push(name); throw new Error(`Forbidden component ownership: ${name}`); };
  let document;
  class DomEvent {
    constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles !== false; this.cancelable = options.cancelable !== false; this.defaultPrevented = false; this.target = null; this.currentTarget = null; this.stopped = false; this.immediate = false; this.key = options.key; this.button = options.button ?? 0; }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.immediate = true; this.stopped = true; }
    composedPath() { const result = []; for (let node = this.target; node; node = node.parentNode) result.push(node); return result; }
  }
  class DomNode {
    constructor(nodeType) { this.nodeType = nodeType; this.parentNode = null; this.childNodes = []; this.listeners = []; registered.add(this); }
    get ownerDocument() { return document; }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    get isConnected() { for (let node = this; node; node = node.parentNode) if (node === document) return true; return false; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, before) {
      if (!(node instanceof DomNode)) throw new TypeError('Fixture insertion requires a DOM node');
      if (node === before) return node;
      if (before !== null && before.parentNode !== this) throw new Error('Reference node has another parent');
      if (node === this || node.contains(this)) throw new Error('DOM cycle');
      if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.insertBefore(child, before); return node; }
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
      this.childNodes.splice(index, 0, node); node.parentNode = this; mutations.push({ type: 'insert', node, parent: this }); return node;
    }
    removeChild(node) { const index = this.childNodes.indexOf(node); if (index < 0) throw new Error('Cannot remove a foreign node'); this.childNodes.splice(index, 1); node.parentNode = null; mutations.push({ type: 'remove', node, parent: this }); return node; }
    append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? new Text(node) : node); }
    prepend(...nodes) { for (const node of [...nodes].reverse()) this.insertBefore(typeof node === 'string' ? new Text(node) : node, this.firstChild); }
    replaceChildren(...nodes) { for (const node of [...this.childNodes]) this.removeChild(node); this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(...(String(value ?? '') ? [new Text(String(value))] : [])); }
    addEventListener(type, callback, options = false) {
      if (typeof callback !== 'function') throw new TypeError('Fixture event listener must be a function');
      const capture = typeof options === 'boolean' ? options : Boolean(options.capture);
      if (options && typeof options === 'object' && options.signal) throw new Error('Unsupported fixture listener signal');
      if (!this.listeners.some(entry => entry.type === type && entry.callback === callback && entry.capture === capture)) this.listeners.push({ target: this, type, callback, capture, once: Boolean(options?.once) });
    }
    removeEventListener(type, callback, options = false) { const capture = typeof options === 'boolean' ? options : Boolean(options.capture); this.listeners = this.listeners.filter(entry => !(entry.type === type && entry.callback === callback && entry.capture === capture)); }
    dispatchEvent(event) {
      if (!(event instanceof DomEvent)) throw new TypeError('Fixture dispatch requires its Event');
      event.target = this;
      const chain = event.composedPath();
      const invoke = (node, capture) => {
        event.currentTarget = node;
        for (const entry of [...node.listeners]) {
          if (entry.type !== event.type || entry.capture !== capture || !node.listeners.includes(entry)) continue;
          if (entry.once) node.removeEventListener(entry.type, entry.callback, entry.capture);
          entry.callback.call(node, event); if (event.immediate) break;
        }
      };
      for (const node of [...chain].reverse()) { invoke(node, true); if (event.stopped) break; }
      if (!event.stopped) for (const node of chain) { invoke(node, false); if (event.stopped || !event.bubbles) break; }
      event.currentTarget = null; return !event.defaultPrevented;
    }
  }
  DomNode.ELEMENT_NODE = 1; DomNode.TEXT_NODE = 3; DomNode.DOCUMENT_FRAGMENT_NODE = 11;
  class Text extends DomNode {
    constructor(value) { super(3); this.data = value; }
    get textContent() { return this.data; }
    set textContent(value) { this.data = String(value); }
    get outerHTML() { return escape(this.data); }
  }
  function matchSimple(node, selector) {
    let rest = selector, matched = node instanceof Element;
    const tag = rest.match(/^(\*|[a-z][a-z0-9-]*)/i);
    if (tag) { if (tag[0] !== '*' && node?.tagName?.toLowerCase() !== tag[0].toLowerCase()) matched = false; rest = rest.slice(tag[0].length); }
    while (rest) {
      const part = rest.match(/^(?:\.([a-zA-Z_][\w-]*)|#([\w-]+)|\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\])/);
      if (!part) throw new Error(`Unsupported fixture selector: ${selector}`);
      if (part[1] && !node?.classList?.contains(part[1])) matched = false;
      if (part[2] && node?.id !== part[2]) matched = false;
      if (part[3] && (!node?.hasAttribute?.(part[3]) || (part[4] ?? part[5] ?? part[6]) !== undefined && node?.getAttribute?.(part[3]) !== (part[4] ?? part[5] ?? part[6]))) matched = false;
      rest = rest.slice(part[0].length);
    }
    return matched;
  }
  function selectorParts(selector) {
    const branches = selector.split(',').map(branch => branch.trim().split(/\s+(?![^\[]*\])/));
    for (const parts of branches) {
      if (!parts[0] || parts.includes('>') || parts.some(part => part.startsWith(':'))) throw new Error(`Unsupported fixture selector: ${selector}`);
      for (const part of parts) matchSimple(null, part);
    }
    return branches;
  }
  function matches(node, selector) {
    return selectorParts(selector).some(parts => {
      if (!matchSimple(node, parts.pop())) return false;
      let ancestor = node.parentNode;
      while (parts.length) { const part = parts.pop(); while (ancestor && !matchSimple(ancestor, part)) ancestor = ancestor.parentNode; if (!ancestor) return false; ancestor = ancestor.parentNode; }
      return true;
    });
  }
  class Element extends DomNode {
    constructor(tagName) {
      super(1); this.tagName = String(tagName).toUpperCase(); this.attrs = new Map(); this.scrollTop = 0; this.scrollLeft = 0;
      this.dataset = new Proxy({}, {
        get: (_target, key) => typeof key === 'string' ? this.getAttribute(`data-${key.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`) ?? undefined : undefined,
        set: (_target, key, value) => { this.setAttribute(`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`, value); return true; },
        deleteProperty: (_target, key) => { this.removeAttribute(`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`); return true; },
      });
      const tokens = () => (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      this.classList = {
        contains: value => tokens().includes(value),
        add: (...values) => this.setAttribute('class', [...new Set([...tokens(), ...values])].join(' ')),
        remove: (...values) => this.setAttribute('class', tokens().filter(value => !values.includes(value)).join(' ')),
        toggle: (value, force) => { const enabled = force === undefined ? !this.classList.contains(value) : Boolean(force); this.classList[enabled ? 'add' : 'remove'](value); return enabled; },
      };
      const styles = new Map();
      this.style = new Proxy({
        setProperty: (key, value) => { styles.set(key, String(value)); this.setAttribute('style', [...styles].map(([name, content]) => `${name}: ${content};`).join(' ')); },
        getPropertyValue: key => styles.get(key) || '',
        removeProperty: key => { const old = styles.get(key) || ''; styles.delete(key); this.setAttribute('style', [...styles].map(([name, content]) => `${name}: ${content};`).join(' ')); return old; },
      }, { get: (target, key) => key in target ? target[key] : styles.get(key) || '', set: (target, key, value) => { target.setProperty(key, value); return true; } });
      if (this.tagName === 'TEMPLATE') this.content = new DomNode(11);
    }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    get nextElementSibling() { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    attributePairs() { return [...this.attrs].sort(([left], [right]) => left.localeCompare(right)); }
    setAttribute(name, value) { this.attrs.set(String(name), String(value)); attributeMutations.push({ type: 'set', node: this, name: String(name), value: String(value) }); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    hasAttribute(name) { return this.attrs.has(name); }
    removeAttribute(name) { if (this.attrs.delete(name)) attributeMutations.push({ type: 'remove', node: this, name: String(name) }); }
    toggleAttribute(name, force) { const enabled = force === undefined ? !this.hasAttribute(name) : Boolean(force); if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); return enabled; }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { this.toggleAttribute('hidden', Boolean(value)); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
    get inert() { return this.hasAttribute('inert'); }
    set inert(value) { this.toggleAttribute('inert', Boolean(value)); }
    get innerHTML() { return (this.content || this).childNodes.map(node => node.outerHTML).join(''); }
    set innerHTML(html) { (this.content || this).replaceChildren(...parseHtml(String(html)).childNodes); }
    get outerHTML() { const name = this.tagName.toLowerCase(), attrs = [...this.attrs].map(([key, value]) => ` ${key}="${escape(value)}"`).join(''); return `<${name}${attrs}>${voidTags.has(name) ? '' : `${this.innerHTML}</${name}>`}`; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let node = this; node instanceof Element; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) { selectorParts(selector); const result = []; const visit = node => { for (const child of node.childNodes) { if (child instanceof Element && matches(child, selector)) result.push(child); visit(child); } }; visit(this); return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    insertAdjacentHTML(position, html) {
      const nodes = [...parseHtml(html).childNodes];
      if (position === 'beforeend') this.append(...nodes);
      else if (position === 'afterbegin') this.prepend(...nodes);
      else throw new Error(`Unsupported fixture HTML insertion: ${position}`);
    }
    focus() { forbidden('focus')(); }
    scrollTo() { forbidden('scrollTo')(); }
    scrollIntoView() { forbidden('scrollIntoView')(); }
    getBoundingClientRect() { forbidden('layout measurement')(); }
    cloneNode() { forbidden('cloneNode')(); }
  }
  function parseHtml(html) {
    const root = new DomNode(11), stack = [root];
    const tokens = String(html).match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g) || [];
    if (tokens.join('') !== String(html)) throw new Error('Unsupported fixture HTML token');
    for (const token of tokens) {
      if (token.startsWith('<!--')) continue;
      if (!token.startsWith('<')) { stack.at(-1).appendChild(new Text(decode(token))); continue; }
      const close = token.match(/^<\/([a-zA-Z][\w-]*)\s*>$/);
      if (close) { if (stack.length === 1 || stack.at(-1).tagName.toLowerCase() !== close[1].toLowerCase()) throw new Error(`Unbalanced fixture HTML: ${token}`); stack.pop(); continue; }
      const open = token.match(/^<([a-zA-Z][\w-]*)([\s\S]*?)\/?\s*>$/);
      if (!open) throw new Error(`Unsupported fixture HTML: ${token}`);
      const node = new Element(open[1]);
      let attributes = open[2];
      while (attributes.trim()) {
        const match = attributes.match(/^\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/);
        if (!match) throw new Error(`Unsupported fixture attributes: ${attributes}`);
        node.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? '')); attributes = attributes.slice(match[0].length);
      }
      stack.at(-1).appendChild(node);
      if (!voidTags.has(open[1].toLowerCase()) && !/\/\s*>$/.test(token)) stack.push(node);
    }
    if (stack.length !== 1) throw new Error('Unclosed fixture HTML');
    return root;
  }
  document = new Element('document'); document.nodeType = 9;
  document.documentElement = new Element('html'); document.body = new Element('body');
  document.appendChild(document.documentElement); document.documentElement.appendChild(document.body);
  document.createElement = name => new Element(name);
  document.createTextNode = value => new Text(String(value));
  document.createDocumentFragment = () => new DomNode(11);
  document.getElementById = id => document.querySelectorAll('[id]').find(node => node.id === id) || null;
  document.activeElement = document.body;
  const globals = {
    document, Element, HTMLElement: Element, Node: DomNode, Event: DomEvent, MouseEvent: DomEvent,
    URL, console, fetch: forbidden('fetch'), setTimeout: forbidden('setTimeout'), setInterval: forbidden('setInterval'),
    requestAnimationFrame: forbidden('requestAnimationFrame'), queueMicrotask: forbidden('queueMicrotask'),
    history: { pushState: forbidden('history.pushState'), replaceState: forbidden('history.replaceState'), back: forbidden('history.back') },
    openTrackModal: forbidden('openTrackModal'), playAlbum: forbidden('playAlbum'),
    scheduleBrowserAnimationFrame: forbidden('scheduleBrowserAnimationFrame'), scheduleBrowserTimeout: forbidden('scheduleBrowserTimeout'),
  };
  globals.window = globals;
  const context = vm.createContext(globals), missing = [];
  const files = ['js/button-component.js', 'js/runtime/markup-format-helpers.js', 'js/runtime/loader-status-helpers.js',
    'js/runtime/alert-components.js', 'js/runtime/album-artbox.js', 'js/runtime/gallery-main-components.js',
    'js/runtime/gallery-card-component.js', 'js/runtime/album-details-components.js'];
  if (dashboard) files.push('js/runtime/dashboard.js');
  if (home) files.push('js/runtime/home-recent.js');
  for (const relative of files) {
    const full = path.join(repoRoot, 'music_app', 'static', relative);
    if (!fs.existsSync(full) && ['js/runtime/dashboard.js', 'js/runtime/home-recent.js'].includes(relative)) { missing.push(relative); continue; }
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  }
  const event = (type, target) => { const result = new DomEvent(type); result.target = target; return result; };
  return {
    context, document, mutations, attributeMutations, forbiddenCalls, missing, event,
    owner: name => vm.runInContext(`typeof ${name} === 'undefined' ? undefined : ${name}`, context),
    listeners: () => [...registered].flatMap(node => node.listeners),
    click(target) { assert.equal(target instanceof Element, true, 'activation target is a real fixture element'); if (target.closest('button')?.disabled) return; target.dispatchEvent(new DomEvent('click')); },
  };
}
function requireOwner(env, name) {
  assert.equal(env.missing.length, 0, `PRODUCT_NOT_IMPLEMENTED: required native component source absent: ${env.missing.join(', ')}`);
  const owner = env.owner(name);
  assert.equal(typeof owner?.mount, 'function', `PRODUCT_NOT_IMPLEMENTED: ${name}.mount must exist`);
  return owner;
}
function buttonNamed(root, pattern, required = true) {
  const found = root.querySelectorAll('button').find(node => pattern.test(node.getAttribute('aria-label') || node.textContent.trim())) || null;
  if (required) assert.equal(found !== null, true, `button with accessible name ${pattern} exists`);
  return found;
}
const cards = root => root.querySelectorAll('.album-card');
module.exports = { createNativeHomeRuntime, requireOwner, cards, buttonNamed, readRepo };
