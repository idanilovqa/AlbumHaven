const crypto = require('node:crypto');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-28): a user's PASTED IMAGES stay with the album between opens of Cover Look Up. The server keeps at
// most 10 per album (pasting an 11th drops the oldest with a short note); deleting a card forgets the image.
const root = path.join(__dirname, '..', '..');
const origin = 'http://127.0.0.1:4399';
const albumId = 41;

// The kept-images API of one signed-in user, per album, in paste order.
function keptImagesServer(page) {
  const kept = [];
  const requests = [];
  page.route(`${origin}/utilities/cover-lookup/pasted-images**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    requests.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'GET') {
      const id = url.pathname.split('/').pop();
      const image = kept.find((item) => item.id === id);
      return image ? route.fulfill({ contentType: image.mime_type, body: image.bytes }) : route.fulfill({ status: 404 });
    }
    const body = request.postDataJSON();
    if (url.pathname.endsWith('/list')) {
      return json({ ok: true, items: kept.map(({ bytes, ...item }) => item) });
    }
    if (url.pathname.endsWith('/delete')) {
      const index = kept.findIndex((item) => item.id === body.image_id);
      if (index >= 0) kept.splice(index, 1);
      return json({ ok: true, deleted: index >= 0 });
    }
    const [, mime, data] = /^data:([^;]+);base64,(.+)$/.exec(body.data_url);
    const bytes = Buffer.from(data, 'base64');
    const id = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!kept.some((item) => item.id === id)) {
      kept.push({ id, filename: body.filename, mime_type: mime, width: body.width, height: body.height, bytes });
    }
    const evicted = kept.splice(0, Math.max(0, kept.length - 10)).map((item) => item.id);
    return json({ ok: true, item: { id }, evicted_ids: evicted });
  });
  return { kept, requests };
}

async function openLookup(page) {
  await page.route(`${origin}/cover-lookup`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0;background:#101a29">
      <section id="cover-lookup-modal"><div id="cover-lookup-modal-body" style="width:760px"></div></section>
    </body></html>`,
  }));
  await page.goto(`${origin}/cover-lookup`);
  for (const file of ['runtime/base-layout.css', 'button-component.css', 'runtime/cover-lookup-modal.css',
    'runtime/cover-lookup-drawer-and-related.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/button-component.js') });
  await page.addScriptTag({ content: `
    function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }
    function paintPicture(seed, size) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const g = canvas.getContext('2d');
      g.fillStyle = 'hsl(' + (seed * 37 % 360) + ', 70%, 45%)'; g.fillRect(0, 0, size, size);
      g.fillStyle = 'hsl(' + ((seed * 37 + 160) % 360) + ', 80%, 70%)';
      g.beginPath(); g.arc(size * (0.2 + (seed % 5) * 0.15), size * (0.25 + (seed % 3) * 0.2), size * 0.18, 0, Math.PI * 2); g.fill();
      g.fillRect(size * 0.1, size * (0.1 + (seed % 7) * 0.1), size * 0.8, size * 0.07);
      return canvas;
    }
    function buildCoverUrl() { return ''; }
    var state = { coverLookup: { tasks: [], optimisticAlbumCovers: {}, modal: {
      album: { album_id: ${albumId}, key: 'artist::album', name: 'Album', album_artist: 'Artist' },
      localCovers: [], localInventoryLoaded: true, pastedImages: [], manualImageAttachments: [], otherArt: [],
      possibleMatches: [],
    } } };
  ` });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/cover-lookup-modal-and-drawer.js') });
  await page.evaluate(() => renderCoverLookupModal());
}

async function pasteAndExtract(page, seeds) {
  await page.evaluate(async (pictureSeeds) => {
    for (const seed of pictureSeeds) {
      const blob = await new Promise((resolve) => paintPicture(seed, 400).toBlob(resolve, 'image/png'));
      await addPastedImageToCoverLookup(new File([blob], `paste-${seed}.png`, { type: 'image/png' }));
    }
    await addRemoteCoverLinksFromLookup();
  }, seeds);
}

// What a later opening does: a new session that starts with no pasted images, then lists the kept ones.
async function reopen(page) {
  await page.evaluate(async () => {
    revokeCoverLookupPastedImageUrls();
    state.coverLookup.modal.pastedImages = [];
    state.coverLookup.modal.manualStatusText = '';
    coverLookupModalSession += 1;
    renderCoverLookupModal();
    await loadCoverLookupPastedImages(state.coverLookup.modal.album, coverLookupModalSession);
  });
}

async function pastedPictures(page) {
  const cards = page.locator('[data-select-pasted-cover] img.cover-lookup-art-preview-image');
  await expect.poll(() => cards.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)))
    .toBe(true);
  return cards.evaluateAll((images) => images.map((image) => image.getAttribute('src')));
}

test('pasted images are shown again when the lookup is opened again', async ({ page }) => {
  const server = keptImagesServer(page);
  await openLookup(page);
  await pasteAndExtract(page, [1, 2]);
  await expect.poll(() => server.kept.length).toBe(2);

  await reopen(page);

  await expect(page.locator('.cover-lookup-subsection-title', { hasText: 'PASTED IMAGES' })).toHaveCount(1);
  const sources = await pastedPictures(page);
  expect(sources).toEqual(server.kept.slice().reverse().map((item) => `/utilities/cover-lookup/pasted-images/${albumId}/${item.id}`));
});

test('pasting an eleventh image keeps the 10 newest and says the oldest was removed', async ({ page }) => {
  const server = keptImagesServer(page);
  await openLookup(page);
  await pasteAndExtract(page, [1, 2, 3, 4, 5, 6, 7, 8]);
  await pasteAndExtract(page, [9, 10]);
  await expect.poll(() => server.kept.length).toBe(10);
  const oldest = server.kept[0].id;
  await reopen(page);
  await expect(page.locator('[data-select-pasted-cover]')).toHaveCount(10);

  await pasteAndExtract(page, [11]);

  await expect(page.locator('.cover-lookup-manual-status')).toHaveText(
    'Only the 10 newest pasted images are kept; the oldest was removed.',
  );
  await expect(page.locator('[data-select-pasted-cover]')).toHaveCount(10);
  expect(server.kept.map((item) => item.id)).not.toContain(oldest);
  expect(await pastedPictures(page)).not.toContain(`/utilities/cover-lookup/pasted-images/${albumId}/${oldest}`);
});

test('deleting a pasted image card forgets it for later openings', async ({ page }) => {
  const server = keptImagesServer(page);
  await openLookup(page);
  await pasteAndExtract(page, [1]);
  await expect.poll(() => server.kept.length).toBe(1);
  await reopen(page);
  await expect(page.locator('[data-select-pasted-cover]')).toHaveCount(1);

  await page.evaluate(() => removePastedImageFromCoverLookup(state.coverLookup.modal.pastedImages[0].id));
  await expect.poll(() => server.kept.length).toBe(0);
  await reopen(page);

  await expect(page.locator('[data-select-pasted-cover]')).toHaveCount(0);
  expect(server.requests).toContain('POST /utilities/cover-lookup/pasted-images/delete');
});
