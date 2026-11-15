const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WORK_CLASSES,
  endpointMatches,
  interactionsForPaths,
  loadRegistry,
  validateInventory,
  validateSchema,
} = require('../../scripts/ci/validate-bounded-interactions.cjs');

const OWNER = 'music_app/static/js/runtime/album-track-table.js';
const KEY = `js:${OWNER}#install:event:pointermove`;
const TEST_FILE = 'tests/js/runtime/bounded-interaction-contracts.test.js';
const files = {
  [OWNER]: '',
  [TEST_FILE]: "test('BI-H01 adjacent drag stays delta-bounded at production scale', () => {});",
  'music_app/services/relations.py': '',
};
const io = {
  fileExists: file => Object.hasOwn(files, file),
  readFile: file => files[file],
};

function contractEntry(overrides = {}) {
  return {
    id: 'BI-H01-loose-track-drag',
    action: 'Drag across one adjacent Loose Tracks row',
    entrypoints: [KEY],
    owners: [OWNER],
    rules: ['BI-01', 'BI-03'],
    workClass: 'delta',
    proof: 'contract',
    cardinalities: { small: 20, production: 1000 },
    budgets: { itemsVisited: 3, domQueries: 0, domMutations: 2, outputEmissions: 0 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
    command: `node --test --test-concurrency=1 ${TEST_FILE}`,
    testIdentity: 'BI-H01 adjacent drag stays delta-bounded at production scale',
    performanceTargets: [],
    rollback: 'Revert the selection-owner change; retain this contract.',
    ...overrides,
  };
}

function registry(interactions, extra = {}) {
  return { schemaVersion: 1, allowedWorkClasses: WORK_CLASSES, libraryScaleOperations: [], interactions, ...extra };
}

const entrypoint = (key = KEY, extra = {}) => ({ key, path: OWNER, kind: 'event', trigger: 'pointermove', ...extra });

test('accepts a minimal contract entry', () => {
  assert.deepEqual(validateSchema(registry([contractEntry()]), io), []);
});

test('accepts a static entry and rejects contract fields on it', () => {
  const entry = { id: 'static', action: 'Toggle', entrypoints: [KEY], owners: [OWNER], rules: ['BI-03'], workClass: 'constant', proof: 'static' };
  assert.deepEqual(validateSchema(registry([entry]), io), []);
  assert.match(validateSchema(registry([{ ...entry, budgets: { requests: 1 } }]), io).join('\n'), /static proof must not declare budgets/);
});

for (const [name, mutate, expected] of [
  ['duplicate ids', reg => reg.interactions.push(contractEntry()), /duplicate id/],
  ['library-size work class', reg => { reg.interactions[0].workClass = 'library-size'; }, /unsupported work class library-size/],
  ['absent owner path', reg => { reg.interactions[0].owners = ['music_app/missing.js']; }, /owner music_app\/missing\.js does not exist/],
  ['entrypoint outside owners', reg => { reg.interactions[0].entrypoints = ['js:music_app/other.js#x:event:scroll']; }, /outside its owners/],
  ['missing test identity', reg => { reg.interactions[0].testIdentity = 'BI-H01 not written yet'; }, /is not defined in/],
  ['missing test file', reg => { reg.interactions[0].command = 'node --test tests/js/missing.test.js'; }, /does not exist/],
  ['missing production cardinality', reg => { delete reg.interactions[0].cardinalities.production; }, /cardinalities/],
  ['production not larger than small', reg => { reg.interactions[0].cardinalities.production = 20; }, /production > small/],
  ['negative budget', reg => { reg.interactions[0].budgets.itemsVisited = -1; }, /nonnegative number/],
  ['unbudgeted growth metric', reg => { reg.interactions[0].growth.metric = 'requests'; }, /growth metric/],
  ['out-of-range rule', reg => { reg.interactions[0].rules = ['BI-15']; }, /BI-01\.\.BI-14/],
  ['unknown interaction key', reg => { reg.interactions[0].notes = 'x'; }, /unknown key notes/],
  ['unknown top-level key', reg => { reg.extra = true; }, /unknown top-level key extra/],
  ['unknown proof', reg => { reg.interactions[0].proof = 'manual'; }, /proof must be/],
  ['top-level allowlist', reg => { reg.allowlist = []; }, /exemption field is not allowed: \$\.allowlist/],
  ['nested waiver', reg => { reg.interactions[0].budgets.waiverUntil = 1; }, /exemption field is not allowed/],
  ['skipped contract', reg => { reg.interactions[0].skip = true; }, /exemption field is not allowed/],
  ['library-scale operation without reason', reg => { reg.libraryScaleOperations = [{ operation: 'py:music_app/services/relations.py#build' }]; }, /must give a reason/],
  ['query in endpoint', reg => { reg.interactions[0].requestOwnership = { allowed: ['/view-data?surface=home'], forbidden: [] }; }, /without query/],
  ['bare slash wildcard endpoint', reg => { reg.interactions[0].requestOwnership = { allowed: ['/home-data', '/*'], forbidden: [] }; }, /endpoint \/\* is a bare wildcard/],
  ['nested bare wildcard endpoint', reg => { reg.interactions[0].requestOwnership = { allowed: ['/*/*'], forbidden: [] }; }, /endpoint \/\*\/\* is a bare wildcard/],
  ['star endpoint', reg => { reg.interactions[0].requestOwnership = { allowed: ['*'], forbidden: [] }; }, /endpoint \* is a bare wildcard/],
]) {
  test(`rejects ${name}`, () => {
    const candidate = registry([contractEntry()]);
    mutate(candidate);
    assert.match(validateSchema(candidate, io).join('\n'), expected);
  });
}

test('rejects unregistered, stale, and doubly registered entrypoints', () => {
  const reg = registry([contractEntry(), contractEntry({ id: 'second' })]);
  reg.interactions[1].entrypoints = [KEY, `js:${OWNER}#install:event:scroll`];
  const errors = validateInventory(reg, { entrypoints: [entrypoint(), entrypoint(`js:${OWNER}#install:event:wheel`)], hazards: [] }).join('\n');
  assert.match(errors, /registered by both BI-H01-loose-track-drag and second/);
  assert.match(errors, /stale entrypoint .*event:scroll/);
  assert.match(errors, /unregistered entrypoint .*event:wheel/);
});

test('rejected hazards fail even for a registered contract entry', () => {
  const errors = validateInventory(registry([contractEntry()]), {
    entrypoints: [entrypoint()],
    hazards: [{ entrypoint: KEY, rule: 'BI-01', operation: 'querySelectorAll', path: OWNER, line: 4, reject: true, via: [] }],
  });
  assert.deepEqual(errors, [`rejected BI-01 querySelectorAll at ${OWNER}:4 from ${KEY}`]);
});

test('a static proof with reachable hazards requires a runtime contract', () => {
  const entry = contractEntry({ proof: 'static' });
  const errors = validateInventory(registry([entry]), {
    entrypoints: [entrypoint()],
    hazards: [{ entrypoint: KEY, rule: 'BI-01', operation: 'forEach', path: OWNER, line: 9, reject: false, via: ['sync'] }],
  });
  assert.match(errors.join('\n'), /1 reachable hazard\(s\) need a runtime contract \(forEach at .*:9\)/);
});

test('only hot-path hazards require a contract; a hazard without the mark always counts', () => {
  const entry = contractEntry({ proof: 'static' });
  const hazard = { entrypoint: KEY, rule: 'BI-01', operation: 'forEach', path: OWNER, line: 9, reject: false, via: ['sync'] };
  const errorsFor = extra => validateInventory(registry([entry]), { entrypoints: [entrypoint()], hazards: [{ ...hazard, ...extra }] });
  assert.deepEqual(errorsFor({ hot: false }), []);
  assert.match(errorsFor({ hot: true }).join('\n'), /1 reachable hazard\(s\) need a runtime contract/);
  // Python routes and background entrypoints report hazards without the mark.
  assert.match(errorsFor({}).join('\n'), /1 reachable hazard\(s\) need a runtime contract/);
});

test('a one-shot entrypoint still fails route ownership, request ownership, and dynamic targets', () => {
  const click = `js:${OWNER}#install:event:click`;
  const request = `js:${OWNER}#install:request:fetch`;
  const entry = {
    id: 'one-shot', action: 'Open Home', entrypoints: [click, request], owners: [OWNER], rules: ['BI-03'], workClass: 'constant', proof: 'static',
    requestOwnership: { allowed: ['/home-data'], forbidden: ['/view-data'] },
  };
  const discovery = target => ({
    entrypoints: [
      entrypoint(click, { trigger: 'click', hot: false }),
      entrypoint(request, { kind: 'request', trigger: 'fetch', hot: false, targets: [{ target, line: 3 }] }),
    ],
    hazards: [{
      entrypoint: `js:${OWNER}#install:route:route-owner:/view-data?surface=home`, rule: 'BI-04', operation: 'route-owner:/view-data?surface=home',
      path: OWNER, line: 3, reject: true, hot: true, via: [],
    }],
  });
  const errors = validateInventory(registry([entry]), discovery('/view-data?surface=home')).join('\n');
  assert.match(errors, /rejected BI-04 route-owner:\/view-data\?surface=home/);
  assert.match(errors, /request target \/view-data is not an allowed endpoint/);
  assert.match(validateInventory(registry([entry]), discovery(null)).join('\n'), /needs a request-capture contract/);
});

test('a contract covers hazards in helper files without listing them as owners', () => {
  const errors = validateInventory(registry([contractEntry()]), {
    entrypoints: [entrypoint()],
    hazards: [{ entrypoint: KEY, rule: 'BI-01', operation: 'forEach', path: 'music_app/static/js/runtime/helpers.js', line: 2, reject: false, via: ['scan'] }],
  });
  assert.deepEqual(errors, []);
});

test('a change to a file hosting a reachable hazard selects the contract', () => {
  const helper = 'music_app/static/js/runtime/helpers.js';
  const discovery = { hazards: [{ entrypoint: KEY, path: helper }] };
  const reg = registry([contractEntry()]);
  assert.deepEqual(interactionsForPaths(reg, [helper], discovery), ['BI-H01-loose-track-drag']);
  assert.deepEqual(interactionsForPaths(reg, [helper]), []);
  assert.deepEqual(interactionsForPaths(reg, ['music_app/static/js/runtime/other.js'], discovery), []);
});

test('bare wildcards are recognized by segment, not by containing a star', () => {
  const { isBareWildcard } = require('../../scripts/ci/validate-bounded-interactions.cjs');
  assert.deepEqual(['/*', '*', '/*/*', '/**'].map(isBareWildcard), [true, true, true, true]);
  assert.deepEqual(['/', '/albums/*', '/utilities/save-task/*'].map(isBareWildcard), [false, false, false]);
});

test('request ownership allows declared endpoints and rejects others', () => {
  const requestKey = `js:${OWNER}#openHome:request:fetch`;
  const entry = {
    id: 'home', action: 'Open Home', entrypoints: [requestKey], owners: [OWNER], rules: ['BI-13'], workClass: 'page', proof: 'static',
    requestOwnership: { allowed: ['/home-data'], forbidden: ['/view-data'] },
  };
  const request = target => ({ key: requestKey, path: OWNER, kind: 'request', trigger: 'fetch', line: 3, targets: [{ target, line: 3 }] });
  assert.deepEqual(validateInventory(registry([entry]), { entrypoints: [request('/home-data?omit_sidebar=1')], hazards: [] }), []);
  assert.match(validateInventory(registry([entry]), { entrypoints: [request('/view-data')], hazards: [] }).join('\n'), /not an allowed endpoint/);
  assert.match(validateInventory(registry([entry]), { entrypoints: [request(null)], hazards: [] }).join('\n'), /needs a request-capture contract/);
});

test('endpoint patterns match one path segment per wildcard', () => {
  assert.equal(endpointMatches('/utilities/save-task/${}', '/utilities/save-task/*'), true);
  assert.equal(endpointMatches('/utilities/save-task/1/cancel', '/utilities/save-task/*'), false);
});

test('changed owners select contract interactions only', () => {
  const reg = registry([contractEntry(), { ...contractEntry({ id: 'static', proof: 'static' }) }]);
  assert.deepEqual(interactionsForPaths(reg, [OWNER, 'README.md']), ['BI-H01-loose-track-drag']);
});

test('the checked-in registry satisfies the schema', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..', '..');
  const errors = validateSchema(loadRegistry(root), {
    fileExists: file => fs.existsSync(path.join(root, file)),
    readFile: file => fs.readFileSync(path.join(root, file), 'utf8'),
  });
  assert.deepEqual(errors, []);
});

