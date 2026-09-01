import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import {
  isCoverLookupCancellationSettledBeforeArchiveWork,
  readCoverLookupProviderEvidence,
  resetCoverLookupProviderEvidence,
  setCoverLookupCandidateImageGate,
  setCoverLookupLaterProviderGate,
  setCoverLookupProviderLatency,
  setCoverLookupProviderMode,
} from '../helpers/coverLookupProviderHelpers.js';

function normalizeResponseUrl(url, baseUrl) {
  const normalized = new URL(url, baseUrl);
  normalized.hash = '';
  return normalized.toString();
}

export function isDisplayedImageEvidenceReady(state) {
  const visualStateIsReady = !state?.hasVisualState
    || String(state.visualState || '').trim() === 'ready';
  return Boolean(
    state?.currentSrc
    && state?.complete
    && Number(state?.naturalWidth || 0) > 0
    && Number(state?.width || 0) > 0
    && Number(state?.height || 0) > 0
    && visualStateIsReady
  );
}

export class CoverLookupActions {
  constructor(coverLookup) {
    this.coverLookup = coverLookup;
    this.laterProviderFixtureHeld = false;
    this.candidateImageFixtureHeld = false;
    this.providerFixtureMode = 'no-results';
    this.providerFixtureLatencySeconds = 0;
    this.imageResponseEvidence = new Map();
    this.coverLookup.page.on('response', (response) => {
      const responseUrl = normalizeResponseUrl(response.url(), this.coverLookup.page.url());
      const resourceType = response.request().resourceType();
      const responseLocation = new URL(responseUrl);
      const pageLocation = new URL(this.coverLookup.page.url());
      const isSameOriginCoverFetch = resourceType === 'fetch'
        && responseLocation.origin === pageLocation.origin
        && responseLocation.pathname === '/cover';
      if (resourceType !== 'image' && !isSameOriginCoverFetch) return;
      const evidence = (async () => {
        const failure = await response.finished();
        if (failure) throw failure;
        if (!response.ok()) {
          throw new Error(`Displayed cover image request failed with ${response.status()}: ${response.url()}`);
        }
        const body = await response.body();
        return {
          src: responseUrl,
          sha256: createHash('sha256').update(body).digest('hex').toUpperCase(),
        };
      })().then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      this.imageResponseEvidence.set(responseUrl, evidence);
    });
  }

  async waitForModalReady(options = {}) {
    await this.coverLookup.waitForVisible(this.coverLookup.modal, { timeout: options.timeout || 30000 });
    await this.coverLookup.waitForPageCondition((selectors) => {
      const modal = document.querySelector(selectors.modalSelector);
      const subtitle = document.querySelector(selectors.modalSubtitleSelector);
      const findBetterButton = document.querySelector(selectors.findBetterButtonSelector);
      return modal instanceof HTMLElement
        && !modal.hidden
        && subtitle instanceof HTMLElement
        && (subtitle.textContent || '').trim().length > 0
        && findBetterButton instanceof HTMLButtonElement;
    }, {
      timeout: options.timeout || 30000,
    }, {
      modalSelector: this.coverLookup.modalSelector,
      modalSubtitleSelector: this.coverLookup.modalSubtitleSelector,
      findBetterButtonSelector: this.coverLookup.findBetterButtonSelector,
    });
  }

  async waitForModalResultsReady(options = {}) {
    await this.coverLookup.waitForPageCondition((selectors) => {
      const modal = document.querySelector(selectors.modalSelector);
      const subtitle = document.querySelector(selectors.modalSubtitleSelector);
      const manualInput = document.querySelector(selectors.manualInputSelector);
      const manualExtractButton = document.querySelector(selectors.manualExtractButtonSelector);
      return modal instanceof HTMLElement
        && !modal.hidden
        && subtitle instanceof HTMLElement
        && (subtitle.textContent || '').trim().length > 0
        && manualInput instanceof HTMLTextAreaElement
        && manualExtractButton instanceof HTMLButtonElement;
    }, {
      timeout: options.timeout || 30000,
    }, {
      modalSelector: this.coverLookup.modalSelector,
      modalSubtitleSelector: this.coverLookup.modalSubtitleSelector,
      manualInputSelector: this.coverLookup.manualUrlInputSelector,
      manualExtractButtonSelector: this.coverLookup.manualExtractButtonSelector,
    });
  }

  async readModalSubtitle() {
    return (await this.coverLookup.modalSubtitle.textContent() || '').trim();
  }

  async expectNoPostgresConflictError() {
    await expect(this.coverLookup.modalStatus).not.toContainText(
      /42P10|there is no unique or exclusion constraint matching the ON CONFLICT specification/,
    );
  }

  async startSearch() {
    await this.coverLookup.findBetterButton.click();
  }

