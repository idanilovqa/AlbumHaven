// Controlled DOM/observer component contract. Imports the real shared owner;
// observes its layout writes and lifetime rather than matching source spelling.
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');
const implementation = import(pathToFileURL(path.join(root, 'music_app/static/js/playtables/track-table-presentation.mjs')).href);

async function fixture() {
  const {bindTrackTablePresentation} = await implementation;
  const frames = new Map(), writes = [], properties = new Map();
  let observer, sequence = -1, current = true, closed = 0; // First valid RAF handle is zero.
  const events = new Map();
  const window = {
    ResizeObserver: class {constructor(callback) {observer = {callback, disconnected: false};} observe() {} disconnect() {observer.disconnected = true;}},
    MutationObserver: class {constructor(callback) {this.callback = callback;} observe() {} disconnect() {}},
    requestAnimationFrame(callback) {const id = ++sequence; frames.set(id, callback); return id;},
    cancelAnimationFrame(id) {frames.delete(id);},
    addEventListener(name, callback) {events.set(name, callback);},
    removeEventListener(name, callback) {if (events.get(name) === callback) events.delete(name);},
    clearTimeout() {}, setTimeout() {throw new Error('This fixture does not start gestures');},
  };
  const document = {defaultView: window, documentElement: {},
    addEventListener() {}, removeEventListener() {}};
  const table = {
    clientWidth: 390,
    style: {setProperty(key, value) {writes.push([key, value]); properties.set(key, value);},
      removeProperty(key) {writes.push(['remove', key]); properties.delete(key);}},
    setAttribute(key, value) {writes.push([key, value]);},
    removeAttribute(key) {writes.push(['remove', key]);},
    querySelectorAll() {return [];}, querySelector() {return null;},
  };
  const parent = {};
  const host = {ownerDocument: document, isConnected: true, parentElement: parent, parentNode: parent,
    clientWidth: 390, closest() {return null;}, matches() {return false;}, contains(node) {return node === table;},
    getBoundingClientRect() {return {width: this.clientWidth};},
    querySelectorAll(selector) {return selector === '.compact-data-table' ? [table] : [];},
  };
  const owner = bindTrackTablePresentation(host, {columns: [
    {key: 'title', label: 'Track', identity: true, width: 100},
    {key: 'path', label: 'File path', width: 220, autoMinWidth: 641},
    {key: 'duration', label: 'Length', required: true, width: 54},
  ], choices: {}, source: {}, isCurrent: () => current,
    openChoice: () => ({close() {closed++;}})});
  writes.length = 0;
  const deliver = () => observer.callback([{target: host, contentRect: {width: host.clientWidth}}], observer);
  const flush = () => {
    const pending = [...frames.entries()];
    for (const [id, callback] of pending) {frames.delete(id); callback(16);}
  };
  return {owner, host, table, frames, writes, properties, deliver, flush,
    loseCurrentness() {current = false;}, observer: () => observer, closed: () => closed};
}

test('ResizeObserver delivery never performs synchronous layout writes and coalesces latest width into one frame', async () => {
  const f = await fixture();
  f.host.clientWidth = f.table.clientWidth = 700;
  f.deliver();
  assert.deepEqual(f.writes, [], 'ResizeObserver must not synchronously paint measured table widths');
  f.host.clientWidth = f.table.clientWidth = 320;
  f.deliver(); f.deliver();
  assert.deepEqual(f.writes, []);
  assert.equal(f.frames.size, 1, 'Repeated delivery coalesces into one pending frame');
  f.flush();
  assert.ok(f.writes.length > 0, 'The deferred frame still paints');
  assert.equal(f.properties.get('--cdt-responsive-columns'), 'minmax(100px,1fr) 54px', 'Paint uses latest narrow width, not captured wide delivery');
  assert.equal(f.frames.size, 0);
  f.owner.dispose();
});

test('pending ResizeObserver frame cannot paint a no-longer-current source', async () => {
  const f = await fixture();
  f.deliver(); assert.equal(f.frames.size, 1);
  f.loseCurrentness(); f.flush();
  assert.deepEqual(f.writes, []);
  f.owner.dispose();
});

test('dispose cancels queued resize work and late observer/frame callbacks stay inert', async () => {
  const f = await fixture();
  f.deliver(); assert.equal(f.frames.size, 1);
  const queued = [...f.frames.values()][0];
  f.owner.dispose();
  assert.equal(f.observer().disconnected, true);
  assert.equal(f.frames.size, 0, 'Disposal cancels the scheduled animation frame');
  f.writes.length = 0;
  queued(16); f.deliver(); f.flush();
  assert.deepEqual(f.writes, [], 'Neither late frame nor delivered observer can repaint a retired owner');
  assert.equal(f.frames.size, 0);
});


test('observer delivery retires an open menu immediately while deferring the layout paint', async () => {
  const f = await fixture();
  assert.equal(f.owner.openColumns({isConnected: true, closest() {return null;}}), true);
  f.writes.length = 0;
  f.deliver();
  assert.equal(f.closed(), 1, 'A stale menu retires during delivery, before the frame');
  assert.deepEqual(f.writes, []);
  assert.equal(f.frames.size, 1);
  f.flush(); f.owner.dispose();
});
