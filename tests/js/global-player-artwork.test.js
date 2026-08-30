const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const globalPlayerUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'poms',
  'globalPlayer.js',
)).href;

async function withBrowserArtworkFakes(options, callback) {
  const originals = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    Image: globalThis.Image,
  };
  const decodeCalls = [];

  class FakeButton {
    constructor() {
      this.hidden = Boolean(options.hidden);
    }

    getBoundingClientRect() {
      return {
        width: options.width ?? 72,
        height: options.height ?? 72,
      };
    }
  }

  class FakeImage {
    constructor() {
      this.complete = options.complete ?? true;
      this.naturalWidth = options.naturalWidth ?? 480;
      this.naturalHeight = options.naturalHeight ?? 480;
      this.src = '';
    }

    async decode() {
      decodeCalls.push(this.src);
      if (options.decodeError) throw options.decodeError;
    }
  }

  const button = new FakeButton();
  globalThis.HTMLButtonElement = FakeButton;
  globalThis.document = {
    baseURI: 'http://127.0.0.1:4173/?surface=albums',
    querySelector(selector) {
      return selector === '#player-cover-button' ? button : null;
    },
  };
  globalThis.getComputedStyle = () => ({
    backgroundImage: options.backgroundImage ?? 'url("/cover?path=Joseph.png")',
  });
  globalThis.Image = FakeImage;

  try {
    await callback({ button, decodeCalls });
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test('player artwork checkpoint extracts the computed URL and decodes it with a fresh browser Image', async () => {
  const { readDecodedPlayerCoverCheckpoint } = await import(globalPlayerUrl);
  const serializedCheckpoint = Function(
    `"use strict"; return (${readDecodedPlayerCoverCheckpoint.toString()});`,
  )();

  await withBrowserArtworkFakes({}, async ({ button, decodeCalls }) => {
    const checkpoint = await serializedCheckpoint(button);

    assert.deepEqual(decodeCalls, ['http://127.0.0.1:4173/cover?path=Joseph.png']);
    assert.deepEqual(checkpoint, {
      hidden: false,
      backgroundImage: 'url("/cover?path=Joseph.png")',
      sourceUrl: 'http://127.0.0.1:4173/cover?path=Joseph.png',
      width: 72,
      height: 72,
      naturalWidth: 480,
      naturalHeight: 480,
    });
  });
});

test('player artwork checkpoint rejects a CSS URL when browser Image.decode rejects it', async () => {
  const { readDecodedPlayerCoverCheckpoint } = await import(globalPlayerUrl);

  await withBrowserArtworkFakes({ decodeError: new Error('invalid image') }, async ({ button, decodeCalls }) => {
    await assert.rejects(
      readDecodedPlayerCoverCheckpoint(button),
      /invalid image/,
    );

    assert.deepEqual(decodeCalls, ['http://127.0.0.1:4173/cover?path=Joseph.png']);
  });
});

test('player artwork checkpoint rejects an undecoded zero-size image', async () => {
  const { readDecodedPlayerCoverCheckpoint } = await import(globalPlayerUrl);

  await withBrowserArtworkFakes({ naturalWidth: 0 }, async ({ button, decodeCalls }) => {
    await assert.rejects(
      readDecodedPlayerCoverCheckpoint(button),
      /without positive intrinsic dimensions/,
    );

    assert.equal(decodeCalls.length, 1);
  });
});

test('FTC-PLAYER-010 consumes the POM checkpoint produced after browser image decode', () => {
  const pom = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'poms', 'globalPlayer.js'), 'utf8');
  const actions = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'actions', 'galleryActions.js'), 'utf8');
  const spec = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'specs', 'galleryCoverStability.spec.js'), 'utf8');
  const playerScenario = spec.split("test('FTC-PLAYER-010", 2)[1];

  assert.match(
    pom,
    /coverButton\.evaluate\(readDecodedPlayerCoverCheckpoint\)/,
  );
  assert.match(spec, /new URL\(playerCover\.sourceUrl\)/);
  assert.match(spec, /playerCover\.naturalWidth\)\.toBeGreaterThan\(0\)/);
  assert.match(spec, /playerCover\.naturalHeight\)\.toBeGreaterThan\(0\)/);
  assert.doesNotMatch(spec, /sourceMatch\s*=\s*\/\^url/);
  assert.match(
    actions,
    /async waitForMinimumAlbumCountByHeading\(artistName, minimumAlbumCount, options = \{\}\)[\s\S]*>= selectors\.minimumAlbumCount/,
  );
  assert.match(
    playerScenario,
    /waitForSelectedArtistGallery\(ARTIST\);[\s\S]{0,200}waitForMinimumAlbumCountByHeading\(ARTIST, 2\);[\s\S]{0,200}readAlbumNamesByHeading\(ARTIST\)/,
  );
});
