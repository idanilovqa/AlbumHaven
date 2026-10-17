'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {native} = require('./artist-visible-fixtures/source-harness.cjs');
const {withFocus} = require('./artist-visible-fixtures/focus-fixture.cjs');
function fixture() {
  const env = withFocus(native()), parent = env.document.createElement('section'), button = env.document.createElement('button');
  parent.append(button); env.document.body.append(parent); return {...env, parent, button};
}
test('focus fixture positive control focuses connected enabled buttons and emits focus once', () => {
  const f = fixture(), events = [];
  f.button.addEventListener('focus', () => events.push(['focus', f.document.activeElement]));
  f.parent.addEventListener('focusin', () => events.push(['focusin', f.document.activeElement]));
  f.button.focus(); f.button.focus();
  assert.equal(f.document.activeElement, f.button);
  assert.deepEqual(events, [['focus', f.button], ['focusin', f.button]]);
  assert.equal(f.focusEvents.length, 1); assert.deepEqual(f.forbiddenCalls, []);
});
test('focus fixture rejects hidden inert disabled and detached targets without changing active element', () => {
  const f = fixture();
  for (const attr of ['hidden', 'inert']) {
    f.parent.setAttribute(attr, ''); f.button.focus(); assert.equal(f.document.activeElement, f.document.body); f.parent.removeAttribute(attr);
  }
  f.button.disabled = true; f.button.focus(); assert.equal(f.document.activeElement, f.document.body); f.button.disabled = false;
  f.button.remove(); f.button.focus(); assert.equal(f.document.activeElement, f.document.body); assert.equal(f.focusEvents.length, 0);
});
test('focus fixture positive control exposes focus timing before later concealment', () => {
  const f = fixture(), trace = [];
  f.button.addEventListener('focus', () => trace.push([f.parent.hidden, f.parent.inert]));
  f.button.focus(); f.parent.hidden = true; f.parent.inert = true;
  assert.deepEqual(trace, [[false, false]]);
});
test('focus fixture removal returns focus to body without invoking forbidden focus or layout', () => {
  const f = fixture(); f.button.focus(); f.parent.remove();
  assert.equal(f.document.activeElement, f.document.body); assert.deepEqual(f.forbiddenCalls, []);
});
