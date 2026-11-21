const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildCommands, evidenceErrors, nodeReportErrors, pytestReportErrors, runCommands,
  pythonProofErrors, pythonProofIdentity,
} = require('../../scripts/run-bounded-interactions.cjs');

const registry = {
  interactions: [
    { id: 'drag', proof: 'contract', owners: ['music_app/static/js/runtime/a.js'], entrypoints: ['js:a#drag'], command: 'node --test tests/js/runtime/a.test.js' },
    { id: 'route', proof: 'contract', owners: ['music_app/routes/b.py'], entrypoints: ['py:b#route'], command: 'python -m pytest -q tests/py/test_b.py::test_route tests/py/test_b.py::TestB::test_cap' },
    { id: 'drag-twin', proof: 'contract', owners: ['music_app/static/js/runtime/a.js'], entrypoints: ['js:a#twin'], command: 'node --test tests/js/runtime/a.test.js' },
    { id: 'click', proof: 'static', owners: ['music_app/static/js/runtime/c.js'], entrypoints: ['js:c#click'] },
  ],
};
const args = commands => commands.filter(([command]) => command !== null).map(([, commandArgs]) => commandArgs.join(' '));
const pytestOf = commands => commands.find(([, commandArgs]) => commandArgs[0] === '-m');
const REPORTS = 'reports';

test('full run validates, then runs JS and Python contracts serially without duplicates', () => {
  const commands = buildCommands({ registry, python: 'py', reportDir: REPORTS });
  assert.equal(commands.length, 4);
  assert.equal(args(commands)[0], 'scripts/ci/validate-bounded-interactions.cjs');
  assert.match(args(commands)[1], /^--test --test-concurrency=1 --require \.\/tests\/js\/helpers\/bounded-interaction-evidence\.js --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=\S+ .*tests\/js\/bounded-interaction-seeded-defects\.test\.js.*tests\/js\/runtime\/a\.test\.js$/);
  assert.equal(args(commands)[1].split('tests/js/runtime/a.test.js').length, 2);
  assert.equal(commands[2][0], 'py');
  assert.match(args(commands)[2], /^-m pytest -q -rs --junitxml=\S+ /);
  assert.equal(commands[3][0], null, 'the last stage checks that every selected contract measured its entry');
});

test('Python contracts run by the exact node ids their commands name', () => {
  const pytest = pytestOf(buildCommands({ registry, changedPaths: ['music_app/routes/b.py'], python: 'py', reportDir: REPORTS }));
  assert.deepEqual(pytest[1].slice(5), ['tests/py/test_b.py::TestB::test_cap', 'tests/py/test_b.py::test_route']);
});

test('a whole selected file supersedes its node ids', () => {
  const both = { interactions: [...registry.interactions, { id: 'all-b', proof: 'contract', owners: ['music_app/routes/b.py'], entrypoints: [], command: 'python -m pytest tests/py/test_b.py' }] };
  const pytest = pytestOf(buildCommands({ registry: both, changedPaths: ['music_app/routes/b.py'], reportDir: REPORTS }));
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

for (const status of ['failure', 'error']) {
  test(`pytest proof rejects a collected exact contract with a ${status} result`, () => {
    const file = report(`<testsuites><testsuite>
      <testcase classname="tests.py.test_cover_batch_bounded_contracts"
        name="test_recovered_cover_contract[manual]">
        <${status} message="native proof did not complete"/>
      </testcase>
    </testsuite></testsuites>`);
    const errors = pytestReportErrors(file, [
      'tests/py/test_cover_batch_bounded_contracts.py::test_recovered_cover_contract[manual]',
    ]);
    assert.ok(errors.some(error => /fail|error/.test(error)),
      `a ${status} testcase must never become passing native proof: ${JSON.stringify(errors)}`);
  });
}

test('pytest proof requires every exact parametrized execution rather than a passing neighbor', () => {
  const file = report(`<testsuites><testsuite>
    <testcase classname="tests.py.test_cover_batch_bounded_contracts"
      name="test_recovered_cover_contract[manual]"/>
  </testsuite></testsuites>`);
  const errors = pytestReportErrors(file, [
    'tests/py/test_cover_batch_bounded_contracts.py::test_recovered_cover_contract[manual]',
    'tests/py/test_cover_batch_bounded_contracts.py::test_recovered_cover_contract[post_scan]',
  ]);
  assert.deepEqual(errors, [
    'pytest selection tests/py/test_cover_batch_bounded_contracts.py::test_recovered_cover_contract[post_scan] was not collected',
  ]);
});

test('every selected contract entry must be measured under its own id by its own test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runner-evidence-'));
  const file = path.join(dir, 'evidence.jsonl');
  const entries = [
    { id: 'py:routes/a.py#route', testIdentity: 'test_route' },
    { id: 'py:routes/a.py#twin', testIdentity: 'test_route', measures: ['py:routes/a.py#route'] },
    { id: 'py:routes/a.py#proxy', testIdentity: 'test_helper' },
    { id: 'js:a.js#drag', testIdentity: 'drag stays bounded' },
  ];
  fs.writeFileSync(file, [
    { id: 'py:routes/a.py#route', test: 'test_route' },
    // A helper test measuring something else never proves the proxied entry.
    { id: 'py:services/helper.py#helper', test: 'test_helper' },
    // Measured, but by another test than the entry's own.
    { id: 'js:a.js#drag', test: 'some other test' },
  ].map(line => JSON.stringify(line)).join('\n'));
  assert.deepEqual(evidenceErrors(entries, file), [
    'py:routes/a.py#proxy: its test "test_helper" did not measure py:routes/a.py#proxy',
    'js:a.js#drag: its test "drag stays bounded" did not measure js:a.js#drag',
  ]);
  assert.deepEqual(evidenceErrors(entries.slice(0, 1), path.join(dir, 'missing.jsonl')), [
    'py:routes/a.py#route: its test "test_route" did not measure py:routes/a.py#route',
  ]);
});

