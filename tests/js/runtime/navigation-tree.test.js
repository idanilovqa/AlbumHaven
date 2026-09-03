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
