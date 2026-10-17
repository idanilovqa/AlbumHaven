const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {fixture: nativeFixture} = require('./home-friends-native-app-fixture.cjs');
const {installPrivateContext} = require('./private-context-harness.cjs');
const source = path.resolve(__dirname, '../../../music_app/static/js');
let mountViewControl;
test.before(async () => {({mountViewControl} = await import(pathToFileURL(path.join(source, 'home-friends/view-control.mjs'))));});

// Actual native chooser ownership; existing native bridge and events remain.
function fixture(t, {width = 1200} = {}) {
  const native = nativeFixture(t), {context, document} = native;
  // Production owns both the canonical chooser and its trigger-surface adapter.
  // Load the actual bridge rather than substituting the fixture's raw chooser.
  context.dispatchEvent = document.dispatchEvent.bind(document);
  installPrivateContext(context);
  vm.runInContext(fs.readFileSync(path.join(source,'runtime/home-friends-bridge.js'),'utf8'),context,{filename:'home-friends-bridge.js'});
  const bridge = context.AlbumHavenHomeRuntime, mediaQueries = [], mounts = [], focusCalls = [];
  context.matchMedia = query => {
    const record = {query, matches: width <= Number(query.match(/\d+/)[0]), listeners: new Set(),
      addEventListener(type, callback) {assert.equal(type, 'change'); this.listeners.add(callback);},
      removeEventListener(type, callback) {assert.equal(type, 'change'); this.listeners.delete(callback);}};
    mediaQueries.push(record); return record;
  };
  const runtime = {...bridge, mountViewChooser(element, options) {
    // This fixture has no browser focus engine. As in the native owner's own
    // tests, record its focus calls and expose the resulting activeElement.
    for (const button of element.querySelectorAll('button')) button.focus = () => {
      document.activeElement = button; focusCalls.push(button);
    };
    const owner = bridge.mountViewChooser(element, options);
    const record = {element, options, owner, configurations: 0, destroyed: 0}; mounts.push(record);
    return {select: value => owner.select(value), configure(value) {record.configurations++; owner.configure(value);},
      destroy() {record.destroyed++; owner.destroy();}};
  }};
  let owner, disposed = false;
  const host = document.createElement('span'); document.body.appendChild(host);
  const render = props => {
    assert.equal(disposed, false);
    if (owner) owner.update(props); else owner = native.own(mountViewControl(host, runtime, props));
    return host.firstElementChild;
  };
  const emit = (target, type, details = {}) => {
    const event = new context.Event(type); Object.assign(event, details); target.dispatchEvent(event); return event;
  };
  const glyph = mode => {const holder = document.createElement('div'); holder.innerHTML = bridge.viewIconHtml(mode); return holder.innerHTML;};
  return {...native, runtime, host, render, mounts, mediaQueries, focusCalls, emit, glyph,
    resize(next) {width = next; for (const media of mediaQueries) {
      media.matches = next <= Number(media.query.match(/\d+/)[0]); for (const callback of [...media.listeners]) callback();
    }},
    dispose() {owner?.dispose(); disposed = true; host.remove();},
  };
}
const actions = root => root.querySelectorAll('[data-action-value]');
const active = root => actions(root).find(button => button.getAttribute('aria-pressed') === 'true');
const props = extra => ({kind: 'albums', context: 'comparison', value: 'rows', ...extra});

