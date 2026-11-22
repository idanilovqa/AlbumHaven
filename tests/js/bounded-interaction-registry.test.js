const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WORK_CLASSES,
  endpointMatches,
  interactionsForPaths,
  loadRegistry,
  validateInventory,
  validateSchema,
  scopedCoverStatus,
  scopedCoverProofErrors,
  coverFamilyProofErrors,
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
  ['request-capture contract outside JavaScript', (reg) => {
    Object.assign(reg.interactions[0], { requestOwnership: { allowed: ['/home-data'], forbidden: [] }, command: 'python -m pytest tests/py/test_bounded_interaction_counter.py' });
  }, /a request-capture contract must be a JavaScript test/],
]) {
  test(`rejects ${name}`, () => {
    const candidate = registry([contractEntry()]);
    mutate(candidate);
    assert.match(validateSchema(candidate, io).join('\n'), expected);
  });
}

test('a test identity must name a real test declaration, never a substring of one', () => {
  const declared = source => validateSchema(registry([contractEntry()]), { ...io, readFile: () => source });
  const identity = 'BI-H01 adjacent drag stays delta-bounded at production scale';
  for (const source of [
    `test("${identity}", () => {});`,
    `require('node:test')('${identity}', async () => {});`,
    `it(\`${identity}\`, () => {});`,
    // A test declared in a loop matches through its template holes.
    "for (const size of ['production']) test(`BI-H01 adjacent drag stays delta-bounded at ${size} scale`, () => {});",
  ]) assert.deepEqual(declared(source), [], source);
  for (const source of [
    `test('${identity} with a longer name', () => {});`,
    `// ${identity}\ntest('another test', () => {});`,
    `const label = '${identity}';`,
    `test('BI-H01 adjacent drag', () => {}); // ${identity}`,
  ]) assert.match(declared(source).join('\n'), /is not defined in/, source);
  const python = { ...io, fileExists: () => true, readFile: () => 'def test_route_contract_at_production_size(app):\n    pass\n' };
  const pyEntry = name => registry([contractEntry({ command: 'python -m pytest tests/py/test_b.py', testIdentity: name })]);
  assert.deepEqual(validateSchema(pyEntry('test_route_contract_at_production_size'), python), []);
  assert.match(validateSchema(pyEntry('test_route_contract'), python).join('\n'), /is not defined in/);
});

