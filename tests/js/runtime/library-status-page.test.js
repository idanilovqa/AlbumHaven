const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/core-state-and-helpers.js'), 'utf8');
const navigation = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/status-ui-helpers.js'), 'utf8');
const warning = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/library-warning-ui.js'), 'utf8');
const galleryRefresh = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/gallery-refresh-and-status.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'music_app/static/css/runtime/cover-lookup-drawer-and-related.css'), 'utf8');

test('gallery markup does not preload a hidden Library Status bar', () => {
  assert.match(template, /data-gallery-bar-instance="gallery"/);
  assert.doesNotMatch(template, /id="library-status-gallery-bar"/);
  assert.doesNotMatch(template, /data-gallery-bar-instance="library-(?:scan|status)"/);
  assert.match(runtime, /function mountLibraryStatusBar\(/);
  assert.match(runtime, /function unmountLibraryStatusBar\(/);
  assert.match(runtime, /detachedGalleryBar/);
  assert.match(galleryRefresh, /function abandonScanPageForNavigation[^]*?unmountLibraryStatusBar\(\)/);
});

test('mount and unmount replace the GalleryBar and restore the same node', () => {
  const anchor = { parentNode: null };
  const gallery = { parentNode: null, nextSibling: anchor, remove() { parent.remove(this); } };
  let statusBar = null;
  const parent = {
    children: [gallery, anchor],
    insertBefore(node, reference) {
      this.remove(node);
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
      node.parentNode = this;
    },
    remove(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      if (node.parentNode === this) node.parentNode = null;
    },
  };
  gallery.parentNode = parent;
  anchor.parentNode = parent;
  const context = {
    appBootstrap: { getInitialView: () => ({}) },
    window: { location: { href: 'http://localhost/', origin: 'http://localhost' } },
    document: {
      querySelector: selector => selector.includes('data-gallery-bar-instance="gallery"') && gallery.parentNode ? gallery : null,
      getElementById: id => id === 'library-status-gallery-bar' ? statusBar : null,
      createElement() {
        return {
          set innerHTML(value) {
            assert.match(value, /Library Status Page/);
            statusBar = { parentNode: null, remove() { parent.remove(this); statusBar = null; } };
            this.firstElementChild = statusBar;
          },
        };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(runtime, context);

  const mounted = context.mountLibraryStatusBar();
  assert.equal(mounted, statusBar);
  assert.equal(gallery.parentNode, null);
  assert.deepEqual(parent.children, [statusBar, anchor]);

  context.unmountLibraryStatusBar();
  assert.equal(statusBar, null);
  assert.equal(parent.children[0], gallery);
  assert.equal(gallery.parentNode, parent);
});

test('runtime Library Status bar uses shared GalleryBar structure and exact labels', () => {
  assert.match(runtime, /data-gallery-bar-instance="library-status"/);
  assert.match(runtime, /aria-label="Library Status Page controls"/);
  assert.match(runtime, />Library Status Page</);
  assert.match(runtime, /data-close-scan-page="1"/);
  assert.match(runtime, /data-cancel-library-scan="1"/);
  assert.match(navigation, /Open Library Status Page/);
  assert.match(navigation, /Go to Library Status Page/);
  assert.doesNotMatch(navigation, /Open Library\/Scan|Go to Scan Page/);
});

test('status body exposes Library State and conditional Library Health', () => {
  assert.match(template, />Library State</);
  assert.match(template, /id="library-loader-ready-check"[^>]*hidden/);
  assert.match(template, /id="library-health"[^>]*hidden[^]*>\s*<h2[^>]*>Library Health</);
  assert.match(runtime, /Your local library is ready\./);
  assert.match(warning, /on-page-alert--compact/);
  assert.match(warning, /libraryHealth\.hidden = hidden/);
  assert.match(css, /\.library-loader\.is-scan-page\.has-library-health \.library-status-workspace\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /@media[^]*max-width:[^]*\.library-loader\.is-scan-page\.has-library-health \.library-status-workspace\s*\{[^}]*grid-template-columns:\s*1fr/s);
});