  async startSearchAndReadToastPlacement(options = {}) {
    const timeout = options.timeout || 30000;
    const modalDialogBeforeToast = await this.coverLookup.modalDialog.boundingBox();
    if (!modalDialogBeforeToast) {
      throw new Error('Expected visible modal geometry before starting the cover lookup.');
    }
    await this.startSearch();
    const finalVisualState = await this.coverLookup
      .waitForCoverLookupStartedToastFinalState({ timeout });
    await expect(this.coverLookup.coverLookupStartedToast).toBeVisible({ timeout });
    await expect(this.coverLookup.coverLookupStartedToast).toHaveText('Cover art lookup started.');
    await expect(this.coverLookup.searchProgress).toBeVisible({ timeout });
    const toastOcclusionTargets = this.coverLookup.toastOcclusionTargets();
    const targetEntries = Object.entries(toastOcclusionTargets);
    const [toastBox, ...targetBoxes] = await Promise.all([
      this.coverLookup.coverLookupStartedToast.boundingBox(),
      ...targetEntries.map(([, locator]) => locator.boundingBox()),
    ]);
    const viewport = this.coverLookup.page.viewportSize();
    if (!toastBox || targetBoxes.some((box) => !box) || !viewport) {
      throw new Error('Expected visible toast, modal, control, and viewport geometry.');
    }
    // parity-check: allow-read-only-measurement-evaluate -- toast center hit-testing and stacking evidence only
    const stackingEvidence = await this.coverLookup.coverLookupStartedToast.evaluate((toast) => {
      const toastLayer = toast.closest('.toast-layer');
      if (!(toastLayer instanceof HTMLElement)) {
        throw new Error('Expected the cover lookup toast inside the global toast layer.');
      }
      const toastBox = toast.getBoundingClientRect();
      const centerX = toastBox.left + (toastBox.width / 2);
      const centerY = toastBox.top + (toastBox.height / 2);
      const underlyingCenterElement = document.elementFromPoint(centerX, centerY);
      const readHighestStackingZIndex = (element) => {
        let current = element;
        let highestZIndex = 0;
        while (current instanceof HTMLElement) {
          const computedZIndex = Number.parseInt(getComputedStyle(current).zIndex, 10);
          if (Number.isFinite(computedZIndex)) {
            highestZIndex = Math.max(highestZIndex, computedZIndex);
          }
          current = current.parentElement;
        }
        return highestZIndex;
      };
      const toastLayerStyle = getComputedStyle(toastLayer);
      const toastLayerZIndex = Number.parseInt(toastLayerStyle.zIndex, 10) || 0;
      const underlyingStackingZIndex = readHighestStackingZIndex(
        underlyingCenterElement,
      );
      const underlyingOverlay = underlyingCenterElement instanceof Element
        ? underlyingCenterElement.closest('#cover-lookup-modal, [role="dialog"]')
        : null;
      return {
        pointerEvents: toastLayerStyle.pointerEvents,
        toastLayerZIndex,
        underlyingCenterElement: underlyingCenterElement instanceof Element
          ? underlyingCenterElement.tagName
          : '',
        underlyingOverlayId: underlyingOverlay instanceof HTMLElement
          ? underlyingOverlay.id
          : '',
        underlyingStackingZIndex,
        topmostAtCenter: toastLayerZIndex > underlyingStackingZIndex,
      };
    });
    const rectanglesIntersect = (left, right) => (
      left.x < right.x + right.width
      && left.x + left.width > right.x
      && left.y < right.y + right.height
      && left.y + left.height > right.y
    );
    const overlaps = Object.fromEntries(targetEntries.map(
      ([name], index) => [name, rectanglesIntersect(toastBox, targetBoxes[index])],
    ));
    const modalDialogAfterToast = targetBoxes[targetEntries.findIndex(([name]) => (
      name === 'modalDialog'
    ))];
    return {
      finalVisualState,
      horizontalCenterDelta: Math.abs(
        (toastBox.x + (toastBox.width / 2)) - (viewport.width / 2),
      ),
      modalGeometryDelta: {
        height: Math.abs(modalDialogAfterToast.height - modalDialogBeforeToast.height),
        width: Math.abs(modalDialogAfterToast.width - modalDialogBeforeToast.width),
        x: Math.abs(modalDialogAfterToast.x - modalDialogBeforeToast.x),
        y: Math.abs(modalDialogAfterToast.y - modalDialogBeforeToast.y),
      },
      overlaps,
      ...stackingEvidence,
    };
  }

  async holdLaterProviderFixture() {
    this.laterProviderFixtureHeld = true;
    return setCoverLookupLaterProviderGate(
      this.coverLookup.testInfo,
      'hold-later-provider',
    );
  }

  async holdCandidateImageFixture() {
    this.candidateImageFixtureHeld = true;
    return setCoverLookupCandidateImageGate(
      this.coverLookup.testInfo,
      'hold-candidate-images',
    );
  }

  async releaseCandidateImageFixture() {
    if (!this.candidateImageFixtureHeld) return null;
    const evidence = await setCoverLookupCandidateImageGate(
      this.coverLookup.testInfo,
      'release-candidate-images',
    );
    this.candidateImageFixtureHeld = false;
    return evidence;
  }

  async waitForCandidateImageFixtureBlocked(options = {}) {
    let evidence = null;
    await expect.poll(async () => {
      evidence = await readCoverLookupProviderEvidence(this.coverLookup.testInfo);
      return Number(evidence?.candidate_image_requests || 0);
    }, {
      message: 'Expected a candidate image request to be waiting at the provider fixture gate.',
      timeout: options.timeout || 30000,
      intervals: [250, 500, 750, 1000],
    }).toBeGreaterThan(0);
    expect(evidence?.candidate_image_released).toBe(false);
    return evidence;
  }

  async releaseLaterProviderFixture() {
    let evidence = null;
    if (this.candidateImageFixtureHeld) {
      evidence = await this.releaseCandidateImageFixture();
    }
    if (this.laterProviderFixtureHeld) {
      evidence = await setCoverLookupLaterProviderGate(
        this.coverLookup.testInfo,
        'release-later-provider',
      );
      this.laterProviderFixtureHeld = false;
    }
    return evidence;
  }

  async resetProviderFixture() {
    const resetErrors = [];
    let evidence = null;
    try {
      evidence = await setCoverLookupProviderMode(this.coverLookup.testInfo, 'no-results');
      this.providerFixtureMode = 'no-results';
    } catch (error) {
      resetErrors.push({ stage: 'mode', error });
    }
    try {
      evidence = await setCoverLookupProviderLatency(this.coverLookup.testInfo, 0);
      this.providerFixtureLatencySeconds = 0;
    } catch (error) {
      resetErrors.push({ stage: 'latency', error });
    }
    if (resetErrors.length) {
      const stagedErrors = resetErrors.map(({ stage, error }) => {
        const detail = error?.stack || error?.message || String(error);
        const stagedError = new Error(`Cover lookup provider reset failed during ${stage}: ${detail}`);
        stagedError.cause = error;
        return stagedError;
      });
      if (stagedErrors.length === 1) throw stagedErrors[0];
      throw new AggregateError(stagedErrors, 'Cover lookup provider reset failed.');
    }
    return evidence;
  }

  async setProviderFixtureMode(mode) {
    const normalizedMode = String(mode || '').trim();
    const evidence = await setCoverLookupProviderMode(this.coverLookup.testInfo, normalizedMode);
    this.providerFixtureMode = normalizedMode;
    return evidence;
  }

  async waitForLaterProviderFixtureBlocked(options = {}) {
    let evidence = null;
    await expect.poll(async () => {
      evidence = await readCoverLookupProviderEvidence(this.coverLookup.testInfo);
      return evidence;
    }, {
      message: 'Expected the deterministic later cover provider to be waiting at its fixture gate.',
      timeout: options.timeout || 30000,
      intervals: [250, 500, 750, 1000],
    }).toMatchObject({
      musicbrainz_started: 1,
      musicbrainz_completed: 0,
      cover_art_archive_requests: 0,
      later_provider_released: false,
    });
    return evidence;
  }