test('measures names registered contract entries and only a contract may declare it', () => {
  const other = contractEntry({ id: 'other-contract', entrypoints: [`js:${OWNER}#install:event:wheel`] });
  assert.deepEqual(validateSchema(registry([contractEntry({ measures: ['other-contract'] }), other]), io), []);
  assert.match(validateSchema(registry([contractEntry({ measures: ['py:services/helper.py#helper'] })]), io).join('\n'), /measures py:services\/helper\.py#helper, which is not a registered contract/);
  assert.match(validateSchema(registry([contractEntry({ measures: [] })]), io).join('\n'), /measures must be a nonempty list/);
  const entry = { id: 'static', action: 'Toggle', entrypoints: [KEY], owners: [OWNER], rules: ['BI-03'], workClass: 'constant', proof: 'static', measures: ['x'] };
  assert.match(validateSchema(registry([entry]), io).join('\n'), /static proof must not declare measures/);
});

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

function graphDigest(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])])) : item;
  return require('node:crypto').createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function scopedConnectionGraphFixture() {
  const routePath = 'music_app/routes/api_wave_d_asgi_routes.py';
  const loopOwner = 'music_app/services/cover_refresh_execution.py#_run_cover_jobs';
  const fingerprints = { analyzerFingerprint: 'a'.repeat(64), contractFingerprint: 'b'.repeat(64) };
  const scan = 'music_app/services/scan_cache_persistence.py';
  const execution = 'music_app/services/cover_refresh_execution.py';
  const pools = 'music_app/services/postgres_connections.py';
  const specifications = [
    { id: 'cover-mutation-shared-transaction', operation: 'database-connect-per-item:psycopg.connect@music_app/services/cover_mutations_postgres.py',
      sinkOwner: 'py:music_app/services/cover_mutations_postgres.py#_default_connect',
      context: { connector: 'scan_cache_transaction', databaseScope: 'matching-config-url', workerContext: 'copy_context', lifetime: 'claimed-cover-run' },
      roles: { 'cache-injection': 'music_app/services/cache.py#execute_cover_mutation_for_config', 'recovery-injection': `${execution}#_recover_existing_cover_selection`,
        'automatic-injection': `${execution}#_build_automatic_cover_write_guard`, 'matching-dsn': `${scan}#scan_cache_transaction`,
        'run-scope': `${execution}#run_cover_jobs`, 'copied-worker-context': loopOwner, 'scope-cleanup': `${scan}#shared_scan_cache_connection` } },
    { id: 'shared-adapter-lazy-initializer', operation: `database-connect-per-item:psycopg.connect@${scan}`, sinkOwner: `py:${scan}#_connect`,
      context: { binding: 'sealed-shared-connection-v1', databaseScope: 'matching-config-url', initializer: 'guarded-lazy', lifetime: 'claimed-cover-run' },
      roles: { 'sealed-constructor': `${scan}#shared_scan_cache_connection`, 'field-assignment': `${scan}#_SharedConnection.__init__`,
        'lazy-guard': `${scan}#_SharedConnection.transaction`, initializer: `${scan}#_SharedConnection.transaction`,
        'transaction-lock': `${scan}#_SharedConnection.transaction`, 'scope-cleanup': `${scan}#shared_scan_cache_connection` } },
    { id: 'cover-advisory-lock-pool-initializer', operation: `database-connect-per-item:psycopg_pool.ConnectionPool@${pools}`, sinkOwner: `py:${pools}#cover_lock_connection`,
      context: { cacheKey: ['dedicated', 'database_url', 'cover-lock'], initializer: 'cache-miss-under-lock', lifetime: 'process-cache-until-close_pools', channels: 'existing-active-cover-worker-bound' },
      roles: Object.fromEntries(['cache-key', 'cache-lookup', 'cache-guard', 'initializer', 'cache-store', 'cache-lock', 'pool-cleanup'].map(role =>
        [role, `${pools}#${role === 'pool-cleanup' ? 'close_pools' : 'cover_lock_connection'}`])) },
  ];
  const contracts = specifications.map(specification => {
    const anchors = Object.entries(specification.roles).sort(([left], [right]) => left.localeCompare(right)).map(([role, owner], index) =>
      ({ role, site: { owner: `py:${owner}`, astPath: ['body', index] } }));
    const contract = { schemaVersion: 1, id: `${specification.id}/v1`, status: 'matched',
      sources: [...new Set(anchors.map(anchor => anchor.site.owner.slice(3).split('#')[0]))].sort().map(path => ({ path, astFingerprint: graphDigest(path) })), anchors };
    return { ...contract, fingerprint: graphDigest(contract) };
  });
  const graphs = [], records = [], hazards = [], entrypoints = [];
  for (const [name, trigger] of [['utilities_fetch_cover', '/utilities/fetch-cover'], ['utilities_fetch_covers_unsuccessful', '/utilities/fetch-covers-unsuccessful']]) {
    const key = `py:${routePath}#${name}:route:POST ${trigger}`;
    const rootOwner = `py:${routePath}#${name}`;
    const site = { owner: rootOwner, astPath: ['body', 0, 'value'] };
    const loop = { owner: `py:${loopOwner}`, astPath: ['body', 0, 'value', 'generators', 0] };
    const node = (owner, activeLoop) => {
      const state = { owner, loop: activeLoop, scan: null, bound: null };
      return { id: graphDigest(state), ...state };
    };
    const nodes = [node(rootOwner, null), node(`py:${loopOwner}`, null)];
    const edge = (from, to, callSite) => {
      const state = { from, to, site: callSite };
      return { id: graphDigest(state), ...state };
    };
    const edges = [edge(nodes[0].id, nodes[1].id, site)], sinks = [], families = [];
    for (const [index, specification] of specifications.entries()) {
      const contract = contracts[index];
      const chain = index === 0 ? [`py:${execution}#_recover_existing_cover_selection`, specification.sinkOwner]
        : index === 1 ? [`py:${scan}#_SharedConnection.transaction`, `py:${scan}#PostgresScanCacheAdapter._connect_to_database`, specification.sinkOwner]
          : [specification.sinkOwner];
      let predecessor = nodes[1];
      for (const owner of chain) {
        const next = node(owner, loop);
        const callSite = index === 1 && owner.endsWith('#PostgresScanCacheAdapter._connect_to_database')
          ? contract.anchors.find(anchor => anchor.role === 'initializer').site
          : { owner: predecessor.owner, astPath: ['body', index, 'value'] };
        nodes.push(next);
        edges.push(edge(predecessor.id, next.id, callSite));
        predecessor = next;
      }
      const sinkSite = index === 2 ? contract.anchors.find(anchor => anchor.role === 'initializer').site
        : { owner: specification.sinkOwner, astPath: ['body', 0, 'value'] };
      const sinkState = { node: predecessor.id, operation: specification.operation.split('@')[0], site: sinkSite, loop };
      const sink = { id: graphDigest(sinkState), ...sinkState };
      sinks.push(sink);
      families.push({ id: specification.id, operation: specification.operation, sinkIds: [sink.id], contractId: contract.id,
        contractFingerprint: contract.fingerprint, context: structuredClone(specification.context) });
      hazards.push({ entrypoint: key, rule: 'BI-05', operation: `${specification.operation}:19`, path: loopOwner.split('#')[0],
        function: '_run_cover_jobs', line: 19, reject: true, via: ['_run_cover_jobs', specification.sinkOwner], graphId: key, sinkId: sink.id });
    }
    const graph = {
      schemaVersion: 1, id: key, entrypoint: key, root: nodes[0].id,
      nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
      edges: edges.sort((left, right) => left.id.localeCompare(right.id)), sinks: sinks.sort((left, right) => left.id.localeCompare(right.id)),
      sources: [...new Set([routePath, ...contracts.flatMap(contract => contract.sources.map(source => source.path)), ...specifications.map(specification => specification.sinkOwner.slice(3).split('#')[0])])]
        .sort().map(path => ({ path, astFingerprint: graphDigest(path) })),
    };
    graph.fingerprint = graphDigest(graph);
    graphs.push(graph);
    records.push({
      schemaVersion: 3, id: `disabled-${name}`, entrypoint: key, rule: 'BI-05', loopOwner, families,
      ...fingerprints,
      coverage: { graphFingerprint: graph.fingerprint, root: graph.root,
        nodeIds: graph.nodes.map(item => item.id), edgeIds: graph.edges.map(item => item.id), sinkIds: graph.sinks.map(item => item.id) },
    });
    entrypoints.push({ key, path: routePath, kind: 'route', trigger: `POST ${trigger}`, owner: name });
  }
  return {
    registry: registry(entrypoints.map(item => contractEntry({ id: item.owner, entrypoints: [item.key], owners: [routePath], rules: ['BI-05'] })), { scopedCoverProofs: records }),
    discovery: { entrypoints, hazards, connectionGraphs: graphs, coverConnectionContracts: contracts }, fingerprints,
  };
}

