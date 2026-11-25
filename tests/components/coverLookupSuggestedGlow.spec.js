const path = require('node:path');
const { test, expect } = require('@playwright/test');

// The cover a lookup notification shows is the cover its Look Up gallery marks with the green suggestion
// glow, also when a local cover is present and selected and the providers return the same art.
const root = path.join(__dirname, '..', '..');
const runtime = (name) => path.join(root, 'music_app', 'static', 'js', name);
const styles = (name) => path.join(root, 'music_app', 'static', 'css', name);

const dronesMatches = [
  { id: 'deezer-1800', source: 'deezer', art_kind: 'cover', url: 'https://images.example/drones-deezer.jpg', width: 1800, height: 1800 },
  { id: 'ytm-2400', source: 'youtube_music', art_kind: 'cover', url: 'https://images.example/drones-ytm.jpg', width: 2400, height: 2400 },
  { id: 'apple-2400', source: 'apple_music', art_kind: 'cover', url: 'https://images.example/drones-apple.jpg', width: 2400, height: 2400 },
  { id: 'booklet', source: 'discogs', art_kind: 'other', url: 'https://images.example/drones-booklet.jpg', width: 600, height: 285 },
];

async function openNotificationThenLookup(page, { bestCandidateId, snapshot }) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setContent(`<!doctype html><html><body>
    <button id="cover-lookup-drawer-button"></button>
    <span id="cover-lookup-drawer-badge"></span>
    <section id="cover-lookup-drawer"><button id="cover-lookup-drawer-clear"></button>
      <div id="cover-lookup-drawer-body"></div></section>
    <div class="cover-lookup-gallery" id="gallery" style="display:flex;flex-wrap:wrap;gap:24px;padding:24px"></div>
  </body></html>`);
  await page.addStyleTag({ path: styles('button-component.css') });
  await page.addStyleTag({ path: styles('runtime/cover-lookup-drawer-and-related.css') });
  await page.addStyleTag({ path: styles('runtime/cover-lookup-modal.css') });
  await page.evaluate(({ matches, bestCandidateId: best }) => {
    window.state = {
      coverLookup: {
        drawerOpen: true,
        modal: { pastedImages: [], localCovers: [], otherArt: [], album: null },
        tasks: [{
          id: 'drones-lookup', status: 'completed', artist: 'Muse', album: 'Drones', year: 2015,
          progress: 100, notification_action_taken: false, best_candidate_id: best, possible_matches: matches,
          search_generation: 'drones-search', candidate_updated_at: '2026-11-18T21:12:47.628306+00:00',
        }],
      },
    };
    window.escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    window.buildCoverUrl = (coverPath) => `/cover?path=${encodeURIComponent(coverPath)}`;
    window.formatCoverLookupTaskElapsedLabel = () => '';
  }, { matches: dronesMatches, bestCandidateId });
  await page.addScriptTag({ path: runtime('button-component.js') });
  await page.addScriptTag({ path: runtime('runtime/alert-components.js') });
  await page.addScriptTag({ path: runtime('runtime/cover-lookup-modal-and-drawer.js') });

  return page.evaluate(({ snapshot: candidateSnapshot }) => {
    renderCoverLookupDrawer();
    const thumbnail = document.querySelector('#cover-lookup-drawer-body .cover-lookup-task-cover');
    const shownKey = new URL(thumbnail.getAttribute('data-gallery-cover-src'), 'http://component.test').searchParams.get('key');

    const task = state.coverLookup.tasks[0];
    const local = { candidate_cover_ref: 'C:/Fixture/Drones/cover.jpg', is_active: true, width: 1000, height: 1000 };
    Object.assign(state.coverLookup.modal, {
      taskId: task.id,
      album: { key: 'muse::drones', name: 'Drones', cover_ref: local.candidate_cover_ref, cover_selection_origin: 'automatic' },
      localCovers: [local], activeLocalSelectionRef: local.candidate_cover_ref,
      selectedRemoteId: '', pendingLocalRef: '', pendingPastedImageId: '',
    });
    applyCoverLookupCandidateSource(getCoverLookupCandidateSource(task, candidateSnapshot));
    document.getElementById('gallery').innerHTML = buildCoverLookupCard(local, 'local')
      + state.coverLookup.modal.possibleMatches.map((match) => buildCoverLookupCard(match, 'remote')).join('');
    const cards = [...document.querySelectorAll('#gallery [data-select-remote-cover]')].map((card) => {
      const style = getComputedStyle(card);
      return {
        id: card.getAttribute('data-select-remote-cover'),
        suggested: card.classList.contains('is-suggested'),
        animation: style.animationName,
        outline: style.outlineColor,
      };
    });
    const localCard = document.querySelector('#gallery .cover-lookup-art-card:not([data-select-remote-cover])');
    return { shownKey, cards, localSelected: Boolean(localCard?.classList.contains('is-active')) };
  }, { snapshot });
}

const green = 'rgb(82, 215, 170)';

test('the lookup glows on the cover its notification shows while a local cover stays selected', async ({ page }) => {
  // The task names no best candidate (lookups stored before tasks carried one); the older snapshot does.
  const result = await openNotificationThenLookup(page, {
    bestCandidateId: '',
    snapshot: {
      search_generation: 'drones-search', status: 'completed', updated_at: '2026-11-18T21:12:47.039810+00:00',
      best_candidate_id: 'apple-2400', candidates: dronesMatches,
    },
  });

  expect(result.shownKey).toBe('deezer-1800');
  expect(result.localSelected).toBe(true);
  expect(result.cards.filter((card) => card.suggested).map((card) => card.id)).toEqual([result.shownKey]);
  const shown = result.cards.find((card) => card.id === result.shownKey);
  expect(shown.animation).toBe('cover-lookup-suggested-pulse');
  expect(shown.outline).toBe(green);
});

test('the lookup glows on the named best cover its notification shows among duplicate provider covers', async ({ page }) => {
  const result = await openNotificationThenLookup(page, { bestCandidateId: 'apple-2400', snapshot: null });

  expect(result.shownKey).toBe('apple-2400');
  expect(result.localSelected).toBe(true);
  expect(result.cards.filter((card) => card.suggested).map((card) => card.id)).toEqual(['apple-2400']);
  const shown = result.cards.find((card) => card.id === 'apple-2400');
  expect(shown.animation).toBe('cover-lookup-suggested-pulse');
  expect(shown.outline).toBe(green);
});
