'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installTemplateFragmentPlatform} = require('./template-fragment-platform.cjs');
function fixture(t) {
  const h = createNativeHomeRuntime(), baseline = h.listeners();
  t.after(() => {const current = h.listeners();
    assert.ok(current.length === baseline.length && current.every((owner, index) => owner === baseline[index]), 'fragment support acquires no listeners');});
  return h;
}
function installed(t) {const h = fixture(t); installTemplateFragmentPlatform(h.document); return h;}

test('new template content returns null for empty and text-only fragments', t => {
  const h = installed(t), template = h.document.createElement('template');
  assert.equal(template.content.firstElementChild, null);
  template.content.append(h.document.createTextNode('leading'), h.document.createTextNode(' trailing'));
  assert.equal(template.content.firstElementChild, null);
});

test('the first element is selected by node type through leading and intervening text', t => {
  const h = installed(t), template = h.document.createElement('template');
  const first = h.document.createElement('button'), second = h.document.createElement('span');
  template.content.append(h.document.createTextNode('leading'), first, h.document.createTextNode('between'), second);
  assert.equal(template.content.firstElementChild, first); assert.equal(first.isConnected, false);
  first.remove(); assert.equal(template.content.firstElementChild, second);
  second.remove(); assert.equal(template.content.firstElementChild, null);
});

test('firstElementChild is live across insertion replacement and reordering', t => {
  const h = installed(t), template = h.document.createElement('template'), a = h.document.createElement('a'), b = h.document.createElement('b');
  template.content.append(a, b); assert.equal(template.content.firstElementChild, a);
  template.content.insertBefore(b, a); assert.equal(template.content.firstElementChild, b);
  template.content.appendChild(b); assert.equal(template.content.firstElementChild, a);
  template.content.replaceChildren(h.document.createTextNode('text'), b); assert.equal(template.content.firstElementChild, b);
  template.content.replaceChildren(); assert.equal(template.content.firstElementChild, null);
});

test('moving fragment children uses the existing insertion owner and empties the live getter', t => {
  const h = installed(t), template = h.document.createElement('template'), host = h.document.createElement('div');
  const leading = h.document.createTextNode('leading'), first = h.document.createElement('button'), second = h.document.createElement('span');
  template.content.append(leading, first, second); assert.equal(template.content.firstElementChild, first);
  host.appendChild(template.content);
  assert.equal(template.content.firstElementChild, null); assert.equal(template.content.childNodes.length, 0);
  assert.equal(host.firstElementChild, first); assert.equal(first.parentNode, host); assert.equal(second.parentNode, host);
  assert.deepEqual(host.childNodes, [leading, first, second]);
});

test('actual template innerHTML parsing exposes the first parsed element and later replacement', t => {
  const h = installed(t), template = h.document.createElement('template');
  template.innerHTML = ' leading <article class="cover-lookup-task"><button>Open</button></article><span>tail</span>';
  const first = template.content.firstElementChild;
  assert.equal(first.tagName, 'ARTICLE'); assert.equal(first.className, 'cover-lookup-task'); assert.equal(first.textContent, 'Open');
  template.innerHTML = 'text only'; assert.equal(template.content.firstElementChild, null);
  template.innerHTML = '<button>Replacement</button>'; assert.equal(template.content.firstElementChild.tagName, 'BUTTON');
  assert.notEqual(template.content.firstElementChild, first); assert.equal(template.content.firstElementChild.textContent, 'Replacement');
});

test('createElement preserves its receiver every argument and exact returned identity', t => {
  const h = fixture(t), actual = h.document.createElement, calls = [];
  h.document.createElement = function (...args) {
    const node = Reflect.apply(actual, this, args); calls.push({receiver: this, args, node}); return node;
  };
  installTemplateFragmentPlatform(h.document);
  const receiver = {name: 'transparent receiver'}, options = {is: 'native-template'}, extra = {};
  const template = h.document.createElement.call(receiver, 'TEMPLATE', options, extra);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, receiver);
  assert.deepEqual(calls[0].args, ['TEMPLATE', options, extra]); assert.equal(calls[0].args[1], options); assert.equal(calls[0].args[2], extra);
  assert.equal(template, calls[0].node); assert.equal(template.content.firstElementChild, null);
});

