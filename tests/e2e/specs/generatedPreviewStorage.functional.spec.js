import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { expect, test } from '../support/baseFixtures.js';
import { waitForDisplayedImageDecode } from '../actions/coverLookupActions.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';
import {
  defineTimingBudget,
  expectTimingBudget,
  formatTimingBudgetOutcome,
} from '../helpers/timingBudget.js';
import { InvitationPage, LoginPage, MembersPage } from '../phase7/poms/authPages.js';
import { AdminServerPage } from '../poms/adminServer.js';

const ARTIST = 'Generated Preview Storage Artist';
const ALBUM = 'Generated Preview Storage Album';
const YEAR = 2026;
const OWNED_DIRECTORY = 'generated-preview-storage';
const MEMBER = Object.freeze({
  username: 'preview.storage.listener',
  email: 'preview.storage.listener@example.test',
  password: 'Cobalt Meadow 73! Silent Aurora',
});
const GALLERY_BUDGET = defineTimingBudget({ targetMaximum: 800, graceMs: 400 });
const COVER_LOOKUP_BUDGET = defineTimingBudget({ targetMaximum: 800, graceMs: 400 });
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAHIElEQVR4nO3VMQEAIAzAMEDN/OtBDDI4mijo131nFgA953cAAH8YAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAEQZAECUAQBEGQBAlAEARBkAQJQBAKymB5R4BSw25oZ9AAAAAElFTkSuQmCC',
  'base64',
);
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAHIUlEQVR4nO3VMQ0AIADAMEANcvAfxCCDY62CfZv73AFAz/odAMAfBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAABRBgAQZQAAUQYAEGUAAFEGABBlAACj6QH+4AVUj09TVAAAAABJRU5ErkJggg==',
  'base64',
);

test.use({ authenticateFreshBrowserSession: false });

function hashTree(root) {
  if (!fs.existsSync(root)) return {};
  const result = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) {
        result[path.relative(root, candidate).split(path.sep).join('/')] = createHash('sha256')
          .update(fs.readFileSync(candidate))
          .digest('hex');
      }
    }
  };
  visit(root);
  return result;
}

function hashAlbumFolderCaches(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name !== '.album-haven') {
        visit(candidate);
        continue;
      }
      for (const [relativePath, hash] of Object.entries(hashTree(candidate))) {
        if (relativePath in result && result[relativePath] !== hash) {
          throw new Error(`Generated preview key collision: ${relativePath}`);
        }
        result[relativePath] = hash;
      }
    }
  };
  visit(root);
  return result;
}

async function readStorageState(page) {
  const response = await authenticatedPageGet(page, '/admin/server/preview-storage');
  expect(response.status()).toBe(200);
  return response.json();
}

async function waitForStorageState(page, predicate, message) {
  let state = null;
  await expect.poll(async () => {
    state = await readStorageState(page);
    return predicate(state);
  }, { timeout: 60_000, intervals: [100, 250, 500, 1000], message }).toBe(true);
  return state;
}

// The controls stay disabled while a follow-up reconciliation of late previews runs.
async function openIdleStorageSettings(page) {
  await page.goto('/admin/server');
  await waitForStorageState(
    page,
    (state) => !['queued', 'running', 'cancel_requested'].includes(state.operation_state),
    'preview storage should be idle before its controls are used',
  );
  await page.goto('/admin/server');
}

