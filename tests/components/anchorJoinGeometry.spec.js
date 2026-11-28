const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { applyFixtureAppearance } = require('./appearanceFixture.js');
const { measureAnchorJoin, expectContinuousJoin, measureAnchorCorners, expectSquareCorners } = require('./anchorJoinMeasure.js');

// Every owner-reported dropdown, opened through its production owner with the
// production stylesheet stack, measured from the painted pixels at desktop and
// phone widths. A step, a missing side, or a broken trigger outline fails here.
const repositoryRoot = path.resolve(__dirname, '../..');
const templates = path.join(repositoryRoot, 'music_app/templates');
const staticRoot = path.join(repositoryRoot, 'music_app/static');

// The stylesheets index.html loads, in its order, including its head partials.
function appStylesheets() {
  const expand = (file, seen = new Set()) => {
    if (seen.has(file)) return '';
    seen.add(file);
    const source = fs.readFileSync(path.join(templates, file), 'utf8');
    return source.replace(/{%\s*include\s+["']([^"']+)["']\s*%}/g, (_, include) => expand(include, seen));
  };
  const head = expand('index.html').split('<body')[0];
  const sheets = [];
  for (const match of head.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) {
    const href = match[1];
    const file = href.match(/filename='([^']+)'/)?.[1]
      || href.replace(/^\/static\//, '').replace(/[?{].*$/, '');
    if (!sheets.includes(file)) sheets.push(file);
  }
  return sheets;
}

const template = file => fs.readFileSync(path.join(templates, file), 'utf8');
// The phone Settings page header's section picker (partials/gallery-bar.html) and its menu (index.html).
const sectionControlHtml = template('partials/gallery-bar.html')
  .match(/<div class="ui-dropdown-control[^"]*mobile-settings-section-control">[\s\S]*?<\/div>/)[0];
const editTagsDropdownHtml = template('partials/primary-modals.html')
  .match(/<div class="tag-editor-exception-field"[\s\S]*?<\/div><\/div><\/div>/)[0];
const sectionMenuHtml = template('index.html')
  .match(/<div class="gallery-anchored-menu" id="mobile-settings-subsection-menu"[^>]*><\/div>/)[0];
const sourcesMenuHtml = template('index.html')
  .match(/<div class="gallery-anchored-menu" id="gallery-sources-menu"[\s\S]*?<\/div>/)[0];

const SCRIPTS = [
  'js/button-component.js',
  'js/runtime/trigger-anchor.js',
  'js/runtime/account-menu.js',
  'js/runtime/gallery-main-components.js',
  'js/runtime/gallery-main-interactions.js',
  'js/runtime/status-ui-helpers.js',
  'js/runtime/browser-dialog-helpers.js',
  'js/runtime/date-range-picker.js',
  'js/runtime/utility-list-builders.js',
];

