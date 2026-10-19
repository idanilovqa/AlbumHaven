'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installSearchValuePlatform} = require('./album-tops-native-fixtures/search-value-platform.cjs');
function environment() {
  const value = createNativeHomeRuntime(); installSearchValuePlatform(value.context); return value;
}
for (const type of ['search', 'text']) test(`${type} initial value reflects parsed attributes until a property edit`, () => {
  const {document} = environment(), host = document.createElement('div');
  host.innerHTML = `<input type="${type}" value="Album &amp; Artist" aria-label="Search albums">`;
  const input = host.firstElementChild;
  assert.equal(input.value, 'Album & Artist');
  input.setAttribute('value', 'Changed default'); assert.equal(input.value, 'Changed default');
  input.value = 'User edit'; assert.equal(input.value, 'User edit');
  assert.equal(input.getAttribute('value'), 'Changed default');
  input.setAttribute('value', 'New default'); assert.equal(input.value, 'User edit');
  const reparsed = document.createElement('div'); reparsed.innerHTML = input.outerHTML;
  assert.equal(reparsed.firstElementChild.value, 'New default', 'serialization preserves the default rather than dirty value');
  input.removeAttribute('value'); assert.equal(input.value, 'User edit');
  assert.equal(input.getAttribute('aria-label'), 'Search albums');
});
test('pristine removal, empty values and line-break sanitation follow text input semantics', () => {
  const {document} = environment(), input = document.createElement('input');
  input.setAttribute('type', 'search'); assert.equal(input.value, '');
  input.setAttribute('value', 'A\r\nB'); assert.equal(input.value, 'AB');
  assert.equal(input.getAttribute('value'), 'A\r\nB');
  input.removeAttribute('value'); assert.equal(input.value, '');
  input.value = 'C\nD'; assert.equal(input.value, 'CD'); assert.equal(input.getAttribute('value'), null);
  input.value = null; assert.equal(input.value, '');
  input.value = undefined; assert.equal(input.value, 'undefined');
  input.value = ''; input.setAttribute('value', 'Later'); assert.equal(input.value, '');
});
test('installation is idempotent and dirty values are isolated by input and environment', () => {
  const a = environment(), b = environment(); installSearchValuePlatform(a.context);
  const one = a.document.createElement('input'), two = a.document.createElement('input'), other = b.document.createElement('input');
  for (const input of [one, two, other]) {input.setAttribute('type', 'search'); input.setAttribute('value', 'Default');}
  one.value = 'Edited'; assert.equal(two.value, 'Default'); assert.equal(other.value, 'Default');
  const div = a.document.createElement('div'); assert.equal(div.value, undefined); div.value = 42; assert.equal(div.value, 42);
});
