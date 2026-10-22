import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { expect, test } from '../support/baseFixtures.js';
import { waitForDisplayedImageDecode } from '../actions/coverLookupActions.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';
import { InvitationPage, LoginPage, MembersPage } from '../phase7/poms/authPages.js';

const ARTIST = 'Generated Preview Storage Artist';
const ALBUM = 'Generated Preview Storage Album';
const YEAR = 2026;
const OWNED_DIRECTORY = 'generated-preview-storage';
const MEMBER = Object.freeze({
  username: 'preview.storage.listener',
  email: 'preview.storage.listener@example.test',
  password: 'Cobalt Meadow 73! Silent Aurora',
});
const HARD_CEILING_MS = 1200;
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

async function selectStorage(page, { mode, root = '' }) {
  await page.goto('/admin/server');
  await expect(page.getByRole('heading', { name: 'Album previews' })).toBeVisible();
  const current = await readStorageState(page);
  await expect(page.locator(`[data-preview-mode="${current.mode}"]`)).toBeChecked({ timeout: 10_000 });
  await page.locator(`[data-preview-mode="${mode}"]`).check({ timeout: 10_000 });
  if (mode === 'custom') {
    const pathInput = page.locator('[data-preview-path]');
    await expect(pathInput).toBeEnabled({ timeout: 10_000 });
    await pathInput.fill(root, { timeout: 10_000 });
  }
  page.once('dialog', (dialog) => dialog.accept());
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => (
      candidate.request().method() === 'PUT'
      && new URL(candidate.url()).pathname === '/admin/server/preview-storage'
    ), { timeout: 10_000 }),
    page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 10_000 }),
  ]);
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
        const initialHashes = hashTree(albumCacheRoot);
        expect(Object.keys(initialHashes).length).toBeGreaterThanOrEqual(150);
        testArtifacts.queueJsonAttachment('generated-preview-storage-initial-hashes.json', initialHashes);
      });

      let initialHashes;
      await stepLogger.step('Relocate to custom storage while foreground interactions retain hard ceilings', async () => {
        const albumCacheRoot = path.join(fixture.albumDirectory, '.album-haven');
        initialHashes = hashTree(albumCacheRoot);
        if (fs.existsSync(customRoot)) fs.rmSync(customRoot, { recursive: true });
        const started = await selectStorage(page, { mode: 'custom', root: customRoot });
        expect(['queued', 'running']).toContain(started.operation_state);

        await galleryActions.goto('/?surface=albums');
        await galleryActions.waitForGalleryReady();
        const searchStartedAt = performance.now();
        await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(ARTIST);
        await galleryActions.waitForAlbumVisible(ALBUM);
        const galleryReadyMs = performance.now() - searchStartedAt;
        const cover = galleryActions.albumCoverByName(ALBUM);
        await cover.evaluate(waitForDisplayedImageDecode);
        const firstDecodedCoverMs = performance.now() - searchStartedAt;
        expect(galleryReadyMs).toBeLessThanOrEqual(HARD_CEILING_MS);
        expect(firstDecodedCoverMs).toBeLessThanOrEqual(HARD_CEILING_MS);
        await coverLookupActions.readDisplayedImageEvidence(cover, 'cover during relocation');

        await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
        await trackModalActions.waitForReady();
        const lookupStartedAt = performance.now();
        await trackModalActions.openCoverLookup();
        await coverLookupActions.waitForModalReady({ timeout: HARD_CEILING_MS });
        const coverLookupReadyMs = performance.now() - lookupStartedAt;
        expect(coverLookupReadyMs).toBeLessThanOrEqual(HARD_CEILING_MS);
        const candidates = await coverLookupActions.readLocalCoverCandidates();
        expect(candidates.some((candidate) => /[\\/]\.album-haven[\\/]/i.test(candidate.sourcePath))).toBe(false);
        await coverLookupActions.closeModal();
        await trackModalActions.close();

        const completed = await waitForStorageState(
          page,
          (state) => state.mode === 'custom' && state.operation_state === 'completed' && !state.requested_mode,
          'custom preview relocation should complete',
        );
        expect(completed.failed_count).toBe(0);
        expect(hashTree(path.join(customRoot, 'v1'))).toMatchObject(initialHashes);
        expect(hashTree(albumCacheRoot)).toEqual({});
        testArtifacts.queueJsonAttachment('generated-preview-storage-relocation-performance.json', {
          galleryReadyMs,
          firstDecodedCoverMs,
          coverLookupReadyMs,
          operationStateAfterInteractions: (await readStorageState(page)).operation_state,
        });
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
        expect(hashTree(path.join(customRoot, 'v1'))).toEqual({});

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
        for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await page.goto('/admin/server');
          const form = page.getByRole('form', { name: 'Album previews' });
          await expect(form).toBeVisible();
          const bounds = await form.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
          const albumFolders = page.locator('[data-preview-mode="album_folders"]');
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
