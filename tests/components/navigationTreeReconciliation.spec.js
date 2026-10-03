const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.resolve(__dirname, '../..');

test('navigation rows preserve unchanged selection and artwork attributes during reconciliation', async ({ page }) => {
  const template = fs.readFileSync(path.join(repositoryRoot, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  await page.setContent('<div id="list"></div><script type="text/template" id="navigation-tree-item-template"></script>');
  await page.locator('#navigation-tree-item-template').evaluate((element, markup) => { element.textContent = markup; }, template);
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/navigation-tree.js') });

  const result = await page.evaluate(async () => {
    const tree = window.NavigationTree;
    const list = document.getElementById('list');
    const rows = [
      { key: 'with-cover', label: 'First album', selected: true, artworkLabel: 'Artwork for First album',
        artworkHtml: '<span class="album-artbox" aria-label="Artwork for First album"><img alt="Artwork for First album"></span>' },
      { key: 'without-cover', label: 'Second album', selected: false, artworkLabel: 'Artwork for Second album',
        artworkHtml: '<span class="album-artbox album-artbox--missing" aria-label="Artwork for Second album"></span>' },
    ];
    list.innerHTML = tree.renderItems(rows.map(row => ({ ...row, variant: 'wide', action: true })));
    const nodes = Array.from(list.children);
    const records = [];
    const observer = new MutationObserver(batch => records.push(...batch.map(record => ({
      type: record.type, attribute: record.attributeName, oldValue: record.oldValue,
      newValue: record.target instanceof Element ? record.target.getAttribute(record.attributeName) : null,
    }))));
    observer.observe(list, { attributes: true, attributeOldValue: true, childList: true, characterData: true, subtree: true });
    const reconcile = values => values.forEach((row, index) => {
      tree.updateItem(nodes[index], { label: row.label, artworkLabel: row.artworkLabel });
      tree.setItemSelected(nodes[index], row.selected);
    });
    try {
      reconcile(rows);
      await Promise.resolve();
      const unchanged = records.splice(0);
      const changedRows = rows.map((row, index) => ({ ...row, selected: index === 1, artworkLabel: '' }));
      reconcile(changedRows);
      await Promise.resolve();
      const changed = records.splice(0);
      const semantics = {
        current: nodes.map(node => node.getAttribute('aria-current')),
        selected: nodes.map(node => node.classList.contains('is-selected')),
        active: nodes.map(node => node.classList.contains('is-active')),
        labels: nodes.map(node => node.querySelector('.album-artbox').getAttribute('aria-label')),
        imageAlt: nodes[0].querySelector('img').getAttribute('alt'),
        sameNodes: nodes.every((node, index) => list.children[index] === node),
      };
      reconcile(changedRows);
      await Promise.resolve();
      return { unchanged, changed, semantics, repeatedChanged: records.splice(0) };
    } finally {
      observer.disconnect();
    }
  });

  expect(result.unchanged).toEqual([]);
  expect(result.semantics).toEqual({
    current: [null, 'true'], selected: [false, true], active: [false, true],
    labels: ['', ''], imageAlt: '', sameNodes: true,
  });
  expect(result.changed.some(record => record.attribute === 'aria-current' && record.newValue === 'true')).toBe(true);
  expect(result.changed.some(record => record.attribute === 'alt' && record.newValue === '')).toBe(true);
  expect(result.changed.some(record => record.attribute === 'aria-label' && record.newValue === '')).toBe(true);
  expect(result.changed.every(record => record.type === 'attributes')).toBe(true);
  expect(result.repeatedChanged).toEqual([]);
});
