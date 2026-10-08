const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness() {
  const source = path.join(__dirname, '../../../music_app/static/js/navigation-tree.js');
  assert.ok(fs.existsSync(source), 'NavigationTree shared component must exist');
  const templatePath = path.join(__dirname, '../../../music_app/templates/components/navigation-tree-item.html');
  assert.ok(fs.existsSync(templatePath), 'server and client must share the canonical row template');
  const document = { getElementById: () => ({textContent: fs.readFileSync(templatePath, 'utf8')}) };
  const window = {document};
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {window, document, console});
  return window.NavigationTree;
}

test('disabled navigation has no activatable link and native buttons retain disabled semantics', () => {
  const tree = harness();
  const disabledLink = tree.renderItem({label: 'Unavailable playlist', href: '/?playlist=private', disabled: true});
  assert.doesNotMatch(disabledLink, /href=/);
  assert.match(disabledLink, /aria-disabled="true"/);
  assert.match(disabledLink, /tabindex="-1"/);
  const disabledAction = tree.renderItem({label: 'Unavailable playlist', action: true, disabled: true});
  assert.match(disabledAction, /^<button /);
  assert.match(disabledAction, / disabled(?: |>|=)/);
  assert.match(disabledAction, /aria-disabled="true"/);
  assert.match(tree.renderItem({label: 'Available', href: '/?playlist=open', disabled: 'true'}), /href=/);
});

function observedElement(attributes = {}, classNames = [], children = {}) {
  const attrs = new Map(Object.entries(attributes));
  const classes = new Set(classNames);
  const writes = [];
  return {
    writes,
    classList: {
      contains: name => classes.has(name),
      toggle(name, selected) { selected ? classes.add(name) : classes.delete(name); },
    },
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute(name, value) { writes.push(['set', name, String(value)]); attrs.set(name, String(value)); },
    removeAttribute(name) { writes.push(['remove', name]); attrs.delete(name); },
    querySelector: selector => children[selector] || null,
  };
}

test('repeated selected and unselected navigation rows perform no attribute writes', () => {
  const tree = harness();
  for (const variant of ['settings', 'wide', 'artists']) {
    for (const selected of [false, true]) {
      const current = variant === 'settings' ? 'page' : 'true';
      const row = observedElement({ 'data-navigation-tree-item': variant, ...(selected ? { 'aria-current': current } : {}) });
      tree.setItemSelected(row, selected);
      tree.setItemSelected(row, selected);
      assert.deepEqual(row.writes, [], `${variant} selected=${selected}`);
    }
  }
});

test('navigation selection repairs missing or changed aria semantics and preserves unrelated attributes', () => {
  const tree = harness();
  for (const variant of ['settings', 'wide', 'artists']) {
    const row = observedElement({ 'data-navigation-tree-item': variant, href: '/album', 'data-navigation-tree-key': 'album' });
    const expected = variant === 'settings' ? 'page' : 'true';
    tree.setItemSelected(row, true);
    assert.equal(row.getAttribute('aria-current'), expected);
    assert.equal(row.classList.contains('is-selected'), true);
    row.setAttribute('aria-current', 'incorrect');
    row.writes.length = 0;
    tree.setItemSelected(row, true);
    assert.deepEqual(row.writes, [['set', 'aria-current', expected]]);
    row.writes.length = 0;
    tree.setItemSelected(row, false);
    assert.deepEqual(row.writes, [['remove', 'aria-current']]);
    assert.equal(row.getAttribute('aria-current'), null);
    assert.equal(row.classList.contains('is-selected'), false);
    assert.equal(row.getAttribute('href'), '/album');
    assert.equal(row.getAttribute('data-navigation-tree-key'), 'album');
  }
});

test('artwork labels write only changed or missing values and retain explicit empty labels', () => {
  const tree = harness();
  const image = observedElement({ alt: 'Original', src: '/cover' });
  const artbox = observedElement({ 'aria-label': 'Original' });
  const artwork = observedElement({}, [], { img: image, '.album-artbox': artbox });
  const row = observedElement({}, [], { '.navigation-tree-artwork': artwork });
  for (const value of ['Original', 'Changed', '', 0]) {
    image.writes.length = 0;
    artbox.writes.length = 0;
    const previous = image.getAttribute('alt');
    tree.updateItem(row, { artworkLabel: value });
    const expected = String(value);
    assert.equal(image.getAttribute('alt'), expected);
    assert.equal(artbox.getAttribute('aria-label'), expected);
    assert.deepEqual(image.writes, previous === expected ? [] : [['set', 'alt', expected]]);
    assert.deepEqual(artbox.writes, previous === expected ? [] : [['set', 'aria-label', expected]]);
    image.writes.length = 0;
    artbox.writes.length = 0;
    tree.updateItem(row, { artworkLabel: value });
    assert.deepEqual(image.writes, []);
    assert.deepEqual(artbox.writes, []);
  }
  image.removeAttribute('alt');
  artbox.removeAttribute('aria-label');
  tree.updateItem(row, { artworkLabel: '' });
  assert.equal(image.getAttribute('alt'), '');
  assert.equal(artbox.getAttribute('aria-label'), '');
  image.writes.length = 0;
  artbox.writes.length = 0;
  tree.updateItem(row, {});
  assert.deepEqual(image.writes, []);
  assert.deepEqual(artbox.writes, []);
  assert.equal(image.getAttribute('src'), '/cover');
});