test('native view leases reject old A callbacks after A-to-B-to-A while live same-owner updates use current props', t => {
  const h=fixture(t,{width:800}), changes=[];
  const a=h.render({kind:'albums',value:'list',onChange:value=>changes.push(`first:${value}`)});
  h.emit(active(a),'click',{detail:1});assert.equal(a.classList.contains('is-open'),true);
  assert.notEqual(vm.runInContext('activeTriggerSurface',h.context),null);
  const first=h.mounts[0], firstMedia=h.mediaQueries[0], firstResize=[...firstMedia.listeners][0];
  const b=h.render(props({value:'rows',onChange:value=>changes.push(`middle:${value}`)}));
  assert.equal(a.classList.contains('is-open'),false);
  h.emit(active(b),'click',{detail:1});assert.equal(b.classList.contains('is-open'),true);
  const middle=h.mounts[1], middleMedia=h.mediaQueries[1], middleResize=[...middleMedia.listeners][0];
  const last=h.render({kind:'albums',value:'cards',onChange:value=>changes.push(`last:${value}`)});
  assert.equal(b.classList.contains('is-open'),false);
  const current=h.mounts[2], currentMedia=h.mediaQueries[2], currentResize=[...currentMedia.listeners][0];
  assert.notStrictEqual(a,b);assert.notStrictEqual(a,last);assert.notStrictEqual(b,last);
  assert.equal(first.destroyed,1);assert.equal(middle.destroyed,1);
  assert.equal(firstMedia.listeners.size,0);assert.equal(middleMedia.listeners.size,0);
  assert.equal(a.listeners.length,0);assert.equal(b.listeners.length,0);
  first.options.onSelect('list');middle.options.onSelect('covers');firstResize();middleResize();
  assert.deepEqual(changes,[]);assert.equal(first.configurations,0);assert.equal(middle.configurations,0);assert.equal(current.configurations,0);
  const updated=h.render({kind:'albums',value:'covers',onChange:value=>changes.push(`latest:${value}`)});
  assert.strictEqual(updated,last);assert.equal(h.mounts.length,3);assert.equal(active(last).dataset.actionValue,'covers');
  current.options.onSelect('list');assert.deepEqual(changes,['latest:list']);
  currentMedia.matches=true;currentResize();assert.equal(current.configurations,1);assert.equal(last.dataset.unfoldDirection,'down');
  h.render({kind:'albums',value:'covers',isCurrent:()=>false,onChange:value=>changes.push(`forbidden:${value}`)});
  current.options.onSelect('cards');currentResize();assert.deepEqual(changes,['latest:list']);assert.equal(current.configurations,1);
  h.emit(active(last),'click',{detail:1});assert.equal(last.classList.contains('is-open'),true);
  h.dispose();assert.equal(last.classList.contains('is-open'),false);current.options.onSelect('list');currentResize();first.options.onSelect('list');firstResize();
  assert.deepEqual(changes,['latest:list']);assert.equal(current.configurations,1);assert.equal(current.destroyed,1);assert.equal(currentMedia.listeners.size,0);
  assert.equal(h.document.listeners.filter(entry=>entry.type==='pointerdown').length,0);
  assert.equal(vm.runInContext('activeTriggerSurface',h.context),null);assert.deepEqual(h.forbiddenCalls,[]);
});

test('native comparison selection and repeated updates retain rows, while hidden and empty transitions retire them', async t => {
  const h=nativeFixture(t), {mountComparisonPanel}=await import(pathToFileURL(path.join(source,'home-friends/comparison.mjs')));
  const row={id:'one',kind:'track',title:'One',artist:'Artist',yours:{listen_count:3},friend:{listen_count:2}};
  let props={friendRef:'friend:one',kind:'tracks',period:'week',friendName:'Maya',value:{status:'ready',data:{rows:[row]}}};
  const owner=h.own(mountComparisonPanel(h.host,h.runtime,props));
  const button=h.host.querySelector('[data-home-comparison-select="one"]'), heading=h.host.querySelector('[data-cdt-sort="yours"]');
  button.focus();h.click(button);
  assert.strictEqual(h.host.querySelector('[data-home-comparison-select="one"]'),button);
  assert.strictEqual(h.document.activeElement,button);assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.equal(h.host.querySelector('.home-comparison__details h3').textContent,'One');
  for(let i=0;i<3;i++)owner.update(props);
  assert.strictEqual(h.host.querySelector('[data-home-comparison-select="one"]'),button);
  assert.strictEqual(h.host.querySelector('[data-cdt-sort="yours"]'),heading);
  assert.match(heading.getAttribute('aria-label'),/Sort by Yours listens:/);
  owner.update({...props,value:{status:'denied',data:null}});
  assert.equal(button.isConnected,false);assert.equal(h.host.querySelector('[data-home-comparison-select]'),null);
  assert.equal(h.host.querySelector('.home-comparison__details').textContent,'');
  owner.update(props);
  const fresh=h.host.querySelector('[data-home-comparison-select="one"]');assert.ok(fresh);assert.notStrictEqual(fresh,button);
  assert.equal(fresh.getAttribute('aria-pressed'),'false');
  owner.update({...props,value:{status:'empty',data:{rows:[]}}});
  assert.equal(fresh.isConnected,false);assert.equal(h.host.querySelector('[data-home-comparison-select]'),null);
  owner.update(props);assert.ok(h.host.querySelector('[data-home-comparison-select="one"]'));
  owner.dispose();assert.equal(h.host.querySelector('.home-comparison'),null);assert.deepEqual(h.forbiddenCalls,[]);
});