test('complete finite graph coverage is native-proof-pending but default validation still rejects', () => {
  const fixture = scopedConnectionGraphFixture();
  assert.deepEqual(scopedCoverProofErrors(fixture.registry), []);
  assert.deepEqual(scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints).map(state => state.state), ['native-proof-pending', 'native-proof-pending']);
  assert.equal(validateInventory(fixture.registry, fixture.discovery, { fingerprints: fixture.fingerprints }).filter(error => /rejected BI-05/.test(error)).length, 6);
  assert.deepEqual(validateInventory(fixture.registry, fixture.discovery, { fingerprints: fixture.fingerprints, nativeProofPreflight: true }), []);
  assert.equal(fixture.discovery.hazards.length, 6);
  assert.ok(fixture.discovery.hazards.every(hazard => hazard.reject));
});

test('finite graph proof binds the exact worker composition source', () => {
  const fixture = scopedConnectionGraphFixture();
  for (const graph of fixture.discovery.connectionGraphs) {
    graph.sources.push({ path: 'scripts/run_jobs_worker.py', astFingerprint: 'e'.repeat(64) });
    graph.sources.sort((left, right) => left.path.localeCompare(right.path));
    graph.fingerprint = graphDigest({ ...graph, fingerprint: undefined });
    fixture.registry.scopedCoverProofs.find(record => record.entrypoint === graph.entrypoint)
      .coverage.graphFingerprint = graph.fingerprint;
  }
  assert.deepEqual(scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints)
    .map(state => state.state), ['native-proof-pending', 'native-proof-pending']);
  fixture.discovery.connectionGraphs[0].sources.find(source => source.path === 'scripts/run_jobs_worker.py')
    .astFingerprint = 'f'.repeat(64);
  assert.equal(scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints)[0].state, 'rejected');
});