test('sync registers new entrypoints, drops stale ones, and keeps reviewed fields', () => {
  const { syncRegistry } = require('../../scripts/ci/bounded-interaction-registry-sync.cjs');
  const reviewed = contractEntry({ id: 'js:runtime/album-track-table.js#install', requestOwnership: { allowed: ['/home-data'], forbidden: ['/view-data'] } });
  reviewed.entrypoints = [KEY, `js:${OWNER}#install:event:stale`];
  const discovered = [
    { key: KEY, language: 'javascript', path: OWNER, owner: 'install', kind: 'event', trigger: 'pointermove' },
    { key: `js:${OWNER}#install:request:fetch`, language: 'javascript', path: OWNER, owner: 'install', kind: 'request', trigger: 'fetch', targets: [{ target: '/view-data', line: 9 }] },
    { key: `js:${OWNER}#openMenu:event:click`, language: 'javascript', path: OWNER, owner: 'openMenu', kind: 'event', trigger: 'click' },
  ];
  const { registry: synced, added, removed } = syncRegistry(registry([reviewed]), discovered);
  assert.deepEqual(removed, [`js:${OWNER}#install:event:stale`]);
  assert.deepEqual(added, [`js:${OWNER}#install:request:fetch`, `js:${OWNER}#openMenu:event:click`]);
  const [install, installRequest, openMenu] = synced.interactions;
  // A contract never absorbs an entrypoint its budgets did not measure.
  assert.deepEqual(install.entrypoints, [KEY]);
  assert.deepEqual(install.requestOwnership, { allowed: ['/home-data'], forbidden: ['/view-data'] });
  assert.equal(install.proof, 'contract');
  assert.deepEqual([installRequest.id, installRequest.proof, installRequest.entrypoints], [
    'js:runtime/album-track-table.js#install#2', 'static', [`js:${OWNER}#install:request:fetch`],
  ]);
  assert.deepEqual(installRequest.requestOwnership, { allowed: [], forbidden: [] });
  assert.deepEqual([openMenu.id, openMenu.proof, openMenu.workClass], ['js:runtime/album-track-table.js#openMenu', 'static', 'constant']);
});

