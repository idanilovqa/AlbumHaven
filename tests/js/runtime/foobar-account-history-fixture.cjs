'use strict';
// Synthetic wire data and platform only; every tested owner is actual product ESM.
const F = require('./foobar-account-import-fixture.cjs');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const load = name => import(pathToFileURL(path.join(F.ROOT, 'music_app/static/js/foobar-history', name)).href);
const VERSION = 'foobar_account_history_v1', MIN = '-9223372036854775808';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const label = text => ({state: 'valid', text, truncated: false});
const absent = () => ({state: 'absent', label: null, truncated: false, resolution: 'not_supplied', unix_microseconds: null, fraction_digits: null});
const boundary = (key = '10', text = '1970-01-01T00:00:00.000010Z') => ({state: 'valid', label: text, truncated: false, resolution: key === null ? 'unresolved' : 'resolved', unix_microseconds: key, fraction_digits: key === null ? null : 6});
function projection(patch = {}) {return {source_kind: 'foobar_local', family: 'standard', source_revision: '1', artist: label('Source artist'), title: label('Source title'), album: label('Source album'), count_state: 'valid', total: '2', status: 'ready', reason: null, first: absent(), last: absent(), timestamp_coverage: 'no_timestamps', first_marker_weight: 0, aggregate_remainder: '2', first_sort_key: null, remainder_sort_key: MIN, grouped_sort_key: MIN, show_grouped_count: true, show_remainder_count: true, ...patch};}
const row = (n = 99999, patch = {}, kind = 'grouped_aggregate') => ({observation_ref: id(n), kind, projection: projection(patch)});
const query = patch => ({source_ref: F.SOURCE, family: 'standard', mode: 'grouped', ...patch});
const source = (n = 1) => ({source_ref: id(n), created_at: '2026-10-23T00:00:00Z', is_default: n === 1, observation_count: '100000'});
const envelope = (operation, result) => F.envelope(VERSION, operation, result);
const sources = (items = [source()], next_cursor = null) => envelope('sources', {items, next_cursor});
const history = (items = [row()], patch = {}) => envelope('history', {...query(), source_revision: '1', items, next_cursor: null, ...patch});
function page(index = 0, {more = true, revision = '1', family = 'standard', mode = 'grouped'} = {}) {
  const items = Array.from({length: 20}, (_, n) => row(999999-index*20-n, {family}, mode === 'grouped' ? 'grouped_aggregate' : 'unknown_dates_bucket'));
  const last = items.at(-1);
  return history(items, {family, mode, source_revision: revision, next_cursor: more ? {context_ref: F.STAMP, ...query({family, mode}), source_revision: revision, sort_key: MIN, kind: last.kind, observation_ref: last.observation_ref} : null});
}
async function setup(t, transport = F.wire({initialList: false})) {
  const {createFoobarHistoryProvider} = await load('provider.mjs');
  const {createFoobarHistoryController} = await load('controller.mjs');
  const root = {isConnected: true, dataset: {accountFoobarContext: F.STAMP, accountFoobarScope: F.SCOPE}};
  let allowed = true, current = true;
  const provider = createFoobarHistoryProvider({fetch: transport.fetch, contextRoot: root, allows: action => allowed && action === 'account.self.foobar.read', isCurrent: () => current});
  const controller = createFoobarHistoryController({provider});
  t.after(() => {controller.dispose(); provider.dispose();});
  return {root, provider, controller, wire: transport, allow(value) {allowed = value;}, current(value) {current = value;}};
}
async function selected(f, initial = page()) {f.wire.enqueue('/history/sources', sources()); await f.controller.initialize(); f.wire.enqueue('/history/list', initial); f.controller.selectSource(F.SOURCE); await F.settle();}
module.exports = {...F, load, VERSION, MIN, id, label, absent, boundary, projection, row, query, source, sources, history, page, setup, selected};
