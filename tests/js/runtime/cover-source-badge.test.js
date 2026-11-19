const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');

function loadBadge(overrides = {}) {
  const context = {
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: {},
    ButtonComponent: require(path.join(__dirname, '../../../music_app/static/js/button-component.js')),
    state: { coverLookup: { modal: { pastedImages: [], localCovers: [], otherArt: [], album: null } } },
    URL,
    URLSearchParams,
    console,
    escapeHtml: (value) => String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    markCoverLookupTaskActionTaken: () => {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(runtimeRoot, 'alert-components.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(runtimeRoot, 'cover-lookup-modal-and-drawer.js'), 'utf8'), context);
  return context;
}

const MBID = '6f1a3f0e-2c3b-4d5e-8f90-123456789abc';

test('every provider badge is a bare mark with its legal line and one link to the release page', () => {
  const context = loadBadge();
  for (const source of ['apple', 'spotify', 'deezer', 'bandcamp', 'discogs', 'cover_art_archive', 'youtube_music', 'genius']) {
    const html = context.buildCoverSourceBadgeHtml({
      source, placement: 'inline', albumUrl: `https://example.test/${source}/release/1`, artist: 'A', album: 'B',
    });
    assert.match(html, /^<span class="cover-source-badge cover-source-badge--inline /, source);
    assert.match(html, /<button type="button" class="cover-source-badge__trigger" aria-expanded="false" aria-label="[^"]+">/);
    assert.match(html, /class="cover-source-badge__mark" aria-hidden="true">(?:<img src="\/static\/images\/icons\/[^"]+" alt=""|<svg)/);
    assert.match(html, /class="cover-source-badge__popover" role="tooltip"/);
    assert.equal((html.match(/<a /g) || []).length, 1, `${source} has exactly one link`);
    assert.match(html, new RegExp(`href="https://example.test/${source}/release/1" target="_blank" rel="noopener noreferrer"`));
    assert.doesNotMatch(html, /background|border/, `${source} carries no chip or outline`);
  }
});

test('each provider shows its required attribution wording', () => {
  const context = loadBadge();
  const html = (source) => context.buildCoverSourceBadgeHtml({ source, albumUrl: 'https://example.test/r' });
  assert.match(html('discogs'), /cover-source-badge__legal">Data provided by Discogs\.</);
  assert.match(html('discogs'), /not affiliated with, sponsored or endorsed by Discogs\. ‘Discogs’ is a trademark of Zink Media, LLC\./);
  assert.match(html('discogs'), /cover-source-badge__link"[^>]*>Data provided by Discogs ↗</);
  assert.match(html('apple'), /Apple and Apple Music are trademarks of Apple Inc\., registered in the U\.S\. and other countries\./);
  assert.match(html('apple'), />Listen on Apple Music ↗</);
  assert.match(html('spotify'), />Open on Spotify ↗</);
  assert.match(html('cover_art_archive'), /Image © its copyright owner\./);
});

test('the link is the stored release page, a MusicBrainz release from the CAA MBID, or the provider search', () => {
  const context = loadBadge();
  const resolve = (config) => context.resolveCoverSourceReleaseUrl(config);
  assert.equal(resolve({ source: 'spotify', albumUrl: 'https://open.spotify.com/album/abc' }), 'https://open.spotify.com/album/abc');
  assert.equal(
    resolve({ source: 'spotify', albumUrl: '', artist: '10cc', album: 'Sheet Music' }),
    'https://open.spotify.com/search/10cc%20Sheet%20Music',
  );
  assert.equal(
    resolve({ source: 'discogs', artist: 'AC/DC', album: 'Back & Black' }),
    'https://www.discogs.com/search/?q=AC%2FDC%20Back%20%26%20Black&type=release',
  );
  assert.equal(
    resolve({ source: 'cover_art_archive', imageUrl: `https://coverartarchive.org/release/${MBID}/123-500.jpg` }),
    `https://musicbrainz.org/release/${MBID}`,
  );
  assert.equal(
    resolve({ source: 'cover_art_archive', imageUrl: `https://archive.org/download/mbid-${MBID.toUpperCase()}/x.jpg` }),
    `https://musicbrainz.org/release/${MBID}`,
  );
  assert.equal(
    resolve({ source: 'cover_art_archive', imageUrl: 'https://example.test/a.jpg', artist: 'A', album: 'B' }),
    'https://musicbrainz.org/search?query=A%20B&type=release',
  );
});

test('a badge never links to the image file or a non-web address', () => {
  const context = loadBadge();
  const resolve = (albumUrl) => context.resolveCoverSourceReleaseUrl({ source: 'deezer', albumUrl, artist: 'A', album: 'B' });
  assert.equal(resolve('https://cdn.example.test/images/cover/abc/1000x1000.jpg'), 'https://www.deezer.com/search/A%20B');
  assert.equal(resolve('javascript:alert(1)'), 'https://www.deezer.com/search/A%20B');
  assert.equal(context.resolveCoverSourceReleaseUrl({ source: 'unknown', albumUrl: 'https://x.test/r' }), '');
  assert.equal(context.buildCoverSourceBadgeHtml({ source: 'unknown' }), '');
});

test('each provider shows its own icon file; Genius keeps the neutral mark', () => {
  const context = loadBadge();
  const staticRoot = path.join(__dirname, '..', '..', '..', 'music_app');
  for (const source of ['apple', 'spotify', 'deezer', 'bandcamp', 'discogs', 'cover_art_archive', 'youtube_music']) {
    const html = context.buildCoverSourceBadgeHtml({ source });
    const icon = html.match(/<img src="([^"]+)" alt="" width="24" height="24"/);
    assert.ok(icon, source);
    assert.ok(fs.existsSync(path.join(staticRoot, icon[1])), `${icon[1]} exists`);
    assert.doesNotMatch(html, /is-neutral/);
  }
  const youtube = context.buildCoverSourceBadgeHtml({ source: 'youtube_music' });
  const genius = context.buildCoverSourceBadgeHtml({ source: 'genius' });
  assert.match(youtube, /src="\/static\/images\/icons\/youtubemusic-favicon-32\.png"/);
  assert.doesNotMatch(genius, /<img/);
  assert.match(genius, /class="cover-source-badge cover-source-badge--inline is-genius is-neutral"/);
  assert.match(genius, /stroke="currentColor"/);
});

test('Album Details puts Spotify beneath the art and every other provider over it', () => {
  const context = loadBadge();
  assert.match(context.buildTrackModalCoverSourceBadge('spotify'), /cover-source-badge--beneath/);
  for (const source of ['apple', 'deezer', 'bandcamp', 'discogs', 'cover_art_archive', 'youtube_music', 'genius']) {
    assert.match(context.buildTrackModalCoverSourceBadge(source), /cover-source-badge--over/, source);
  }
  assert.equal(context.buildTrackModalCoverSourceBadge(''), '');
  assert.match(
    context.buildTrackModalCoverSourceBadge('apple', { albumUrl: 'https://music.apple.com/us/album/x/1' }),
    /href="https:\/\/music\.apple\.com\/us\/album\/x\/1"/,
  );
});

test('only a Discogs mark over the art follows the cover brightness', () => {
  const context = loadBadge();
  assert.match(context.buildTrackModalCoverSourceBadge('discogs'), /data-cover-source-tone="dark"/);
  assert.doesNotMatch(context.buildCoverSourceBadgeHtml({ source: 'discogs', placement: 'inline' }), /data-cover-source-tone/);
  assert.doesNotMatch(context.buildTrackModalCoverSourceBadge('apple'), /data-cover-source-tone/);
  const pixels = (r, g, b, count = 4) => Uint8ClampedArray.from(Array.from({ length: count }, () => [r, g, b, 255]).flat());
  assert.equal(context.coverSourceToneFromPixels(pixels(250, 245, 230)), 'light');
  assert.equal(context.coverSourceToneFromPixels(pixels(240, 190, 30)), 'light');
  assert.equal(context.coverSourceToneFromPixels(pixels(20, 20, 30)), 'dark');
  assert.equal(context.coverSourceToneFromPixels(Uint8ClampedArray.from([255, 255, 255, 0])), 'dark');
});

test('a tap opens one badge without selecting the card; its link opens without selecting; elsewhere closes it', () => {
  const makeBadge = () => {
    const classes = new Set();
    const trigger = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    return {
      classes,
      trigger,
      classList: {
        contains: (name) => classes.has(name),
        toggle: (name, value) => (value ? classes.add(name) : classes.delete(name)),
        remove: (name) => classes.delete(name),
      },
      querySelector: (selector) => (selector === '.cover-source-badge__trigger' ? trigger : null),
    };
  };
  const first = makeBadge();
  const second = makeBadge();
  const context = loadBadge();
  const event = (badge, { link = false } = {}) => {
    const calls = [];
    return {
      calls,
      stopPropagation: () => calls.push('stop'),
      preventDefault: () => calls.push('prevent'),
      target: {
        closest: (selector) => {
          if (selector === '.cover-source-badge') return badge;
          if (selector === '.cover-source-badge__link') return link ? {} : null;
          return null;
        },
      },
    };
  };

  const tap = event(first);
  assert.equal(context.handleCoverSourceBadgeClick(tap), true);
  assert.deepEqual(tap.calls, ['stop', 'prevent']);
  assert.ok(first.classes.has('is-open'));
  assert.equal(first.trigger.attributes['aria-expanded'], 'true');

  context.handleCoverSourceBadgeClick(event(second));
  assert.ok(!first.classes.has('is-open'), 'opening one badge closes the other');
  assert.ok(second.classes.has('is-open'));

  const linkTap = event(second, { link: true });
  assert.equal(context.handleCoverSourceBadgeClick(linkTap), true);
  assert.deepEqual(linkTap.calls, ['stop'], 'the link keeps its default navigation');

  assert.equal(context.handleCoverSourceBadgeClick(event(null)), false);
  assert.ok(!second.classes.has('is-open'));
  assert.equal(second.trigger.attributes['aria-expanded'], 'false');

  context.handleCoverSourceBadgeClick(event(first));
  assert.equal(context.handleCoverSourceBadgeKeyDown({ key: 'Escape' }), true);
  assert.ok(!first.classes.has('is-open'));
  assert.equal(context.handleCoverSourceBadgeKeyDown({ key: 'Escape' }), false, 'Escape passes on once none is open');
  context.handleCoverSourceBadgeClick(event(first));
  context.handleCoverSourceBadgeClick(event(first));
  assert.ok(!first.classes.has('is-open'), 'a second tap closes the badge');
});

test('remote Cover Look Up cards show the badge and today\'s name, and no Select word', () => {
  const context = loadBadge({ buildCoverUrl: (ref) => `/cover/${ref}` });
  for (const [source, label] of [['apple', 'Apple Music'], ['spotify', 'SPOTIFY'], ['genius', 'Genius']]) {
    for (const kind of ['remote', 'saved-remote']) {
      const card = context.buildCoverLookupCard({
        id: source, source, source_label: 'Genius', album: 'Fixture', album_url: `https://example.test/${source}/r`,
      }, kind);
      assert.match(card, /<span class="cover-source-badge cover-source-badge--inline /);
      assert.match(card, new RegExp(`href="https://example.test/${source}/r"`));
      assert.equal(card.match(/<span class="cover-lookup-art-source">([^]*?)<\/span>/)[1], label);
      assert.doesNotMatch(card, /cover-lookup-art-action-label/, `${kind} ${source}`);
    }
  }
  const local = context.buildCoverLookupCard({ candidate_cover_ref: 'cover.jpg', filename: 'cover.jpg' }, 'local');
  assert.match(local, /cover-lookup-art-action-label/, 'local cards keep their action label');
  assert.doesNotMatch(local, /cover-source-badge/);
});
