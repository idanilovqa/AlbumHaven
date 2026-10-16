'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders, projectOwnerPublication, projectPublicationReceipt, isPublicationRevision;
test.before(async () => {
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({projectOwnerPublication, projectPublicationReceipt, isPublicationRevision} = await F.load('album-tops/publication.mjs'));
});
const CONTEXT = 'a'.repeat(64), SHARE = F.id(41), PUBLICATION = F.id(51), KEY = F.id(61);
const PATH = '/public/album-tops/' + SHARE, URL = 'https://public.example.test' + PATH;
const options = patch => ({scopeKey: F.SCOPE, signal: new AbortController().signal, ...patch});
const items = () => [{item_ref: F.IA, album_ref: F.A, selected_local_album_id: 11, selected_source_ref: F.SOURCE}];
const receiptPublication = (state = 'enabled', patch = {}) => ({state,
  share_ref: state === 'unpublished' ? null : SHARE, link_revision: state === 'unpublished' ? null : '4',
  publication_ref: state === 'enabled' ? PUBLICATION : null, publication_revision: state === 'enabled' ? '2' : null, ...patch});
const owner = (state = 'enabled', patch = {}) => ({...receiptPublication(state),
  public_path: state === 'enabled' ? PATH : null, public_url: state === 'enabled' ? URL : null,
  deployment_available: true, can_enable_external: true, can_revoke_external: state === 'enabled', ...patch});
const sharing = patch => ({top_ref: F.TOP, revision: '7', visibility: 'private', can_manage: true,
  can_request_edit: false, can_copy: true, request_status: 'none', pending_requests: [], next_pending_cursor: null, ...patch});
const command = (action = 'enable_external', patch = {}) => ({top_ref: F.TOP, request_key: KEY, revision: '7',
  ...(action === 'enable_external' ? {items: items(), evidence_revision: 'b'.repeat(64)} : {}), ...patch});
const receipt = (action = 'enable_external', patch = {}) => ({top_ref: F.TOP, request_key: KEY, revision: '8', action,
  ...(action === 'enable_external' || action === 'revoke_external' ? {publication: receiptPublication(action === 'enable_external' ? 'enabled' : 'revoked')} : {}), ...patch});
const source = patch => ({selected_local_album_id: 11, selected_source_ref: F.SOURCE,
  title: 'Album', artist: 'Artist', year: 2001, ...patch});
const sourcePage = patch => ({top_ref: F.TOP, revision: '7', item_ref: F.IA, album_ref: F.A,
  sources: [source()], next_cursor: null, ...patch});
const sourceOptions = patch => options({revision: '7', albumRef: F.A, ...patch});
function fixture(t, reply) {
  let context = CONTEXT, allowed = true; const calls = [];
  const transport = {context: () => context, async request(path, request) {
    calls.push({path, request});
    const data = typeof reply === 'function' ? await reply(path, request) : reply;
    return {status: 'ready', context_ref: CONTEXT, data};
  }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: scope => allowed && scope === F.SCOPE});
  t.after(() => providers.dispose());
  return {providers, calls, context(value) {context = value;}, deny() {allowed = false;}};
}

for (const state of ['unpublished', 'enabled', 'revoked']) test(`sharing retains detached ${state} owner publication facts only`, async t => {
  const publication = owner(state), data = sharing({publication: {...publication, private_path: '/private', receipt_authority: true}});
  const {providers, calls} = fixture(t, data), opts = options();
  const result = await providers.readSharing(F.TOP, opts);
  assert.deepEqual(result, sharing({publication}));
  assert.notEqual(result.publication, data.publication);
  assert.equal(calls[0].path, '/album-tops/' + F.TOP + '/sharing');
  assert.equal(calls[0].request.expected, CONTEXT); assert.equal(calls[0].request.signal, opts.signal);
  data.publication.state = 'revoked'; assert.equal(result.publication.state, state);
});

