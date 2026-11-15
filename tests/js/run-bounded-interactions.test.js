const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCommands, runCommands } = require('../../scripts/run-bounded-interactions.cjs');

const registry = {
  interactions: [
    { id: 'drag', proof: 'contract', owners: ['music_app/static/js/runtime/a.js'], command: 'node --test tests/js/runtime/a.test.js' },
    { id: 'route', proof: 'contract', owners: ['music_app/routes/b.py'], command: 'python -m pytest -q tests/py/test_b.py::test_route' },
    { id: 'drag-twin', proof: 'contract', owners: ['music_app/static/js/runtime/a.js'], command: 'node --test tests/js/runtime/a.test.js' },
    { id: 'click', proof: 'static', owners: ['music_app/static/js/runtime/c.js'] },
  ],
};
const args = commands => commands.map(([, commandArgs]) => commandArgs.join(' '));

test('full run validates, then runs JS and Python contracts serially without duplicates', () => {
  const commands = buildCommands({ registry, python: 'py' });
  assert.equal(commands.length, 3);
  assert.equal(args(commands)[0], 'scripts/ci/validate-bounded-interactions.cjs');
  assert.match(args(commands)[1], /^--test --test-concurrency=1 .*tests\/js\/bounded-interaction-seeded-defects\.test\.js.*tests\/js\/runtime\/a\.test\.js$/);
  assert.equal(args(commands)[1].split('tests/js/runtime/a.test.js').length, 2);
  assert.equal(commands[2][0], 'py');
  assert.match(args(commands)[2], /^-m pytest -q .*tests\/py\/test_b\.py/);
});

test('changed owners select only their contracts; guard self-tests run only when the guard changed', () => {
  assert.deepEqual(args(buildCommands({ registry, changedPaths: ['music_app/static/js/runtime/a.js'] })), [
    'scripts/ci/validate-bounded-interactions.cjs',
    '--test --test-concurrency=1 tests/js/runtime/a.test.js',
  ]);
  assert.deepEqual(args(buildCommands({ registry, changedPaths: ['music_app/static/js/runtime/c.js'] })), [
    'scripts/ci/validate-bounded-interactions.cjs',
  ]);
  assert.match(args(buildCommands({ registry, changedPaths: ['tests/ci/bounded-interactions.json'] }))[1], /bounded-interaction-registry\.test\.js/);
});

test('a failed stage stops later stages and a signal is an error', () => {
  const calls = [];
  const failing = (command, commandArgs) => {
    calls.push(commandArgs[0]);
    return { status: calls.length === 1 ? 1 : 0 };
  };
  assert.equal(runCommands([['node', ['first']], ['node', ['second']]], failing), 1);
  assert.deepEqual(calls, ['first']);
  assert.throws(() => runCommands([['node', ['x']]], () => ({ status: null, signal: 'SIGTERM' })), /stopped by SIGTERM/);
});
