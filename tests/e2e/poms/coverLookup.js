import { BasePage } from './basePage.js';

export class CoverLookup extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.modal = page.locator(this.modalSelector);
    this.mobilePage = page.locator('#cover-lookup-modal.is-mobile-page');
    this.mobileSheet = page.locator('#cover-lookup-modal.is-mobile-sheet');
    this.mobileBackButton = page.locator('#mobile-back-button');
    this.modalDialog = page.locator(this.modalDialogSelector);
    this.modalHeader = this.modal.locator('.cover-lookup-modal-header');
    this.modalBody = page.locator(this.modalBodySelector);
    this.modalSubtitle = page.locator(this.modalSubtitleSelector);
    this.modalStatus = page.locator(this.modalStatusSelector);
    this.modalStatusTitle = this.modalStatus.locator('.on-page-alert__title');
    this.modalStatusMessage = this.modalStatus.locator('.on-page-alert__message');
    this.modalActions = page.locator(this.modalActionsSelector);
    this.findBetterButton = page.locator(this.findBetterButtonSelector);
    this.saveRemoteButton = page.locator(this.saveRemoteButtonSelector);
    this.cancelButton = this.modal.getByRole('button', { name: 'Cancel', exact: true });
    this.manualUrlInput = page.locator(this.manualUrlInputSelector);
    this.manualExtractButton = page.locator(this.manualExtractButtonSelector);
    this.addImageButton = this.modal.getByRole('button', { name: 'Add image', exact: true });
    this.manualDropZone = this.modal.locator('[data-cover-lookup-drop-zone]');
    this.pendingAttachments = this.modal.locator('[data-cover-lookup-pending-attachment]');
    this.stagedCoverCards = this.modal.locator('[data-select-pasted-cover]');
    this.selectedCoverCards = this.modal.locator('.cover-lookup-art-card.is-active');
    this.searchProgress = this.modalBody.locator('.cover-lookup-search-progress');
    this.searchChips = this.modalBody.locator('.cover-lookup-search-chip');
    this.sectionTitles = this.modalBody.locator('.cover-lookup-section-title');
    this.subsectionTitles = this.modalBody.locator('.cover-lookup-subsection-title');
    this.localCoverCards = this.modalBody.locator('[data-select-local-cover]');
    this.deleteConfirm = page.locator('#cover-lookup-delete-confirm-modal');
    this.deleteConfirmDialog = this.deleteConfirm.getByRole('dialog');
    this.deleteConfirmButton = this.deleteConfirm.getByRole('button', { name: 'Delete', exact: true });
    this.activeLocalCoverCard = this.modalBody
      .locator('[data-select-local-cover][data-cover-lookup-local-active]')
      .first();
    this.inactiveLocalCoverCards = this.modalBody
      .locator('[data-select-local-cover]:not([data-cover-lookup-local-active])');
    this.remoteCoverCards = this.modalBody.locator('[data-select-remote-cover]');
    this.firstRemoteCoverCard = this.remoteCoverCards.first();
    this.savedRemoteCoverCards = this.modalBody.locator('[data-cover-lookup-saved-remote]');
    this.savedRemoteCoverCard = this.savedRemoteCoverCards.first();
    this.openLightboxButtons = this.modalBody.locator('[data-cover-lookup-open-lightbox]');
    this.activeLocalCoverImage = this.modalBody
      .locator('[data-cover-lookup-local-active] .cover-lookup-art-preview-image')
      .first();
    this.firstRemoteMatchImage = this.modalBody
      .locator('[data-select-remote-cover] .cover-lookup-art-preview-image')
      .first();
    this.closeModalButton = page.locator(this.closeModalButtonSelector).first();
    this.drawerButton = page.locator(this.drawerButtonSelector);
    this.drawer = page.locator(this.drawerSelector);
    this.drawerTitle = this.drawer.locator('.cover-lookup-drawer-title');
    this.drawerBadge = page.locator(this.drawerBadgeSelector);
    this.drawerBody = page.locator(this.drawerBodySelector);
    this.drawerCloseButton = page.locator(this.drawerCloseButtonSelector);
    this.drawerClearCompletedButton = page.locator(this.drawerClearCompletedButtonSelector);
    this.drawerEmptyState = page.locator(this.drawerEmptyStateSelector);
    this.coverLookupStartedToast = page
      .locator(this.toastSelector)
      .filter({ hasText: 'Cover art lookup started.' })
      .last();
    this.toolbarRight = page.locator(this.toolbarRightSelector);
    this.coverLookupStartedToastMessage = this.coverLookupStartedToast.locator('.on-page-alert__message');
  }

  get modalSelector() {
    return '#cover-lookup-modal';
  }

  get modalSubtitleSelector() {
    return '#cover-lookup-modal-subtitle';
  }

  get modalDialogSelector() {
    return '#cover-lookup-modal .cover-lookup-modal-dialog';
  }

  get modalBodySelector() {
    return '#cover-lookup-modal-body';
  }

  get modalStatusSelector() {
    return '#cover-lookup-modal-status';
  }

  get modalActionsSelector() {
    return '#cover-lookup-modal .cover-lookup-modal-actions';
  }

  get findBetterButtonSelector() {
    return '#cover-lookup-find-better-button';
  }

  get saveRemoteButtonSelector() {
    return '#cover-lookup-save-remote-button';
  }

  get manualUrlInputSelector() {
    return '#cover-lookup-pasted-urls';
  }

  providerGallery(providerGroup) {
    return this.modalBody.locator(
      `[data-cover-lookup-provider-group="${String(providerGroup || '').trim()}"]`,
    );
  }

  providerRemoteCoverCards(providerGroup) {
    return this.providerGallery(providerGroup).locator('[data-select-remote-cover]');
  }

  providerOtherArtCards(providerGroup) {
    return this.providerGallery(providerGroup).locator('[data-cover-lookup-other-remote-art]');
  }

  get manualExtractButtonSelector() {
    return '[data-add-cover-lookup-remote="1"]';
  }

  get closeModalButtonSelector() {
    return '#cover-lookup-modal [data-close-cover-lookup-modal="1"]';
  }

  get drawerButtonSelector() {
    return '#cover-lookup-drawer-button';
  }

  get drawerSelector() {
    return '#cover-lookup-drawer';
  }

  get drawerBadgeSelector() {
    return '#cover-lookup-drawer-badge';
  }

  get drawerBodySelector() {
    return '#cover-lookup-drawer-body';
  }

  get drawerCloseButtonSelector() {
    return '[data-close-cover-lookup-drawer="1"]';
  }

  async notificationActionDimensions() {
    const dimensions = [];
    for (const button of [this.drawerClearCompletedButton, this.drawerCloseButton]) {
      // parity-check: allow-read-only-measurement-evaluate -- compare the shared notification action hit targets and glyph boxes.
      dimensions.push(await button.evaluate(node => {
        const box = node.getBoundingClientRect(), glyph = node.querySelector('svg').getBoundingClientRect();
        return { width: box.width, height: box.height, glyphWidth: glyph.width, glyphHeight: glyph.height };
      }));
    }
    return dimensions;
  }

  get drawerClearCompletedButtonSelector() {
    return '#cover-lookup-drawer-clear';
  }

  get drawerEmptyStateSelector() {
    return '#cover-lookup-drawer-body .cover-lookup-drawer-empty';
  }

  get toastSelector() {
    return '#toast-layer .toast';
  }

  get toolbarRightSelector() {
    return '.toolbar-right';
  }

  toastOcclusionTargets() {
    return {
      modalDialog: this.modalDialog,
      modalActions: this.modalActions,
      toolbarRight: this.toolbarRight,
    };
  }

  get taskCardSelector() {
    return '#cover-lookup-drawer-body .cover-lookup-task-card';
  }

  get taskCardWithinDrawerSelector() {
    return '.cover-lookup-task-card';
  }

  get taskSpacerWithinDrawerSelector() {
    return '.cover-lookup-task-spacer';
  }

  get taskTitleWithinCardSelector() {
    return '.cover-lookup-task-title';
  }

  get taskStatusWithinCardSelector() {
    return '.cover-lookup-task-status-label';
  }

  pendingAttachmentByName(name) {
    return this.pendingAttachments.filter({ has: this.page.getByRole('button', { name: `Remove ${name}`, exact: true }) });
  }

  stagedCoverCardByName(name) {
    return this.stagedCoverCards.filter({ has: this.page.getByText(name, { exact: true }) });
  }

  get taskElapsedWithinCardSelector() {
    return '.cover-lookup-task-elapsed';
  }

  get taskOpenButtonWithinCardSelector() {
    return '[data-open-cover-lookup-task]';
  }

  async isDrawerOpen() {
    // parity-check: allow-read-only-measurement-evaluate -- cover lookup drawer product open state only
    return this.drawer.evaluate((element) => (
      element instanceof HTMLElement
      && !element.hidden
      && element.classList.contains('is-open')
    ));
  }

  async observeStartedToastEntrance(options = {}) {
    // parity-check: allow-read-only-measurement-evaluate -- observe running-layout geometry through native toast entrance; no application state or DOM mutations
    return this.page.evaluateHandle(({
      findBetterButtonSelector,
      modalSelector,
      modalStatusSelector,
      toastSelector,
      timeout,
    }) => {
      let frame;
      let timer;
      let finish;
      let baseline;
      let busyButtonSeen = false;
      let startingStatusSeen = false;
      let settledFrames = 0;
      let sampledFrames = 0;
      const delta = { height: 0, width: 0, x: 0, y: 0 };
      const result = new Promise((resolve) => {
        finish = (value) => {
          cancelAnimationFrame(frame);
          clearTimeout(timer);
          resolve(value);
        };
        const sample = () => {
          const modal = document.querySelector(modalSelector);
          const progress = modal?.querySelector('.cover-lookup-search-progress');
          const findBetterButton = document.querySelector(findBetterButtonSelector);
          const modalStatus = document.querySelector(modalStatusSelector);
          busyButtonSeen = busyButtonSeen || (
            findBetterButton instanceof HTMLButtonElement
            && findBetterButton.disabled
          );
          startingStatusSeen = startingStatusSeen
            || String(modalStatus?.textContent || '').includes('Starting cover search…');
          const toast = Array.from(document.querySelectorAll(toastSelector)).findLast(
            (candidate) => candidate.querySelector('.on-page-alert__message')
              ?.textContent?.trim() === 'Cover art lookup started.',
          );
          if (modal && progress?.getBoundingClientRect().height > 0 && toast) {
            const style = getComputedStyle(toast);
            const settled = toast.classList.contains('is-visible')
              && style.opacity === '1'
              && !toast.getAnimations().some((animation) => animation.playState === 'running');
            if (!baseline) {
              if (settled) {
                finish({ error: 'Toast already settled before running-layout baseline was observed.' });
                return;
              }
              baseline = modal.getBoundingClientRect();
            }
            const rectangle = modal.getBoundingClientRect();
            for (const key of Object.keys(delta)) {
              delta[key] = Math.max(delta[key], Math.abs(rectangle[key] - baseline[key]));
            }
            sampledFrames += 1;
            settledFrames = settled ? settledFrames + 1 : 0;
            if (settledFrames >= 2) {
              finish({
                busyButtonSeen,
                delta,
                sampledFrames,
                startingStatusSeen,
                baselineUnsettled: true,
              });
              return;
            }
          } else if (baseline) {
            finish({ error: 'Running progress or toast disappeared during entrance measurement.' });
            return;
          }
          frame = requestAnimationFrame(sample);
        };
        timer = setTimeout(() => finish({ error: 'Timed out observing cover lookup toast entrance.' }), timeout);
        frame = requestAnimationFrame(sample);
      });
      return { result, cancel: () => finish({ error: 'Toast entrance observation cancelled.' }) };
    }, {
      modalSelector: this.modalDialogSelector,
      modalStatusSelector: this.modalStatusSelector,
      findBetterButtonSelector: this.findBetterButtonSelector,
      toastSelector: this.toastSelector,
      timeout: options.timeout || 30000,
    });
  }

  async observeDrawerInitialLoad(options = {}) {
    // parity-check: allow-read-only-measurement-evaluate -- observe transient notification loading markup without changing app state
    return this.page.evaluateHandle(({ bodySelector, timeout }) => {
      const body = document.querySelector(bodySelector);
      if (!(body instanceof HTMLElement)) throw new Error('Notification drawer body is unavailable.');
      let loadingSeen = false;
      let falseEmptySeen = false;
      let observer;
      let timer;
      let finish;
      const result = new Promise((resolve) => {
        finish = (value) => {
          observer?.disconnect();
          clearTimeout(timer);
          resolve(value);
        };
        const sample = () => {
          const loading = Boolean(body.querySelector('.cover-lookup-task-card.is-loading'));
          loadingSeen = loadingSeen || loading;
          falseEmptySeen = falseEmptySeen || (
            !loadingSeen
            && /not looking for anything at the moment/i.test(body.textContent || '')
          );
          const settled = loadingSeen
            && !loading
            && Boolean(body.querySelector('.cover-lookup-task-card:not(.is-loading), .cover-lookup-drawer-empty'));
          if (settled) finish({ loadingSeen, falseEmptySeen });
        };
        observer = new MutationObserver(sample);
        observer.observe(body, { childList: true, subtree: true, characterData: true });
        sample();
        timer = setTimeout(
          () => finish({ error: 'Timed out observing notification history loading.', loadingSeen, falseEmptySeen }),
          timeout,
        );
      });
      return { result, cancel: () => finish({ error: 'Notification loading observation cancelled.' }) };
    }, {
      bodySelector: this.drawerBodySelector,
      timeout: options.timeout || 30000,
    });
  }

  async waitForCoverLookupStartedToastFinalState(options = {}) {
    const timeout = options.timeout || 30000;
    await this.waitForPageCondition((selectors) => {
      const toast = Array.from(document.querySelectorAll(selectors.toastSelector))
        .filter((candidate) => (
          candidate.querySelector('.on-page-alert__message')?.textContent?.trim()
            === selectors.toastText
        ))
        .at(-1);
      if (!(toast instanceof HTMLElement)) return false;
      const style = getComputedStyle(toast);
      return toast.classList.contains('is-visible')
        && style.opacity === '1'
        && !toast.getAnimations().some((animation) => animation.playState === 'running');
    }, { timeout }, {
      toastSelector: this.toastSelector,
      toastText: 'Cover art lookup started.',
    });

    // parity-check: allow-read-only-measurement-evaluate -- two paints prove settled toast transform and rectangle
    return this.coverLookupStartedToast.evaluate(async (toast) => {
      const readVisualState = () => {
        const style = getComputedStyle(toast);
        const rectangle = toast.getBoundingClientRect();
        return {
          activeAnimationCount: toast.getAnimations()
            .filter((animation) => animation.playState === 'running')
            .length,
          isVisibleClass: toast.classList.contains('is-visible'),
          opacity: style.opacity,
          rectangle: {
            x: rectangle.x,
            y: rectangle.y,
            width: rectangle.width,
            height: rectangle.height,
          },
          transform: style.transform,
        };
      };
      const firstState = readVisualState();
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const finalState = readVisualState();
      const rectangleStable = Object.keys(finalState.rectangle).every(
        (key) => Math.abs(finalState.rectangle[key] - firstState.rectangle[key]) <= 0.1,
      );
      return {
        ...finalState,
        transformStable: firstState.transform === finalState.transform && rectangleStable,
      };
    });
  }

  async waitForDrawerState(expectedOpen, options = {}) {
    await this.waitForPageCondition((selectors) => {
      const drawer = document.querySelector(selectors.drawerSelector);
      if (!(drawer instanceof HTMLElement)) return false;
      const isOpen = !drawer.hidden && drawer.classList.contains('is-open');
      return isOpen === selectors.expectedOpen;
    }, {
      timeout: options.timeout || 30000,
    }, {
      drawerSelector: this.drawerSelector,
      expectedOpen: Boolean(expectedOpen),
    });
  }

  get localCoverImageWithinCardSelector() {
    return '.cover-lookup-art-preview-image';
  }

  get localCoverNameWithinCardSelector() {
    return '.cover-lookup-art-name';
  }

  get localCoverActionWithinCardSelector() {
    return '.cover-lookup-art-action-label';
  }

  get localCoverResolutionWithinCardSelector() {
    return '.cover-lookup-art-resolution';
  }

  get remoteCoverImageWithinCardSelector() {
    return '.cover-lookup-art-preview-image';
  }

  get remoteCoverNameWithinCardSelector() {
    return '.cover-lookup-art-name';
  }

  get remoteCoverResolutionWithinCardSelector() {
    return '.cover-lookup-art-resolution';
  }

  get remoteCoverSourceWithinCardSelector() {
    return '.cover-lookup-art-source';
  }

  localCoverImageWithin(card) {
    return card.locator(this.localCoverImageWithinCardSelector).first();
  }

  localCoverNameWithin(card) {
    return card.locator(this.localCoverNameWithinCardSelector).first();
  }

  localCoverActionWithin(card) {
    return card.locator(this.localCoverActionWithinCardSelector).first();
  }

  localCoverDeleteWithin(card) {
    return card.locator('[data-delete-local-cover]').first();
  }

  async readDeleteConfirmStacking() {
    // parity-check: allow-read-only-measurement-evaluate -- Cover Lookup owns its confirmation stacking evidence
    return this.deleteConfirmDialog.evaluate((dialog) => {
      const confirmation = dialog.closest('#cover-lookup-delete-confirm-modal');
      const lookup = document.querySelector('#cover-lookup-modal');
      const bounds = dialog.getBoundingClientRect();
      const topmost = document.elementFromPoint(
        bounds.left + (bounds.width / 2),
        bounds.top + (bounds.height / 2),
      );
      return {
        confirmationZIndex: Number(getComputedStyle(confirmation).zIndex) || 0,
        lookupZIndex: Number(getComputedStyle(lookup).zIndex) || 0,
        confirmationOwnsTopElement: Boolean(topmost?.closest('#cover-lookup-delete-confirm-modal')),
      };
    });
  }

  localCoverResolutionWithin(card) {
    return card.locator(this.localCoverResolutionWithinCardSelector).first();
  }

  localCoverCardByName(name) {
    return this.localCoverCards.filter({
      has: this.page.getByText(name, { exact: true }),
    });
  }

  remoteCoverImageWithin(card) {
    return card.locator(this.remoteCoverImageWithinCardSelector).first();
  }

  remoteCoverNameWithin(card) {
    return card.locator(this.remoteCoverNameWithinCardSelector).first();
  }

  remoteCoverResolutionWithin(card) {
    return card.locator(this.remoteCoverResolutionWithinCardSelector).first();
  }

  remoteCoverSourceWithin(card) {
    return card.locator(this.remoteCoverSourceWithinCardSelector).first();
  }

  remoteCoverCardById(candidateId) {
    return this.modalBody.locator(
      `[data-select-remote-cover="${String(candidateId || '').replaceAll('"', '\\"')}"]`,
    ).first();
  }

  taskCardByTitle(taskTitle) {
    return this.page.locator(this.taskCardSelector).filter({
      has: this.page.locator(this.taskTitleWithinCardSelector).filter({ hasText: taskTitle }),
    }).first();
  }

  taskCardById(taskId) {
    return this.page.locator(
      `[data-open-cover-lookup-task="${String(taskId || '').replaceAll('"', '\\"')}"]`,
    ).locator('..');
  }

  taskOpenButtonById(taskId) {
    return this.taskCardById(taskId).locator('.cover-lookup-task-open');
  }

  taskCoverById(taskId) {
    return this.taskCardById(taskId).locator('img.cover-lookup-task-cover').first();
  }

  taskInfoByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator('.cover-lookup-task-open');
  }

  taskCoverByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator('img.cover-lookup-task-cover').first();
  }

  async readTaskClearHoverStyle(taskTitle) {
    // parity-check: allow-read-only-measurement-evaluate -- wait for the control's finite hover transitions before comparing its computed styles
    return this.taskClearButtonByTitle(taskTitle).evaluate(async (element) => {
      await Promise.all(element.getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished));
      const style=getComputedStyle(element);
      return {outline:style.outline,background:style.backgroundColor,cursor:style.cursor};
    });
  }

  taskCancelButtonByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).getByRole('button', { name: 'Stop lookup' });
  }

  taskClearButtonByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).getByRole('button', { name: 'Delete notification', exact: true });
  }

  taskRetryIconByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle)
      .getByRole('button', { name: 'Retry lookup', exact: true })
      .locator('.ui-icon');
  }

  taskStatusByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator(this.taskStatusWithinCardSelector).first();
  }

  taskStatusById(taskId) {
    return this.taskCardById(taskId).locator(this.taskStatusWithinCardSelector).first();
  }

  taskBylineByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator('.cover-lookup-task-byline');
  }

  taskTitleByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator(this.taskTitleWithinCardSelector).first();
  }

  taskElapsedByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator(this.taskElapsedWithinCardSelector).first();
  }

  taskOpenButtonByTitle(taskTitle) {
    return this.taskCardByTitle(taskTitle).locator(this.taskOpenButtonWithinCardSelector).first();
  }
}
