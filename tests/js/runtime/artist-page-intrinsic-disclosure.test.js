'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {disclosureRuntime} = require('./artist-visible-fixtures/source-harness.cjs');
function fixture({preset = false, enabled = true} = {}) {
  const env = disclosureRuntime(), create = env.owner('createIntrinsicDisclosure');
  assert.equal(typeof create, 'function', 'Existing runtime registration must provide the real shared disclosure owner');
  const root = env.document.createElement('div'); env.document.body.appendChild(root);
  function member(key, id) {
    const section = env.document.createElement('section'), header = env.document.createElement('header'), host = env.document.createElement('span');
    host.innerHTML = env.runtime.actionHtml({icon: 'next', ariaLabel: key, presentation: 'bare'});
    const toggle = host.firstElementChild, panel = env.document.createElement('div'); panel.id = id;
    header.append(host); section.append(header, panel); root.append(section);
    return {key, panel, header, toggle, section};
  }
  const info = member('info', 'entry-info'), discography = member('discography', 'entry-discography'), ep = member('release:ep', 'entry-ep');
  discography.panel.append(ep.section);
  if (preset) {
    info.panel.setAttribute('hidden', 'consumer-hidden'); info.panel.setAttribute('inert', 'consumer-inert');
    info.toggle.setAttribute('aria-controls', 'consumer-panel'); info.toggle.setAttribute('aria-expanded', 'mixed');
  }
  const members = [info, discography, ep], changes = [];
  const original = members.map(row => ({row, panel: row.panel.attributePairs(), toggle: row.toggle.attributePairs()}));
  const owner = create({members, collapsed: {}, enabled, onToggle(key, collapsed) {changes.push([key, collapsed]);}});
  return {...env, create, root, info, discography, ep, changes, owner, members, original, member};
}
function assertOriginal(record) {
  assert.deepEqual(record.row.panel.attributePairs(), record.panel);
  assert.deepEqual(record.row.toggle.attributePairs(), record.toggle);
}

