const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {nativeDialogFixture} = require('./playlist-native-dialog-fixture.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
function filterFixture({phone = false, withMedia = true, delayed = false, refuse = false} = {}) {
  const env = nativeDialogFixture(), {document, context, runtime} = env;
  const winEvents = document.createElement('window'), media = document.createElement('media');
  context.innerWidth = phone ? 390 : 1200; media.matches = phone;
  context.addEventListener = (...args) => winEvents.addEventListener(...args);
  context.removeEventListener = (...args) => winEvents.removeEventListener(...args);
  context.matchMedia = withMedia ? query => {assert.equal(query, '(max-width: 900px)'); return media;} : undefined;
  // Bounded nearest-scroll platform support for the real canonical Choice owner.
  context.Element.prototype.scrollIntoView = function (options = {}) {
    assert.equal(options.block, 'nearest');
    if (!this.isConnected) return;
    const box = this.getBoundingClientRect();
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (!(parent.scrollHeight > parent.clientHeight)) continue;
      const viewport = parent.getBoundingClientRect();
      const delta = box.top < viewport.top ? box.top - viewport.top
        : box.bottom > viewport.bottom ? box.bottom - viewport.bottom : 0;
      parent.scrollTop = Math.max(0, Math.min(parent.scrollHeight - parent.clientHeight, parent.scrollTop + delta));
    }
  };
  const search = installNativeSearch(env);
  for (const file of ['trigger-anchor.js', 'library-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), context);
  }
  const template = document.createElement('script'); template.id = 'navigation-tree-item-template';
  template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  document.body.append(template);
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), context);
  Object.assign(runtime, {searchHtml: search.render, openChoice: env.owner('openUtilityChoiceDropdown'),
    navigationItemHtml: config => context.window.NavigationTree.renderItem(config),
    detailHeaderHtml: env.owner('buildAlbumDetailsHeaderHtml'), galleryBarHtml: env.owner('buildGalleryBarHtml'), downloadText() {}});
  const forms = [], closes = []; let resolveReturn;
  if (delayed) {
    context.presentMobileAppFormPage = () => {};
    context.retireMobileAppFormPage = () => new Promise(resolve => {resolveReturn = resolve;});
  }
  const openForm = runtime.openForm;
  runtime.openForm = options => {
    const record = {options}; forms.push(record);
    record.owner = openForm({...options, ...(refuse ? {beforeDismiss: () => false} : {}),
      onMount(host, close) {record.host = host; options.onMount(host, (value, next) => {closes.push(next); return close(value, next);});},
      onClose(host, next) {record.closed = next; options.onClose(host, next);},
    });
    return record.owner;
  };
  // Canonical global owners precede consumer acquisition and keep their listeners.
  // Capture exact listener records, including callback and capture identity.
  const windowListenerBaseline = Object.freeze(winEvents.listeners.map(entry => Object.freeze({...entry})));
  return {...env, media, winEvents, forms, closes, windowListenerBaseline,
    resize(next) {media.matches = next; context.innerWidth = next ? 390 : 1200;
      (withMedia ? media : winEvents).dispatchEvent(new context.Event(withMedia ? 'change' : 'resize'));},
    async returnParent(current = true) {resolveReturn?.(current); await settle();},
  };
}
async function settle() {for (let i = 0; i < 16; i++) await Promise.resolve();}
module.exports = {filterFixture, settle};
