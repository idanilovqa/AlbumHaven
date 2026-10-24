'use strict';
// Synthetic wire DTOs and DOM selection only. Full genuine product modules,
// transport validation, controller continuation and CompactDataTable execute.
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const I = require('./foobar-account-import-native-fixture.cjs');
const P = require('./foobar-account-personal-conflicts-fixture.cjs');
const D = require('./foobar-account-diagnostic-pages-fixture.cjs');
const E = require('./foobar-enhanced-v4-fixture.cjs');
const FIELDS = ['play_count','play_count_enhanced','first_played','last_played','first_played_enhanced','last_played_enhanced'];
const OLDER = 'e'.repeat(64);
const field = (name, row = 1, patch = {}) => ({field: name, state: 'valid', count: name.startsWith('play_count') ? (name === 'play_count' ? '2' : '9') : null,
  code: null, origin: ['b'.repeat(64), row, [11,12,13,14,16,17][FIELDS.indexOf(name)]], raw_prefix: name.startsWith('play_count') ? (name === 'play_count' ? '2' : '9') : '2026-10-',
  raw_characters: name.startsWith('play_count') ? 1 : 10, ...patch});
const rawField = (name, row, raw, patch = {}) => field(name, row, {raw_prefix: raw === null ? null : Array.from(raw).slice(0,8).join(''), raw_characters: raw === null ? 0 : Array.from(raw).length, ...patch});
const row = (n = 1, patch = {}) => ({row: n, source_artist: 'Source artist', source_title: 'Source song ' + n, source_album: 'Source album',
  incoming: FIELDS.map(name => field(name, n)), effective: FIELDS.map(name => field(name, n)), ...patch});
const page = ({total = 4, after = 0, rows = null, chunk = null} = {}) => {
  const items = rows || Array.from({length: Math.min(20, total - after)}, (_, n) => row(after + n + 1));
  const remaining = total - after - items.length;
  return {items, after, next: remaining ? items.at(-1).row : null, remaining, raw_chunk: chunk,
    date_state_is_raw_parser_evidence: true, families_are_not_added: true};
};
const chunk = (raw, {ordinal = 1, side = 'incoming', field: name = 'play_count', offset = 0} = {}) => {
  const chars = Array.from(raw), text = chars.slice(offset, offset + 512).join('');
  return {ordinal, side, field: name, offset, total_characters: chars.length, text, next_offset: offset + Array.from(text).length < chars.length ? offset + Array.from(text).length : null};
};
const base = ({total = 4, start = 0, matching = null, ...patch} = {}) => F.proposal({command: F.command({total_rows: total, original_matching_library_id: matching}),
  checked_rows: total - start, start_offset: start, proposed_counts: [total-start,0,0,0,0,0,0], review_counts: [total-start,0,0,0,0,0],
  problems: [], problem_items: [], problem_count: 0, ...patch});
const proposal = (view = page(), patch = {}) => base({total: view.after + view.items.length + view.remaining, observations: view, ...patch});
const fieldAt = (view, side = 'incoming', name = 'play_count', index = 0) => view.items[index][side].find(item => item.field === name);
const header = call => JSON.parse(call.init.headers['X-AlbumHaven-Foobar-Command']);
const starts = f => f.wire.calls.filter(call => call.route === '/review/start');
const enqueue = (f, value) => f.wire.enqueue('/review/start', F.accepted(F.REVIEW,'start')).enqueue('/review/status', F.review({review:value}));
async function ready(t, {value = base(), selected = F.file(), library = '', matching = false} = {}) {
  const f = await F.controller(t, F.wire(), {library}); f.wire.enqueue('/ui/source',F.source()); await f.owner.initialize();
  f.owner.choose(selected); if(matching)f.owner.setMatching(true); enqueue(f,value); await f.owner.preview(); await f.time.tick();
  assert.equal(f.owner.getState().phase,'review_ready'); return {...f,selected};
}
async function inspect(f, value = proposal(), after = null, raw = null) {
  enqueue(f,value); await f.owner.inspectObservations(after,raw); await f.time.tick();
  assert.equal(f.owner.getState().phase,'review_ready'); return f.owner.getState().review;
}
function nodes(f) {
  const heading = f.host.querySelectorAll('h4').find(n => n.textContent === 'Count precedence and original observations'); assert.ok(heading);
  const section = heading.parentElement;
  const button = text => {const n=section.querySelectorAll('button').find(n=>n.textContent===text);assert.ok(n,text);return n;};
  const select = suffix => {const n=section.querySelectorAll('select').find(n=>n.id.endsWith(suffix));assert.ok(n,suffix);return n;};
  return {section,family:select('-count-family'),row:select('-observation-row'),side:select('-observation-side'),field:select('-observation-field'),
    open:button('Inspect original and effective observations'),next:button('Inspect next observation page'),back:button('Return to problem and conflict review'),
    rawStart:button('Inspect raw field from beginning'),rawNext:button('Inspect next raw characters'),raw:section.querySelector('pre'),status:section.querySelector('[role="status"]')};
}
const table = f => nodes(f).section.querySelector('[aria-label="Original and effective source observations"]');
const cells = (f,key) => {const t=table(f);assert.ok(t,'Actual shared table mounted');return t.querySelectorAll(`[data-cdt-column="${key}"]`).filter(n=>n.getAttribute('role')==='cell');};
async function native(t, {value = base(), selected = F.file(), library = '', matching = false} = {}) {
  const f=await I.native(t,F.wire(),{library,sibling:true});
  if(matching){f.field('matching').checked=true;f.change(f.field('matching'));await F.settle();}
  await I.reviewed(f,{selected,proposal:value});return {...f,selected};
}
async function nativeInspect(f,value=proposal(),button=nodes(f).open){enqueue(f,value);f.click(button);await F.settle();await f.time.tick();assert.ok(table(f));}
function selectRaw(f,{ordinal=1,side='incoming',field:name='play_count'}={}){const n=nodes(f);n.row.value=String(ordinal);n.side.value=side;n.field.value=name;f.change(n.field);return n;}
function confirm(f){f.field('confirmation').checked=true;f.change(f.field('confirmation'));assert.equal(f.action('confirm').disabled,false);}
module.exports={F,I,P,D,E,FIELDS,OLDER,field,rawField,row,page,chunk,base,proposal,fieldAt,header,starts,enqueue,ready,inspect,nodes,table,cells,native,nativeInspect,selectRaw,confirm};