test('finite graph proof rejects an unrelated script even with updated coverage', () => {
  const fixture = scopedConnectionGraphFixture();
  const graph = fixture.discovery.connectionGraphs[0];
  graph.sources.push({ path: 'scripts/unreviewed_worker.py', astFingerprint: 'e'.repeat(64) });
  graph.sources.sort((left, right) => left.path.localeCompare(right.path));
  graph.fingerprint = graphDigest({ ...graph, fingerprint: undefined });
  fixture.registry.scopedCoverProofs[0].coverage.graphFingerprint = graph.fingerprint;
  assert.equal(scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints)[0].state, 'rejected');
});

test('finite graph proof uses graph identity rather than diagnostic via paths or line numbers', () => {
  const fixture = scopedConnectionGraphFixture();
  fixture.discovery.hazards[0].via = ['different', 'diagnostic', 'path'];
  fixture.discovery.hazards[0].line = 900;
  fixture.discovery.hazards[0].operation = fixture.discovery.hazards[0].operation.replace(/:19$/, ':900');
  assert.deepEqual(scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints).map(state => state.state), ['native-proof-pending', 'native-proof-pending']);
});

for (const [name, mutate] of [
  ['old witness schema', record => { record.schemaVersion = 1; record.witnesses = []; delete record.coverage; }],
  ['unknown record field', record => { record.enabled = true; }],
  ['wrong trusted context', record => { record.families[0].context.databaseScope = 'any-database'; }],
  ['invalid analyzer fingerprint', record => { record.analyzerFingerprint = 'not-a-sha'; }],
  ['invalid contract fingerprint', record => { record.contractFingerprint = 'not-a-sha'; }],
  ['duplicate covered node', record => { record.coverage.nodeIds.push(record.coverage.nodeIds[0]); }],
  ['duplicate covered edge', record => { record.coverage.edgeIds.push(record.coverage.edgeIds[0]); }],
  ['duplicate covered sink', record => { record.coverage.sinkIds.push(record.coverage.sinkIds[0]); }],
]) {
  test(`finite graph proof schema rejects ${name}`, () => {
    const fixture = scopedConnectionGraphFixture();
    mutate(fixture.registry.scopedCoverProofs[0]);
    assert.notDeepEqual(scopedCoverProofErrors(fixture.registry), []);
  });
}