test('a check-only stage fails the run without spawning anything', () => {
  const spawn = () => assert.fail('a check-only stage must not spawn');
  assert.equal(runCommands([[null, [], () => ['x: its test "t" did not measure x']]], spawn), 1);
  assert.equal(runCommands([[null, [], () => []]], spawn), 0);
});

test('python-evidence runs nothing and checks only the Python contracts against the recorded evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runner-python-evidence-'));
  const file = path.join(dir, 'evidence.jsonl');
  const identified = { interactions: registry.interactions.map(entry => ({ ...entry, testIdentity: `test_${entry.id}` })) };
  const commands = buildCommands({ registry: identified, python: 'py', reportDir: REPORTS, pythonEvidence: file });
  assert.deepEqual(commands.map(([command]) => command), [null]);
  assert.deepEqual(commands[0][2](), ['route: its test "test_route" did not measure route']);
  fs.writeFileSync(file, `${JSON.stringify({ id: 'route', test: 'test_route' })}\n`);
  assert.deepEqual(commands[0][2](), []);
});

test('node-only runs just the JavaScript contracts and checks only their evidence', () => {
  const commands = buildCommands({ registry, python: 'py', reportDir: REPORTS, nodeOnly: true });
  assert.deepEqual(commands.map(([command]) => command), [process.execPath, null]);
  assert.match(args(commands)[0], /^--test .*tests\/js\/runtime\/a\.test\.js$/);
  const evidence = path.join(REPORTS, 'bounded-interactions-evidence.jsonl');
  const errors = commands[1][2]();
  assert.ok(errors.every(error => !error.includes('route')), 'Python contracts are measured in the Python job');
  assert.ok(errors.some(error => error.includes('drag')), `missing JS evidence must still fail: ${errors.join('; ')}`);
  assert.equal(fs.existsSync(evidence), false);
});

function nativeCoverProofFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-native-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shard = path.join(directory, 'foundation-versions-python-windows-1-2');
  fs.mkdirSync(shard);
  const identity = {
    testedCommit: '1'.repeat(40), testedTree: '2'.repeat(40),
    headSha: '3'.repeat(40), baseSha: '4'.repeat(40),
    runId: '12345', runAttempt: '2', shardTotal: 1,
  };
  const manifest = { boundedProof: { schemaVersion: 1, ...identity, shard: 1 } };
  const rows = [];
  for (const kind of ['unit', 'real-postgres']) for (const mode of ['manual', 'post_scan']) {
    const file = kind === 'unit' ? 'test_cover_batch_bounded_contracts' : 'test_cover_batch_bounded_contracts_postgres_live';
    const testName = `${kind === 'unit' ? 'test' : 'test_live'}_claimed_cover_refresh_reuses_connections_for_recovered_existing_covers`;
    rows.push({
      id: 'py:services/cover_refresh_runtime.py#run_claimed_cover_refresh',
      test: testName, nodeId: `tests/py/${file}.py::${testName}[${mode}]`,
      proof: { schemaVersion: 1, kind, mode, scales: [20, 1000].map(cardinality => ({
        cardinality, physicalConnections: 3, checkouts: cardinality + 2,
        recoveryHits: cardinality, defaultConnectorCalls: 0, cleanupComplete: true,
      })) },
    });
  }
  const cases = rows.map(row => {
    const [file, name] = row.nodeId.split('::');
    return { classname: file.replace(/\.py$/, '').replaceAll('/', '.'), name, body: '' };
  });
  const write = () => {
    fs.writeFileSync(path.join(shard, 'foundation-version-manifest-python-windows.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(shard, 'bounded-interactions-evidence.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    fs.writeFileSync(path.join(shard, 'pytest-results.xml'), `<testsuites><testsuite>${cases.map(item =>
      `<testcase classname="${item.classname}" name="${item.name}">${item.body}</testcase>`).join('')}</testsuite></testsuites>`);
  };
  write();
  return { directory, identity, manifest, rows, cases, write,
    errors: () => pythonProofErrors([], directory, identity, [{}]) };
}

test('native proof accepts complete same-shard exact identities and both kinds, modes, and scales', t => {
  assert.deepEqual(nativeCoverProofFixture(t).errors(), []);
});

test('native proof accepts truthful connection reuse below both approved ceilings', t => {
  const fixture = nativeCoverProofFixture(t);
  for (const row of fixture.rows) {
    for (const scale of row.proof.scales) {
      scale.physicalConnections = 2;
      scale.checkouts = scale.cardinality + 1;
    }
  }
  fixture.write();
  assert.deepEqual(fixture.errors(), [], 'lower measured cost must not require artificial opens or checkouts');
});

for (const field of ['physicalConnections', 'checkouts']) {
  for (const [name, value] of [['negative', -1], ['fractional', 1.5], ['string', '2'], ['null', null], ['missing', undefined], ['boolean', true]]) {
    test(`native proof rejects ${name} ${field} despite counts otherwise below ceilings`, t => {
      const fixture = nativeCoverProofFixture(t);
      fixture.rows[0].proof.scales[1][field] = value;
      fixture.write();
      assert.notDeepEqual(fixture.errors(), []);
    });
  }
}

for (const key of ['testedCommit', 'testedTree', 'headSha', 'baseSha', 'runId', 'runAttempt', 'shardTotal']) {
  test(`native proof rejects a different ${key} despite passing measurements`, t => {
    const fixture = nativeCoverProofFixture(t);
    fixture.manifest.boundedProof[key] = key === 'shardTotal' ? 2 : 'different';
    fixture.write();
    assert.match(fixture.errors().join('\n'), /identity differs|shard/);
  });
}

for (const [name, mutate] of [
  ['missing native mode', fixture => fixture.rows.pop()],
  ['unit evidence presented as real PostgreSQL', fixture => { fixture.rows[2].proof.kind = 'unit'; }],
  ['duplicate exact proof row', fixture => fixture.rows.push(structuredClone(fixture.rows[0]))],
  ['partial scale set', fixture => fixture.rows[0].proof.scales.pop()],
  ['above physical-open ceiling', fixture => { fixture.rows[0].proof.scales[1].physicalConnections = 4; }],
  ['above total-checkout ceiling', fixture => { fixture.rows[0].proof.scales[1].checkouts = fixture.rows[0].proof.scales[1].cardinality + 3; }],
  ['missing real recovery', fixture => { fixture.rows[0].proof.scales[1].recoveryHits = 999; }],
  ['default connector use', fixture => { fixture.rows[0].proof.scales[1].defaultConnectorCalls = 1; }],
  ['unfinished cleanup', fixture => { fixture.rows[0].proof.scales[1].cleanupComplete = false; }],
  ['skipped exact native execution', fixture => { fixture.cases[0].body = '<skipped type="pytest.skip"/>'; }],
  ['failed exact native execution', fixture => { fixture.cases[0].body = '<failure message="failed"/>'; }],
  ['missing exact native execution', fixture => fixture.cases.pop()],
  ['passing neighboring parameter', fixture => { fixture.cases[0].name = fixture.cases[0].name.replace('[manual]', '[other]'); }],
]) {
  test(`native proof rejects ${name}`, t => {
    const fixture = nativeCoverProofFixture(t);
    mutate(fixture);
    fixture.write();
    assert.notDeepEqual(fixture.errors(), []);
  });
}

test('native proof refuses local evidence authority even when a caller claims GitHub identity', () => {
  assert.throws(() => pythonProofIdentity({
    GITHUB_ACTIONS: 'false', GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ID: '12345',
  }), /authoritative pull-request pipeline/);
});