async function mountApp(page, width) {
  await page.setViewportSize({ width, height: width > 900 ? 900 : 844 });
  await page.setContent(`<!doctype html><html lang="en"><head></head><body>
    <div class="layout shell-layout" id="app-shell">
      <header class="app-bar shell-app-bar app-bar--library" data-shell-slot="app_bar">
        <a class="app-bar-brand" href="#" aria-label="Album Haven library"><span class="app-bar-brand-mark" aria-hidden="true"></span></a>
        <form class="toolbar-left" id="search-form"></form>
        <div class="toolbar-right" data-toolbar-right></div>
      </header>
      <main class="main shell-main-surface" id="shell-main-surface" data-shell-slot="main_content">
        <header class="gallery-bar mobile-page-header" data-gallery-bar data-gallery-bar-instance="page" data-section-picker-host>
          <div class="gallery-bar__context"><h1 class="gallery-bar__title">Appearance</h1></div>
          <div class="gallery-bar__actions" id="mobile-settings-actions"></div>
        </header>
        <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery"></header>
        <div class="albums-scroll" id="albums-scroll"><div class="albums-viewport" id="albums-viewport"><div id="artist-groups"></div></div></div>
      </main>
    </div>
    <div data-family-host></div>
    <div class="utility-modal" id="utility-modal" hidden><div class="utility-modal-dialog" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="utility-modal-header"><div class="utility-modal-tabs" role="tablist">
        <button class="utility-tab is-active" type="button" data-utility-tab="problematic-files" aria-selected="true">Problematic files</button>
        <button class="utility-tab" type="button" data-utility-tab="log-history" aria-selected="false">Log History</button>
      </div></div>
      <div class="utility-modal-body"><aside class="utility-sidebar"><div class="utility-sidebar-search">
        <div class="utility-search-row utility-problem-filter" data-problem-filter-host></div>
      </div><div class="utility-list"></div></aside><section class="utility-detail"></section></div>
    </div></div>
    <div id="tag-editor-modal"><form class="tag-editor-form" data-edit-tags-host></form></div>
    <div class="confirm-modal" id="app-form-modal" hidden>
      <div class="confirm-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="app-form-title">
        <div class="app-form-header"><h3 class="confirm-modal-title" id="app-form-title"></h3><span data-app-form-close-host></span></div>
        <div class="confirm-modal-text" id="app-form-description" hidden></div>
        <div id="app-form-content"></div>
        <p id="app-form-error" role="alert"></p>
        <div class="confirm-modal-actions">
          <button class="button ui-button ui-button--quiet ui-button--medium" type="button" id="app-form-cancel">Cancel</button>
          <button class="button ui-button ui-button--primary ui-button--medium" type="button" id="app-form-submit">Apply</button>
        </div>
      </div>
    </div>
  </body></html>`);
  for (const sheet of appStylesheets()) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', sheet.replace(/^css\//, '')) });
  }
  await applyFixtureAppearance(page, { palette_id: null, panel_index: 0 });
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    window.cssEscape = value => CSS.escape(value);
    window.usesMobilePageLayout = () => Number(window.innerWidth) <= 900;
    window.state = {
      status: {}, ui: {}, utility: {},
      gallery: { mainState: { sources: {}, albumTypes: [], view: 'grid' } },
      view: { selected_artist: 'Harbor Lights', query: '', surface: { active: 'albums' } },
    };
    window.ensureGalleryMainState = () => window.state.gallery.mainState;
    window.prefetchGallerySourceTotalsForAllScopes = () => {};
    window.hydrateDeferredNonAlbumTracksForAlbumTypes = () => {};
    window.shouldFocusGalleryMainSurface = () => false;
    window.getGalleryFamilyContextKey = () => '';
  });
  for (const script of SCRIPTS) await page.addScriptTag({ path: path.join(staticRoot, script) });
  await page.evaluate(({ sourcesMenu, sectionControl, sectionMenu, editTagsDropdown }) => {
    const { renderActionButton } = window.ButtonComponent;
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/></svg>';
    const toolbar = document.querySelector('[data-toolbar-right]');
    toolbar.innerHTML = [
      renderActionButton({ ariaLabel: 'Library status', className: 'status-indicator is-idle', attributes: { id: 'scan-indicator', 'aria-controls': 'status-context-menu', 'aria-expanded': 'false' } }),
      renderActionButton({ ariaLabel: 'Sources', attributes: { id: 'gallery-sources-button', 'data-gallery-sources-anchor': '1', 'aria-controls': 'gallery-sources-menu', 'aria-expanded': 'false' } }),
      sourcesMenu,
      `<div class="account-menu-component" data-account-menu-component>${renderActionButton({ ariaLabel: 'Settings', attributes: { id: 'settings-button', 'data-account-menu-trigger': true, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'account-menu' } })}
        <div class="account-menu" id="account-menu" data-account-menu role="menu" aria-label="Account actions" hidden>
          <button class="account-menu-item" type="button" role="menuitem" tabindex="-1"><span class="account-menu-icon" aria-hidden="true">&#9881;</span><span>Settings</span></button>
          <a class="account-menu-item" href="#" role="menuitem" tabindex="-1"><span class="account-menu-icon" aria-hidden="true">&#9817;</span><span>Admin Panel</span></a>
          <div class="account-menu-separator" role="separator"></div>
          <button class="account-menu-item" type="button" role="menuitem" tabindex="-1"><span class="account-menu-icon" aria-hidden="true">&#8618;</span><span>Sign Out</span></button>
        </div></div>`,
    ].join('');
    toolbar.querySelectorAll('.action-button__content').forEach(content => { if (!content.innerHTML) content.innerHTML = icon; });
    attachAccountMenu(document.querySelector('[data-account-menu-component]'));
    document.querySelector('[data-gallery-bar-instance="gallery"]').innerHTML = buildGalleryBarHtml({
      contextKind: 'artist', artist: 'Harbor Lights', albumCount: 13,
    });
    document.querySelector('[data-family-host]').outerHTML = buildArtistFamilyPanelHtml({
      title: 'Harbor Lights Family', albumTotal: '13 albums', bodyHtml: '<p>Harbor Lights</p>',
    });
    document.querySelector('[data-artist-family-panel]').id = 'artist-family-panel';
    const albumTypes = document.createElement('div');
    albumTypes.innerHTML = `<div class="gallery-anchored-menu" id="gallery-album-types-menu" data-anchored-surface="album-types" data-trigger-anchor-context="content" role="group" aria-label="Album types" hidden>
      <span class="gallery-menu-title">Album types</span>
      ${['Studio', 'EP', 'Live', 'Demo', 'Compilation', 'Single'].map(label => `<button class="gallery-type-choice" type="button" aria-pressed="true"><span aria-hidden="true">✓</span>${label}</button>`).join('')}
      <div class="gallery-menu-divider"></div>
      <button class="gallery-menu-action" type="button">Customize</button></div>`;
    document.querySelector('#shell-main-surface').appendChild(albumTypes.firstElementChild);
    // Problematic Files search field, as partials/search-input.html renders it with the filter action.
    document.querySelector('[data-problem-filter-host]').innerHTML = `<div class="search-input-wrap search-field">
      <div class="search-field-control ui-input-action">
        <input type="search" id="utility-problematic-search" placeholder="Filter artist, album, or track" aria-label="Search settings items" autocomplete="off">
        <span class="search-field-action">
          <button class="search-field-button" type="button" aria-label="Clear search" data-search-clear hidden></button>
          <button class="search-field-button utility-problem-filter-button" type="button" id="utility-problem-filter-button" aria-label="Filters" aria-haspopup="listbox" aria-controls="utility-problem-filter-menu" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4h16l-6 7v7l-4 2v-9L4 4Z"></path></svg></button>
        </span>
      </div></div>
      <div class="utility-problem-filter-menu" id="utility-problem-filter-menu" role="listbox" aria-multiselectable="true" hidden></div>`;
    document.querySelector('[data-app-form-close-host]').outerHTML = renderActionButton({
      ariaLabel: 'Close', className: 'app-form-close', presentation: 'bare', attributes: { id: 'app-form-close' },
    });
    // bootstrap-gallery-event-handlers.js routes document clicks the same way.
    document.addEventListener('click', event => handleGalleryMainClick(event));
    document.getElementById('mobile-settings-actions').innerHTML = sectionControl;
    document.body.insertAdjacentHTML('beforeend', sectionMenu);
    document.querySelector('[data-edit-tags-host]').innerHTML = editTagsDropdown;
  }, { sourcesMenu: sourcesMenuHtml, sectionControl: sectionControlHtml, sectionMenu: sectionMenuHtml,
    editTagsDropdown: editTagsDropdownHtml });
}

