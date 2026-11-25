const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (sandbox2): an extracted pasted image that is already one of the album's local images is not staged
// again; the matching local card gets the green suggestion glow instead. Matching compares decoded pixels, so a
// PNG copy of a saved JPG still matches; a different picture is staged under PASTED IMAGES as before.
const root = path.join(__dirname, '..', '..');

async function openLookupWithLocalCover(page) {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#101a29">
    <section id="cover-lookup-modal"><div id="cover-lookup-modal-body" style="width:760px"></div></section>
  </body></html>`);
  for (const file of ['runtime/base-layout.css', 'button-component.css', 'runtime/cover-lookup-modal.css',
    'runtime/cover-lookup-drawer-and-related.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/button-component.js') });
  await page.addScriptTag({ content: `
    function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }
    // Two different pictures of the same size: X (the saved local cover) and Y.
    function paintPicture(kind, size) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const g = canvas.getContext('2d');
      const gradient = g.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, kind === 'x' ? '#1d3557' : '#e9c46a');
      gradient.addColorStop(1, kind === 'x' ? '#e63946' : '#264653');
      g.fillStyle = gradient; g.fillRect(0, 0, size, size);
      g.fillStyle = kind === 'x' ? '#f1faee' : '#2a9d8f';
      g.beginPath(); g.arc(size * (kind === 'x' ? 0.35 : 0.65), size * 0.4, size * 0.22, 0, Math.PI * 2); g.fill();
      g.fillRect(size * 0.1, size * (kind === 'x' ? 0.75 : 0.15), size * 0.8, size * 0.08);
      return canvas;
    }
    window.savedCoverUrl = paintPicture('x', 480).toDataURL('image/jpeg', 0.82);
    function buildCoverUrl() { return window.savedCoverUrl; }
    var state = { coverLookup: { tasks: [], optimisticAlbumCovers: {}, modal: {
      album: { key: 'artist::album', name: 'Album', album_artist: 'Artist', cover_ref: 'x-ref' },
      localCovers: [{ candidate_cover_ref: 'x-ref', filename: 'cover.jpg', width: 480, height: 480, is_active: true }],
      localInventoryLoaded: true, pastedImages: [], manualImageAttachments: [], otherArt: [], possibleMatches: [],
    } } };
  ` });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/cover-lookup-modal-and-drawer.js') });
  await page.evaluate(async () => {
    renderCoverLookupModal();
    await document.querySelector('[data-select-local-cover="x-ref"] img.cover-lookup-art-preview-image').decode();
  });
}

async function pasteAndExtract(page, kind, size) {
  await page.evaluate(async ({ kind, size }) => {
    const blob = await new Promise((resolve) => paintPicture(kind, size).toBlob(resolve, 'image/png'));
    await addPastedImageToCoverLookup(new File([blob], `${kind}.png`, { type: 'image/png' }));
    await addRemoteCoverLinksFromLookup();
  }, { kind, size });
}

test('extracting a pasted copy of a local image highlights that card instead of staging it', async ({ page }) => {
  await openLookupWithLocalCover(page);
  await pasteAndExtract(page, 'x', 1000);
  expect(await page.evaluate(() => state.coverLookup.modal.pastedImages.length)).toBe(0);
  await expect(page.locator('[data-select-pasted-cover]')).toHaveCount(0);
  const card = page.locator('[data-select-local-cover="x-ref"]');
  await expect(card).toHaveClass(/is-suggested/);
  await expect(card).toHaveCSS('animation-name', /^cover-lookup-suggested/);
});

test('extracting a different pasted image stages it under PASTED IMAGES', async ({ page }) => {
  await openLookupWithLocalCover(page);
  await pasteAndExtract(page, 'y', 1000);
  expect(await page.evaluate(() => state.coverLookup.modal.pastedImages.length)).toBe(1);
  await expect(page.locator('[data-select-pasted-cover]')).toHaveCount(1);
  await expect(page.locator('.cover-lookup-subsection-title', { hasText: 'PASTED IMAGES' })).toHaveCount(1);
  await expect(page.locator('[data-select-local-cover="x-ref"]')).not.toHaveClass(/is-suggested/);
});

test('extracting a pasted copy of a local image scrolls the gallery to that card', async ({ page }) => {
  await openLookupWithLocalCover(page);
  // The local card starts far below the visible part of the lookup's scrolling body.
  await page.addStyleTag({ content: `
    #cover-lookup-modal-body { height: 360px; overflow-y: auto; }
    #cover-lookup-modal-body::before { content: ''; display: block; height: 1600px; }
  ` });
  const body = page.locator('#cover-lookup-modal-body');
  const card = page.locator('[data-select-local-cover="x-ref"]');
  const cardInsideBody = () => page.evaluate(() => {
    const bodyRect = document.getElementById('cover-lookup-modal-body').getBoundingClientRect();
    const cardRect = document.querySelector('[data-select-local-cover="x-ref"]').getBoundingClientRect();
    return cardRect.top >= bodyRect.top - 0.5 && cardRect.bottom <= bodyRect.bottom + 0.5;
  });
  expect(await body.evaluate((node) => node.scrollTop)).toBe(0);
  expect(await cardInsideBody()).toBe(false);
  await pasteAndExtract(page, 'x', 1000);
  await expect(card).toHaveClass(/is-suggested/);
  await expect.poll(cardInsideBody).toBe(true);
  // Settled: the card stays fully in view.
  await page.waitForTimeout(400);
  expect(await cardInsideBody()).toBe(true);
});

test('extracting a different pasted image does not scroll to the local card', async ({ page }) => {
  await openLookupWithLocalCover(page);
  await page.addStyleTag({ content: `
    #cover-lookup-modal-body { height: 360px; overflow-y: auto; }
    #cover-lookup-modal-body::before { content: ''; display: block; height: 1600px; }
  ` });
  await pasteAndExtract(page, 'y', 1000);
  await page.waitForTimeout(400);
  expect(await page.locator('#cover-lookup-modal-body').evaluate((node) => node.scrollTop)).toBe(0);
});
