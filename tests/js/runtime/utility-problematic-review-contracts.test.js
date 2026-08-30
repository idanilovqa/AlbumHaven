const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const builderPath = path.join(runtimeRoot, 'utility-list-builders.js');
const rendererPath = path.join(runtimeRoot, 'utility-renderers-and-actions.js');
const eventHandlerPath = path.join(runtimeRoot, 'bootstrap-utility-event-handlers.js');
const compactTablePath = path.join(runtimeRoot, 'compact-data-table.js');
const loaderPath = path.join(runtimeRoot, 'utility-loaders-and-cover-lookup.js');
const builderSource = fs.readFileSync(builderPath, 'utf8');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const eventHandlerSource = fs.readFileSync(eventHandlerPath, 'utf8');
const compactTableSource = fs.readFileSync(compactTablePath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');
const compactTableCss = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
  'compact-data-table.css',
), 'utf8');
const utilitiesCss = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
  'utilities.css',
), 'utf8');

function collectMobileMediaCss(source) {
  const blocks = [];
  const mediaPattern = /@media\s*\(max-width:\s*720px\)\s*\{/g;
  let match = mediaPattern.exec(source);
  while (match) {
    let depth = 1;
    let cursor = mediaPattern.lastIndex;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    blocks.push(source.slice(mediaPattern.lastIndex, cursor - 1));
    mediaPattern.lastIndex = cursor;
    match = mediaPattern.exec(source);
  }
  return blocks.join('\n');
}

function cssRuleBody(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(
    new RegExp(`(?:^|\\})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`, 's'),
  )?.[1] || '';
}

function createRuntimeContext() {
  const context = {
    console,
    state: {
      utility: {
        activeTab: 'problematic-files',
        loaded: true,
        loading: false,
        problematicFiles: [],
        selectedProblematicKey: '',
        selectedProblemFilters: [],
        problemExclusionSelections: {},
        repairSelections: {},
        repairDragActive: false,
        repairDragChoice: 'repair',
        repairDragClearOnClick: false,
        repairSuppressClick: false,
      },
      tagEditor: {
        dragSelecting: false,
        dragAnchorPath: '',
      },
      coverLookup: {},
    },
    document: { activeElement: null },
    scheduleBrowserTimeout(callback) {
      callback();
      return 1;
    },
    renderUtilityModalContent() {},
  };
  vm.createContext(context);
  vm.runInContext(builderSource, context, { filename: builderPath });
  vm.runInContext(rendererSource, context, { filename: rendererPath });
  vm.runInContext(eventHandlerSource, context, { filename: eventHandlerPath });
  return context;
}

function createClosestEvent(target, overrides = {}) {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    preventDefault() {},
    target: {
      closest(selector) {
        return target.matches?.includes(selector) ? target : null;
      },
    },
    ...overrides,
  };
}

test('pending detail is inert while its accessible status overlay leaves the sidebar usable', () => {
  const context = createRuntimeContext();
  const attributes = new Map();
  let overlayMarkup = '';
  const detail = {
    innerHTML: '<button type="button">Repair tags</button>',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    querySelector() { return null; },
    insertAdjacentHTML(_position, html) { overlayMarkup = html; },
  };
  const list = { scrollTop: 0 };
  context.state.utility.problematicFiles = [{ key: 'album-pending' }];
  context.state.utility.selectedProblematicKey = 'album-pending';
  context.state.utility.problematicMutation = {
    taskId: 'save-1',
    albumKey: 'album-pending',
    priorScrollTop: 237,
  };
  context.getFilteredProblematicAlbums = () => context.state.utility.problematicFiles;
  context.getUtilityModalElements = () => ({
    overlay: {},
    list,
    detail,
    count: { textContent: '' },
  });
  context.renderProblemFilterControls = () => {};

  context.renderProblematicFiles();

  assert.equal(attributes.get('aria-busy'), 'true');
  assert.equal(attributes.has('inert'), false, 'the detail root must leave the status overlay perceivable');
  assert.match(
    detail.innerHTML,
    /class="problematic-mutation-content" data-problematic-mutation-content inert/,
    'only the preserved detail controls become inert',
  );
  assert.match(overlayMarkup, /role="status"/);
  assert.match(overlayMarkup, /aria-live="polite"/);
  assert.match(overlayMarkup, /Hold on\. Your changes are being applied/);
  assert.equal(Object.prototype.hasOwnProperty.call(list, 'inert'), false, 'sidebar navigation stays usable');
  assert.equal(list.scrollTop, 237);
});

