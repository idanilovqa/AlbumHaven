const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function setup() {
  const context = vm.createContext({Object, Map, Set});
  const file = path.resolve(__dirname, '../../../music_app/static/js/runtime/explicit-queue-planner.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const allowed = new Set(['x','y','a','b','c']);
  const planner = context.createExplicitQueuePlanner({canPlay: id => allowed.has(id)});
  const q = {session: 's', source: 'playlist', tracks: ['a','b','c'], albums: ['A','A','B'], index: 0, repeat: 'off', shuffle: false};
  return {planner, q, allowed};
}
const next = (q, index) => ({...q,index,ended:index >= q.tracks.length});
const ids = p => Array.from(p.getSnapshot().entries, e => e.id);
test('ordinary automatic order is never copied into explicit entries', () => {
  const {planner:p,q}=setup(); assert.deepEqual(ids(p), []); assert.equal(p.preview(q,next(q,1)).next.index,1);
});
test('duplicates retain occurrence identity and insertion blocks keep authored order', () => {
  const {planner:p,q}=setup(); const tail=p.enqueue(['y'],'end',q), first=p.enqueue(['x','x'],'next',q);
  assert.deepEqual(ids(p),[...first,...tail]); assert.notEqual(first[0],first[1]);
  assert.equal(p.getSnapshot().entries[0].blockId,p.getSnapshot().entries[1].blockId);
  assert.ok(Object.isFrozen(p.getSnapshot())); assert.ok(Object.isFrozen(p.getSnapshot().entries));
});
test('preview is inert, then explicit boundaries consume once and return exact ordinary successor', () => {
  const {planner:p,q}=setup(); const entries=p.enqueue(['x','y'],'next',q), after=next(q,1), snapshot=p.getSnapshot();
  const preview=p.preview(q,after); assert.equal(preview.next.entryId,entries[0]); assert.equal(p.getSnapshot(),snapshot);
  const first=p.advance(q,after); assert.equal(first.entryId,entries[0]);
  const second=p.advance(first,{...first,ended:true}); assert.equal(second.entryId,entries[1]);
  assert.equal(p.advance(second,{...second,ended:true}),after); assert.deepEqual(ids(p),[]);
});
test('deactivation preserves entries, finishes current and returns ordinary playback without auto-start', () => {
  const {planner:p,q}=setup(); const [a,b]=p.enqueue(['x','y'],'next',q), after=next(q,1), first=p.advance(q,after);
  p.setEnabled(false); assert.equal(p.getSnapshot().currentId,a); assert.equal(p.advance(first,{...first,ended:true}),after);
  assert.deepEqual(ids(p),[b]); p.setEnabled(true); assert.equal(p.getSnapshot().currentId,null);
});
test('album gate waits through repeat one, repeat all fires at captured pass boundary', () => {
  const {planner:p,q}=setup(); const [id]=p.enqueue(['x'],'album',q);
  assert.equal(p.advance({...q,repeat:'one'},{...q,repeat:'one'}).index,0);
  const middle=p.advance(q,next(q,1)); assert.equal(middle.index,1);
  assert.equal(p.advance(middle,next(q,2)).entryId,id);
});
test('shuffle and split album groups disable ambiguous album timing', () => {
  const {planner:p,q}=setup();
  for(const value of [{...q,shuffle:true},{...q,albums:['A','B','A']}]) {
    assert.equal(p.timingOptions(value).find(o=>o.value==='album').enabled,false);
    assert.deepEqual(Array.from(p.enqueue(['x'],'album',value)),[]);
  }
});
test('stop priority defeats explicit selection and saved ordinary return', () => {
  const {planner:p,q}=setup(); const [id]=p.enqueue(['x'],'next',q), stopped={...q,ended:true};
  assert.equal(p.advance(q,stopped,{stopPriority:true}),stopped); assert.equal(p.getSnapshot().halted,true);
  assert.equal(p.getSnapshot().entries[0].ready,true); p.setEnabled(true);
  const first=p.start(id,stopped); assert.equal(first.entryId,id);
  assert.equal(p.advance(first,{...first,ended:true},{stopPriority:true}).ended,true); assert.equal(p.getSnapshot().returnContext,null);
});
test('reorder retime and captured clear cannot remove current or newly queued entries', () => {
  const {planner:p,q}=setup(); const [a,b]=p.enqueue(['x','y'],'next',q);
  assert.equal(p.reorder([b,a]),true); assert.equal(p.reorder([b,b]),false);
  assert.equal(p.retime(a,'next',q),true); const current=p.advance(q,next(q,1));
  const [newId]=p.enqueue(['x'],'end',current); p.clear([a,b]); assert.deepEqual(ids(p),[a,newId]);
});
test('unavailable tracks cannot start or promote; context and order changes invalidate anchors', () => {
  const {planner:p,q,allowed}=setup(); const [id]=p.enqueue(['x'],'album',q); allowed.delete('x');
  assert.equal(p.canStart(id,null),false); p.reconcile({...q,tracks:['a','c','b']}); assert.ok(p.getSnapshot().entries[0].invalid);
  assert.equal(p.retime(id,'next',q),true); p.replaceContext({...q,session:'replacement'}); assert.ok(p.getSnapshot().entries[0].invalid);
});
test('Previous never consumes current explicit occurrence or satisfies a future boundary', () => {
  const {planner:p,q}=setup(); const [id]=p.enqueue(['x'],'next',q), prior={...q,index:0};
  assert.equal(p.advance(q,prior,{direction:-1}),prior); assert.equal(p.getSnapshot().entries[0].ready,false);
  const current=p.advance(q,next(q,1)); assert.equal(p.advance(current,null,{direction:-1}),current); assert.equal(p.getSnapshot().currentId,id);
});