async function selectStorage(page, { mode, root = '' }) {
  const adminServer = new AdminServerPage(page);
  await openIdleStorageSettings(page);
  await expect(adminServer.heading).toBeVisible();
  const current = await readStorageState(page);
  await expect(adminServer.mode(current.mode)).toBeChecked({ timeout: 10_000 });
  await adminServer.mode(mode).check({ timeout: 10_000 });
  if (mode === 'custom') {
    await expect(adminServer.path).toBeEnabled({ timeout: 10_000 });
    if (current.mode !== 'custom') {
      // Owner (11-09, UI-8): the proposed folder is the field's value, not a hint.
      await expect(adminServer.path).toHaveValue(current.suggested_path);
      await expect(adminServer.save).toBeEnabled();
    }
    // Owner (11-09, UI-7): the folder icon opens the server's own folders.
    await expect(adminServer.browse).toBeEnabled();
    await adminServer.browse.click({ timeout: 10_000 });
    const chooser = page.getByRole('dialog', { name: 'Choose server folder' });
    await expect(chooser).toBeVisible();
    await expect(chooser.locator('[data-folder-path]').first()).toBeVisible();
    await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(chooser).toBeHidden();
    await adminServer.path.fill(root, { timeout: 10_000 });
  }
  // Owner (11-09): the move is confirmed in the app's own dialog; a browser confirm() fails the test.
  const browserDialog = (dialog) => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`); };
  page.on('dialog', browserDialog);
  await adminServer.save.click({ timeout: 10_000 });
  const confirm = page.getByRole('dialog', { name: 'Move album previews' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Covers stay available while the move runs.');
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => (
      candidate.request().method() === 'PUT'
      && new URL(candidate.url()).pathname === '/admin/server/preview-storage'
    ), { timeout: 10_000 }),
    confirm.getByRole('button', { name: 'Move previews', exact: true }).click({ timeout: 10_000 }),
  ]);
  page.off('dialog', browserDialog);
  await expect(confirm).toBeHidden();
  expect(response.status()).toBe(202);
  return response.json();
}

async function generateVariants(page, productionSource, sizes) {
  const source = new URL(productionSource, page.url());
  for (let offset = 0; offset < sizes.length; offset += 8) {
    const responses = await Promise.all(sizes.slice(offset, offset + 8).map(async (size) => {
      const url = new URL(source);
      url.searchParams.set('size', String(size));
      return authenticatedPageGet(page, url.toString(), {
        headers: { 'X-Album-Haven-Cover-Priority': 'foreground' },
      });
    }));
    for (const response of responses) expect(response.status()).toBe(200);
  }
}

test(
  'FTC-PREVIEW-STORAGE-001 / 002 relocates generated previews safely and denies non-owner access',
  { tag: '@area:settings' },
  async ({
    appBarActions,
    context,
    coverLookupActions,
    freshBrowserSession,
    galleryActions,
    managedAppLifecycle,
    page,
    searchToolbarActions,
    stepLogger,
    testArtifacts,
    trackModalActions,
  }) => {
    test.skip(process.platform === 'linux', 'Native watched-media acceptance is Windows-only.');
    test.setTimeout(300_000);
    expect(process.env.PLAYWRIGHT_MANAGED_APP).toBe('1');

    const tempRoot = path.resolve(String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || ''));
    const customRoot = path.join(tempRoot, 'generated-preview-storage-custom');
    let fixture;
    let originalFailure;

    try {
      await stepLogger.step('Create owned real media and generate inventoried previews through the production cover route', async () => {
        fixture = await createWatchedAlbumFixture({
          artist: ARTIST,
          album: ALBUM,
          year: YEAR,
          ownedDirectoryName: OWNED_DIRECTORY,
          context,
          managedAppLifecycle,
        });
        fs.writeFileSync(path.join(fixture.albumDirectory, 'cover.png'), PNG_RED);
        fs.writeFileSync(path.join(fixture.albumDirectory, 'alternate.png'), PNG_BLUE);
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await appBarActions.triggerFullRescanAndWait();
        await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(ARTIST);
        await galleryActions.waitForAlbumVisible(ALBUM);
        const cover = galleryActions.albumCoverByName(ALBUM);
        await coverLookupActions.readDisplayedImageEvidence(cover, 'owned album cover');
        const productionSource = await cover.getAttribute('data-production-cover-src');
        expect(productionSource).toContain('/cover?');
        await generateVariants(page, productionSource, Array.from({ length: 160 }, (_, index) => 80 + index));

        const albumCacheRoot = path.join(fixture.albumDirectory, '.album-haven');
        const preexistingPreview = path.join(
          albumCacheRoot,
          'cover_variants',
          'fe',
          `${'f'.repeat(40)}.webp`,
        );
        fs.mkdirSync(path.dirname(preexistingPreview), { recursive: true });
        fs.writeFileSync(preexistingPreview, Buffer.from('pre-feature-preview'));
        const initialHashes = hashTree(albumCacheRoot);
        expect(Object.keys(initialHashes).length).toBeGreaterThanOrEqual(150);
        testArtifacts.queueJsonAttachment('generated-preview-storage-initial-hashes.json', initialHashes);
      });

      let initialHashes;
      await stepLogger.step('Relocate to custom storage while foreground interactions retain hard ceilings', async () => {
        const albumCacheRoot = path.join(fixture.albumDirectory, '.album-haven');
        initialHashes = hashTree(albumCacheRoot);
        if (fs.existsSync(customRoot)) fs.rmSync(customRoot, { recursive: true });
        // Owner (11-10): a move with a failed file has not switched yet, and Settings must say so. A different file
        // already at one preview's destination is the one failure the move refuses.
        const [conflictRelative, conflictSource] = Object.keys(initialHashes)
          .filter((relative) => relative.startsWith('cover_variants/') && !relative.includes('f'.repeat(40)))
          .sort();
        const conflictTarget = path.join(customRoot, 'v1', conflictRelative);
        fs.mkdirSync(path.dirname(conflictTarget), { recursive: true });
        fs.writeFileSync(conflictTarget, fs.readFileSync(path.join(albumCacheRoot, conflictSource)));
        const started = await selectStorage(page, { mode: 'custom', root: customRoot });
        expect(['queued', 'running']).toContain(started.operation_state);
        // Owner (11-09, UI-8): once the move has recorded its list, a preview that changes on disk (regenerated
        // with the inventory recorder off, as on sandbox3) has a stale checksum, and one may disappear. The stale
        // one still moves and is re-checked; the missing one is left to be regenerated. Neither fails the move.
        await waitForStorageState(
          page,
          (state) => state.operation_state === 'running' && Number(state.completed_count) > 0,
          'the preview move should be under way',
        );
        const notYetMoved = Object.keys(hashTree(albumCacheRoot))
          .filter((relative) => relative.startsWith('cover_variants/') && !relative.includes('f'.repeat(40)))
          .sort();
        expect(notYetMoved.length).toBeGreaterThanOrEqual(3);
        const [regeneratedRelative, staleRelative, missingRelative] = notYetMoved.slice(-3);
        // A real preview of another size stands in for the regenerated one: a valid image with a new checksum.
        const regenerated = fs.readFileSync(path.join(albumCacheRoot, regeneratedRelative));
        fs.writeFileSync(path.join(albumCacheRoot, staleRelative), regenerated);
        fs.rmSync(path.join(albumCacheRoot, missingRelative));
        initialHashes[staleRelative] = createHash('sha256').update(regenerated).digest('hex');
        delete initialHashes[missingRelative];
        // Owner (11-09): a preview written into the album folder after the move passed it (never recorded) is moved
        // by the move's cleanup, which then removes the emptied .album-haven folder.
        const lateRelative = `cover_variants/ee/${'e'.repeat(40)}.webp`;
        fs.mkdirSync(path.join(albumCacheRoot, 'cover_variants', 'ee'), { recursive: true });
        fs.writeFileSync(path.join(albumCacheRoot, lateRelative), regenerated);
        initialHashes[lateRelative] = createHash('sha256').update(regenerated).digest('hex');

        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        const searchStartedAt = performance.now();
        await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(ARTIST);
        await galleryActions.waitForAlbumVisible(ALBUM);
        const galleryReadyMs = performance.now() - searchStartedAt;
        const cover = galleryActions.albumCoverByName(ALBUM);
        // parity-check: allow-read-only-measurement-evaluate -- wait for the rendered image to decode
        await cover.evaluate(waitForDisplayedImageDecode);
        const firstDecodedCoverMs = performance.now() - searchStartedAt;
        const galleryReady = expectTimingBudget(
          expect,
          galleryReadyMs,
          GALLERY_BUDGET,
          'Preview relocation search gallery readiness',
        );
        const firstDecodedCover = expectTimingBudget(
          expect,
          firstDecodedCoverMs,
          GALLERY_BUDGET,
          'Preview relocation first decoded cover',
        );
        await coverLookupActions.readDisplayedImageEvidence(cover, 'cover during relocation');

        await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
        await trackModalActions.waitForReady();
        const lookupStartedAt = performance.now();
        await trackModalActions.openCoverLookup();
        await coverLookupActions.waitForModalReady({ timeout: COVER_LOOKUP_BUDGET.hardCeiling });
        const coverLookupReadyMs = performance.now() - lookupStartedAt;
        const coverLookupReady = expectTimingBudget(
          expect,
          coverLookupReadyMs,
          COVER_LOOKUP_BUDGET,
          'Preview relocation Cover Lookup readiness',
        );
        const candidates = await coverLookupActions.readLocalCoverCandidates();
        expect(candidates.some((candidate) => /[\\/]\.album-haven[\\/]/i.test(candidate.sourcePath))).toBe(false);
        await coverLookupActions.closeModal();
        await trackModalActions.close();

        const unfinished = await waitForStorageState(
          page,
          (state) => state.operation_state === 'completed_with_failures',
          'the move should finish with the one refused file',
        );
        expect({ mode: unfinished.mode, failed: unfinished.failed_count }).toEqual({ mode: 'album_folders', failed: 1 });
        const adminServer = new AdminServerPage(page);
        // Owner (11-10): "that needs to also come as notification in notification panel ... Clicking in the
        // notification will lead the user to that server setting page", and a pop-up alert so the owner notices.
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await expect(page.locator('#toast-layer .toast').filter({ hasText: 'Move album previews failed. Your attention is needed.' }))
          .toBeVisible({ timeout: 10_000 });
        await coverLookupActions.openDrawer();
        const attention = page.locator('#preview-move-attention [data-preview-move-attention]');
        await expect(attention).toBeVisible();
        await expect(attention).toContainText('Move album previews failed');
        await expect(attention).toContainText('Your attention is needed');
        await expect(attention).toContainText('1 file failed');
        await attention.click();
        await expect(page).toHaveURL(/\/admin\/server$/);
        await expect(adminServer.heading).toBeVisible();
        // Owner (11-10): the option the owner chose stays chosen after a reload, marked not finished.
        await page.goto('/admin/server');
        await expect(adminServer.mode('custom')).toBeChecked();
        await expect(page.locator('label.ui-radio-option').filter({ has: adminServer.mode('custom') }))
          .toContainText('Special path (not finished)');
        // The note asks for Retry, as wide as its message.
        await expect(adminServer.status).toContainText(
          `Moving to ${customRoot}: 1 file failed. The switch happens after they're retried.`,
        );
        const [noteBox, formBox] = await Promise.all([adminServer.status.boundingBox(), adminServer.form.boundingBox()]);
        expect(noteBox.width).toBeLessThan(formBox.width - 40);
        // Owner (11-10): the selected radio shows a filled dot in its ring.
        // parity-check: allow-read-only-measurement-evaluate -- read the rendered radio dot
        expect(await adminServer.mode('custom').evaluate((input) => new DOMMatrix(getComputedStyle(input, '::before').transform).a)).toBe(1);
        expect(await adminServer.mode('album_folders').evaluate((input) => new DOMMatrix(getComputedStyle(input, '::before').transform).a)).toBe(0);
        fs.rmSync(conflictTarget);
        // Owner (11-10): "I clicked Retry failed files - but saw no reaction". The button shows it is working at
        // once, the note goes once Retry is clicked, and the summary line carries the progress and result.
        // parity-check: allow-read-only-measurement-evaluate -- record the Retry button, note and summary on every frame
        await page.evaluate(() => {
          const frames = [];
          window.__retryFrames = frames;
          const read = () => {
            const button = document.querySelector('[data-preview-retry]');
            const status = document.querySelector('[data-preview-status]');
            const counts = document.querySelector('[data-preview-counts]')?.textContent || '';
            const entry = `${button?.getAttribute('aria-busy') === 'true' ? 'busy' : 'idle'}|${status && !status.hidden ? 'note' : 'no-note'}|${counts}`;
            if (frames.at(-1) !== entry) frames.push(entry);
            if (frames.length < 400 && !/cleaned up/.test(counts)) requestAnimationFrame(read);
          };
          requestAnimationFrame(read);
        });
        await adminServer.retry.click();
        await expect(adminServer.counts).toContainText('cleaned up 1 cache folders', { timeout: 60_000 });
        await expect(adminServer.status).toBeHidden();
        await expect(adminServer.mode('custom')).toBeChecked();
        await expect(page.locator('label.ui-radio-option').filter({ has: adminServer.mode('custom') })).toHaveText('Special path');
        const retryFrames = await page.evaluate(() => window.__retryFrames);
        const clickedAt = retryFrames.findIndex((frame) => frame.startsWith('busy|'));
        expect(clickedAt, JSON.stringify(retryFrames)).toBeGreaterThan(-1);
        expect(retryFrames[clickedAt], 'the note goes as the button turns busy').toMatch(/^busy\|no-note\|/);
        expect(retryFrames.slice(clickedAt).some((frame) => frame.includes('|note|')), JSON.stringify(retryFrames)).toBe(false);
        const completed = await waitForStorageState(
          page,
          (state) => state.mode === 'custom' && state.operation_state === 'completed' && !state.requested_mode,
          'custom preview relocation should complete after the retry',
        );
        expect(completed.failed_count).toBe(0);
        expect({ rechecked: completed.rechecked_count, regenerateLater: completed.regenerate_later_count })
          .toEqual({ rechecked: 1, regenerateLater: 1 });
        expect(hashTree(path.join(customRoot, 'v1'))).toMatchObject(initialHashes);
        await page.goto('/admin/server');
        await expect(adminServer.mode('custom')).toBeChecked();
        await expect(adminServer.counts).toContainText('cleaned up 1 cache folders');
        // The late preview was never recorded, so the reverse move below does not bring it back.
        delete initialHashes[lateRelative];
        await expect(adminServer.counts).toContainText(/ moved · 1 re-checked · 1 to be regenerated · 0 failed · cleaned up 1 cache folders$/);
        await expect(page.locator('[data-preview-failure]')).toBeHidden();
        expect(hashTree(albumCacheRoot)).toEqual({});
        testArtifacts.queueJsonAttachment('generated-preview-storage-relocation-performance.json', {
          galleryReady,
          firstDecodedCover,
          coverLookupReady,
          operationStateAfterInteractions: (await readStorageState(page)).operation_state,
        });
        console.info([
          formatTimingBudgetOutcome('Search gallery', galleryReady),
          formatTimingBudgetOutcome('First decoded cover', firstDecodedCover),
          formatTimingBudgetOutcome('Cover Lookup', coverLookupReady),
        ].join(' '));
      });

      await stepLogger.step('Interrupt reverse relocation, restart the real app, and verify byte-identical recovery', async () => {
        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(ARTIST);
        await galleryActions.waitForAlbumVisible(ALBUM);
        const cover = galleryActions.albumCoverByName(ALBUM);
        await coverLookupActions.readDisplayedImageEvidence(cover, 'custom-storage cover');
        const productionSource = await cover.getAttribute('data-production-cover-src');
        await generateVariants(page, productionSource, Array.from({ length: 80 }, (_, index) => 300 + index));
        initialHashes = hashTree(path.join(customRoot, 'v1'));

        const started = await selectStorage(page, { mode: 'album_folders' });
        expect(['queued', 'running']).toContain(started.operation_state);
        await page.goto('about:blank');
        await managedAppLifecycle.restart();
        await page.goto('/admin/server');
        const completed = await waitForStorageState(
          page,
          (state) => state.mode === 'album_folders' && state.operation_state === 'completed' && !state.requested_mode,
          'reverse preview relocation should recover after restart',
        );
        expect(completed.failed_count).toBe(0);
        expect(hashAlbumFolderCaches(fixture.mediaRoot)).toMatchObject(initialHashes);
        // The worker clears the old cache just after it publishes the completed state.
        await expect.poll(() => hashTree(path.join(customRoot, 'v1')), {
          timeout: 30000,
          intervals: [250, 500, 1000],
        }).toEqual({});

        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(ARTIST);
        await galleryActions.waitForAlbumVisible(ALBUM);
        await coverLookupActions.readDisplayedImageEvidence(
          galleryActions.albumCoverByName(ALBUM),
          'album-folder cover after restart recovery',
        );
        await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
        await trackModalActions.waitForReady();
        await trackModalActions.openCoverLookup();
        await coverLookupActions.waitForModalReady();
        const candidates = await coverLookupActions.readLocalCoverCandidates();
        expect(candidates.some((candidate) => /[\\/]\.album-haven[\\/]/i.test(candidate.sourcePath))).toBe(false);
        await coverLookupActions.closeModal();
        await trackModalActions.close();
      });

      await stepLogger.step('Verify desktop and narrow owner controls, then deny an ordinary member page and API access', async () => {
        const adminServer = new AdminServerPage(page);
        for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await openIdleStorageSettings(page);
          await expect(adminServer.form).toBeVisible();
          const bounds = await adminServer.form.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
          const albumFolders = adminServer.mode('album_folders');
          // The choices render disabled until the page reads the storage state.
          await expect(albumFolders).toBeEnabled();
          await albumFolders.focus();
          await expect(albumFolders).toBeFocused();
        }

        const members = new MembersPage(page);
        await members.open();
        await members.openAddUser();
        await members.createUser({ username: MEMBER.username, email: MEMBER.email, sendInvitation: false });
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const invitationUrl = await members.copyInviteLink(MEMBER.username);
        const member = await freshBrowserSession.create();
        const invitation = new URL(invitationUrl);
        await member.page.goto(`${invitation.pathname}${invitation.search}`);
        await new InvitationPage(member.page).complete(MEMBER.password);
        const login = new LoginPage(member.page);
        await login.open('/admin/server');
        await login.signIn(MEMBER.username, MEMBER.password);

        const pageResponse = await member.page.goto('/admin/server');
        expect(pageResponse.status()).toBe(403);
        await expect(member.page.getByText('Action not permitted.', { exact: true })).toBeVisible();
        const apiResponse = await authenticatedPageGet(member.page, '/admin/server/preview-storage');
        expect(apiResponse.status()).toBe(403);
        expect(await apiResponse.json()).toEqual({ detail: 'Action not permitted.' });
      });
    } catch (error) {
      originalFailure = error;
      throw error;
    } finally {
      if (fs.existsSync(customRoot)) fs.rmSync(customRoot, { recursive: true });
      if (fixture) await fixture.cleanup({ context, managedAppLifecycle, originalFailure });
    }
  },
);
