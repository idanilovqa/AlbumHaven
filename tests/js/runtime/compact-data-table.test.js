const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'compact-data-table.js',
);
const componentCssPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
  'compact-data-table.css',
);
const utilitiesCssPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
  'utilities.css',
);

function loadRenderer({buttons = false} = {}) {
  assert.equal(
    fs.existsSync(rendererPath),
    true,
    'the approved reusable CompactDataTable renderer must be a production runtime module',
  );
  const context = {
    escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    },
  };
  if (buttons) context.ButtonComponent = require(path.join(path.dirname(rendererPath), '..', 'button-component.js'));
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(rendererPath, 'utf8'), context, { filename: rendererPath });
  assert.equal(typeof context.buildCompactDataTable, 'function');
  return context.buildCompactDataTable;
}

test('multiple selection is presentation-only and retains table semantics', () => {
  const html = loadRenderer()({selection: 'multiple', columnsConfig: [{key: 'title', label: 'Track'}],
    rows: [{key: 'first-occurrence', ariaSelected: true, tabIndex: 0, cells: {title: 'One'}},
      {key: 'second-occurrence', ariaSelected: true, tabIndex: 0, cells: {title: 'One again'}}]});
  assert.match(html, /role="table"/); assert.match(html, /data-cdt-selection="multiple"/);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 2);
  assert.doesNotMatch(html, /role="grid"|aria-multiselectable|aria-activedescendant/);
  const css = fs.readFileSync(componentCssPath, 'utf8');
  assert.match(css, /data-cdt-selection="multiple"[^{}]*aria-selected="true"/);
  assert.match(css, /data-cdt-selection="multiple"[^{}]*:focus-visible/);
});

test('narrow columns hide matching headers and cells only when an alternate grid is supplied', () => {
  const render = loadRenderer();
  const config = {columns: '1fr 60px 20px', narrowColumns: '1fr', columnsConfig: [
    {key: 'title', label: 'Title'}, {key: 'rating', label: 'Rating', hideWhenNarrow: true},
    {key: 'action', header: 'absent', hideWhenNarrow: true, action: true},
  ], rows: [{key: 'one', cells: {title: 'Track', rating: '4', action: 'Select'}}]};
  const html = render(config);
  assert.match(html, /data-cdt-narrow="true"/);
  assert.match(html, /--cdt-narrow-columns: 1fr/);
  assert.equal((html.match(/data-cdt-hide-narrow/g) || []).length, 4);
  assert.doesNotMatch(render({...config, narrowColumns: undefined}), /data-cdt-hide-narrow|data-cdt-narrow=/);
});

test('buildCompactDataTable renders deterministic accessible structure without domain policy', () => {
  const buildCompactDataTable = loadRenderer();
  const config = {
    ariaLabel: 'Problem exclusions',
    columns: 'minmax(220px,.42fr) minmax(300px,.58fr) 88px',
    headers: 'visible',
    density: 'compact',
    overflow: 'local',
    mobile: 'stack',
    frame: 'outline',
    actionTrackWidth: '88px',
    columnsConfig: [
      { key: 'target', label: 'Filename' },
      { key: 'reason', label: 'Reason' },
      { key: 'action', label: 'Actions', header: 'screen-reader', action: true },
    ],
    rows: [
      {
        key: 'opaque-row-2',
        ariaSelected: true,
        cells: {
          target: '<strong>Second.flac</strong>',
          reason: '<span>Missing year</span>',
          action: '<button type="button">Revert rule</button>',
        },
      },
      {
        key: 'opaque-row-1',
        cells: {
          target: '<strong>First.flac</strong>',
          reason: '<span>Missing artist</span>',
          action: '',
        },
      },
    ],
  };

  const first = buildCompactDataTable(config);
  const second = buildCompactDataTable(config);
  assert.equal(first, second);
  assert.match(first, /role="table"/);
  assert.match(first, /aria-label="Problem exclusions"/);
  assert.match(first, /data-cdt-headers="visible"/);
  assert.match(first, /data-cdt-density="compact"/);
  assert.match(first, /data-cdt-overflow="local"/);
  assert.match(first, /data-cdt-mobile="stack"/);
  assert.match(first, /data-cdt-frame="outline"/);
  assert.match(first, /--cdt-action-track:\s*88px/);
  assert.match(first, /role="columnheader"[^>]*>Filename</);
  assert.match(first, /role="columnheader"[^>]*>Reason</);
  assert.match(first, /role="columnheader"[^>]*class="[^"]*sr-only/);
  assert.equal((first.match(/role="row"/g) || []).length, 3);
  assert.equal((first.match(/role="cell"/g) || []).length, 6);
  assert.ok(first.indexOf('opaque-row-2') < first.indexOf('opaque-row-1'));
  assert.match(first, /data-cdt-row-key="opaque-row-2"[^>]*aria-selected="true"/);
  assert.match(first, /data-cdt-column="reason"/);
  assert.match(first, /data-cdt-action/);
  assert.doesNotMatch(first, /repairSelections|ignored_rows|Exclude the problem|fetch\(/);
});