// The filter owner (utility-list-builders.js renderProblemFilterControls) opens
// the menu and marks the button active when a problem type is selected.
async function openProblemFilter(page, { selected }) {
  await page.evaluate(({ selected }) => {
    document.getElementById('utility-modal').hidden = false;
    window.getProblemReasonTypes = () => ['Album not found', 'Encoding problem', 'Missing cover art', 'Missing year'];
    Object.assign(state.utility, { problematicFilesComplete: true, selectedProblemFilters: selected, problemDropdownOpen: true });
    renderProblemFilterControls({
      problemFilterButton: document.getElementById('utility-problem-filter-button'),
      problemFilterMenu: document.getElementById('utility-problem-filter-menu'),
    });
  }, { selected });
}

// Log History reuses the same field button as its "Period" anchor
// (utility-renderers-and-actions.js) and opens the shared anchored app form.
async function openLogHistoryPeriod(page) {
  await openProblemFilter(page, { selected: ['Album not found'] });
  await page.evaluate(() => {
    const button = document.getElementById('utility-problem-filter-button');
    const menu = document.getElementById('utility-problem-filter-menu');
    state.utility.problemDropdownOpen = false;
    renderProblemFilterControls({ problemFilterButton: button, problemFilterMenu: menu });
    // Log History relabels the same button; a stale PF "active" state must not break its outline.
    button.classList.add('is-active');
    button.setAttribute('aria-label', 'Period');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'app-form-modal');
    showAppFormDialog({
      title: 'Date range', anchor: button,
      contentHtml: `${buildDateRangePicker({ fromDate: '2026-11-24', toDate: '2026-11-24' })}<p class="utility-detail-meta">UTC</p>`,
      submitLabel: 'Apply',
      onMount: content => { window.disposeCalendar = mountDateRangePicker(content); },
    });
  });
}