test('registered disclosure keeps independent siblings and nested semantic choices', () => {
  const f = fixture(); f.click(f.ep.toggle);
  assert.equal(f.ep.panel.hidden, true); assert.equal(f.info.panel.hidden, false); assert.equal(f.discography.panel.hidden, false);
  f.click(f.discography.toggle); f.click(f.discography.toggle);
  assert.equal(f.discography.panel.hidden, false); assert.equal(f.ep.panel.hidden, true);
  assert.deepEqual(f.changes, [['release:ep', true], ['discography', true], ['discography', false]]);
  assert.equal(f.ep.toggle.getAttribute('aria-controls'), f.ep.panel.id);
  assert.equal(f.ep.toggle.getAttribute('aria-expanded'), 'false'); assert.equal(f.ep.panel.inert, true); f.owner.dispose();
});
test('registered disclosure follows semantic keys after reordering without resetting a retained member', () => {
  const f = fixture(); f.click(f.ep.toggle);
  f.owner.update({members: [f.ep, f.discography, f.info], collapsed: {'release:ep': true}, enabled: true});
  assert.equal(f.ep.panel.hidden, true); f.click(f.ep.toggle);
  assert.deepEqual(f.changes.at(-1), ['release:ep', false]); assert.equal(f.discography.panel.hidden, false); f.owner.dispose();
});
test('registered disclosure evacuates focused content before concealment and ignores independent actions', () => {
  const f = fixture(), child = f.document.createElement('button'), action = f.document.createElement('button'), trace = [];
  f.ep.panel.append(child); f.ep.header.append(action); f.click(action); assert.equal(f.changes.length, 0);
  child.focus(); assert.equal(f.document.activeElement, child, 'positive fixture setup control');
  f.ep.toggle.addEventListener('focus', () => trace.push([f.ep.panel.hidden, f.ep.panel.inert]));
  f.owner.update({members: f.members, collapsed: {'release:ep': true}, enabled: true});
  assert.equal(f.document.activeElement, f.ep.toggle); assert.deepEqual(trace, [[false, false]], 'focus moves before hidden/inert');
  assert.equal(f.ep.panel.hidden, true); assert.equal(f.ep.panel.inert, true); f.owner.dispose();
});
test('collapsing a parent evacuates focus from nested content to the actual parent toggle', () => {
  const f = fixture(), child = f.document.createElement('button'), trace = [];
  f.ep.panel.append(child); child.focus(); assert.equal(f.document.activeElement, child);
  f.discography.toggle.addEventListener('focus', () => trace.push([f.discography.panel.hidden, f.discography.panel.inert]));
  f.owner.update({members: f.members, collapsed: {discography: true}, enabled: true});
  assert.equal(f.document.activeElement, f.discography.toggle); assert.deepEqual(trace, [[false, false]]);
  assert.equal(f.ep.toggle.getAttribute('aria-expanded'), 'true', 'nested own choice remains expanded'); f.owner.dispose();
});
test('disposal restores exact originally present attributes as well as originally absent ones', () => {
  const f = fixture({preset: true}); f.click(f.ep.toggle); f.owner.dispose(); f.owner.dispose();
  for (const record of f.original) assertOriginal(record);
  const count = f.changes.length; for (const row of f.members) f.click(row.toggle);
  assert.equal(f.changes.length, count); assert.deepEqual(f.forbiddenCalls, []);
});
test('disabled disclosure releases DOM ownership and cannot dispatch until reenabled', () => {
  const f = fixture({enabled: false}); for (const record of f.original) assertOriginal(record);
  f.click(f.ep.toggle); assert.equal(f.changes.length, 0);
  f.owner.update({members: f.members, collapsed: {'release:ep': true}, enabled: true});
  assert.equal(f.ep.panel.hidden, true); f.click(f.ep.toggle); assert.deepEqual(f.changes, [['release:ep', false]]);
  f.owner.update({members: f.members, collapsed: {'release:ep': true}, enabled: false});
  for (const record of f.original) assertOriginal(record);
  f.click(f.ep.toggle); assert.equal(f.changes.length, 1);
  f.owner.update({members: f.members, collapsed: {'release:ep': true}, enabled: true});
  assert.equal(f.ep.panel.hidden, true); f.owner.dispose();
});
test('removed members regain original attributes and their old controls stop dispatching', () => {
  const f = fixture({preset: true}); f.click(f.info.toggle);
  f.owner.update({members: [f.discography, f.ep], collapsed: {'release:ep': true}, enabled: true});
  assertOriginal(f.original[0]); const count = f.changes.length;
  f.click(f.info.toggle); assert.equal(f.changes.length, count); assert.equal(f.ep.panel.hidden, true); f.owner.dispose();
});
test('replacing a semantic member retires old DOM handlers and binds new retained DOM once', () => {
  const f = fixture(), replacement = f.member('release:ep', 'replacement-ep');
  f.owner.update({members: [f.info, f.discography, replacement], collapsed: {'release:ep': true}, enabled: true});
  assertOriginal(f.original[2]); f.click(f.ep.toggle); assert.equal(f.changes.length, 0);
  assert.equal(replacement.panel.hidden, true); f.click(replacement.toggle);
  assert.deepEqual(f.changes, [['release:ep', false]]); f.owner.dispose();
});
test('repeated update does not accumulate callbacks or replace panel and child identities', () => {
  const f = fixture(), child = f.document.createElement('button'); f.ep.panel.append(child);
  const initialListeners = f.listeners().length;
  for (let index = 0; index < 5; index++) f.owner.update({members: f.members, collapsed: {}, enabled: true});
  assert.equal(f.listeners().length, initialListeners); f.click(f.ep.toggle);
  assert.deepEqual(f.changes, [['release:ep', true]]); assert.equal(f.ep.panel.firstElementChild, child);
  f.click(f.ep.toggle); assert.equal(f.ep.panel.firstElementChild, child); f.owner.dispose();
});
test('independent disclosure instances cannot toggle or dispose one another', () => {
  const f = fixture(), extra = f.member('info', 'second-instance-info'), otherChanges = [];
  const second = f.create({members: [extra], collapsed: {}, enabled: true, onToggle: (...value) => otherChanges.push(value)});
  f.click(extra.toggle); assert.equal(extra.panel.hidden, true); assert.equal(f.info.panel.hidden, false); assert.equal(f.changes.length, 0);
  f.owner.dispose(); f.click(extra.toggle); assert.deepEqual(otherChanges, [['info', true], ['info', false]]); second.dispose();
});