test('buildCompactDataTable supports screen-reader and absent headers plus preserve mode', () => {
  const buildCompactDataTable = loadRenderer();
  const baseConfig = {
    columns: '1fr 1fr',
    density: 'default',
    overflow: 'local',
    mobile: 'preserve',
    frame: 'inset',
    columnsConfig: [
      { key: 'filename', label: 'Filename' },
      { key: 'reason', label: 'Reason' },
    ],
    rows: [{ key: 'row-a', cells: { filename: 'A.flac', reason: 'Missing year' } }],
  };
  const screenReader = buildCompactDataTable({ ...baseConfig, headers: 'screen-reader' });
  const absent = buildCompactDataTable({ ...baseConfig, headers: 'absent' });

  assert.match(screenReader, /data-cdt-headers="screen-reader"/);
  assert.equal((screenReader.match(/role="columnheader"/g) || []).length, 2);
  assert.equal((screenReader.match(/class="[^"]*sr-only/g) || []).length, 2);
  assert.match(screenReader, /data-cdt-mobile="preserve"/);
  assert.match(screenReader, /data-cdt-frame="inset"/);
  assert.doesNotMatch(absent, /role="columnheader"/);
  assert.doesNotMatch(absent, />Filename<|>Reason</);
});

test('buildCompactDataTable supports an absent header per column without removing its body cell', () => {
  const buildCompactDataTable = loadRenderer();
  const html = buildCompactDataTable({
    headers: 'visible',
    columnsConfig: [
      { key: 'filename', label: 'Filename' },
      { key: 'reason', label: 'Reason' },
      { key: 'action', label: 'Actions', header: 'absent', action: true },
    ],
    rows: [{
      key: 'row-a',
      cells: {
        filename: 'A.flac',
        reason: 'Missing year',
        action: '<button type="button">Revert rule</button>',
      },
    }],
  });

  assert.equal((html.match(/role="columnheader"/g) || []).length, 2);
  assert.doesNotMatch(html, />Actions</);
  assert.match(html, /role="cell"[^>]*data-cdt-column="action"[^>]*data-cdt-action/);
  assert.match(html, />Revert rule</);
});