for (const [name, mutate] of [
  ['missing covered node', fixture => { fixture.registry.scopedCoverProofs[0].coverage.nodeIds.pop(); }],
  ['missing covered edge', fixture => { fixture.registry.scopedCoverProofs[0].coverage.edgeIds.pop(); }],
  ['missing covered sink', fixture => { fixture.registry.scopedCoverProofs[0].coverage.sinkIds.pop(); }],
  ['wrong root', fixture => { fixture.registry.scopedCoverProofs[0].coverage.root = fixture.discovery.connectionGraphs[0].nodes.find(node => node.id !== fixture.discovery.connectionGraphs[0].root).id; }],
  ['changed analyzer', fixture => { fixture.fingerprints.analyzerFingerprint = 'c'.repeat(64); }],
  ['changed contract', fixture => { fixture.fingerprints.contractFingerprint = 'c'.repeat(64); }],
  ['changed trusted context', fixture => { fixture.registry.scopedCoverProofs[0].families[0].context.workerContext = 'unreviewed-context'; }],
  ['forged graph fingerprint', fixture => { fixture.discovery.connectionGraphs[0].sources[0].astFingerprint = 'c'.repeat(64); }],
  ['uncovered new edge', fixture => {
    const graph = fixture.discovery.connectionGraphs[0];
    const edge = { from: graph.root, to: graph.sinks[0].node, site: { owner: graph.nodes.find(node => node.id === graph.root).owner, astPath: ['body', 1, 'value'] } };
    graph.edges.push({ id: graphDigest(edge), ...edge });
    graph.edges.sort((left, right) => left.id.localeCompare(right.id));
    graph.fingerprint = graphDigest({ ...graph, fingerprint: undefined });
  }],
  ['unrepresented raw rejecting sink', fixture => { fixture.discovery.hazards.push({ ...fixture.discovery.hazards[0], sinkId: 'c'.repeat(64), via: ['unreviewed'] }); }],
  ['fully covered unsafe connector branch', fixture => {
    const graph = fixture.discovery.connectionGraphs[0], record = fixture.registry.scopedCoverProofs[0];
    const owner = 'py:music_app/services/unreviewed.py#connect';
    const state = { owner, loop: graph.sinks[0].loop, scan: null, bound: null };
    const node = { id: graphDigest(state), ...state };
    const edgeState = { from: graph.root, to: node.id, site: { owner: graph.nodes.find(item => item.id === graph.root).owner, astPath: ['body', 1, 'value'] } };
    const sinkState = { node: node.id, operation: 'database-connect-per-item:psycopg.connect', site: { owner, astPath: ['body', 0, 'value'] }, loop: graph.sinks[0].loop };
    const sink = { id: graphDigest(sinkState), ...sinkState };
    graph.nodes.push(node);
    graph.edges.push({ id: graphDigest(edgeState), ...edgeState });
    graph.sinks.push(sink);
    for (const field of ['nodes', 'edges', 'sinks']) graph[field].sort((left, right) => left.id.localeCompare(right.id));
    graph.sources.push({ path: 'music_app/services/unreviewed.py', astFingerprint: graphDigest(owner) });
    graph.sources.sort((left, right) => left.path.localeCompare(right.path));
    graph.fingerprint = graphDigest({ ...graph, fingerprint: undefined });
    record.coverage = { graphFingerprint: graph.fingerprint, root: graph.root,
      nodeIds: graph.nodes.map(item => item.id), edgeIds: graph.edges.map(item => item.id), sinkIds: graph.sinks.map(item => item.id) };
    fixture.discovery.hazards.push({ ...fixture.discovery.hazards[0], operation: 'database-connect-per-item:psycopg.connect@music_app/services/unreviewed.py:23', sinkId: sink.id });
  }],
]) {
  test(`finite graph proof disposition rejects ${name}`, () => {
    const fixture = scopedConnectionGraphFixture();
    mutate(fixture);
    const [state] = scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints);
    assert.equal(state.state, 'rejected');
    assert.match(validateInventory(fixture.registry, fixture.discovery, { fingerprints: fixture.fingerprints, nativeProofPreflight: true }).join('\n'), /rejected BI-05/);
  });
}

test('three-family proof accepts only all exact source-bound families as pending', () => {
  const fixture = scopedConnectionGraphFixture();
  const record = fixture.registry.scopedCoverProofs[0], graph = fixture.discovery.connectionGraphs[0];
  assert.deepEqual(coverFamilyProofErrors(record, graph, fixture.discovery.hazards.filter(hazard => hazard.graphId === graph.id), fixture.discovery.coverConnectionContracts), []);
  assert.deepEqual(record.families.map(family => family.id), [
    'cover-mutation-shared-transaction', 'shared-adapter-lazy-initializer', 'cover-advisory-lock-pool-initializer',
  ]);
  assert.deepEqual(scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints).map(state => state.state), ['native-proof-pending', 'native-proof-pending']);
  assert.equal(validateInventory(fixture.registry, fixture.discovery, { fingerprints: fixture.fingerprints }).filter(error => /rejected BI-05/.test(error)).length, 6);
});

for (const [name, mutate] of [
  ['missing family', record => record.families.pop()],
  ['duplicate family', record => { record.families[1] = structuredClone(record.families[0]); }],
  ['unknown family', record => { record.families[0].id = 'any-repository'; }],
  ['wildcard operation', record => { record.families[0].operation = 'database-connect-per-item:*'; }],
  ['overlapping sink families', record => { record.families[1].sinkIds.push(record.families[0].sinkIds[0]); }],
  ['wrong mutation DSN', record => { record.families[0].context.databaseScope = 'another-database'; }],
  ['lost mutation worker context', record => { record.families[0].context.workerContext = 'thread-default'; }],
  ['unknown lazy binding', record => { record.families[1].context.binding = 'inferred-any-callable'; }],
  ['per-item lazy lifetime', record => { record.families[1].context.lifetime = 'per-album'; }],
  ['unguarded lazy initializer', record => { record.families[1].context.initializer = 'always'; }],
  ['changed pool cache key', record => { record.families[2].context.cacheKey = ['database_url', 'cover-lock']; }],
  ['changed pool lifetime', record => { record.families[2].context.lifetime = 'per-item'; }],
  ['unbounded pool channels', record => { record.families[2].context.channels = 'unlimited'; }],
  ['unknown family context field', record => { record.families[2].context.allowAnyOwner = true; }],
]) {
  test(`three-family proof rejects ${name}`, () => {
    const fixture = scopedConnectionGraphFixture();
    mutate(fixture.registry.scopedCoverProofs[0]);
    assert.notDeepEqual(scopedCoverProofErrors(fixture.registry), []);
    assert.match(validateInventory(fixture.registry, fixture.discovery, { fingerprints: fixture.fingerprints, nativeProofPreflight: true }).join('\n'), /rejected BI-05/);
  });
}

