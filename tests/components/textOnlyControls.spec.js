const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { applyFixtureAppearance } = require('./appearanceFixture');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const stylesheets = [
  'css/runtime/base-layout.css',
  'css/button-component.css',
  'css/runtime/utilities.css',
  'css/runtime/album-details-components.css',
  'css/runtime/track-modal-and-lightbox.css',
  'css/runtime/cover-lookup-modal.css',
  'css/appearance-backgrounds.css',
  'css/mobile-layout.css',
];

async function mount(page, palette) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent('<main id="root"></main>');
  await applyFixtureAppearance(page, { palette_id: palette, panel_index: 0 });
  for (const file of stylesheets) await page.addStyleTag({ path: path.join(staticRoot, file) });
  for (const file of ['js/button-component.js', 'js/runtime/in-page-tabs.js', 'js/runtime/cover-lookup-modal-and-drawer.js', 'js/runtime/album-details-components.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, file) });
  }
  await page.evaluate(() => {
    window.escapeHtml = value => String(value ?? '');
    document.getElementById('root').innerHTML = `
      <div class="tag-editor-folder-copy">
        <div class="tag-editor-folder-path">C:/Music/Album/CD2</div>
        ${ButtonComponent.renderButton({
          label: 'Load all tracks from the folder', variant: 'secondary', size: 'small',
          className: 'tag-editor-folder-load ui-text-link',
        })}
      </div>
      <div class="tag-editor-artwork"><img alt="Album artwork" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></div>
      <section class="cover-lookup-modal"><div class="cover-lookup-modal-dialog" role="dialog"><div class="cover-lookup-modal-header"><div>
        <div class="cover-lookup-modal-subtitle">${buildCoverLookupAlbumSubtitleHtml({
          album_artist: 'Юрий Шевчук, оркестр Митьков / Настя Полева, Юрий Шевчук', name: 'Странные скачки', year: 1996,
        })}</div></div></div></div></section>
      <div class="track-modal-dialog" role="dialog"><div class="track-modal-header"><div class="track-modal-actions">${buildAlbumDetailsHeaderActionsHtml({})}</div></div>
      <div class="track-modal-tabs">${buildInPageTabsHtml({ id: 'versions', label: 'Versions', selectedKey: 'a', tabs: [
        { key: 'a', label: 'Génération sans futur - 1980' }, { key: 'b', label: 'Original - 1980' },
      ] })}</div></div>`;
    mountInPageTabs(document.querySelector('.in-page-tabs'));
  });
}

const transparent = 'rgba(0, 0, 0, 0)';