// mobile-navigation.js fills the menu with the section's choices and opens it
// through the gallery surface owner (handleMobileSettingsClick).
async function openAppearanceSections(page) {
  await page.evaluate(() => {
    const trigger = document.getElementById('mobile-settings-section-button');
    const menu = document.getElementById('mobile-settings-subsection-menu');
    trigger.value = 'Main elements';
    menu.innerHTML = ['Main elements', 'Player & Seekbar', 'Selection & Hover', 'Alerts', 'Album page']
      .map((label, index) => `<button class="gallery-menu-action" type="button" aria-pressed="${index === 0}">${escapeHtml(label)}</button>`).join('');
    openGalleryMainSurface('settings-subsection', trigger, menu);
  });
}

const dropdowns = [
  { name: 'Album Types', flush: ['right'], open: page => page.locator('[data-gallery-bar-action="album-types"]').click(),
    anchor: '[data-gallery-bar-action="album-types"]', surface: '#gallery-album-types-menu' },
  { name: 'Artist Family', flush: [], open: page => page.locator('[data-gallery-bar-action="artist-family"]').click(),
    anchor: '[data-gallery-bar-action="artist-family"]', surface: '#artist-family-panel' },
  { name: 'Library check', flush: ['right'], open: page => page.evaluate(() => showStatusContextMenu()),
    anchor: '#scan-indicator', surface: '#status-context-menu' },
  { name: 'Settings', flush: ['right'], open: page => page.locator('#settings-button').click(),
    anchor: '#settings-button', surface: '#account-menu' },
  { name: 'Sources', flush: ['right'], open: page => page.locator('#gallery-sources-button').click(),
    anchor: '#gallery-sources-button', surface: '#gallery-sources-menu' },
  { name: 'PF filter', flush: ['right'], open: page => openProblemFilter(page, { selected: [] }),
    anchor: '#utility-problem-filter-button', surface: '#utility-problem-filter-menu' },
  { name: 'PF filter with a selection', flush: ['right'], open: page => openProblemFilter(page, { selected: ['Album not found'] }),
    anchor: '#utility-problem-filter-button', surface: '#utility-problem-filter-menu' },
  { name: 'Appearance sections', flush: ['right'], open: openAppearanceSections,
    anchor: '.mobile-settings-section-control', surface: '#mobile-settings-subsection-menu' },
  { name: 'Log History filter after a PF filter', flush: [], open: openLogHistoryPeriod,
    anchor: '#utility-problem-filter-button', surface: '#app-form-modal .confirm-modal-dialog' },
  // On a phone the calendar is wider than the room left of its trigger, so it extends both ways.
  { name: 'Log History calendar', flush: width => (width > 900 ? ['left'] : []), open: async page => {
    await openLogHistoryPeriod(page);
    await page.getByRole('button', { name: 'Choose to date', exact: true }).click();
  }, anchor: '[data-calendar-trigger="toDate"]', surface: '.calendar-picker' },
];