for (const [name, mutate] of [
  ['missing source guard contract', fixture => fixture.discovery.coverConnectionContracts.pop()],
  ['stale family contract fingerprint', fixture => { fixture.registry.scopedCoverProofs[0].families[1].contractFingerprint = 'c'.repeat(64); }],
  ['mismatched contract source', fixture => { fixture.discovery.coverConnectionContracts[1].sources[0].astFingerprint = 'c'.repeat(64); }],
  ['rejected actual guard despite refreshed contract hash', fixture => {
    const contract = fixture.discovery.coverConnectionContracts[1];
    contract.status = 'rejected';
    contract.fingerprint = graphDigest({ ...contract, fingerprint: undefined });
    fixture.registry.scopedCoverProofs[0].families[1].contractFingerprint = contract.fingerprint;
  }],
  ['missing guard anchor despite refreshed contract hash', fixture => {
    const contract = fixture.discovery.coverConnectionContracts[2];
    contract.anchors = contract.anchors.filter(anchor => anchor.role !== 'cache-guard');
    contract.fingerprint = graphDigest({ ...contract, fingerprint: undefined });
    fixture.registry.scopedCoverProofs[0].families[2].contractFingerprint = contract.fingerprint;
  }],
  ['lazy initializer bypass despite complete refreshed graph coverage', fixture => {
    const graph = fixture.discovery.connectionGraphs[0], record = fixture.registry.scopedCoverProofs[0];
    const [family] = record.families.filter(family => family.id === 'shared-adapter-lazy-initializer');
    const sink = graph.sinks.find(sink => sink.id === family.sinkIds[0]);
    const edge = { from: graph.root, to: sink.node, site: { owner: graph.nodes.find(node => node.id === graph.root).owner, astPath: ['body', 99] } };
    graph.edges.push({ id: graphDigest(edge), ...edge });
    graph.edges.sort((left, right) => left.id.localeCompare(right.id));
    graph.fingerprint = graphDigest({ ...graph, fingerprint: undefined });
    record.coverage.graphFingerprint = graph.fingerprint;
    record.coverage.edgeIds = graph.edges.map(edge => edge.id);
  }],
  ['different pool initializer site despite complete refreshed coverage', fixture => {
    const graph = fixture.discovery.connectionGraphs[0], record = fixture.registry.scopedCoverProofs[0];
    const family = record.families.find(family => family.id === 'cover-advisory-lock-pool-initializer');
    const sink = graph.sinks.find(sink => sink.id === family.sinkIds[0]);
    const oldId = sink.id;
    sink.site = { ...sink.site, astPath: ['body', 99] };
    sink.id = graphDigest({ ...sink, id: undefined });
    graph.sinks.sort((left, right) => left.id.localeCompare(right.id));
    family.sinkIds = [sink.id];
    fixture.discovery.hazards.find(hazard => hazard.graphId === graph.id && hazard.sinkId === oldId).sinkId = sink.id;
    graph.fingerprint = graphDigest({ ...graph, fingerprint: undefined });
    record.coverage.graphFingerprint = graph.fingerprint;
    record.coverage.sinkIds = graph.sinks.map(sink => sink.id);
  }],
]) {
  test(`three-family proof rejects ${name}`, () => {
    const fixture = scopedConnectionGraphFixture();
    mutate(fixture);
    const [state] = scopedCoverStatus(fixture.registry, fixture.discovery, fixture.fingerprints);
    assert.equal(state.state, 'rejected');
  });
}