  async waitForLaterProviderCancellationEvidence(options = {}) {
    let stableSamples = 0;
    let evidence = null;
    await expect.poll(async () => {
      evidence = await readCoverLookupProviderEvidence(this.coverLookup.testInfo);
      const canceledBeforeRemainingWork = isCoverLookupCancellationSettledBeforeArchiveWork(evidence);
      stableSamples = canceledBeforeRemainingWork ? stableSamples + 1 : 0;
      return stableSamples;
    }, {
      message: 'Expected save cancellation to prevent later fake-provider work after gate release.',
      timeout: options.timeout || 30000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(2);
    return evidence;
  }

  async waitForPartialRemoteCandidates(options = {}) {
    await expect(this.coverLookup.firstRemoteCoverCard).toBeVisible({
      timeout: options.timeout || 30000,
    });
    return this.readRemoteCandidateIds();
  }

  async readRemoteCandidateIds() {
    const count = await this.coverLookup.remoteCoverCards.count();
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(String(
        await this.coverLookup.remoteCoverCards.nth(index).getAttribute('data-select-remote-cover') || '',
      ));
    }
    return ids;
  }

  async readRemoteCandidateSummaries() {
    // parity-check: allow-read-only-measurement-evaluate -- atomically read rendered cover candidate evidence
    return this.coverLookup.remoteCoverCards.evaluateAll((cards, selectors) => cards.map((card) => ({
      id: String(card.getAttribute('data-select-remote-cover') || '').trim(),
      imageSrc: String(card.querySelector(selectors.image)?.getAttribute('src') || '').trim(),
      name: String(card.querySelector(selectors.name)?.textContent || '').trim(),
      resolution: String(card.querySelector(selectors.resolution)?.textContent || '').trim(),
      source: String(card.querySelector(selectors.source)?.textContent || '').trim(),
      selected: card.classList.contains('is-active'),
    })), {
      image: this.coverLookup.remoteCoverImageWithinCardSelector,
      name: this.coverLookup.remoteCoverNameWithinCardSelector,
      resolution: this.coverLookup.remoteCoverResolutionWithinCardSelector,
      source: this.coverLookup.remoteCoverSourceWithinCardSelector,
    });
  }

  async setProviderFixtureLatency(delaySeconds) {
    const normalizedDelay = Number(delaySeconds);
    const evidence = await setCoverLookupProviderLatency(
      this.coverLookup.testInfo,
      normalizedDelay,
    );
    this.providerFixtureLatencySeconds = normalizedDelay;
    return evidence;
  }

  async readProviderGroupSummary(providerGroup) {
    return {
      cards: await this.coverLookup.providerRemoteCoverCards(providerGroup).count(),
      otherArtCards: await this.coverLookup.providerOtherArtCards(providerGroup).count(),
    };
  }

  async resetProviderFixtureEvidence() {
    return resetCoverLookupProviderEvidence(this.coverLookup.testInfo);
  }

  async waitForAutomaticProviderSearch(target, options = {}) {
    const expectedAlbum = String(target?.album || '').trim().toLowerCase();
    let evidence = null;
    await expect.poll(async () => {
      evidence = await readCoverLookupProviderEvidence(this.coverLookup.testInfo);
      return (evidence.apple_search_terms || []).some(
        (term) => String(term || '').toLowerCase().includes(expectedAlbum),
      );
    }, {
      message: `Expected automatic cover lookup to search Apple for ${target?.album || 'the album'}.`,
      timeout: options.timeout || 120000,
      intervals: [500, 1000, 2000],
    }).toBe(true);
    return evidence;
  }

  async waitForRemoteCandidateCountAtLeast(minimumCount, options = {}) {
    await expect.poll(
      () => this.coverLookup.remoteCoverCards.count(),
      {
        message: `Expected at least ${minimumCount} remote cover candidates.`,
        timeout: options.timeout || 30000,
      },
    ).toBeGreaterThanOrEqual(Number(minimumCount));
  }

  async waitForRemoteCandidateId(candidateId, options = {}) {
    const expectedId = String(candidateId || '').trim();
    await expect.poll(
      () => this.readRemoteCandidateIds(),
      {
        message: `Expected remote cover candidate ${expectedId}.`,
        timeout: options.timeout || 30000,
      },
    ).toContain(expectedId);
  }

  async readSelectedRemoteCandidateId() {
    const summaries = await this.readRemoteCandidateSummaries();
    return String(summaries.find((candidate) => candidate.selected)?.id || '');
  }

  async waitForSelectedRemoteCandidateId(candidateId, options = {}) {
    const expectedId = String(candidateId || '').trim();
    await expect.poll(
      () => this.readSelectedRemoteCandidateId(),
      {
        message: `Expected selected remote cover candidate ${expectedId}.`,
        timeout: options.timeout || 30000,
      },
    ).toBe(expectedId);
  }

  async selectRemoteCandidateById(candidateId, options = {}) {
    const card = this.coverLookup.remoteCoverCardById(candidateId);
    await expect(card).toBeVisible({ timeout: options.timeout || 30000 });
    await this.coverLookup.localCoverActionWithin(card).click();
    await expect(card).toHaveClass(/\bis-active\b/, {
      timeout: options.timeout || 30000,
    });
  }

  async selectRemoteCandidateByIdAndSave(candidateId, options = {}) {
    const timeout = options.timeout || 30000;
    await this.selectRemoteCandidateById(candidateId, { timeout });
    const responsePromise = this.coverLookup.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/cover-lookup/save-remote'
    ), { timeout });
    await expect(this.coverLookup.saveRemoteButton).toBeEnabled({ timeout });
    await this.coverLookup.saveRemoteButton.click();
    const response = await responsePromise;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        `Remote cover selection failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    await this.coverLookup.waitForHidden(this.coverLookup.modal, { timeout });
    return payload;
  }

  async reopenUntilSavedRemoteCoverIsActive(
    openGallery,
    expectedSource,
    expectedCandidateId,
    options = {},
  ) {
    const timeout = options.timeout || 30000;
    let summaries = [];
    let source = '';
    await expect.poll(async () => {
      if (!(await this.coverLookup.modal.isVisible())) {
        await openGallery();
        await this.waitForModalResultsReady({ timeout });
      }
      summaries = await this.readRemoteCandidateSummaries();
      const savedCard = this.coverLookup.savedRemoteCoverCard;
      if (!(await savedCard.isVisible())) {
        await this.closeModal();
        return false;
      }
      source = String(
        await this.coverLookup.remoteCoverSourceWithin(savedCard).textContent() || '',
      ).trim();
      const active = String(await savedCard.getAttribute('class') || '')
        .split(/\s+/)
        .includes('is-active');
      const retainedCandidate = summaries.find(
        (candidate) => candidate.id === String(expectedCandidateId || ''),
      );
      const ready = active
        && source.toLocaleLowerCase() === String(expectedSource).toLocaleLowerCase()
        && retainedCandidate?.selected === false;
      if (!ready) await this.closeModal();
      return ready;
    }, {
      message: `Expected ${expectedSource} to persist as the selected linked remote cover with its retained candidate after reopen.`,
      timeout,
      intervals: [2000, 3000, 5000],
    }).toBe(true);
    return { source, remoteCandidates: summaries };
  }

  async reopenUntilLocalCoverIsActive(openGallery, options = {}) {
    const timeout = options.timeout || 30000;
    let activeLocalCover = null;
    let remoteCandidates = [];
    await expect.poll(async () => {
      if (!(await this.coverLookup.modal.isVisible())) {
        await openGallery();
        await this.waitForModalResultsReady({ timeout });
      }
      const hasActiveLocalCover = await this.coverLookup.activeLocalCoverCard.count() === 1;
      activeLocalCover = hasActiveLocalCover
        ? await this.readLocalCoverCardEvidence(
          this.coverLookup.activeLocalCoverCard,
          'active local cover',
        )
        : null;
      remoteCandidates = await this.readRemoteCandidateSummaries();
      const ready = /[\\/]cover\.jpg$/i.test(activeLocalCover?.sourcePath || '')
        && !remoteCandidates.some((candidate) => candidate.selected);
      if (!ready) await this.closeModal();
      return ready;
    }, {
      message: 'Expected downloaded cover art to reopen as canonical local cover.jpg.',
      timeout,
      intervals: [2000, 3000, 5000],
    }).toBe(true);
    return { activeLocalCover, remoteCandidates };
  }

  async waitForModalSearchCompleted(options = {}) {
    await expect(this.coverLookup.modalStatus).toHaveText('Possible matches are ready.', {
      timeout: options.timeout || 120000,
    });
  }

  async readProviderFixtureEvidence() {
    return readCoverLookupProviderEvidence(this.coverLookup.testInfo);
  }

  async waitForDiscogsFixtureStarted(options = {}) {
    await expect.poll(
      async () => Number(
        (await this.readProviderFixtureEvidence()).discogs_search_requests || 0,
      ),
      {
        message: 'Expected Discogs to start while the other manual-search providers were active.',
        timeout: options.timeout || 30000,
      },
    ).toBeGreaterThan(0);
  }

  async readRemoteCandidateEvidence(candidateId, options = {}) {
    const expectedCandidateId = String(candidateId || '').trim();
    if (!expectedCandidateId) {
      throw new Error('A stable remote cover candidate identity is required.');
    }
    const count = await this.coverLookup.remoteCoverCards.count();
    for (let index = 0; index < count; index += 1) {
      const card = this.coverLookup.remoteCoverCards.nth(index);
      const actualCandidateId = String(
        await card.getAttribute('data-select-remote-cover') || '',
      ).trim();
      if (actualCandidateId !== expectedCandidateId) continue;
      return this.readDisplayedImageEvidence(
        this.coverLookup.remoteCoverImageWithin(card),
        `remote cover candidate ${expectedCandidateId}`,
        options,
      );
    }
    throw new Error(`Remote cover candidate ${expectedCandidateId} is not displayed.`);
  }

  async enterManualUrls(urls) {
    const value = Array.from(urls || [], (url) => String(url)).join('\n');
    await this.waitForModalResultsReady();
    await this.coverLookup.manualUrlInput.fill(value);
    await expect(this.coverLookup.manualUrlInput).toHaveValue(value);
  }

  async closeModal() {
    await this.coverLookup.closeModalButton.click();
    await this.coverLookup.waitForHidden(this.coverLookup.modal, { timeout: 30000 });
  }

  async openDrawer(options = {}) {
    if (await this.coverLookup.isDrawerOpen()) return;
    await this.coverLookup.drawerButton.click();
    await this.coverLookup.waitForDrawerState(true, { timeout: options.timeout || 30000 });
  }

  async pressSpaceOnFocusedDrawerOpener(options = {}) {
    await this.openDrawer(options);
    await this.coverLookup.drawerButton.focus();
    await expect(this.coverLookup.drawerButton).toBeFocused();
    await this.coverLookup.drawerButton.press('Space');
    await this.coverLookup.waitForDrawerState(true, { timeout: options.timeout || 30000 });
    await options.afterSpace?.();
    await expect(this.coverLookup.drawerButton).toBeFocused();
  }

  async closeDrawer(options = {}) {
    if (!(await this.coverLookup.isDrawerOpen())) return;
    await this.coverLookup.drawerCloseButton.click();
    await this.coverLookup.waitForDrawerState(false, { timeout: options.timeout || 30000 });
  }

  async pressSpaceOnFocusedDrawerClose(options = {}) {
    await this.openDrawer(options);
    await this.coverLookup.drawerCloseButton.focus();
    await expect(this.coverLookup.drawerCloseButton).toBeFocused();
    await this.coverLookup.drawerCloseButton.press('Space');
    await this.coverLookup.waitForDrawerState(true, { timeout: options.timeout || 30000 });
    await options.afterSpace?.();
    await expect(this.coverLookup.drawerCloseButton).toBeFocused();
  }

  async waitForDrawerOpen(options = {}) {
    await this.coverLookup.waitForDrawerState(true, { timeout: options.timeout || 30000 });
  }

  async reloadAndOpenDrawer(options = {}) {
    const timeout = options.timeout || 30000;
    await this.coverLookup.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(this.coverLookup.drawerButton).toBeVisible({ timeout });
    await this.openDrawer();
    await this.waitForDrawerOpen({ timeout });
  }

  async waitForDrawerBadgeCountAtLeast(minimumCount, options = {}) {
    await this.coverLookup.waitForPageCondition((selectors) => {
      const badge = document.querySelector(selectors.drawerBadgeSelector);
      if (!(badge instanceof HTMLElement) || badge.hidden) {
        return false;
      }
      return Number(badge.textContent || '0') >= selectors.minimumCount;
    }, {
      timeout: options.timeout || 30000,
    }, {
      drawerBadgeSelector: this.coverLookup.drawerBadgeSelector,
      minimumCount: Number(minimumCount),
    });
  }

  async waitForTaskVisible(taskTitle, options = {}) {
    await this.coverLookup.waitForVisible(
      this.coverLookup.taskCardByTitle(taskTitle),
      { timeout: options.timeout || 30000 },
    );
  }

  async readTaskStatus(taskTitle) {
    return (await this.coverLookup.taskStatusByTitle(taskTitle).textContent() || '').trim();
  }

  async dragSelectTaskTitleWithoutOpeningModal(taskTitle, options = {}) {
    const timeout = options.timeout || 30000;
    const taskOpenButton = this.coverLookup.taskOpenButtonByTitle(taskTitle);
    await expect(taskOpenButton).toBeVisible({ timeout });
    let textRects = [];
    await expect.poll(async () => {
      try {
        // parity-check: allow-read-only-measurement-evaluate -- atomically measure the currently connected card text before a real mouse selection gesture
        textRects = await taskOpenButton.evaluate((element) => {
          if (!element.isConnected) return [];
          const range = document.createRange();
          range.selectNodeContents(element);
          const rectangles = [...range.getClientRects()]
            .filter((rect) => rect.width >= 4 && rect.height >= 2);
          if (!rectangles.length) return [];
          const textWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let lastTextNode = null;
          let lastTextEnd = 0;
          let lastCharacterRect = null;
          while (textWalker.nextNode()) {
            const textNode = textWalker.currentNode;
            const finalNonWhitespace = String(textNode.textContent || '').match(/\S(?=\s*$)/u);
            if (!finalNonWhitespace) continue;
            const candidateTextEnd = Number(finalNonWhitespace.index) + 1;
            const candidateRange = document.createRange();
            candidateRange.setStart(textNode, candidateTextEnd - 1);
            candidateRange.setEnd(textNode, candidateTextEnd);
            const candidateRect = candidateRange.getBoundingClientRect();
            if (candidateRect.width < 1 || candidateRect.height < 2) continue;
            lastTextNode = textNode;
            lastTextEnd = candidateTextEnd;
            lastCharacterRect = candidateRect;
          }
          if (!lastTextNode || !lastCharacterRect) return [];
          const lastCharacterRange = document.createRange();
          lastCharacterRange.setStart(lastTextNode, lastTextEnd - 1);
          lastCharacterRange.setEnd(lastTextNode, lastTextEnd);
          const endRect = lastCharacterRange.getBoundingClientRect();
          const startRect = rectangles[0];
          return [startRect, endRect].map((rect) => ({
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            top: rect.top,
          }));
        });
      } catch (_error) {
        textRects = [];
      }
      return textRects.length;
    }, {
      message: `Expected selectable notification card geometry for ${taskTitle}.`,
      timeout,
    }).toBeGreaterThan(0);
    const startRect = textRects[0];
    const endRect = textRects[textRects.length - 1];
    await this.coverLookup.page.mouse.move(
      startRect.left + 2,
      startRect.top + (startRect.bottom - startRect.top) / 2,
    );
    await this.coverLookup.page.mouse.down();
    await this.coverLookup.page.mouse.move(
      endRect.left + (endRect.right - endRect.left) * 0.75,
      endRect.top + (endRect.bottom - endRect.top) / 2,
      { steps: 12 },
    );
    await this.coverLookup.page.mouse.up();
    // parity-check: allow-read-only-measurement-evaluate -- browser selection text only
    const selectedText = await this.coverLookup.page.evaluate(
      () => String(window.getSelection()?.toString() || '').trim(),
    );
    await this.coverLookup.page.context().grantPermissions(
      ['clipboard-read', 'clipboard-write'],
      { origin: new URL(this.coverLookup.page.url()).origin },
    );
    await this.coverLookup.page.keyboard.press('ControlOrMeta+C');
    // parity-check: allow-read-only-measurement-evaluate -- read clipboard text after the real platform copy shortcut
    const clipboardText = await this.coverLookup.page.evaluate(
      () => navigator.clipboard.readText(),
    );
    // parity-check: allow-read-only-measurement-evaluate -- verify the task trigger keeps its computed pointer cursor
    const cursor = await taskOpenButton.evaluate((element) => getComputedStyle(element).cursor);
    await expect(this.coverLookup.drawer).toBeVisible({ timeout });
    await expect(this.coverLookup.modal).toBeHidden({ timeout });
    return { clipboardText, cursor, selectedText };
  }

  async readTaskElapsed(taskTitle) {
    return (await this.coverLookup.taskElapsedByTitle(taskTitle).textContent() || '').trim();
  }

  async waitForRunningTaskElapsedToAdvance(taskTitle, options = {}) {
    const timeout = options.timeout || 10000;
    const elapsed = this.coverLookup.taskElapsedByTitle(taskTitle);
    await expect(elapsed).toHaveText(/^Elapsed \d/, { timeout });
    const initialLabel = await this.readTaskElapsed(taskTitle);
    let advancedLabel = '';
    await expect.poll(async () => {
      const currentLabel = await this.readTaskElapsed(taskTitle);
      if (/^Elapsed \d/.test(currentLabel) && currentLabel !== initialLabel) {
        advancedLabel = currentLabel;
      }
      return advancedLabel;
    }, {
      message: `Expected the running elapsed label for ${taskTitle} to advance from ${initialLabel}.`,
      timeout,
      intervals: [250, 500, 750, 1000],
    }).not.toBe('');
    return advancedLabel;
  }

  async waitForTerminalTaskElapsed(taskTitle, options = {}) {
    const timeout = options.timeout || 30000;
    const elapsed = this.coverLookup.taskElapsedByTitle(taskTitle);
    await expect(elapsed).toHaveText(/^Took \d/, { timeout });
    return this.readTaskElapsed(taskTitle);
  }

  async readTaskElapsedPill(taskTitle, options = {}) {
    const timeout = options.timeout || 30000;
    const elapsed = this.coverLookup.taskElapsedByTitle(taskTitle);
    await expect(elapsed).toBeVisible({ timeout });
    // parity-check: allow-read-only-measurement-evaluate -- elapsed pill class and computed geometry only
    return elapsed.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        className: element.className,
        display: style.display,
        borderRadius: Number.parseFloat(style.borderRadius) || 0,
        backgroundColor: style.backgroundColor,
        width: box.width,
        height: box.height,
      };
    });
  }

  async expectTaskElapsedStable(taskTitle, expectedLabel, options = {}) {
    const timeout = options.timeout || 5000;
    let sampleCount = 0;
    await expect.poll(async () => {
      sampleCount += 1;
      const currentLabel = await this.readTaskElapsed(taskTitle);
      return sampleCount >= 2 ? currentLabel : `initial:${currentLabel}`;
    }, {
      message: `Expected the terminal elapsed label for ${taskTitle} to remain frozen.`,
      timeout,
      intervals: [1200, 1200],
    }).toBe(expectedLabel);
  }

  async cancelTask(taskTitle) {
    await this.coverLookup.taskCancelButtonByTitle(taskTitle).click();
  }

  async clearTask(taskTitle) {
    await this.coverLookup.taskClearButtonByTitle(taskTitle).click();
  }

  async clearFinishedTasksAndPreserveActive(finishedTaskTitles, activeTaskTitle, options = {}) {
    const timeout = options.timeout || 30000;
    const responsePromise = this.coverLookup.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/cover-lookup/tasks/clear-completed'
    ), { timeout });
    await this.coverLookup.drawerClearCompletedButton.click();
    for (const taskTitle of finishedTaskTitles) {
      await this.expectTaskHiddenImmediately(taskTitle);
    }
    await expect(this.coverLookup.taskCardByTitle(activeTaskTitle)).toBeVisible();
    const response = await responsePromise;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        `Bulk notification clear failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    for (const taskTitle of finishedTaskTitles) {
      await expect(this.coverLookup.taskCardByTitle(taskTitle)).toBeHidden({ timeout });
    }
    await this.waitForTaskActive(activeTaskTitle, { timeout });
    return {
      removedCount: Number(payload.removed_count || 0),
      requestedTaskCount: Array.isArray(response.request().postDataJSON()?.task_ids)
        ? response.request().postDataJSON().task_ids.length
        : 0,
    };
  }

  async clearTaskAndExpectImmediateRemoval(taskTitle, options = {}) {
    const timeout = options.timeout || 30000;
    const responsePromise = this.coverLookup.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.includes('/utilities/cover-lookup/task/')
      && new URL(response.url()).pathname.endsWith('/clear')
    ), { timeout });
    await this.clearTask(taskTitle);
    await this.expectTaskHiddenImmediately(taskTitle);
    const response = await responsePromise;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        `Notification clear failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    await expect(this.coverLookup.taskCardByTitle(taskTitle)).toBeHidden({ timeout });
  }

  async waitForTaskActive(taskTitle, options = {}) {
    await expect(this.coverLookup.taskCancelButtonByTitle(taskTitle)).toBeVisible({
      timeout: options.timeout || 30000,
    });
  }

  async expectTaskHiddenImmediately(taskTitle, options = {}) {
    await expect(this.coverLookup.taskCardByTitle(taskTitle)).toBeHidden({
      timeout: options.timeout || 750,
    });
  }

  async openTask(taskTitle) {
    await this.coverLookup.taskOpenButtonByTitle(taskTitle).click();
  }

  async waitForTaskStatus(taskTitle, expectedStatus, options = {}) {
    await expect(this.coverLookup.taskStatusByTitle(taskTitle)).toHaveText(expectedStatus, {
      timeout: options.timeout || 30000,
    });
  }

  async waitForDrawerEmpty(options = {}) {
    await this.coverLookup.waitForVisible(this.coverLookup.drawerEmptyState, {
      timeout: options.timeout || 30000,
    });
    await this.coverLookup.waitForPageCondition((selectors) => {
      const badge = document.querySelector(selectors.drawerBadgeSelector);
      const body = document.querySelector(selectors.drawerBodySelector);
      const taskCards = body ? body.querySelectorAll(selectors.taskCardSelector).length : 0;
      return taskCards === 0 && (!(badge instanceof HTMLElement) || badge.hidden);
    }, {
      timeout: options.timeout || 30000,
    }, {
      drawerBadgeSelector: this.coverLookup.drawerBadgeSelector,
      drawerBodySelector: this.coverLookup.drawerBodySelector,
      taskCardSelector: this.coverLookup.taskCardSelector,
    });
  }

  async readDisplayedImageEvidence(image, label, options = {}) {
    if (!(await image.count())) return { src: '', coverPath: '', sha256: '' };
    const timeout = options.timeout || 30000;
    await expect(image, `Expected the displayed ${label} image to be visible.`).toBeVisible();
    await expect.poll(async () => {
      // parity-check: allow-read-only-measurement-evaluate -- displayed cover decode readiness only
      return image.evaluate((element) => (
        element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
      ));
    }, {
      message: `Expected the displayed ${label} image to decode.`,
      timeout,
    }).toBe(true);
    let resolvedEvidence = null;
    let displayedState = null;
    await expect.poll(async () => {
      // parity-check: allow-read-only-measurement-evaluate -- displayed cover source, decode readiness, and dimensions only
      displayedState = await image.evaluate((element) => ({
        currentSrc: element instanceof HTMLImageElement ? String(element.currentSrc || '').trim() : '',
        productionSrc: element instanceof HTMLImageElement
          ? String(element.getAttribute('data-production-cover-src') || '').trim()
          : '',
        hasVisualState: element instanceof HTMLImageElement
          && element.hasAttribute('data-cover-visual-state'),
        visualState: element instanceof HTMLImageElement
          ? String(element.getAttribute('data-cover-visual-state') || '').trim()
          : '',
        complete: element instanceof HTMLImageElement && element.complete,
        naturalWidth: element instanceof HTMLImageElement ? element.naturalWidth : 0,
        naturalHeight: element instanceof HTMLImageElement ? element.naturalHeight : 0,
        width: element instanceof HTMLElement ? element.getBoundingClientRect().width : 0,
        height: element instanceof HTMLElement ? element.getBoundingClientRect().height : 0,
      }));
      const displayedSource = displayedState.productionSrc || displayedState.currentSrc;
      if (!displayedSource || !isDisplayedImageEvidenceReady(displayedState)) {
        return false;
      }
      const src = normalizeResponseUrl(displayedSource, this.coverLookup.page.url());
      const coverUrl = new URL(src);
      const coverPath = coverUrl.pathname === '/cover'
        ? String(coverUrl.searchParams.get('path') || '')
        : '';
      const coverRevision = coverUrl.pathname === '/cover'
        ? String(coverUrl.searchParams.get('v') || '')
        : '';
      if (options.expectedCoverPath && coverPath !== String(options.expectedCoverPath)) {
        return false;
      }
      if (options.expectedCoverRevision && coverRevision !== String(options.expectedCoverRevision)) {
        return false;
      }
      const pendingEvidence = this.imageResponseEvidence.get(src);
      if (!pendingEvidence) return false;
      const evidence = await pendingEvidence;
      if (evidence.error) throw evidence.error;
      resolvedEvidence = {
        ...evidence.value,
        coverPath,
        coverRevision,
        currentSrc: displayedState.currentSrc,
        naturalWidth: displayedState.naturalWidth,
        naturalHeight: displayedState.naturalHeight,
      };
      return true;
    }, {
      message: `Expected decoded browser response evidence for the displayed ${label}.`,
      timeout,
    }).toBe(true);
    return resolvedEvidence;
  }

  async readFullSizeCoverEvidence(options = {}) {
    const label = String(options.label || 'cover').trim();
    let source = String(options.source || '').trim();
    if (!source) {
      const coverPath = String(options.coverPath || '').trim();
      if (!coverPath) {
        throw new Error(`Cannot measure full-size ${label} bytes without a cover path.`);
      }
      const coverUrl = new URL('/cover', this.coverLookup.page.url());
      coverUrl.searchParams.set('path', coverPath);
      const coverRevision = String(options.coverRevision || '').trim();
      if (coverRevision) coverUrl.searchParams.set('v', coverRevision);
      source = coverUrl.toString();
    }

    const src = normalizeResponseUrl(source, this.coverLookup.page.url());
    const coverUrl = new URL(src);
    const pageUrl = new URL(this.coverLookup.page.url());
    if (coverUrl.origin !== pageUrl.origin || coverUrl.pathname !== '/cover') {
      throw new Error(`Full-size ${label} evidence must use the production /cover route.`);
    }
    if (String(coverUrl.searchParams.get('size') || '').trim()) {
      throw new Error(`Full-size ${label} evidence cannot use a resized cover variant.`);
    }

    const response = await authenticatedPageGet(this.coverLookup.page, src, {
      headers: { Accept: 'image/*' },
    });
    if (!response.ok()) {
      throw new Error(
        `Full-size ${label} request failed with HTTP ${response.status()}: ${src}`,
      );
    }
    const body = await response.body();
    return {
      src,
      coverPath: String(coverUrl.searchParams.get('path') || ''),
      coverRevision: String(coverUrl.searchParams.get('v') || ''),
      sha256: createHash('sha256').update(body).digest('hex').toUpperCase(),
    };
  }

  async readLocalCoverCardEvidence(card, label) {
    const sourcePath = String(await card.getAttribute('data-select-local-cover') || '').trim();
    const fullSizeSource = String(await card.getAttribute('data-cover-src') || '').trim();
    const name = String(await this.coverLookup.localCoverNameWithin(card).textContent() || '').trim();
    const resolution = String(
      await this.coverLookup.localCoverResolutionWithin(card).textContent() || '',
    ).trim();
    const image = this.coverLookup.localCoverImageWithin(card);
    return {
      sourcePath,
      fullSizeSource,
      name,
      resolution,
      isActive: await card.getAttribute('data-cover-lookup-local-active') === '1',
      image: await this.readDisplayedImageEvidence(image, label),
    };
  }

  async readLocalCoverCandidates(options = {}) {
    const timeout = options.timeout || 30000;
    await expect(this.coverLookup.activeLocalCoverCard).toHaveCount(1, { timeout });
    await expect(this.coverLookup.inactiveLocalCoverCards.first()).toBeVisible({ timeout });
    const candidates = [];
    const count = await this.coverLookup.localCoverCards.count();
    for (let index = 0; index < count; index += 1) {
      candidates.push(await this.readLocalCoverCardEvidence(
        this.coverLookup.localCoverCards.nth(index),
        `local cover candidate ${index + 1}`,
      ));
    }
    return candidates;
  }

  async readActiveLocalCoverEvidence(options = {}) {
    const timeout = options.timeout || 30000;
    await expect(this.coverLookup.activeLocalCoverCard).toHaveCount(1, { timeout });
    return this.readLocalCoverCardEvidence(
      this.coverLookup.activeLocalCoverCard,
      'active local cover',
    );
  }

  async selectLocalCoverBySourcePath(sourcePath, options = {}) {
    const timeout = options.timeout || 30000;
    const expectedPath = String(sourcePath || '').trim();
    await expect(this.coverLookup.localCoverCards.first()).toBeVisible({ timeout });
    const count = await this.coverLookup.localCoverCards.count();
    for (let index = 0; index < count; index += 1) {
      const card = this.coverLookup.localCoverCards.nth(index);
      const candidatePath = String(
        await card.getAttribute('data-select-local-cover') || '',
      ).trim();
      if (candidatePath !== expectedPath) continue;
      await card.click();
      await expect(card).toHaveAttribute('data-cover-lookup-local-active', '1', { timeout });
      return this.readLocalCoverCardEvidence(card, 'selected local cover');
    }
    throw new Error(`Local cover candidate was not found: ${expectedPath}`);
  }

  async readLocalCoverNames() {
    const names = [];
    const count = await this.coverLookup.localCoverCards.count();
    for (let index = 0; index < count; index += 1) {
      names.push(String(
        await this.coverLookup.localCoverNameWithin(
          this.coverLookup.localCoverCards.nth(index),
        ).textContent() || '',
      ).trim());
    }
    return names;
  }

  async selectFirstInactiveLocalCoverAndSave(options = {}) {
    const timeout = options.timeout || 30000;
    await expect(this.coverLookup.inactiveLocalCoverCards.first()).toBeVisible({ timeout });
    const candidateCard = this.coverLookup.inactiveLocalCoverCards.first();
    return this.selectLocalCoverCardAndSave(candidateCard, options);
  }

  async selectLocalCoverByNameAndSave(name, options = {}) {
    const timeout = options.timeout || 30000;
    const candidateCard = this.coverLookup.localCoverCardByName(name);
    await expect(candidateCard).toHaveCount(1, { timeout });
    await expect(candidateCard).toBeVisible({ timeout });
    return this.selectLocalCoverCardAndSave(candidateCard, options);
  }

  async selectLocalCoverCardAndSave(candidateCard, options = {}) {
    const timeout = options.timeout || 30000;
    const stableCoverLocator = options.stableCoverLocator || null;
    const candidate = await this.readLocalCoverCardEvidence(
      candidateCard,
      'selected local cover',
    );
    const candidateFullSize = await this.readFullSizeCoverEvidence({
      source: candidate.fullSizeSource,
      label: 'selected local cover source',
    });
    const saveResponsePromise = this.coverLookup.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/cover-lookup/local-select'
    ), { timeout });

    await this.coverLookup.localCoverActionWithin(candidateCard).click();
    await expect(candidateCard).toHaveClass(/\bis-active\b/, { timeout });
    await expect(this.coverLookup.saveRemoteButton).toBeEnabled({ timeout });
    await this.coverLookup.saveRemoteButton.click();
    let immediateCoverState = null;
    if (stableCoverLocator) {
      // parity-check: allow-read-only-measurement-evaluate -- immediate cover readiness telemetry only
      immediateCoverState = await stableCoverLocator.evaluate((image) => ({
        currentSrc: String(image.currentSrc || image.src || ''),
        complete: Boolean(image.complete),
        naturalWidth: Number(image.naturalWidth || 0),
        width: Number(image.getBoundingClientRect().width || 0),
        height: Number(image.getBoundingClientRect().height || 0),
        hasVisualState: image.hasAttribute('data-cover-visual-state'),
        visualState: String(image.getAttribute('data-cover-visual-state') || ''),
      }));
      expect(
        isDisplayedImageEvidenceReady(immediateCoverState),
        'the already-open Album Details cover should remain decoded while local art is promoted',
      ).toBe(true);
    }

    const response = await saveResponsePromise;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        `Local cover selection failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    await this.coverLookup.waitForHidden(this.coverLookup.modal, { timeout });
    const selectedCoverPath = String(payload.selected_cover_path || '').trim();
    if (!selectedCoverPath) {
      throw new Error('Local cover selection did not return an authoritative cover path.');
    }
    return {
      candidate,
      candidateFullSize,
      selectedCoverPath,
      updatedAlbum: payload.updated_album || null,
      immediateCoverState,
    };
  }

  async selectFirstRemoteCoverAndSave(options = {}) {
    const timeout = options.timeout || 30000;
    const stableCoverLocator = options.stableCoverLocator || null;
    const candidateCard = this.coverLookup.firstRemoteCoverCard;
    await expect(candidateCard).toBeVisible({ timeout });
    const candidateId = String(await candidateCard.getAttribute('data-select-remote-cover') || '').trim();
    if (!candidateId) {
      throw new Error('The first remote cover candidate has no stable selection identity.');
    }
    const candidate = await this.readDisplayedImageEvidence(
      this.coverLookup.firstRemoteMatchImage,
      'selected first remote cover',
      { timeout },
    );
    const saveResponsePromise = this.coverLookup.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/cover-lookup/save-remote'
    ), { timeout });

    await this.coverLookup.localCoverActionWithin(candidateCard).click();
    await expect(candidateCard).toHaveClass(/\bis-active\b/, { timeout });
    await expect(this.coverLookup.saveRemoteButton).toBeEnabled({ timeout });
    await this.coverLookup.saveRemoteButton.click();

    let immediateCoverState = null;
    if (stableCoverLocator) {
      // parity-check: allow-read-only-measurement-evaluate -- immediate optimistic cover transition only
      immediateCoverState = await stableCoverLocator.evaluate((image) => {
        const visual = image.parentElement;
        const placeholder = image.previousElementSibling;
        return {
          productionSrc: String(image.getAttribute('data-production-cover-src') || ''),
          currentSrc: String(image.currentSrc || image.src || ''),
          complete: Boolean(image.complete),
          naturalWidth: Number(image.naturalWidth || 0),
          visibility: getComputedStyle(image).visibility,
          isLoading: Boolean(visual?.classList.contains('is-loading')),
          placeholderText: String(placeholder?.textContent || '').trim(),
        };
      });
      const candidateSrc = normalizeResponseUrl(candidate.src, this.coverLookup.page.url());
      const optimisticSrc = normalizeResponseUrl(
        immediateCoverState.productionSrc || immediateCoverState.currentSrc,
        this.coverLookup.page.url(),
      );
      expect(
        optimisticSrc,
        'Album Details should reuse the selected gallery preview during optimistic cover replacement.',
      ).toBe(candidateSrc);
      if (immediateCoverState.isLoading) {
        expect(immediateCoverState.visibility).toBe('hidden');
        expect(immediateCoverState.placeholderText).toBe('');
      } else {
        expect(immediateCoverState.complete).toBe(true);
        expect(immediateCoverState.naturalWidth).toBeGreaterThan(0);
      }
    }

    const response = await saveResponsePromise;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        `Remote cover selection failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    await this.coverLookup.waitForHidden(this.coverLookup.modal, { timeout });
    return {
      candidateId,
      candidate,
      payload,
      immediateCoverState,
    };
  }

  async inspectModalComponents() {
    if (!(await this.coverLookup.modal.isVisible())) {
      throw new Error('Cover lookup modal is not open.');
    }
    const manualInput = this.coverLookup.manualUrlInput;
    const manualExtractButton = this.coverLookup.manualExtractButton;
    await expect(manualInput).toHaveCount(1);
    await expect(manualExtractButton).toHaveCount(1);
    const searchChips = [];
    const chipLocators = this.coverLookup.searchChips;
    const chipCount = await chipLocators.count();
    for (let index = 0; index < chipCount; index += 1) {
      const chip = chipLocators.nth(index);
      searchChips.push({
        label: String(await chip.textContent() || '').trim(),
        href: String(await chip.getAttribute('href') || '').trim(),
      });
    }
    return {
      subtitle: String(await this.coverLookup.modalSubtitle.textContent() || '').trim(),
      statusText: String(await this.coverLookup.modalStatus.textContent() || '').trim(),
      hasFindBetterButton: await this.coverLookup.findBetterButton.count() > 0,
      hasSaveButton: await this.coverLookup.saveRemoteButton.count() > 0,
      sectionTitles: (await this.coverLookup.sectionTitles.allTextContents())
        .map((value) => value.trim()).filter(Boolean),
      subsectionTitles: (await this.coverLookup.subsectionTitles.allTextContents())
        .map((value) => value.trim()).filter(Boolean),
      localCards: await this.coverLookup.localCoverCards.count(),
      serviceCards: await this.coverLookup.remoteCoverCards.count(),
      openLightboxButtons: await this.coverLookup.openLightboxButtons.count(),
      hasManualInput: await manualInput.count() > 0,
      hasManualExtractButton: await manualExtractButton.count() > 0,
      searchChips,
      activeLocalCover: await this.readDisplayedImageEvidence(
        this.coverLookup.activeLocalCoverImage,
        'active local cover',
      ),
      firstRemoteMatch: await this.readDisplayedImageEvidence(
        this.coverLookup.firstRemoteMatchImage,
        'first remote match',
      ),
    };
  }
}