test.use({ deviceScaleFactor: 2 });

for (const width of [1440, 390]) {
  for (const dropdown of dropdowns) {
    test(`${dropdown.name} trigger and panel form one outline at ${width} px`, async ({ page }) => {
      await mountApp(page, width);
      await dropdown.open(page);
      const anchor = page.locator(dropdown.anchor);
      const surface = page.locator(dropdown.surface);
      await expect(surface).toBeVisible();
      await expect(anchor).toHaveClass(/trigger-anchor-open/);
      // Sliding drawers settle before the join is read.
      await surface.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const result = await measureAnchorJoin(page, anchor, surface);
      const flushSides = typeof dropdown.flush === 'function' ? dropdown.flush(width) : dropdown.flush;
      expectContinuousJoin(expect, result, { flushSides, label: `${dropdown.name} @${width}` });
    });
  }
}

test('the Appearance section picker is the shared dropdown component an Edit Tags dropdown uses', async ({ page }) => {
  await mountApp(page, 390);
  const read = selector => page.locator(selector).evaluate(input => {
    const style = getComputedStyle(input);
    return {
      wrapper: input.parentElement.classList.contains('ui-dropdown-control'),
      tag: input.tagName, type: input.type, role: input.getAttribute('role'), readOnly: input.readOnly,
      // Presentation comes from the component, not a page-local class on its field.
      fieldClasses: input.className,
      radius: ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(corner => style[`border${corner}Radius`]),
      borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle, borderColor: style.borderTopColor,
      background: style.backgroundColor, color: style.color,
    };
  });
  const editTags = await read('#tag-editor-exception-input');
  const appearance = await read('#mobile-settings-section-button');
  expect(editTags).toMatchObject({ wrapper: true, tag: 'INPUT', role: 'combobox', readOnly: true, fieldClasses: '' });
  expect(appearance).toEqual(editTags);
}
);

for (const width of [1440, 390]) {
  test(`the PF filter icon stays put closed, open, and with a selection at ${width} px`, async ({ page }) => {
    await mountApp(page, width);
    await page.evaluate(() => { document.getElementById('utility-modal').hidden = false; });
    const icon = page.locator('#utility-problem-filter-button svg');
    const box = async () => {
      await page.mouse.move(1, 1);
      return icon.evaluate(element => {
        const { left, top, width, height } = element.getBoundingClientRect();
        return { left, top, width, height };
      });
    };
    const render = state => page.evaluate(({ open, selected }) => {
      window.getProblemReasonTypes = () => ['Album not found', 'Encoding problem', 'Missing cover art', 'Missing year'];
      Object.assign(window.state.utility, { problematicFilesComplete: true, selectedProblemFilters: selected, problemDropdownOpen: open });
      renderProblemFilterControls({
        problemFilterButton: document.getElementById('utility-problem-filter-button'),
        problemFilterMenu: document.getElementById('utility-problem-filter-menu'),
      });
    }, state);
    await render({ open: false, selected: [] });
    const closed = await box();
    for (const state of [{ open: true, selected: [] }, { open: true, selected: ['Album not found'] },
      { open: false, selected: ['Album not found'] }]) {
      await render(state);
      expect(await box(), `icon position with ${JSON.stringify(state)}`).toEqual(closed);
    }
  });
}

// Owner-reported corners: where the trigger's side line meets the panel, both lines
// keep one 2 px width and meet square, with no step, overshoot, notch or stub.
for (const width of [1440, 375]) {
  for (const name of ['Artist Family', 'PF filter', 'Log History calendar', 'Appearance sections', 'Settings']) {
    test(`${name} trigger and panel meet at square corners at ${width} px`, async ({ page }) => {
      const dropdown = dropdowns.find(entry => entry.name === name);
      await mountApp(page, width);
      await dropdown.open(page);
      const surface = page.locator(dropdown.surface);
      await expect(surface).toBeVisible();
      await surface.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const result = await measureAnchorCorners(page, page.locator(dropdown.anchor), surface);
      expectSquareCorners(expect, result, { label: `${name} @${width}`, scale: 2 });
    });
  }
}
