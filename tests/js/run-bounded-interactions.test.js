const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCommands, nodeReportErrors, pytestReportErrors, runCommands } = require('../../scripts/run-bounded-interactions.cjs');

const registry = {
  interactions: [
    { id: 'drag', proof: 'contract', owners: ['music_app/static/js/runtime/a.js'], entrypoints: ['js:a#drag'], command: 'node --test tests/js/runtime/a.test.js' },
    { id: 'route', proof: 'contract', owners: ['music_app/routes/b.py'], entrypoints: ['py:b#route'], command: 'python -m pytest -q tests/py/test_b.py::test_route tests/py/test_b.py::TestB::test_cap' },
    { id: 'drag-twin', proof: 'contract', owners: ['music_app/static/js/runtime/a.js'], entrypoints: ['js:a#twin'], command: 'node --test tests/js/runtime/a.test.js' },
    { id: 'click', proof: 'static', owners: ['music_app/static/js/runtime/c.js'], entrypoints: ['js:c#click'] },
  ],
};
const args = commands => commands.map(([, commandArgs]) => commandArgs.join(' '));
const REPORTS = 'reports';

test('full run validates, then runs JS and Python contracts serially without duplicates', () => {
  const commands = buildCommands({ registry, python: 'py', reportDir: REPORTS });
  assert.equal(commands.length, 3);
  assert.equal(args(commands)[0], 'scripts/ci/validate-bounded-interactions.cjs');
  assert.match(args(commands)[1], /^--test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=\S+ .*tests\/js\/bounded-interaction-seeded-defects\.test\.js.*tests\/js\/runtime\/a\.test\.js$/);
  assert.equal(args(commands)[1].split('tests/js/runtime/a.test.js').length, 2);
  assert.equal(commands[2][0], 'py');
  assert.match(args(commands)[2], /^-m pytest -q -rs --junitxml=\S+ /);
});

test('Python contracts run by the exact node ids their commands name', () => {
  const pytest = buildCommands({ registry, changedPaths: ['music_app/routes/b.py'], python: 'py', reportDir: REPORTS }).at(-1);
  assert.deepEqual(pytest[1].slice(5), ['tests/py/test_b.py::TestB::test_cap', 'tests/py/test_b.py::test_route']);
});

test('a whole selected file supersedes its node ids', () => {
  const both = { interactions: [...registry.interactions, { id: 'all-b', proof: 'contract', owners: ['music_app/routes/b.py'], entrypoints: [], command: 'python -m pytest tests/py/test_b.py' }] };
  const pytest = buildCommands({ registry: both, changedPaths: ['music_app/routes/b.py'], reportDir: REPORTS }).at(-1);
  assert.deepEqual(pytest[1].slice(5), ['tests/py/test_b.py']);
});

test('changed owners or reachable hazard files select only their contracts; guard self-tests run only when the guard changed', () => {
  const nodeArgs = changedPaths => args(buildCommands({ registry, changedPaths, reportDir: REPORTS, discovery: { hazards: [{ entrypoint: 'js:a#drag', path: 'music_app/static/js/runtime/helper.js' }] } }));
  assert.match(nodeArgs(['music_app/static/js/runtime/a.js'])[1], /reporter-destination=\S+ tests\/js\/runtime\/a\.test\.js$/);
  assert.match(nodeArgs(['music_app/static/js/runtime/helper.js'])[1], /reporter-destination=\S+ tests\/js\/runtime\/a\.test\.js$/);
  assert.deepEqual(nodeArgs(['music_app/static/js/runtime/c.js']), ['scripts/ci/validate-bounded-interactions.cjs']);
  assert.match(nodeArgs(['tests/ci/bounded-interactions.json'])[1], /bounded-interaction-registry\.test\.js/);
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

test('a stage whose exit status passed still fails when its report check finds unrun tests', () => {
  const calls = [];
  const spawn = (command, commandArgs) => { calls.push(commandArgs[0]); return { status: 0 }; };
  const commands = [['node', ['first'], () => ['pytest tests.py.test_b::test_route was skipped']], ['node', ['second']]];
  assert.equal(runCommands(commands, spawn), 1);
  assert.deepEqual(calls, ['first']);
});

function report(xml) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runner-test-')), 'report.xml');
  fs.writeFileSync(file, xml);
  return file;
}

test('node test reports fail on skipped or todo tests and on an empty run', () => {
  assert.deepEqual(nodeReportErrors(report('<testsuites><testcase name="a" classname="test"/></testsuites>')), []);
  assert.deepEqual(nodeReportErrors(report(`<testsuites>
    <testcase name="a &quot;quoted&quot;" classname="test"><skipped type="skipped" message="why"/></testcase>
    <testcase name="b" classname="test"><skipped type="todo" message="true"/></testcase>
  </testsuites>`)), ['node test "a "quoted"" was skipped', 'node test "b" was marked todo']);
  assert.deepEqual(nodeReportErrors(report('<testsuites></testsuites>')), ['node test run reported no tests']);
  assert.match(nodeReportErrors(path.join(os.tmpdir(), 'missing-bounded-report.xml'))[0], /was not written/);
});

test('pytest reports fail on skipped tests and on selections that were not collected', () => {
  const xml = `<testsuites><testsuite>
    <testcase classname="tests.py.test_b" name="test_route" />
    <testcase classname="tests.py.test_b" name="test_param[1]" />
    <testcase classname="tests.py.test_b.TestB" name="test_cap" />
    <testcase classname="tests.py.test_c" name="test_skip"><skipped type="pytest.skip" message="no database">x</skipped></testcase>
  </testsuite></testsuites>`;
  assert.deepEqual(pytestReportErrors(report(xml), [
    'tests/py/test_b.py::test_route',
    'tests/py/test_b.py::test_param',
    'tests/py/test_b.py::TestB::test_cap',
    'tests/py/test_b.py',
  ]), ['pytest tests.py.test_c::test_skip was skipped']);
  assert.deepEqual(pytestReportErrors(report(xml), ['tests/py/test_b.py::test_missing', 'tests/py/test_d.py']), [
    'pytest tests.py.test_c::test_skip was skipped',
    'pytest selection tests/py/test_b.py::test_missing was not collected',
    'pytest selection tests/py/test_d.py was not collected',
  ]);
});