test('editor/viewer sharing absence remains absent rather than synthesizing unpublished ownership', async t => {
  for (const can_manage of [true, false]) {
    const {providers} = fixture(t, sharing({can_manage}));
    const result = await providers.readSharing(F.TOP, options());
    assert.equal(Object.hasOwn(result, 'publication'), false);
  }
});

test('saved URL may use a different public origin and a canonical nondefault HTTPS port', async t => {
  const publication = owner('enabled', {public_url: 'https://guest.example.test:8443' + PATH});
  const {providers} = fixture(t, sharing({can_manage: false, publication}));
  assert.deepEqual((await providers.readSharing(F.TOP, options())).publication, publication);
});

test('disabled hosting preserves enabled link identity and independent revoke permission without URL', async t => {
  const publication = owner('enabled', {deployment_available: false, public_url: null, can_enable_external: false});
  const {providers} = fixture(t, sharing({can_manage: false, publication}));
  assert.deepEqual((await providers.readSharing(F.TOP, options())).publication, publication);
});

const invalidOwnerChanges = [
  ['null', () => null], ['array', () => []], ['empty', () => ({})],
  ['unknown state', value => ({...value, state: 'pending'})],
  ['uppercase UUID', value => ({...value, share_ref: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'})],
  ['missing share', value => ({...value, share_ref: null})],
  ['numeric revision', value => ({...value, link_revision: 4})],
  ['zero revision', value => ({...value, publication_revision: '0'})],
  ['leading-zero revision', value => ({...value, link_revision: '04'})],
  ['overflow revision', value => ({...value, publication_revision: '9223372036854775808'})],
  ['missing publication identity', value => ({...value, publication_ref: null})],
  ['enabled revoke false', value => ({...value, can_revoke_external: false})],
  ['untyped deployment', value => ({...value, deployment_available: 1})],
  ['untyped enable', value => ({...value, can_enable_external: 'true'})],
  ['untyped revoke', value => ({...value, can_revoke_external: null})],
  ['unavailable enable', value => ({...value, deployment_available: false, public_url: null})],
  ['unavailable URL', value => ({...value, deployment_available: false, can_enable_external: false})],
  ['available missing URL', value => ({...value, public_url: null})],
  ['wrong saved path', value => ({...value, public_path: '/public/album-tops/' + F.OTHER})],
  ['unpublished retained share', () => owner('unpublished', {share_ref: SHARE})],
  ['unpublished retained revision', () => owner('unpublished', {link_revision: '1'})],
  ['unpublished retained publication', () => owner('unpublished', {publication_ref: PUBLICATION})],
  ['unpublished retained path', () => owner('unpublished', {public_path: PATH})],
  ['unpublished retained URL', () => owner('unpublished', {public_url: URL})],
  ['unpublished revoke', () => owner('unpublished', {can_revoke_external: true})],
  ['revoked missing share', () => owner('revoked', {share_ref: null})],
  ['revoked retained publication', () => owner('revoked', {publication_ref: PUBLICATION})],
  ['revoked retained publication revision', () => owner('revoked', {publication_revision: '1'})],
  ['revoked retained path', () => owner('revoked', {public_path: PATH})],
  ['revoked revoke', () => owner('revoked', {can_revoke_external: true})],
];
for (const [label, change] of invalidOwnerChanges) test(`invalid publication ${label} cannot carry owner authority`, async t => {
  const publication = change(owner()), {providers} = fixture(t, sharing({publication}));
  assert.throws(() => projectOwnerPublication(publication));
  await assert.rejects(providers.readSharing(F.TOP, options()));
});

for (const key of Object.keys(owner())) test(`missing owner publication ${key} fails closed`, async t => {
  const publication = owner(); delete publication[key];
  const {providers} = fixture(t, sharing({publication})); await assert.rejects(providers.readSharing(F.TOP, options()));
});

for (const url of ['javascript:alert(1)', 'data:text/plain,x', 'http://public.example.test' + PATH,
  'https://user:secret@public.example.test' + PATH, 'https://@public.example.test' + PATH,
  'https://public.example.test' + PATH + '?', 'https://public.example.test' + PATH + '#', URL + '?x=1', URL + '#anchor',
  URL + '/', 'https://public.example.test/other/' + SHARE, 'https://public.example.test/public/album-tops/' + F.OTHER,
  'https://public.example.test:443' + PATH, 'https://PUBLIC.example.test' + PATH, ' ' + URL, URL + '\n',
  'https://public.example.test/public/album-tops/%30' + SHARE.slice(1)]) {
  test('unsafe, noncanonical, or mismatched saved URL fails closed: ' + JSON.stringify(url), async t => {
    const {providers} = fixture(t, sharing({publication: owner('enabled', {public_url: url})}));
    await assert.rejects(providers.readSharing(F.TOP, options()));
  });
}

test('publication bigint revisions have strict PostgreSQL positive bounds', () => {
  for (const value of ['1', '9223372036854775807']) assert.equal(isPublicationRevision(value), true);
  for (const value of [null, 1, '0', '-1', '01', '1.0', '1e2', ' 1', '9223372036854775808', '9999999999999999999']) assert.equal(isPublicationRevision(value), false);
  assert.deepEqual(projectPublicationReceipt(receiptPublication('enabled', {link_revision: '9223372036854775807'})),
    receiptPublication('enabled', {link_revision: '9223372036854775807'}));
});

for (const action of ['enable_external', 'revoke_external']) test(`${action} uses existing transport and retains receipt identity without URL authority`, async t => {
  const reply = receipt(action); reply.publication = {...reply.publication, public_url: URL, can_revoke_external: true, private_path: '/private'};
  const {providers, calls} = fixture(t, reply), sent = command(action), opts = options();
  assert.deepEqual(await providers.execute(action, sent, opts), receipt(action));
  assert.equal(calls[0].path, '/album-tops/' + F.TOP + '/' + action);
  assert.equal(calls[0].request.expected, CONTEXT); assert.equal(calls[0].request.signal, opts.signal);
  assert.equal(calls[0].request.method, 'POST');
  const {top_ref, ...body} = sent; assert.deepEqual(calls[0].request.body, body);
});

test('save retains its optional publication receipt but never creates owner projection authority', async t => {
  for (const present of [true, false]) {
    const data = receipt('save', present ? {publication: {...receiptPublication(), public_url: URL, can_enable_external: true}} : {});
    const {providers} = fixture(t, data), result = await providers.execute('save', command('save'), options());
    assert.deepEqual(result, receipt('save', present ? {publication: receiptPublication()} : {}));
    if (present) assert.throws(() => projectOwnerPublication(result.publication));
  }
});

for (const action of ['enable_external', 'revoke_external']) for (const [label, patch] of [
  ['missing publication', {publication: undefined}], ['null publication', {publication: null}],
  ['wrong state', {publication: receiptPublication(action === 'enable_external' ? 'revoked' : 'enabled')}],
  ['wrong request', {request_key: F.id(62)}], ['wrong top', {top_ref: F.OTHER}], ['wrong action', {action: 'save'}],
  ['wrong revision', {revision: '9'}], ['overflow revision', {revision: '9223372036854775808'}],
]) test(`${action} rejects ${label} acknowledgment`, async t => {
  const data = receipt(action, patch); if (patch.publication === undefined && Object.hasOwn(patch, 'publication')) delete data.publication;
  const {providers} = fixture(t, data); await assert.rejects(providers.execute(action, command(action), options()), {status: 502});
});

for (const publication of [null, [], receiptPublication('enabled', {publication_revision: null}), receiptPublication('revoked', {publication_ref: PUBLICATION})]) {
  test('malformed optional save publication cannot be silently discarded', async t => {
    const {providers} = fixture(t, receipt('save', {publication})); await assert.rejects(providers.execute('save', command('save'), options()), {status: 502});
  });
}

for (const [label, patch] of [['missing source', {items: [{item_ref: F.IA, album_ref: F.A}]}],
  ['new membership', {items: [{...items()[0], item_ref: null}]}], ['missing items', {items: undefined}],
  ['half source', {items: [{item_ref: F.IA, album_ref: F.A, selected_source_ref: F.SOURCE}]}],
  ['bad evidence', {evidence_revision: 'bad'}], ['numeric revision', {revision: 7}],
  ['overflow revision', {revision: '9223372036854775808'}], ['implicit title edit', {title: 'Unexpected'}],
  ['implicit description edit', {description: 'Unexpected'}]]) test(`publication command rejects ${label} before transport`, async t => {
  const {providers, calls} = fixture(t, receipt()); await assert.rejects(providers.execute('enable_external', command('enable_external', patch), options()));
  assert.equal(calls.length, 0);
});

test('revoke rejects unrelated edits and empty saved Top publish stays valid', async t => {
  const {providers, calls} = fixture(t, receipt());
  await assert.rejects(providers.execute('revoke_external', command('revoke_external', {items: []}), options())); assert.equal(calls.length, 0);
  assert.deepEqual(await providers.execute('enable_external', command('enable_external', {items: []}), options()), receipt());
});

test('source choices bind exact saved item/revision/catalog and preserve distinct equal-label physical copies', async t => {
  const rows = [source(), source({selected_source_ref: F.id(32)}), source({selected_local_album_id: 12, selected_source_ref: F.id(33)})];
  const {providers, calls} = fixture(t, sourcePage({sources: rows.map(row => ({...row, root_path: '/private', container: 'Hidden'})), next_cursor: 'next'}));
  const opts = sourceOptions({cursor: 'previous', limit: 3});
  assert.deepEqual(await providers.readPublicationSources(F.TOP, F.IA, opts), sourcePage({sources: rows, next_cursor: 'next'}));
  const parsed = new globalThis.URL(calls[0].path, 'https://private.example.test');
  assert.equal(parsed.pathname, '/album-tops/' + F.TOP + '/items/' + F.IA + '/publication-sources');
  assert.deepEqual(Object.fromEntries(parsed.searchParams), {revision: '7', limit: '3', cursor: 'previous'});
  assert.equal(calls[0].request.expected, CONTEXT); assert.equal(calls[0].request.signal, opts.signal);
  assert.equal(Object.hasOwn(calls[0].request, 'body'), false);
});

test('empty filtered source page may retain a cursor without inventing a candidate', async t => {
  const data = sourcePage({sources: [], next_cursor: 'next'}), {providers, calls} = fixture(t, data);
  assert.deepEqual(await providers.readPublicationSources(F.TOP, F.IA, sourceOptions()), data);
  assert.equal(new globalThis.URL(calls[0].path, 'https://private.example.test').searchParams.get('limit'), '100');
});

for (const [label, patch] of [['wrong top', {top_ref: F.OTHER}], ['wrong item', {item_ref: F.IB}],
  ['wrong album', {album_ref: F.B}], ['wrong revision', {revision: '8'}], ['numeric revision', {revision: 7}],
  ['missing rows', {sources: null}], ['missing cursor', {next_cursor: undefined}], ['empty cursor', {next_cursor: ''}],
  ['long cursor', {next_cursor: 'x'.repeat(4097)}], ['repeated cursor', {next_cursor: 'previous'}],
  ['duplicate tuple', {sources: [source(), source()]}],
  ['duplicate source', {sources: [source(), source({selected_local_album_id: 12})]}],
  ['out of order', {sources: [source({selected_local_album_id: 12, selected_source_ref: F.id(32)}), source()]}],
  ['over page bound', {sources: [source(), source({selected_source_ref: F.id(32)}), source({selected_source_ref: F.id(33)})]}]]) {
  test(`source page rejects ${label}`, async t => {
    const {providers} = fixture(t, sourcePage(patch));
    await assert.rejects(providers.readPublicationSources(F.TOP, F.IA, sourceOptions({limit: 2, cursor: 'previous'})));
  });
}

for (const patch of [{selected_local_album_id: 0}, {selected_local_album_id: '11'}, {selected_local_album_id: Number.MAX_SAFE_INTEGER + 1},
  {selected_source_ref: 'invalid'}, {title: ''}, {title: '  '}, {title: 'x'.repeat(1001)}, {title: '\ud800'},
  {artist: null}, {artist: 'Hidden\npath'}, {year: 0}, {year: 10000}, {year: '2001'}]) {
  test('source rows require exact source identities and positive metadata labels: ' + JSON.stringify(patch), async t => {
    const {providers} = fixture(t, sourcePage({sources: [source(patch)]})); await assert.rejects(providers.readPublicationSources(F.TOP, F.IA, sourceOptions()));
  });
}

for (const patch of [{revision: 7}, {revision: '0'}, {revision: '9223372036854775808'}, {albumRef: F.TOP + 'x'},
  {albumRef: undefined}, {limit: null}, {limit: 0}, {limit: 101}, {limit: '50'}, {limit: 1.5}, {cursor: ''}, {cursor: 'x'.repeat(4097)}]) {
  test('invalid source query fails before transport: ' + JSON.stringify(patch), async t => {
    const {providers, calls} = fixture(t, sourcePage());
    await assert.rejects(providers.readPublicationSources(F.TOP, F.IA, sourceOptions(patch))); assert.equal(calls.length, 0);
  });
}

test('source query identity cannot change while its response is pending', async t => {
  const gate = F.deferred(), {providers} = fixture(t, () => gate.promise), opts = sourceOptions();
  const waiting = providers.readPublicationSources(F.TOP, F.IA, opts);
  opts.revision = '8'; opts.albumRef = F.B;
  gate.resolve(sourcePage({revision: '8', album_ref: F.B})); await assert.rejects(waiting);
});

for (const operation of ['sharing', 'sources', 'preview', 'enable', 'revoke']) for (const change of ['scope', 'context', 'dispose', 'abort']) {
  test(`late ${operation} response is retired by ${change}`, async t => {
    const gate = F.deferred(), env = fixture(t, () => gate.promise), controller = new AbortController();
    const opts = options({signal: controller.signal});
    const waiting = operation === 'sharing' ? env.providers.readSharing(F.TOP, opts)
      : operation === 'sources' ? env.providers.readPublicationSources(F.TOP, F.IA, {...opts, revision: '7', albumRef: F.A})
      : operation === 'preview' ? env.providers.preview(F.TOP, {revision: '7', items: items()}, opts)
      : env.providers.execute(operation === 'enable' ? 'enable_external' : 'revoke_external', command(operation === 'enable' ? 'enable_external' : 'revoke_external'), opts);
    if (change === 'scope') env.deny(); else if (change === 'context') env.context('c'.repeat(64));
    else if (change === 'dispose') env.providers.dispose(); else controller.abort();
    gate.resolve({}); await assert.rejects(waiting, {name: 'AbortError'}); assert.equal(env.calls.length, 1);
  });
}

test('preview and publication still share the existing command byte bound', async t => {
  const many = Array.from({length: 5000}, (_, index) => ({item_ref: F.id(index + 1000), album_ref: F.id(index + 10000),
    selected_local_album_id: index + 1, selected_source_ref: F.id(index + 20000)}));
  const {providers, calls} = fixture(t, {});
  await assert.rejects(providers.preview(F.TOP, {revision: '7', items: many}, options()), {status: 413, code: 'command_too_large'});
  await assert.rejects(providers.execute('enable_external', command('enable_external', {items: many}), options()), {status: 413, code: 'command_too_large'});
  assert.equal(calls.length, 0);
});
