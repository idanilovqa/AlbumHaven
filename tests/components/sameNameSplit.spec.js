// MusicBrainz Delivery 2, item 3 (approved b3-3; owner 2026-11-17 "Same-name split labels"):
// the artist tree draws each same-name identity the server labels as "Name (Qualifier)" with the
// qualifier dimmed. The labels themselves come from the browse SQL (tested on PostgreSQL in
// tests/py/test_isolated_postgres_live.py); these cases render the trees those rules produce.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '../..');
const staticRoot = path.join(repoRoot, 'music_app/static');
const template = fs.readFileSync(path.join(repoRoot, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');

async function renderTree(page, { tree, split }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<style>:root { --text: rgb(20, 20, 20); --muted: rgb(120, 120, 120); } body { color: var(--text); }</style>
    <template id="navigation-tree-item-template">${template}</template><nav id="sidebar" style="width:260px"></nav>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/navigation-tree.css') });
  await page.addScriptTag({ content: 'window.escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c])); window.state = { view: {} };' });
  for (const file of ['js/navigation-tree.js', 'js/runtime/view-state-helpers.js', 'js/runtime/browser-navigation-helpers.js',
    'js/runtime/render-markup-helpers.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, file) });
  }
  await page.evaluate(({ tree, split }) => {
    setSplitArtistQualifiers(split);
    document.getElementById('sidebar').innerHTML = buildSidebarHtml({ surface: 'albums' }, tree, {});
  }, { tree, split });
}

async function rowParts(page, artist) {
  const parts = await page.evaluate((key) => {
    const found = document.querySelector(`#sidebar [data-navigation-tree-key="${CSS.escape(key)}"]`);
    if (!found) return null;
    const label = found.querySelector('.navigation-tree-label');
    const secondary = found.querySelector('.navigation-tree-label-secondary');
    return {
      nameColor: getComputedStyle(label).color,
      secondary: secondary?.textContent.trim() || '',
      secondaryColor: secondary ? getComputedStyle(secondary).color : '',
      height: found.getBoundingClientRect().height,
    };
  }, `artist:${artist}`);
  expect(parts, artist).not.toBeNull();
  return { parts };
}

function labelRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('#sidebar .navigation-tree-label')]
    .map((label) => label.textContent.replace(/\s+/g, ' ').trim()));
}

test('same-name split: each identity shows its full country name, dimmed, and a code with no English name shows as the code', async ({ page }) => {
  await renderTree(page, {
    tree: [
      { artist: 'Amarok (Poland)', artist_display: 'Amarok (Poland)', count: 4 },
      { artist: 'Amarok (Spain)', artist_display: 'Amarok (Spain)', count: 3 },
      { artist: 'Arion (QZ)', artist_display: 'Arion (QZ)', count: 2 },
      { artist: 'Arion (Finland)', artist_display: 'Arion (Finland)', count: 1 },
      { artist: 'Angra', artist_display: 'Angra', count: 16 },
    ],
    split: { 'Amarok (Poland)': 'Poland', 'Amarok (Spain)': 'Spain', 'Arion (QZ)': 'QZ', 'Arion (Finland)': 'Finland' },
  });
  expect(await labelRows(page)).toEqual(['Amarok (Poland)', 'Amarok (Spain)', 'Arion (QZ)', 'Arion (Finland)', 'Angra']);
  const { parts: spain } = await rowParts(page, 'Amarok (Spain)');
  expect(spain.secondary).toBe('(Spain)');
  expect(spain.secondaryColor).toBe('rgb(120, 120, 120)');
  expect(spain.nameColor).not.toBe(spain.secondaryColor);
  // Negative: a code with no English name is shown as the code, still dimmed, never dropped.
  const { parts: unknown } = await rowParts(page, 'Arion (QZ)');
  expect(unknown.secondary).toBe('(QZ)');
  // Negative: a name MusicBrainz does not split has no dimmed part.
  const { parts: angra } = await rowParts(page, 'Angra');
  expect(angra.secondary).toBe('');
  // Every row keeps the tree's one-line height.
  expect(spain.height).toBe(angra.height);
});

test('same-name split: two identities from one country show Person and Band; the disambiguation only when the type is the same too', async ({ page }) => {
  await renderTree(page, {
    tree: [
      { artist: 'Alice Cooper (Band)', artist_display: 'Alice Cooper (Band)', count: 7 },
      { artist: 'Alice Cooper (Person)', artist_display: 'Alice Cooper (Person)', count: 21 },
      { artist: 'Ark (norwegian metal band)', artist_display: 'Ark (norwegian metal band)', count: 1 },
      { artist: 'Ark (UK prog rock band)', artist_display: 'Ark (UK prog rock band)', count: 2 },
    ],
    split: { 'Alice Cooper (Band)': 'Band', 'Alice Cooper (Person)': 'Person',
      'Ark (norwegian metal band)': 'norwegian metal band', 'Ark (UK prog rock band)': 'UK prog rock band' },
  });
  expect(await labelRows(page)).toEqual(['Alice Cooper (Band)', 'Alice Cooper (Person)', 'Ark (norwegian metal band)', 'Ark (UK prog rock band)']);
  for (const [label, secondary] of [['Alice Cooper (Band)', '(Band)'], ['Alice Cooper (Person)', '(Person)']]) {
    const { parts } = await rowParts(page, label);
    expect(parts.secondary).toBe(secondary);
    expect(parts.secondaryColor).toBe('rgb(120, 120, 120)');
  }
  // Negative: two bands (the same type) are told apart by MusicBrainz's disambiguation.
  const { parts: ark } = await rowParts(page, 'Ark (UK prog rock band)');
  expect(ark.secondary).toBe('(UK prog rock band)');
});

test('same-name split: the plain name row lists only the undecided albums and is gone once every album is matched', async ({ page }) => {
  await renderTree(page, {
    tree: [
      { artist: 'Amarok', artist_display: 'Amarok', count: 1 },
      { artist: 'Amarok (Poland)', artist_display: 'Amarok (Poland)', count: 4 },
      { artist: 'Amarok (Spain)', artist_display: 'Amarok (Spain)', count: 3 },
    ],
    split: { 'Amarok (Poland)': 'Poland', 'Amarok (Spain)': 'Spain' },
  });
  expect(await labelRows(page)).toEqual(['Amarok', 'Amarok (Poland)', 'Amarok (Spain)']);
  const { parts: plain } = await rowParts(page, 'Amarok');
  expect(plain.secondary).toBe('');
  await expect(page.locator('#sidebar').getByText('1', { exact: true })).toHaveCount(1);
  // Every album matched: the server sends no plain row, and none is drawn.
  await renderTree(page, {
    tree: [
      { artist: 'Amarok (Poland)', artist_display: 'Amarok (Poland)', count: 5 },
      { artist: 'Amarok (Spain)', artist_display: 'Amarok (Spain)', count: 3 },
    ],
    split: { 'Amarok (Poland)': 'Poland', 'Amarok (Spain)': 'Spain' },
  });
  expect(await labelRows(page)).toEqual(['Amarok (Poland)', 'Amarok (Spain)']);
});