test('installation is idempotent per document and never stacks createElement wrappers', t => {
  const h = fixture(t); installTemplateFragmentPlatform(h.document); const installedCreate = h.document.createElement;
  installTemplateFragmentPlatform(h.document); installTemplateFragmentPlatform(h.document);
  assert.equal(h.document.createElement, installedCreate);
  const one = h.document.createElement('template'), two = h.document.createElement('template');
  assert.notEqual(one, two); assert.notEqual(one.content, two.content);
  assert.equal(one.content.firstElementChild, null); assert.equal(two.content.firstElementChild, null);
});

for (const inherited of [false, true]) test(`an existing ${inherited ? 'inherited' : 'own'} native fragment getter is left untouched`, t => {
  const h = fixture(t), actual = h.document.createElement;
  const getter = function () {return this.childNodes.find(node => node.nodeType === 1) || null;};
  let existingOwner;
  h.document.createElement = function (...args) {
    const node = Reflect.apply(actual, this, args);
    if (node.content) {
      existingOwner = inherited ? Object.create(Object.getPrototypeOf(node.content)) : node.content;
      Object.defineProperty(existingOwner, 'firstElementChild', {get: getter, configurable: false});
      if (inherited) Object.setPrototypeOf(node.content, existingOwner);
    }
    return node;
  };
  installTemplateFragmentPlatform(h.document); const template = h.document.createElement('template');
  const descriptor = Object.getOwnPropertyDescriptor(existingOwner, 'firstElementChild');
  assert.equal(descriptor.get, getter); assert.equal(descriptor.configurable, false);
  assert.equal(Object.hasOwn(template.content, 'firstElementChild'), !inherited);
  const child = h.document.createElement('button'); template.content.append(child);
  assert.equal(template.content.firstElementChild, child);
});

test('an existing undefined-valued fragment property is present and must not be overwritten', t => {
  const h = fixture(t), actual = h.document.createElement;
  h.document.createElement = function (...args) {
    const node = Reflect.apply(actual, this, args);
    if (node.content) Object.defineProperty(node.content, 'firstElementChild', {value: undefined, configurable: false, writable: false});
    return node;
  };
  installTemplateFragmentPlatform(h.document); const template = h.document.createElement('template');
  assert.equal(Object.hasOwn(template.content, 'firstElementChild'), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(template.content, 'firstElementChild'),
    {value: undefined, configurable: false, writable: false, enumerable: false});
});

test('ordinary nodes and global DOM prototypes keep their original identity and descriptors', t => {
  const h = fixture(t), actual = h.document.createElement, original = actual('template');
  const prototypes = [Object.getPrototypeOf(h.document), h.context.Element.prototype, Object.getPrototypeOf(original.content)];
  const descriptors = prototypes.map(value => Object.getOwnPropertyDescriptors(value)); let returned;
  h.document.createElement = function (...args) {returned = Reflect.apply(actual, this, args); return returned;};
  installTemplateFragmentPlatform(h.document); const ordinary = h.document.createElement('div');
  assert.equal(ordinary, returned); assert.equal(Object.hasOwn(ordinary, 'firstElementChild'), false);
  assert.equal(Object.hasOwn(ordinary, 'content'), false);
  h.document.createElement('template');
  prototypes.forEach((value, index) => assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors[index]));
});

test('installation is document-local and does not retroactively patch earlier fragments', t => {
  const first = fixture(t), second = fixture(t), earlier = first.document.createElement('template'), secondCreate = second.document.createElement;
  installTemplateFragmentPlatform(first.document);
  assert.equal('firstElementChild' in earlier.content, false);
  assert.equal(second.document.createElement, secondCreate);
  assert.equal('firstElementChild' in second.document.createElement('template').content, false);
  assert.equal(first.document.createElement('template').content.firstElementChild, null);
  installTemplateFragmentPlatform(second.document);
  assert.equal(second.document.createElement('template').content.firstElementChild, null);
});