for (const palette of ['parchment-pine', 'harbor-mint']) {
  test(`text-only controls never paint a hover fill (${palette})`, async ({ page }) => {
    await mount(page, palette);

    // Issue 3: artist, album and year are visibly separated by spaced dots.
    const subtitle = page.locator('.cover-lookup-modal-subtitle');
    await expect(subtitle).toHaveText('Юрий Шевчук, оркестр Митьков / Настя Полева, Юрий Шевчук · Странные скачки · 1996');
    // Each separator is wider than its bare dot, so the spaces around it render.
    const separatorWidths = await subtitle.evaluate(node => [...node.querySelectorAll('.cover-lookup-modal-subtitle-separator')]
      .map(dot => {
        const bare = document.createElement('span');
        bare.textContent = '·';
        dot.after(bare);
        const widths = [dot.getBoundingClientRect().width, bare.getBoundingClientRect().width];
        bare.remove();
        return widths;
      }));
    expect(separatorWidths).toHaveLength(2);
    for (const [spaced, bare] of separatorWidths) expect(spaced).toBeGreaterThan(bare + 4);

    // Issue 2: the album link is plain at rest and only underlined on hover.
    const link = page.getByRole('button', { name: 'Странные скачки' });
    await expect(link).toHaveCSS('text-decoration-line', 'none');
    await link.hover();
    await expect(link).toHaveCSS('background-color', transparent);
    await expect(link).toHaveCSS('text-decoration-line', 'underline');
    await expect(link).toHaveCSS('border-top-width', '0px');

    // The Edit Tags folder action stays underlined; hover only brightens/glows it, with no movement.
    const folderAction = page.getByRole('button', { name: 'Load all tracks from the folder' });
    const folderPath = page.locator('.tag-editor-folder-path');
    const folderArt = page.getByRole('img', { name: 'Album artwork', exact: true });
    const readFolderGeometry = () => page.evaluate(() => {
      const action = document.querySelector('.tag-editor-folder-load');
      const path = document.querySelector('.tag-editor-folder-path');
      const style = getComputedStyle(action);
      return {
        actionRect: action.getBoundingClientRect().toJSON(),
        pathRect: path.getBoundingClientRect().toJSON(),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        padding: style.padding,
        transform: style.transform,
      };
    });
    const restingFolderGeometry = await readFolderGeometry();
    const restingFolderPresentation = await folderAction.evaluate(node => ({
      color: getComputedStyle(node).color,
      textShadow: getComputedStyle(node).textShadow,
    }));
    const restingArtbox = await folderArt.boundingBox();
    expect(restingArtbox).toMatchObject({ width: 52, height: 52 });
    await expect(folderAction).toHaveCSS('text-decoration-line', 'underline');
    expect(restingFolderPresentation.textShadow).toBe('none');
    expect(restingFolderGeometry.fontSize).toBe(await folderPath.evaluate(node => getComputedStyle(node).fontSize));
    const prominence = await folderAction.evaluate((node) => {
      const path = document.querySelector('.tag-editor-folder-path');
      const probe = document.createElement('span');
      probe.style.color = 'var(--text)';
      document.body.append(probe);
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      const channels = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const distance = (left, right) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0);
      const action = channels(getComputedStyle(node).color);
      const text = channels(getComputedStyle(probe).color);
      const muted = channels(getComputedStyle(path).color);
      probe.remove();
      return { actionToText: distance(action, text), actionToPath: distance(action, muted) };
    });
    expect.soft(prominence.actionToPath).toBeGreaterThan(0);
    expect.soft(prominence.actionToText).toBeLessThan(prominence.actionToPath);
    await folderAction.hover();
    await expect(folderAction).toHaveCSS('text-decoration-line', 'underline');
    const hoveredFolderPresentation = await folderAction.evaluate(node => ({
      color: getComputedStyle(node).color,
      textShadow: getComputedStyle(node).textShadow,
    }));
    expect(hoveredFolderPresentation.color).not.toBe(restingFolderPresentation.color);
    expect(hoveredFolderPresentation.textShadow).not.toBe('none');
    expect(await readFolderGeometry()).toEqual(restingFolderGeometry);
    expect(await folderArt.boundingBox()).toEqual(restingArtbox);

    // Issue 4: every Album Details header action has no outline at rest.
    for (const name of ['Edit album tags', 'Open album in File Explorer', 'Close tracklist']) {
      const action = page.getByRole('button', { name, exact: true });
      await expect(action).toHaveCSS('border-top-color', transparent);
      await expect(action).toHaveCSS('outline-style', 'none');
    }

    // Issue 11: version tabs are underlined, never filled, on hover or press.
    const tab = page.getByRole('tab', { name: 'Original - 1980' });
    await tab.hover();
    await expect(tab).toHaveCSS('background-color', transparent);
    await page.mouse.down();
    await expect(tab).toHaveCSS('background-color', transparent);
    await page.mouse.up();
    await expect(page.getByRole('tab', { name: 'Original - 1980' })).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toHaveCSS('background-color', transparent);
    const selectedBorder = await tab.evaluate(node => getComputedStyle(node).borderBottomColor);
    expect(selectedBorder).not.toBe(transparent);
  });
}
