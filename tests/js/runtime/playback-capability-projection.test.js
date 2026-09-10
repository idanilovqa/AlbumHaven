const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = path.join(__dirname, '../../../music_app/static/js/runtime/response-state-helpers.js');
function helpers() {
  const updates = [];
  const context = { console, state: { status: {}, loopCreateAllowed: false },
    syncLoopCreateCapability() { updates.push(context.state.loopCreateAllowed); } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  return { context, updates };
}

test('B06 status capability loss replaces prior grants and synchronizes mounted players', () => {
  const { context, updates } = helpers();
  context.applyStatusPayload({ allowed_actions: { 'library.loops.create': true } });
  assert.equal(context.state.loopCreateAllowed, true);
  assert.equal(updates.at(-1), true);
  context.applyStatusPayload({ allowed_actions: {} });
  assert.equal(context.state.loopCreateAllowed, false);
  assert.equal(updates.at(-1), false);
});

test('B06 omitted or malformed authority cannot reuse a previous grant or infer one from a role', () => {
  const { context } = helpers();
  for (const payload of [{}, { role_name: 'owner' }, { allowed_actions: { 'library.loops.create': 'true' } }, { allowed_actions: null }]) {
    context.applyStatusPayload({ allowed_actions: { 'library.loops.create': true } });
    context.applyStatusPayload(payload);
    assert.equal(context.state.loopCreateAllowed, false);
    assert.notEqual(context.state.status.allowed_actions?.['library.loops.create'], true);
  }
});

test('B06 normalizing a status without authority does not inherit fallback grants', () => {
  const { context } = helpers();
  const result = context.normalizeStatusPayload({ scan_processed: 12 }, { allowed_actions: { 'library.loops.create': true }, scan_total: 30 });
  assert.notEqual(result.allowed_actions?.['library.loops.create'], true);
  assert.equal(result.scan_processed, 12);
  assert.equal(result.scan_total, 30);
});

test('B06 initial status retains the exact server-projected bootstrap capability before polling', () => {
  const { context } = helpers();
  const bootstrapSource = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/bootstrap-init.js'), 'utf8');
  const start = bootstrapSource.indexOf('updateStatusIndicator({');
  const end = bootstrapSource.indexOf('\n});', start) + '\n});'.length;
  assert.ok(start >= 0 && end > start);
  context.bootstrap = {};
  context.updateStatusIndicator = payload => context.applyStatusPayload(payload);
  for (const allowed of [true, false]) {
    context.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__ = allowed ? { 'library.loops.create': true } : {};
    context.state.loopCreateAllowed = allowed;
    vm.runInContext(bootstrapSource.slice(start, end), context);
    assert.equal(context.state.loopCreateAllowed, allowed);
  }
});