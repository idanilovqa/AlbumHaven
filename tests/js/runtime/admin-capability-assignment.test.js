const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/admin-members.js'), 'utf8');
function input(value, checked = false, dataset = {}) {
  const handlers = new Map();
  return { value, checked, disabled: false, dataset, title: '',
    addEventListener(type, fn) { handlers.set(type, fn); },
    change(checked) { this.checked = checked; handlers.get('change')?.(); },
    click() { if (!this.disabled) handlers.get('click')?.(); } };
}
function fixture({ mode = 'edit', direct = ['library.browse.read', 'library.media.read'], selected = [], hidden = [] } = {}) {
  const definitions = { viewer: ['capability.view'], listener: ['capability.view', 'capability.play'],
    owner: ['capability.view', 'capability.play', 'capability.edit'], admin: ['capability.view', 'capability.admin'] };
  const roles = Object.entries(definitions).map(([key, grants]) => input(key, selected.includes(key), {
    roleLabel: key, roleGrants: JSON.stringify(grants),
  }));
  const keys = ['library.browse.read', 'library.media.read', 'capability.view', 'capability.play',
    'capability.admin', 'capability.edit', 'capability.practice'];
  const capabilities = keys.map((key) => input(key, direct.includes(key), { explicitGrant: String(direct.includes(key)) }));
  const summary = { textContent: '' }, legacy = { hidden: false }, only = input('only');
  const editor = {
    querySelectorAll(selector) {
      return selector === '[name="role_keys"]' ? roles : hidden.map((value) => input(value));
    },
    querySelector(selector) { return selector === '[data-role-summary]' ? summary : only; },
  };
  const form = { dataset: { mode },
    querySelector(selector) { return selector === '[data-capability-assignment]' ? editor : legacy; },
    querySelectorAll() { return capabilities; },
  };
  const context = { window: {}, document: { querySelector: () => ({}) } };
  vm.runInNewContext(source, context);
  const controller = context.window.AlbumHavenBindCapabilityAssignment(form);
  return { controller, legacy, summary, only,
    role: (key) => roles.find((item) => item.value === key),
    capability: (key) => capabilities.find((item) => item.value === key),
    direct: () => Array.from(controller.capabilityKeys()),
    selected: () => Array.from(controller.roleKeys()),
  };
}

test('existing explicit grants are unchanged when the form first mounts', () => {
  const f = fixture();
  assert.deepEqual(f.direct(), ['library.browse.read', 'library.media.read']);
  assert.deepEqual(f.selected(), []);
  assert.equal(f.only.disabled, true);
  assert.equal(f.legacy.hidden, false);
});

test('selecting the first role for a new user replaces untouched legacy defaults', () => {
  const f = fixture({ mode: 'create' });
  f.role('viewer').change(true);
  assert.deepEqual(f.direct(), []);
  assert.deepEqual(f.selected(), ['viewer']);
  assert.equal(f.capability('capability.view').checked, true);
  assert.equal(f.capability('capability.view').disabled, true);
  assert.equal(f.capability('library.media.read').checked, false);
});

test('Admin and Owner are independent and may be selected together', () => {
  const f = fixture({ direct: [] });
  f.role('admin').change(true);
  assert.equal(f.role('owner').checked, false);
  assert.equal(f.capability('capability.admin').checked, true);
  assert.equal(f.capability('capability.play').checked, false);
  f.role('owner').change(true);
  assert.equal(f.capability('capability.play').checked, true);
  f.role('admin').change(false);
  assert.equal(f.role('owner').checked, true);
  assert.equal(f.capability('capability.admin').checked, false);
  assert.equal(f.capability('capability.admin').disabled, false);
});

test('switching roles on an existing member preserves explicit additions', () => {
  const f = fixture();
  f.role('admin').change(true);
  f.capability('capability.practice').change(true);
  f.role('admin').change(false);
  assert.deepEqual(f.direct(), ['capability.practice', 'library.browse.read', 'library.media.read']);
  assert.equal(f.capability('capability.practice').checked, true);
});

test('Use selected roles only clears explicit grants without changing roles', () => {
  const f = fixture({ hidden: ['library.notes.manage'] });
  f.role('listener').change(true);
  f.only.click();
  assert.deepEqual(f.direct(), []);
  assert.deepEqual(f.selected(), ['listener']);
  assert.equal(f.capability('library.media.read').checked, false);
  assert.equal(f.capability('capability.play').checked, true);
  assert.equal(f.capability('capability.play').disabled, true);
});

test('an explicit capability overlapping a role remains explicit when that role is removed', () => {
  const f = fixture({ direct: ['capability.play'], selected: ['listener'] });
  assert.deepEqual(f.direct(), ['capability.play']);
  assert.equal(f.capability('capability.play').disabled, true);
  f.role('listener').change(false);
  assert.equal(f.capability('capability.play').checked, true);
  assert.equal(f.capability('capability.play').disabled, false);
  assert.deepEqual(f.direct(), ['capability.play']);
});

test('new-user role selection does not erase a manually customized grant', () => {
  const f = fixture({ mode: 'create' });
  f.capability('capability.practice').change(true);
  f.role('viewer').change(true);
  assert.equal(f.direct().includes('capability.practice'), true);
});

test('bootstrap or legacy forms without the assignment section are left alone', () => {
  const context = { window: {}, document: { querySelector: () => ({}) } };
  vm.runInNewContext(source, context);
  assert.equal(context.window.AlbumHavenBindCapabilityAssignment({ querySelector: () => null }), null);
});
