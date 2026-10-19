'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

test('fixture ID lookup matches complete document-order lookup through live DOM mutations', () => {
  const {document} = createNativeHomeRuntime();
  const check = id => {
    const expected = document.querySelectorAll('[id]').find(node => node.id === id) || null;
    assert.equal(document.getElementById(id), expected);
    return expected;
  };
  const left = document.createElement('section'), right = document.createElement('section');
  const first = document.createElement('i'), second = document.createElement('b');
  first.id = second.id = 'duplicate';
  left.append(first); right.append(second); document.body.append(left, right);
  assert.equal(check('duplicate'), first);
  assert.equal(check('missing'), null);
  right.append(first); assert.equal(check('duplicate'), second);
  second.remove(); assert.equal(check('duplicate'), first);
  first.setAttribute('id', 'renamed'); assert.equal(check('duplicate'), null); assert.equal(check('renamed'), first);
  first.removeAttribute('id'); assert.equal(check('renamed'), null);
  first.id = 'reconnected'; right.remove(); assert.equal(check('reconnected'), null);
  document.body.append(right); assert.equal(check('reconnected'), first);
  document.documentElement.id = 'root'; assert.equal(check('root'), document.documentElement);
  const detached = document.createElement('div'); detached.id = 'detached'; assert.equal(check('detached'), null);
  const template = document.createElement('template'), hidden = document.createElement('span');
  hidden.id = 'template-content'; template.content.appendChild(hidden); document.body.append(template);
  assert.equal(check('template-content'), null);
  assert.equal(check(null), null); assert.equal(check(undefined), null); assert.equal(check(''), null);
});

test('fixture ID lookup stops before unrelated later branches without a cache', () => {
  const {document} = createNativeHomeRuntime();
  const first = document.createElement('div'), later = document.createElement('div');
  first.id = 'first-match'; document.body.append(first, later);
  Object.defineProperty(later, 'childNodes', {get() {throw new Error('later branch must not be traversed');}});
  assert.equal(document.getElementById('first-match'), first);
});