test('mobile stack keeps semantic header associations without adding visible mobile labels', () => {
  const buildCompactDataTable = loadRenderer();
  const html = buildCompactDataTable({
    id: 'rules-file-exclusions',
    headers: 'visible',
    mobile: 'stack',
    columnsConfig: [
      { key: 'target', label: 'Filename' },
      { key: 'reason', label: 'Reason' },
      { key: 'action', label: 'Actions', header: 'screen-reader', action: true },
    ],
    rows: [{
      key: 'file-rule-a',
      cells: {
        target: '<strong>A.flac</strong>',
        reason: '<span>Missing year</span>',
        action: '<button type="button">Revert rule</button>',
      },
    }],
  });
  const css = fs.readFileSync(componentCssPath, 'utf8');

  for (const column of ['target', 'reason', 'action']) {
    assert.match(
      html,
      new RegExp(`role="columnheader"[^>]*data-cdt-column="${column}"[^>]*id="rules-file-exclusions-header-${column}"`),
      `${column} must keep a stable header identity even when the mobile header row is visually omitted`,
    );
    assert.match(
      html,
      new RegExp(`role="cell"[^>]*data-cdt-column="${column}"[^>]*aria-labelledby="rules-file-exclusions-header-${column}"`),
      `${column} cells must retain an explicit accessible header association in mobile stack mode`,
    );
  }
  const mobileHeaderRule = css.match(
    /\.compact-data-table\[data-cdt-mobile="stack"\] \.compact-data-table-header\s*\{([^}]*)\}/s,
  )?.[1] || '';
  assert.doesNotMatch(
    mobileHeaderRule,
    /(?:display:\s*none|visibility:\s*hidden)/,
    'mobile headers must remain in the accessibility tree',
  );
  assert.match(mobileHeaderRule, /position:\s*absolute/);
  assert.match(mobileHeaderRule, /width:\s*1px/);
  assert.match(mobileHeaderRule, /height:\s*1px/);
  assert.match(
    mobileHeaderRule,
    /(?:clip:\s*rect\(0(?:px)?\s*,?\s*0(?:px)?\s*,?\s*0(?:px)?\s*,?\s*0(?:px)?\)|clip-path:\s*inset\(50%\))/,
    'mobile headers must use a standard visually-hidden clipping technique',
  );
  assert.doesNotMatch(
    css,
    /data-cdt-mobile="stack"[^{}]*(?:::before|::after)[^{}]*content:\s*(?:attr\(|['"](?:Filename|Reason|Actions))/s,
    'mobile stack must not inject visible per-cell labels that the approved artifact omits',
  );
});

test('an absent middle header keeps its grid slot so later headers remain aligned', () => {
  const buildCompactDataTable = loadRenderer();
  const html = buildCompactDataTable({
    id: 'mixed-header-table',
    headers: 'visible',
    columnsConfig: [
      { key: 'target', label: 'Filename' },
      { key: 'reason', label: 'Reason', header: 'absent' },
      { key: 'action', label: 'Actions', header: 'screen-reader', action: true },
    ],
    rows: [{
      key: 'row-a',
      cells: {
        target: 'A.flac',
        reason: 'Missing year',
        action: '<button type="button">Revert rule</button>',
      },
    }],
  });
  const headerMarkup = html.match(/<div role="row" class="compact-data-table-header">([\s\S]*?)<\/div><div role="rowgroup"/)?.[1] || '';

  assert.equal((headerMarkup.match(/data-cdt-column=/g) || []).length, 3);
  assert.equal((headerMarkup.match(/role="columnheader"/g) || []).length, 2);
  assert.match(
    headerMarkup,
    /data-cdt-column="target"[\s\S]*data-cdt-column="reason"[^>]*aria-hidden="true"[\s\S]*data-cdt-column="action"/,
    'the absent middle header must render a non-semantic placeholder in its original grid track',
  );
  assert.doesNotMatch(headerMarkup, />Reason</);
  assert.match(headerMarkup, /data-cdt-column="action"[^>]*>Actions</);
});

test('buildCompactDataTable preserves frame none and reflects cell accessibility state', () => {
  const buildCompactDataTable = loadRenderer();
  const html = buildCompactDataTable({
    frame: 'none',
    columnsConfig: [{ key: 'problem', label: 'Problem' }],
    rows: [{
      key: 'album-problem',
      cells: {
        problem: {
          content: '<button type="button">Missing cover art</button>',
          ariaSelected: true,
          ariaDisabled: true,
          ariaLabel: 'Missing cover art problem',
        },
      },
    }],
  });

  assert.match(html, /data-cdt-frame="none"/);
  assert.match(
    html,
    /role="cell"[^>]*data-cdt-column="problem"[^>]*aria-selected="true"[^>]*aria-disabled="true"[^>]*aria-label="Missing cover art problem"/,
  );
  assert.match(html, /<button type="button">Missing cover art<\/button>/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test('buildCompactDataTable renders configured empty and helper output', () => {
  const buildCompactDataTable = loadRenderer();
  const empty = buildCompactDataTable({
    columnsConfig: [{ key: 'filename', label: 'Filename' }],
    rows: [],
    emptyHtml: '<p>No track-level problems remain.</p>',
    helperHtml: '<p>Problems excluded here become Rules.</p>',
  });
  const populated = buildCompactDataTable({
    columnsConfig: [{ key: 'filename', label: 'Filename' }],
    rows: [{ key: 'row-a', cells: { filename: 'A.flac' } }],
    emptyHtml: '<p>No track-level problems remain.</p>',
    helperHtml: '<p>Problems excluded here become Rules.</p>',
  });

  assert.match(empty, /data-cdt-empty[^]*No track-level problems remain\./);
  assert.match(empty, /data-cdt-helper[^]*Problems excluded here become Rules\./);
  assert.doesNotMatch(populated, /data-cdt-empty|No track-level problems remain\./);
  assert.match(populated, /data-cdt-helper[^]*Problems excluded here become Rules\./);
});

test('CompactDataTable is markup and layout only without global listeners or selection mutation', () => {
  const source = fs.readFileSync(rendererPath, 'utf8');
  assert.doesNotMatch(source, /document\s*\.\s*addEventListener/);
  assert.doesNotMatch(source, /\b(?:setRowSelected|clearSelection)\b/);
  assert.doesNotMatch(source, /compact-table-select|new\s+CustomEvent/);
  assert.doesNotMatch(
    source,
    /repairSelections|ignored_rows|Exclude the problem|problem-exclusion/,
  );
});

test('buildCompactDataTable creates its automatic empty-state region for zero rows', () => {
  const buildCompactDataTable = loadRenderer();
  const html = buildCompactDataTable({
    ariaLabel: 'Empty table',
    columnsConfig: [{ key: 'filename', label: 'Filename' }],
    rows: [],
  });

  assert.match(html, /data-cdt-empty/);
});

test('local overflow has one structural owner in the shared component', () => {
  const componentCss = fs.readFileSync(componentCssPath, 'utf8');
  const utilitiesCss = fs.readFileSync(utilitiesCssPath, 'utf8');

  assert.match(
    componentCss,
    /\.compact-data-table\[data-cdt-overflow="local"\]\s*\{[^}]*overflow-x:\s*auto/s,
  );
  assert.doesNotMatch(
    utilitiesCss,
    /\.utility-track-problem-table\s*\{[^}]*overflow-x:\s*auto/s,
    'the domain wrapper must not become a second horizontal-scroll owner',
  );
  assert.match(
    utilitiesCss,
    /\.utility-track-problem-table \.compact-data-table\s*\{[^}]*--cdt-mobile-min-width:\s*560px/s,
  );
  assert.doesNotMatch(
    utilitiesCss,
    /\.utility-track-problem-table \.compact-data-table\s*\{[^}]*(?:^|[^-])min-width:\s*560px/ms,
    'the scroll-owner root must stay contained instead of expanding itself to 560px',
  );
  assert.match(
    componentCss,
    /@media[^{}]*\{[^]*data-cdt-mobile="preserve"[^]*\.compact-data-table-(?:header|row)[^}]*min-width:\s*var\(--cdt-mobile-min-width/s,
    'mobile preserve applies the configured minimum to the inner grid while the table root owns overflow',
  );
  assert.doesNotMatch(
    utilitiesCss,
    /(?:html|body|#utility-problematic-detail)\s*\{[^}]*min-width:\s*560px/s,
    'the approved 560px mobile minimum belongs to the locally scrolling table only',
  );
});

test('Problematic Files album and track groups keep the approved separate outer frames and inset spacing', () => {
  const css = fs.readFileSync(utilitiesCssPath, 'utf8');
  const approvedOuterFrame = (selector) => new RegExp(
    `${selector}\\s*\\{[^}]*border:\\s*1px solid rgba\\(148,\\s*163,\\s*184,\\s*0\\.18\\)`
      + `[^}]*border-radius:\\s*12px[^}]*background:\\s*transparent`,
    's',
  );

  assert.match(css, approvedOuterFrame('\\.utility-album-problem-list'));
  assert.match(css, approvedOuterFrame('\\.utility-track-problem-table'));
  assert.match(
    css,
    /\.utility-track-problem-table\s*\{[^}]*padding:\s*12px/s,
    'the inset track table starts 12px inside its outer frame on desktop',
  );
  assert.match(
    css,
    /@media\s*\(max-width:[^)]+\)\s*\{[^]*?\.utility-track-problem-table\s*\{[^}]*padding:\s*10px/s,
    'the inset track table starts 10px inside its outer frame on mobile',
  );
});

test('standalone framed tables use the themed surface and approved structural palette', () => {
  const css = fs.readFileSync(componentCssPath, 'utf8');

  assert.match(
    css,
    /\.compact-data-table\[data-cdt-frame="outline"\]\s*\{[^}]*border:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.18\)[^}]*background:\s*var\(--appearance-table-surface,/s,
  );
  assert.match(
    css,
    /\.compact-data-table\[data-cdt-frame="outline"\] \.compact-data-table-header\s*\{[^}]*border-bottom:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.18\)/s,
  );
  assert.match(
    css,
    /\.compact-data-table\[data-cdt-frame="inset"\] \.compact-data-table-header\s*\{[^}]*border-bottom:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.12\)/s,
  );
  assert.match(
    css,
    /\.compact-data-table-row \+ \.compact-data-table-row\s*\{[^}]*color-mix\([^;]*65%[^;]*transparent\)/s,
  );
  assert.doesNotMatch(
    css,
    /\.compact-data-table-header\s*\{[^}]*background:/s,
    'the approved standalone table has no separate header fill',
  );
});

test('compact table keeps approved compact row geometry', () => {
  const css = fs.readFileSync(componentCssPath, 'utf8');

  assert.match(
    css,
    /\.compact-data-table\s*\{[^}]*--cdt-row-min-height:\s*34px[^}]*--cdt-row-padding:\s*7px 12px[^}]*--cdt-gap:\s*12px/s,
    'default table geometry must retain the approved reusable component tokens',
  );
  assert.match(
    css,
    /\.compact-data-table\[data-cdt-density="compact"\]\s*\{[^}]*--cdt-row-min-height:\s*29px[^}]*--cdt-row-padding:\s*5px 10px[^}]*--cdt-gap:\s*8px/s,
    'compact rows must use the approved 29px minimum, 5px/10px padding, and 8px gap',
  );
  assert.match(
    css,
    /\.compact-data-table-header,\s*\.compact-data-table-row\s*\{[^}]*gap:\s*var\(--cdt-gap\)[^}]*min-height:\s*var\(--cdt-row-min-height\)[^}]*padding:\s*var\(--cdt-row-padding\)/s,
  );
});

