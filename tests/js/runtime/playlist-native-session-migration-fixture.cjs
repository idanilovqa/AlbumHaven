const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const {nativeDialogFixture} = require('./playlist-native-dialog-fixture.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const settle = () => new Promise(resolve => setImmediate(resolve));
function sessionDom() {
  const h = nativeDialogFixture(), {context, document} = h;
  const windowNode = document.createElement('window'); windowNode.appendChild(document);
  context.addEventListener = (...args) => windowNode.addEventListener(...args);
  context.removeEventListener = (...args) => windowNode.removeEventListener(...args);
  context.Element.prototype.scrollIntoView = function () {};
  context.Element.prototype.getBoundingClientRect = function () {
    return this.rect || {left: 10, right: 210, top: 40, bottom: 70, width: 200, height: 180};
  };
  context.getComputedStyle = () => ({display: 'block', columnGap: '8px', direction: 'ltr', zIndex: '125', backgroundColor: 'rgb(250, 250, 250)', getPropertyValue: () => ''});
  for (const file of ['trigger-anchor.js', 'library-settings.js']) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context);
  h.runtime.openChoice = context.openUtilityChoiceDropdown;
  h.click = target => {assert.ok(target, 'Expected a real native control'); target.dispatchEvent(new target.ownerDocument.defaultView.Event('click'));};
  h.button = (label, root = document.body) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  h.choose = (label, value) => {
    const choice = [...document.querySelectorAll('.ui-choice')].find(node => node.querySelector('.ui-choice__label')?.textContent === label);
    h.click(choice?.querySelector('button')); h.click(document.querySelector(`[role="menu"] [data-foobar-format="${value}"]`));
  };
  h.runtime.searchHtml = installNativeSearch(h).render;
  const template = h.document.createElement('script'); template.id = 'navigation-tree-item-template';
  template.textContent = readRepo('music_app/templates/components/navigation-tree-item.html'); h.document.body.append(template);
  vm.runInContext(readRepo('music_app/static/js/navigation-tree.js'), h.context);
  h.runtime.navigationItemHtml = h.context.NavigationTree.renderItem;
  const forms = [], closing = deferred(), closeEntered = deferred();
  // Control only the external native-close acknowledgement boundary. The
  // delivered openNativeDialog, form, search, tabs and table own real DOM.
  // Neither a React tree nor a synthetic successful form is supplied.
  h.runtime.openForm = config => {
    const host = h.document.createElement('section'); h.document.body.append(host);
    const owner = {host, config, attempts: [], closed: false,
      updatePresentation(next) {Object.assign(config, next);}, setDismissDisabled() {},
      close(_value, options) {owner.attempts.push(options); closeEntered.resolve(); return closing.promise;},
      nativeClosed() {if (owner.closed) return; owner.closed = true; config.onClose(host, owner.attempts.at(-1)); host.remove();},
    };
    forms.push(owner); config.onMount(host, owner.close); return owner;
  };
  const event = (target, type) => {assert.ok(target, `Expected actual ${type} target`); target.dispatchEvent(new target.ownerDocument.defaultView.Event(type));};
  const input = (target, value) => {assert.ok(target); target.value = value; event(target, 'input');};
  const body = () => forms.at(-1)?.host || h.host;
  const form = () => body().querySelector('form[aria-label="Create playlist"]');
  const field = label => body().querySelector(`[aria-label="${label}"]`);
  const button = label => h.button(label, body());
  const submit = (target = form()) => {event(target, 'submit'); return settle();};
  const edit = (title, description = '') => {input(field('Playlist name'), title); input(field('Playlist description'), description);};
  const picks = () => [...body().querySelectorAll('[data-creation-pick]')];
  const selected = () => {
    const keys = picks().filter(node => node.checked || node.hasAttribute('checked')).map(node => node.dataset.creationPick);
    const count = [...body().querySelectorAll('[role="status"]')].find(node => /^\d+ tracks selected$/.test(node.textContent));
    assert.ok(count, 'Actual selection announcement exists');
    assert.equal(Number(count.textContent.split(' ')[0]), keys.length, 'No invisible selection may be omitted from this observation');
    return keys;
  };
  const toggle = key => {const target = picks().find(node => node.dataset.creationPick === key); event(target, 'change');};
  const reload = () => {const target = button('Reload tracks'); assert.ok(target && !target.closest('[hidden]')); h.click(target); return settle();};
  const zeroSelection = () => {
    const counts = [...body().querySelectorAll('[role="status"]')].filter(node => /^\d+ tracks selected$/.test(node.textContent));
    const tab = body().querySelector('[role="tab"][data-in-page-tab="selected"]');
    if (form()) {
      assert.equal(counts.length, 1, 'Retained form exposes its selection count at privacy-clear time');
      assert.equal(counts[0].textContent, '0 tracks selected');
      assert.ok(tab, 'Retained form exposes its Selected tab');
      assert.equal(tab.textContent.trim(), 'Selected (0)');
    } else {
      assert.equal(counts.length, 0, 'Disposed form leaves no selection announcement');
      assert.equal(tab, null, 'Disposed form leaves no Selected tab');
    }
  };
  const retired = () => {
    zeroSelection();
    assert.equal(picks().length, 0);
    assert.equal(field('Playlist name')?.value || '', ''); assert.equal(field('Playlist description')?.value || '', '');
    assert.equal(body().querySelector('input[type="search"]')?.value || '', '');
    assert.equal(body().querySelector('.playlists__selection')?.textContent || '', '');
    assert.equal(body().querySelector('.playlists__selection button'), null);
    assert.doesNotMatch(body().textContent, /Private source title|Private source artist|Private album/);
  };
  return {...h, forms, closing, closeEntered, event, input, body, form, field, button, submit, edit, picks, selected, toggle, reload, retired, zeroSelection,
    beforeDismiss: () => forms.at(-1).config.beforeDismiss(),
    finishClose(value = true) {if (value) forms.at(-1).nativeClosed(); closing.resolve(value); return settle();},
    nativeClosed() {forms.at(-1).nativeClosed();},
    mutationsNow: () => [h.mutations.length, h.attributeMutations.length],
  };
}
module.exports = {sessionDom, deferred, settle};
