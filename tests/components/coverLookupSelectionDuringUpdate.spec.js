const path = require('node:path');
const { test, expect } = require('@playwright/test');

// While a search runs, candidate polls re-render the Cover Look Up gallery several times a second. A press on a
// card must still select it at once: the blue frame shows in the frame after the click, and the re-render patches
// the cards it already shows instead of detaching them (a detached press target loses its click in Chromium).
const root = path.join(__dirname, '..', '..');
const decodedPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function loadCoverLookupGallery(page) {
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <section id="cover-lookup-modal"><div id="cover-lookup-modal-body" style="width:460px"></div></section>
  </body></html>`);
  for (const file of ['runtime/base-layout.css', 'runtime/cover-lookup-modal.css', 'runtime/cover-lookup-drawer-and-related.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.addScriptTag({ content: `
    var state = { coverLookup: { tasks: [], modal: { possibleMatches: [], album: null } } };
    function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }
  ` });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/cover-lookup-modal-and-drawer.js') });
  await page.evaluate(() => {
    document.addEventListener('click', (event) => {
      const card = event.target.closest('[data-select-remote-cover]');
      if (card) selectRemoteCoverFromLookup(card.getAttribute('data-select-remote-cover'));
    });
    window.renderGallery = (candidates, progress) => {
      state.coverLookup.modal.possibleMatches = candidates;
      replaceCoverLookupModalMarkup(document.getElementById('cover-lookup-modal-body'), `
        <section class="cover-lookup-section cover-lookup-results">
          <div class="cover-lookup-search-progress-label">${progress}</div>
          <div class="cover-lookup-gallery" style="display:grid;grid-template-columns:repeat(3,140px)">
            ${candidates.map((candidate) => buildCoverLookupCard(candidate, 'remote', true)).join('')}
          </div>
        </section>`);
    };
    window.candidate = (id) => ({ id, url: `https://images.example/${id}.jpg`, source: 'discogs', lookup_group: 'services' });
  });
}

test('a card pressed while a candidate update re-renders the gallery shows its blue frame in the next frame', async ({ page }) => {
  await loadCoverLookupGallery(page);
  await page.evaluate(() => renderGallery([candidate('first'), candidate('second')], 'Searching Discogs'));
  const second = page.locator('[data-select-remote-cover="second"]');
  const box = await second.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // A poll lands between press and release: progress moves on and a new candidate arrives.
  await page.evaluate(() => {
    renderGallery([candidate('first'), candidate('second'), candidate('third')], 'Searching Cover Art Archive');
    window.frameAfterClick = new Promise((resolve) => {
      document.addEventListener('click', () => requestAnimationFrame(() => resolve(
        document.querySelector('[data-select-remote-cover="second"]').classList.contains('is-active'),
      )), { once: true });
    });
  });
  await page.mouse.up();
  expect(await page.evaluate(() => Promise.race([
    window.frameAfterClick,
    new Promise((resolve) => setTimeout(() => resolve('click was lost'), 500)),
  ]))).toBe(true);
  await expect(second).toHaveClass(/is-active/);
  await expect(second).toHaveCSS('outline-color', 'rgb(96, 165, 250)');
  expect(await page.evaluate(() => state.coverLookup.modal.selectedRemoteId)).toBe('second');
});