test('approved mobile Problematic Files and Rules turn the album sidebar into a horizontal card strip', () => {
  const mobileCss = collectMobileMediaCss(utilitiesCss);
  for (const activeTab of ['problematic-files', 'rules']) {
    const scope = `#utility-modal[data-active-tab="${activeTab}"]`;
    const sidebarRule = cssRuleBody(mobileCss, `${scope} .utility-sidebar`);
    const listRule = cssRuleBody(mobileCss, `${scope} .utility-list`);
    const itemRule = cssRuleBody(mobileCss, `${scope} .utility-list-item`);

    assert.match(sidebarRule, /max-height\s*:/, 'the strip must reserve bounded vertical space');
    assert.match(sidebarRule, /border-right\s*:\s*(?:0|none)/);
    assert.match(listRule, /flex-direction\s*:\s*row/);
    assert.match(listRule, /overflow-x\s*:\s*auto/);
    assert.match(listRule, /overflow-y\s*:\s*(?:hidden|clip)/);
    assert.match(itemRule, /flex\s*:\s*0\s+0\s+/);
    assert.match(itemRule, /width\s*:/, 'cards need a compact fixed or bounded strip width');
  }
  assert.equal(cssRuleBody(mobileCss, '.utility-sidebar'), '');
  assert.equal(cssRuleBody(mobileCss, '.utility-list'), '');
  assert.equal(cssRuleBody(mobileCss, '.utility-list-item'), '');
});

test('approved mobile Problems Rules and mutation states scope detail containment to owning tabs', () => {
  const mobileCss = collectMobileMediaCss(utilitiesCss);

  for (const activeTab of ['problematic-files', 'rules']) {
    const scope = `#utility-modal[data-active-tab="${activeTab}"]`;
    const dialogRule = cssRuleBody(mobileCss, `${scope} .utility-modal-dialog`);
    const bodyRule = cssRuleBody(mobileCss, `${scope} .utility-modal-body`);
    const detailRule = cssRuleBody(mobileCss, `${scope} .utility-detail`);

    assert.match(dialogRule, /(?:height|max-height)\s*:[^;]*(?:dvh|svh)/);
    assert.match(bodyRule, /grid-template-columns\s*:\s*(?:1fr|minmax\(0,\s*1fr\))/);
    assert.match(
      bodyRule,
      /grid-template-rows\s*:\s*(?:auto|minmax\(0,\s*auto\))\s+minmax\(0,\s*1fr\)/,
    );
    assert.match(bodyRule, /overflow\s*:\s*(?:hidden|clip)/);
    assert.match(detailRule, /min-height\s*:\s*0/);
    assert.match(detailRule, /overflow-y\s*:\s*auto/);
  }
  assert.equal(cssRuleBody(mobileCss, '.utility-modal-dialog'), '');
  assert.equal(cssRuleBody(mobileCss, '.utility-modal-body'), '');
  assert.equal(cssRuleBody(mobileCss, '.utility-detail'), '');
});

test('approved mobile Problematic Files keeps an 84px cover beside detail metadata', () => {
  const mobileCss = collectMobileMediaCss(utilitiesCss);
  const scope = '#utility-modal[data-active-tab="problematic-files"]';
  const headerRule = cssRuleBody(mobileCss, `${scope} .utility-detail-header`);
  const coverRule = cssRuleBody(mobileCss, `${scope} .utility-detail-cover`);

  assert.match(
    headerRule,
    /grid-template-columns\s*:\s*84px\s+minmax\(0,\s*1fr\)/,
  );
  assert.match(headerRule, /align-items\s*:\s*start/);
  assert.match(coverRule, /width\s*:\s*84px/);
  assert.match(coverRule, /height\s*:\s*84px/);
});

test('utility render exposes the active tab for scoped responsive layout', () => {
  const context = createRuntimeContext();
  const attributes = new Map();
  const overlay = {
    setAttribute(name, value) { attributes.set(name, String(value)); },
  };
  context.getUtilityModalElements = () => ({
    overlay,
    detail: { classList: { remove() {} } },
    tabs: [],
  });
  context.renderProblematicFiles = () => {};

  context.state.utility.activeTab = 'problematic-files';
  context.renderUtilityModalContent();
  assert.equal(attributes.get('data-active-tab'), 'problematic-files');

  context.state.utility.activeTab = 'rules';
  context.renderUtilityRules = () => {};
  context.renderUtilityModalContent();
  assert.equal(attributes.get('data-active-tab'), 'rules');
});

test('Rules keeps the 88px Actions header semantic but visually hidden on desktop', () => {
  const context = {
    escapeHtml(value) { return String(value ?? ''); },
  };
  vm.createContext(context);
  vm.runInContext(compactTableSource, context, { filename: compactTablePath });
  const html = context.buildCompactDataTable({
    id: 'problem-exclusion-rules',
    columns: 'minmax(220px,.42fr) minmax(180px,.58fr) 88px',
    columnsConfig: [
      { key: 'target', label: 'Album' },
      { key: 'reason', label: 'Reason' },
      { key: 'action', label: 'Actions', header: 'screen-reader', action: true },
    ],
    headers: 'visible',
    rows: [{
      key: 'rule-1',
      cells: { target: 'Album', reason: 'Missing cover art', action: 'Revert rule' },
    }],
  });
  const hiddenActionHeaderCss = cssRuleBody(
    compactTableCss,
    '.compact-data-table [role="columnheader"].sr-only',
  );

  assert.match(
    html,
    /role="columnheader"[^>]*data-cdt-column="action"[^>]*class="sr-only"[^>]*>Actions<\/div>/,
  );
  assert.match(hiddenActionHeaderCss, /position\s*:\s*absolute/);
  assert.match(hiddenActionHeaderCss, /width\s*:\s*1px/);
  assert.match(hiddenActionHeaderCss, /height\s*:\s*1px/);
  assert.match(hiddenActionHeaderCss, /overflow\s*:\s*hidden/);
});