test('shared row escapes labels and preserves selected links and counts', () => {
  const tree = harness();
  const markup = tree.renderItem({label: '<Artist & friends>', href: '/?artist=a&b=c', key: 'artist-one', selected: true, count: 0});
  assert.match(markup, /&lt;Artist &amp; friends&gt;/);
  assert.doesNotMatch(markup, /<Artist/);
  assert.match(markup, /href="[^"]*artist=a&amp;b=c"/);
  assert.match(markup, /aria-current="true"/);
  assert.match(markup, />0</);
  assert.doesNotMatch(markup, /role="treeitem"/);
});

test('panel rows retain descriptive metadata without an artwork column',()=>{
  const html=harness().renderItem({variant:'panel',action:true,label:'Loop created',subtitle:'Album Haven',year:'Sep 9, 10:42'});
  assert.match(html,/utility-list-item-meta[^>]*>Album Haven · Sep 9, 10:42/);
  assert.doesNotMatch(html,/navigation-tree-artwork/);
});

test('flat settings row keeps feature-owned actions and unselected semantics', () => {
  const tree = harness();
  const markup = tree.renderItem({label: 'My account', href: '/account', key: 'account', variant: 'settings', attributes: {'data-settings-section': 'account'}});
  assert.match(markup, /href="\/account"/);
  assert.match(markup, /data-settings-section="account"/);
  assert.doesNotMatch(markup, /aria-current=/);
  assert.doesNotMatch(markup, /aria-expanded|role="treeitem"/);
});

test('selection changes remove the previous row state while preserving other row attributes', () => {
  const tree = harness();
  function row(key, selected) {
    const attrs = new Map([['data-navigation-tree-key',key], ['href','/'+key]]);
    const classes = new Set(selected ? ['is-selected'] : []);
    if (selected) attrs.set('aria-current','page');
    return {dataset:{navigationTreeKey:key}, classList:{contains(name){return classes.has(name);},toggle(name,on){on ? classes.add(name) : classes.delete(name);},add(name){classes.add(name);},remove(name){classes.delete(name);}},
      getAttribute(name){return attrs.get(name) ?? null;}, setAttribute(name,value){attrs.set(name,String(value));}, removeAttribute(name){attrs.delete(name);}};
  }
  const first = row('first',true), second = row('second',false);
  tree.setSelection({querySelectorAll(){return [first,second];}}, 'second');
  assert.equal(first.getAttribute('aria-current'), null);
  assert.equal(second.getAttribute('aria-current'), 'true');
  assert.equal(first.getAttribute('href'), '/first');
});

test('panel variant renders a compact one-line NavigationTree button', () => {
  const tree = harness();
  const markup = tree.renderItem({
    label: 'Player & Seekbar',
    key: 'seekbar',
    variant: 'panel',
    action: true,
    selected: true,
    attributes: {'data-utility-appearance-key':'seekbar'},
  });
  assert.match(markup, /^<button /);
  assert.match(markup, /type="button"/);
  assert.match(markup, /data-navigation-tree-item="panel"/);
  assert.match(markup, /data-utility-appearance-key="seekbar"/);
  assert.match(markup, /<span class="navigation-tree-label artist-name-label">Player &amp; Seekbar<\/span>/);
  assert.doesNotMatch(markup, /utility-list-item-meta|Default or waveform appearance/);
});

test('panel NavigationTree buttons preserve the regular left-aligned row presentation', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/navigation-tree.css'), 'utf8');
  assert.match(css, /button\.navigation-tree-item\[data-navigation-tree-item="panel"\]\s*\{[^}]*width:\s*100%[^}]*text-align:\s*left[^}]*font:\s*inherit/s);
});

test('Appearance navigation uses the compact shared rows in approved order and defaults to Main elements', () => {
  const builderSource = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/utility-list-builders.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/utility-renderers-and-actions.js'), 'utf8');
  const rendered = [];
  const NavigationTree = {renderItem(options){rendered.push(options);return `<button>${options.label}</button>`;}};
  const elements = {
    overlay:{}, search:{}, problemFilterButton:{}, problemFilterMenu:{}, problemFilterChips:{},
    list:{innerHTML:'',scrollTop:0,querySelectorAll:()=>[],querySelector:()=>null}, detail:{innerHTML:''}, count:{textContent:''},
  };
  const context = vm.createContext({
    console,
    window:{NavigationTree,AlbumHavenSelectionAccent:{unmount(){}}},
    state:{utility:{appearanceKey:'backgrounds'},player:{appearance:{seekbarMode:'waveform'}}},
    getUtilityModalElements:()=>elements,
    escapeHtml:value=>String(value),
    mountBackgroundAppearanceEditor(){},
    getBackgroundAppearanceEditor:()=>({unmount(){}}),
    unmountAppearanceEditors(){},
  });
  vm.runInContext(builderSource,context);
  vm.runInContext(rendererSource,context);
  context.renderUtilityAppearance();

  assert.deepEqual(rendered.map(item=>[item.key,item.label]),[
    ['backgrounds','Main elements'],
    ['seekbar','Player & Seekbar'],
    ['selection-accent','Selection & Hover'],
    ['alerts','Alerts'],
    ['album-page','Album page'],
  ]);
  assert.ok(rendered.every(item=>item.variant==='panel' && item.action===true));
  assert.equal(elements.list.innerHTML.includes('utility-list-item-meta'),false);
  const coreState = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/core-state-and-helpers.js'), 'utf8');
  assert.match(coreState, /appearanceKey:\s*'backgrounds'/);
});
