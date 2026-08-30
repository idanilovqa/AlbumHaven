const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'shell-navigation-drawer.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) {
      if (force === undefined) {
        if (values.has(value)) values.delete(value);
        else values.add(value);
        return values.has(value);
      }
      if (force) values.add(value);
      else values.delete(value);
      return values.has(value);
    },
    contains(value) { return values.has(value); },
  };
}

function createElement() {
  const attributes = new Map();
  return {
    hidden: false,
    dataset: {},
    classList: createClassList(),
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    focus() {},
    contains(target) {
      return target === this;
    },
  };
}

function loadHelper({ isMobile = false } = {}) {
  const drawerRail = createElement();
  const drawerBackdrop = createElement();
  const body = createElement();
  const document = {
    body,
    getElementById(id) {
      return {
        'shell-navigation-rail': drawerRail,
        'shell-navigation-rail-backdrop': drawerBackdrop,
      }[id] || null;
    },
  };
  const context = {
    state: {
      view: {
        shell_layout: {
          slots: {
            navigation_rail: {
              content_kind: 'artists_sidebar',
            },
          },
        },
      },
      ui: {
        artistsDrawerOpen: false,
      },
    },
    document,
    window: {
      matchMedia: () => ({
        matches: isMobile,
      }),
      innerWidth: isMobile ? 480 : 1200,
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return {
    context,
    drawerRail,
    drawerBackdrop,
    body,
  };
}

{
  const { context, drawerRail, drawerBackdrop, body } = loadHelper({ isMobile: true });

  const opened = context.openArtistsDrawer();

  assert.equal(opened, true);
  assert.equal(context.state.ui.artistsDrawerOpen, true);
  assert.equal(drawerRail.getAttribute('aria-hidden'), 'false');
  assert.equal(drawerBackdrop.hidden, false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer-open'), true);
  assert.equal(body.classList.contains('artists-drawer-open'), true);
}

{
  const { context, drawerRail, drawerBackdrop, body } = loadHelper({ isMobile: false });
  context.state.ui.artistsDrawerOpen = true;

  context.syncArtistsDrawerVisibility();

  assert.equal(context.state.ui.artistsDrawerOpen, false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer'), false);
  assert.equal(drawerBackdrop.hidden, true);
  assert.equal(body.classList.contains('artists-drawer-open'), false);
}

{
  const { context, drawerRail, drawerBackdrop, body } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  context.state.view.shell_layout.slots.navigation_rail.content_kind = 'playlist_sidebar';

  context.syncArtistsDrawerVisibility();

  assert.equal(context.state.ui.artistsDrawerOpen, false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer'), false);
  assert.equal(drawerBackdrop.hidden, true);
  assert.equal(body.classList.contains('artists-drawer-open'), false);
}

{
  const { context } = loadHelper({ isMobile: true });
  context.state.view.shell_layout.slots.navigation_rail.content_kind = 'playlist_sidebar';

  const opened = context.openArtistsDrawer();

  assert.equal(opened, false);
  assert.equal(context.state.ui.artistsDrawerOpen, false);
}