test('compact table keeps approved title-case headers with normal spacing', () => {
  const css = fs.readFileSync(componentCssPath, 'utf8');
  const headerRule = css.match(/\.compact-data-table \[role="columnheader"\]\s*\{([^}]*)\}/s);

  assert.ok(headerRule, 'the shared component must define its column-header typography');
  assert.doesNotMatch(headerRule[1], /text-transform:\s*uppercase/);
  assert.doesNotMatch(headerRule[1], /letter-spacing:\s*0\.08em/);
});

test('sortable headers use native shared Buttons and announce current and next directions', () => {
  const render = loadRenderer({buttons: true});
  const config = {id: 'metrics', columnsConfig: [
    {key: 'title', label: 'Track'}, {key: 'plays', label: 'Plays', sortable: true},
    {key: 'duration', label: 'Length', sortable: true},
  ], rows: [{key: 'second', cells: {title: 'Second'}}, {key: 'first', cells: {title: 'First'}}]};
  for (const [direction, ariaSort, current, next] of [
    ['default', 'none', 'default order', 'ascending order'],
    ['asc', 'ascending', 'ascending', 'descending order'],
    ['desc', 'descending', 'descending', 'default order'],
  ]) {
    const html = render({...config, sort: {key: 'plays', direction}});
    assert.match(html, new RegExp(`role="columnheader"[^>]*data-cdt-column="plays"[^>]*aria-sort="${ariaSort}"`));
    assert.match(html, /role="columnheader"[^>]*data-cdt-column="duration"[^>]*aria-sort="none"/);
    assert.match(html, new RegExp(`aria-label="Sort by Plays: ${current}\\. Activate for ${next}\\."`));
    assert.match(html, /<button type="button" class="button ui-button ui-button--secondary ui-button--small ui-button--quiet compact-data-table__sort"/);
    assert.match(html, new RegExp(`data-cdt-sort="plays" data-cdt-sort-direction="${direction}"`));
    assert.match(html, /class="compact-data-table__sort-label">Plays<\/span>/);
    assert.match(html, /sort-icon"[^>]*aria-hidden="true"/);
    assert.doesNotMatch(html, /<button[^>]*(?:aria-sort|aria-pressed|tabindex|onkeydown|onclick|role)=/);
    assert.match(html, /role="cell"[^>]*data-cdt-column="plays"[^>]*aria-labelledby="metrics-header-plays"/);
    assert.ok(html.indexOf('data-cdt-row-key="second"') < html.indexOf('data-cdt-row-key="first"'), 'the renderer never sorts source rows');
  }
});

test('sorting opt-in preserves ordinary and hidden headers without a Button dependency', () => {
  const render = loadRenderer();
  const plain = {columnsConfig: [{key: 'plays', label: 'Plays'}], rows: []};
  const normal = render(plain);
  assert.equal(render({...plain, sort: {key: 'plays', direction: 'desc'}}), normal);
  assert.doesNotMatch(normal, /<button|aria-sort|data-cdt-sort/);
  for (const key of [undefined, null, 0, '', ' ']) {
    assert.doesNotMatch(render({columnsConfig: [{key, label: 'Plays', sortable: true}]}), /<button|aria-sort|data-cdt-sort/);
  }
  for (const headers of ['screen-reader', 'absent']) {
    assert.doesNotMatch(render({...plain, headers, columnsConfig: [{key: 'plays', label: 'Plays', sortable: true}]}), /<button|aria-sort|data-cdt-sort/);
    assert.doesNotMatch(render({...plain, columnsConfig: [{key: 'plays', label: 'Plays', sortable: true, header: headers}]}), /<button|aria-sort|data-cdt-sort/);
  }
});

test('locked sort headers use native disabled state while retaining the current view direction', () => {
  const render = loadRenderer({buttons: true});
  const config = {columnsConfig: [{key: 'plays', label: 'Plays', sortable: true},
    {key: 'duration', label: 'Length', sortable: true}], sort: {key: 'plays', direction: 'desc'}};
  const locked = render({...config, sortDisabled: true});
  assert.equal((locked.match(/ disabled aria-disabled="true"/g) || []).length, 2);
  assert.match(locked, /data-cdt-column="plays"[^>]*aria-sort="descending"/);
  assert.match(locked, /data-cdt-column="duration"[^>]*aria-sort="none"/);
  assert.match(locked, /data-cdt-sort="plays" data-cdt-sort-direction="desc"/);
  assert.match(locked, /aria-label="Sort by Plays: descending\."/);
  assert.doesNotMatch(locked, /Activate for/);
  for (const sortDisabled of [undefined, false, 'true', 1]) {
    const active = render({...config, sortDisabled});
    assert.doesNotMatch(active, / disabled|aria-disabled/);
    assert.match(active, /aria-label="Sort by Plays: descending\. Activate for default order\."/);
  }
});

test('sortable labels and action keys remain escaped literal data', () => {
  const render = loadRenderer({buttons: true});
  const key = 'plays" autofocus="', label = 'Plays <img src=x> & "mine"';
  const html = render({columnsConfig: [{key, label, sortable: true}], sort: {key, direction: 'asc'}});
  assert.match(html, /data-cdt-sort="plays&quot; autofocus=&quot;"/);
  assert.match(html, /class="compact-data-table__sort-label">Plays &lt;img src=x&gt; &amp; &quot;mine&quot;<\/span>/);
  assert.doesNotMatch(html, /<img| autofocus="/);
  assert.match(html, /aria-sort="ascending"/);
  assert.match(render({columnsConfig: [{key: 'plays', label: 'Plays', sortable: true}], sort: {key: 'plays', direction: 'unexpected'}}), /aria-sort="none"/);
});

test('only explicitly focusable data rows enter keyboard order', () => {
  const render = loadRenderer();
  const html = render({columnsConfig: [{key: 'title', label: 'Title'}], rows: [
    {key: 'normal'}, {key: 'focusable', tabIndex: 0}, {key: 'programmatic', tabIndex: -1},
    {key: 'disabled', ariaDisabled: true, tabIndex: 0}, {key: 'invalid-number', tabIndex: 1},
    {key: 'invalid-string', tabIndex: '0'}, {key: 'status', fullSpanContent: 'Unavailable', tabIndex: 0},
  ]});
  assert.match(html, /data-cdt-row-key="focusable" tabindex="0"/);
  assert.match(html, /data-cdt-row-key="programmatic" tabindex="-1"/);
  assert.match(html, /data-cdt-row-key="disabled" aria-disabled="true" tabindex="-1"/);
  for (const key of ['normal', 'invalid-number', 'invalid-string', 'status']) {
    assert.doesNotMatch(html.match(new RegExp(`<div[^>]*data-cdt-row-key="${key}"[^>]*>`))[0], /tabindex/);
  }
});

test('sort controls preserve compact header geometry and visible keyboard access in stacked tables', () => {
  const css = fs.readFileSync(componentCssPath, 'utf8');
  assert.match(css, /\.compact-data-table-header:has\(\.compact-data-table__sort\)\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(css, /\.compact-data-table \.compact-data-table__sort\s*\{[^}]*height:\s*18px[^}]*min-height:\s*18px[^}]*padding:\s*0/s);
  assert.match(css, /\.compact-data-table__sort::before\s*\{[^}]*inset-block:\s*-3px/s);
  assert.match(css, /data-cdt-mobile="stack"\] \.compact-data-table-header:has\(\.compact-data-table__sort\)\s*\{[^}]*position:\s*static[^}]*clip:\s*auto/s);
});

test('problematic mutation spinner stops animating for reduced motion while retaining its ring', () => {
  const css = fs.readFileSync(utilitiesCssPath, 'utf8');

  assert.match(css, /\.problematic-mutation-spinner\s*\{[^}]*border:\s*3px solid/s);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.problematic-mutation-spinner\s*\{[^}]*animation:\s*none/s,
  );
});