test('a candidate poll patches the shown cards by key instead of rebuilding the gallery', async ({ page }) => {
  await loadCoverLookupGallery(page);
  await page.evaluate(() => renderGallery([candidate('first'), candidate('second')], 'Searching Discogs'));
  const detached = await page.evaluate(() => {
    const body = document.getElementById('cover-lookup-modal-body');
    const before = Array.from(body.querySelectorAll('.cover-lookup-art-card-shell, [data-cover-lookup-item-key], .cover-lookup-art-preview, .cover-lookup-art-meta'));
    const observer = new MutationObserver(() => {});
    observer.observe(body, { childList: true, subtree: true });
    // A mark added after rendering (such as a duplicate-picture badge) survives on a card whose markup is unchanged.
    body.querySelector('[data-select-remote-cover="second"]').setAttribute('data-test-mark', '1');
    state.coverLookup.modal.selectedRemoteId = 'first';
    renderGallery([candidate('first'), candidate('second'), candidate('third')], 'Searching Cover Art Archive');
    const removed = observer.takeRecords().flatMap((record) => Array.from(record.removedNodes));
    return {
      removedShown: before.filter((node) => removed.some((gone) => gone === node || gone.contains(node))).length,
      stillMounted: before.filter((node) => node.isConnected).length,
      shown: before.length,
      progress: body.querySelector('.cover-lookup-search-progress-label').textContent,
      cards: body.querySelectorAll('[data-cover-lookup-item-key]').length,
      firstActive: body.querySelector('[data-select-remote-cover="first"]').classList.contains('is-active'),
      unchangedCardMark: body.querySelector('[data-select-remote-cover="second"]').getAttribute('data-test-mark'),
    };
  });
  expect(detached).toEqual({
    removedShown: 0,
    stillMounted: detached.shown,
    shown: detached.shown,
    progress: 'Searching Cover Art Archive',
    cards: 3,
    firstActive: true,
    unchangedCardMark: '1',
  });
});

test('a re-render keeps a decoded preview and replaces deferred or failed ones', async ({ page }) => {
  await loadCoverLookupGallery(page);
  const card = (key, image) => `<div class="cover-lookup-art-card-shell"><div class="cover-lookup-art-card"
    data-cover-lookup-item-key="${key}"><span class="cover-lookup-art-preview is-loading" aria-busy="true">${image}</span>
    <span class="cover-lookup-art-meta">${key}</span></div></div>`;
  const result = await page.evaluate(async ({ pixel, markup }) => {
    const body = document.getElementById('cover-lookup-modal-body');
    replaceCoverLookupModalMarkup(body, markup.first);
    await Promise.all(Array.from(body.querySelectorAll('img[src]'), (image) => image.decode().catch(() => {})));
    body.querySelector('[data-cover-lookup-item-key="decoded"] .cover-lookup-art-preview').classList.remove('is-loading');
    const images = Object.fromEntries(Array.from(body.querySelectorAll('[data-cover-lookup-item-key]'), (item) => (
      [item.getAttribute('data-cover-lookup-item-key'), item.querySelector('img')]
    )));
    replaceCoverLookupModalMarkup(body, markup.second);
    const preview = (key) => body.querySelector(`[data-cover-lookup-item-key="${key}"] .cover-lookup-art-preview`);
    return {
      decodedKept: preview('decoded').querySelector('img') === images.decoded,
      decodedLoading: preview('decoded').classList.contains('is-loading'),
      decodedBusy: preview('decoded').getAttribute('aria-busy'),
      metaUpdated: body.querySelector('[data-cover-lookup-item-key="decoded"] .cover-lookup-art-meta').textContent,
      deferredReplaced: preview('deferred').querySelector('img') !== images.deferred,
      deferredSource: preview('deferred').querySelector('img').getAttribute('src'),
      failedReplaced: preview('failed').querySelector('img') !== images.failed,
      pixel,
    };
  }, {
    pixel: decodedPixel,
    markup: {
      first: card('decoded', `<img class="cover-lookup-art-preview-image" src="${decodedPixel}">`)
        + card('deferred', `<img class="cover-lookup-art-preview-image" data-cover-lookup-deferred-src="${decodedPixel}">`)
        + card('failed', '<img class="cover-lookup-art-preview-image" src="data:image/png;base64,broken">'),
      second: card('decoded', `<img class="cover-lookup-art-preview-image" data-cover-lookup-deferred-src="${decodedPixel}">`).replace('>decoded<', '>decoded, enriched<')
        + card('deferred', `<img class="cover-lookup-art-preview-image" src="${decodedPixel}">`)
        + card('failed', '<img class="cover-lookup-art-preview-image" src="data:image/png;base64,broken">').replace('>failed<', '>failed, enriched<'),
    },
  });
  expect(result).toEqual({
    decodedKept: true,
    decodedLoading: false,
    decodedBusy: 'false',
    metaUpdated: 'decoded, enriched',
    deferredReplaced: true,
    deferredSource: decodedPixel,
    failedReplaced: true,
    pixel: decodedPixel,
  });
});