test('sync never grants endpoints, so a synced request fails validation until its owner is reviewed', () => {
  const { syncRegistry } = require('../../scripts/ci/bounded-interaction-registry-sync.cjs');
  const requestKey = `js:${OWNER}#openHome:request:fetch`;
  const request = { key: requestKey, language: 'javascript', path: OWNER, owner: 'openHome', kind: 'request', trigger: 'fetch', line: 3, targets: [{ target: '/home-data', line: 3 }] };
  const { registry: synced } = syncRegistry(registry([]), [request]);
  assert.deepEqual(synced.interactions[0].requestOwnership, { allowed: [], forbidden: [] });
  assert.match(validateInventory(synced, { entrypoints: [request], hazards: [] }).join('\n'), /needs requestOwnership\.allowed/);
});

test('sync adds a reviewable empty endpoint list when a request joins a static entry', () => {
  const { syncRegistry } = require('../../scripts/ci/bounded-interaction-registry-sync.cjs');
  const id = 'js:runtime/album-track-table.js#openHome';
  const click = { key: `js:${OWNER}#openHome:event:click`, language: 'javascript', path: OWNER, owner: 'openHome', kind: 'event', trigger: 'click' };
  const request = { key: `js:${OWNER}#openHome:request:fetch`, language: 'javascript', path: OWNER, owner: 'openHome', kind: 'request', trigger: 'fetch', targets: [{ target: '/home-data', line: 3 }] };
  const existing = { id, action: 'Open Home', entrypoints: [click.key], owners: [OWNER], rules: ['BI-03'], workClass: 'constant', proof: 'static' };
  const { registry: synced } = syncRegistry(registry([existing]), [click, request]);
  assert.deepEqual(synced.interactions.map(entry => [entry.id, entry.entrypoints, entry.requestOwnership]), [
    [id, [click.key, request.key], { allowed: [], forbidden: [] }],
  ]);
});