test('390px exclusion confirmation uses its own wide one-line approved sentence mode', () => {
  const overlayAttributes = new Map();
  const elements = {
    overlay: {
      hidden: true,
      setAttribute(name, value) { overlayAttributes.set(name, String(value)); },
      removeAttribute(name) { overlayAttributes.delete(name); },
    },
    dialog: {
      setAttribute() {},
      removeAttribute() {},
    },
    title: { hidden: false, textContent: '' },
    text: { textContent: '' },
    cancel: { textContent: '' },
    accept: { textContent: '' },
  };
  const context = {
    document: {
      activeElement: null,
      body: { classList: { add() {} } },
    },
    state: { utility: { pendingRepairAction: 'detected' } },
    getIgnoredRepairRowKeys() { return ['opaque-row-key']; },
    getRepairConfirmElements() { return elements; },
    getSelectedRepairRowKeys() { return []; },
    getSelectedSeparateReleaseKeys() { return ['artist::album']; },
  };
  vm.createContext(context);
  vm.runInContext(loaderSource, context, { filename: loaderPath });

  context.openRepairConfirmModal();

  const mobileCss = collectMobileMediaCss(utilitiesCss);
  const overlayRule = cssRuleBody(
    mobileCss,
    '#repair-confirm-modal[data-confirm-mode="exclusion"]',
  );
  const dialogRule = cssRuleBody(
    mobileCss,
    '#repair-confirm-modal[data-confirm-mode="exclusion"] .confirm-modal-dialog',
  );
  const textRule = cssRuleBody(
    mobileCss,
    '#repair-confirm-modal[data-confirm-mode="exclusion"] .confirm-modal-text',
  );
  assert.equal(overlayAttributes.get('data-confirm-mode'), 'exclusion');
  assert.equal(elements.text.textContent, 'Are you sure? This will create an exclusion rule');
  assert.match(overlayRule, /padding-inline\s*:\s*18px/);
  assert.match(dialogRule, /width\s*:\s*(?:100%|min\([^;]*100%[^;]*\))/);
  assert.match(textRule, /white-space\s*:\s*nowrap/);
});

test('problem pill rerender restores focus to the equivalent selected pill', () => {
  const context = createRuntimeContext();
  const rowKey = 'opaque-file-missing-year';
  let replacementFocused = false;
  const original = {
    matches: ['[data-problem-exclusion-row-key]'],
    getAttribute(name) {
      return {
        'data-problem-exclusion-row-key': rowKey,
        'data-problem-exclusion-scope': 'file',
        'data-problem-exclusion-reason': 'Missing year',
        'data-problem-exclusion-row-index': '0',
      }[name] || '';
    },
  };
  const replacement = {
    focus() { replacementFocused = true; },
  };
  context.document.activeElement = original;
  context.selectProblemExclusion = (selectedRowKey) => {
    context.state.utility.problemExclusionSelections = { [selectedRowKey]: true };
  };
  context.renderUtilityModalContent = () => {
    context.document.activeElement = null;
  };
  context.document.querySelector = (selector) => (
    selector.includes(rowKey) ? replacement : null
  );

  context.handleUtilityBootstrapMouseDown(createClosestEvent(original));

  assert.equal(replacementFocused, true, 'selection rerender must return focus to the same logical pill');
});

test('unchanged repair-choice mouseover does not rerender or detach tags and mouseup ends drag state', () => {
  const context = createRuntimeContext();
  const rowKey = 'repair-row-1';
  let connected = true;
  let renders = 0;
  const button = {
    matches: ['[data-repair-choice]'],
    classList: { contains() { return false; } },
    getAttribute(name) {
      if (name === 'data-repair-choice') return 'repair';
      if (name === 'data-repair-row-key') return rowKey;
      return '';
    },
  };
  context.state.utility.repairSelections = { [rowKey]: 'repair' };
  context.state.utility.repairDragActive = true;
  context.state.utility.repairDragChoice = 'repair';
  context.state.tagEditor.dragSelecting = true;
  context.state.tagEditor.dragAnchorPath = 'C:/Music/01.flac';
  context.renderUtilityModalContent = () => {
    renders += 1;
    connected = false;
  };

  const handled = context.handleUtilityBootstrapMouseOver(createClosestEvent(button));
  context.handleUtilityBootstrapMouseUp(createClosestEvent(button));

  assert.equal(handled, true);
  assert.equal(renders, 0, 'hovering an already-selected choice must not replace the rendered Repair tags');
  assert.equal(connected, true);
  assert.equal(context.state.utility.repairDragActive, false);
  assert.equal(context.state.tagEditor.dragSelecting, false);
  assert.equal(context.state.tagEditor.dragAnchorPath, '');
});
