import { BasePage } from './basePage.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export class TagEditor extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.overlay = page.locator('#tag-editor-modal');
    this.dialog = this.overlay.getByRole('dialog', { name: 'Edit tags', exact: true });
    this.subtitle = this.overlay.locator('#tag-editor-subtitle');
    this.body = this.overlay.locator('.tag-editor-body');
    this.form = this.overlay.locator('#tag-editor-form');
    this.formLabels = this.form.locator('label');
    this.footer = this.overlay.locator('.tag-editor-actions');
    this.autoNumberControls = this.footer.locator('#tag-editor-auto-number-controls');
    this.trackList = this.overlay.locator('#tag-editor-track-list');
    this.trackButtons = this.overlay.locator('[data-tag-editor-track]');
    this.trackTitles = this.overlay.locator('[data-tag-editor-track] .tag-editor-track-title');
    this.activeTrackButtons = this.overlay.locator('[data-tag-editor-track][aria-pressed="true"]');
    this.activeTrackTitles = this.activeTrackButtons.locator('.tag-editor-track-title');
    this.albumNameInput = this.overlay.locator('input[data-tag-field="album"]');
    this.trackNameInput = this.overlay.locator('input[data-tag-field="title"]');
    this.genreInput = this.overlay.locator('input[data-tag-field="genre"]');
    this.yearInput = this.overlay.locator('input[data-tag-field="year"]');
    this.trackNumberInput = this.overlay.locator('input[data-tag-field="track_number"]');
    this.discNumberInput = this.overlay.locator('input[data-tag-field="disc_number"]');
    this.exceptionSelect = this.overlay.locator('select[data-tag-field="exception_type"]');
    this.autoNumberButton = this.overlay.getByRole('button', {
      name: 'Auto-number',
      exact: true,
    });
    this.startAtInput = this.overlay.getByLabel('Start at', { exact: true });
    this.autoNumberHelp = this.overlay.locator('#tag-editor-auto-number-help');
    this.autoNumberStatus = this.overlay.locator('#tag-editor-auto-number-status');
    this.applyButton = this.overlay.getByRole('button', { name: 'Apply', exact: true });
    this.cancelButton = this.overlay.getByRole('button', { name: 'Cancel', exact: true });
    this.confirmOverlay = page.locator('#tag-edit-confirm-modal');
    this.confirmDialog = this.confirmOverlay.getByRole('dialog', {
      name: 'Apply tag edits',
      exact: true,
    });
    this.confirmButton = this.confirmOverlay.getByRole('button', {
      name: 'Yes, apply tags',
      exact: true,
    });
    this.confirmCancelButton = this.confirmDialog.getByRole('button', {
      name: 'Cancel',
      exact: true,
    });
    this.nonAlbumRarityWarning = this.confirmDialog.getByRole('alert');
    this.nonAlbumRarityWarningIcon = this.nonAlbumRarityWarning.locator(
      '[data-non-album-rarity-warning-icon="1"]',
    );
    this.nonAlbumRarityWarningText = this.nonAlbumRarityWarning.locator(
      '[data-non-album-rarity-warning-text="1"]',
    );
    this.repairAlertMessageSelector = '#repair-alert-message';
    this.repairAlertLogHistorySelector = '#repair-alert-log-history';
    this.repairAlert = page.locator('#repair-alert');
    this.repairAlertMessage = page.locator(this.repairAlertMessageSelector);
    this.repairAlertLogHistory = page.locator(this.repairAlertLogHistorySelector);
  }

  get dialogSelector() {
    return '.tag-editor-dialog';
  }

  get footerSelector() {
    return '.tag-editor-actions';
  }

  get autoNumberControlsSelector() {
    return '#tag-editor-auto-number-controls';
  }

  get cancelButtonSelector() {
    return '[data-close-tag-editor="1"].button';
  }

  get applyButtonSelector() {
    return '[data-open-tag-edit-confirm="1"]';
  }

  trackButtonByFilename(filename) {
    return this.trackButtons.filter({
      has: this.page.locator('.tag-editor-track-title').filter({
        hasText: exactNormalizedText(filename),
      }),
    });
  }

  pendingMarkerForTrack(filename) {
    return this.trackButtonByFilename(filename).getByRole('img', {
      name: 'Pending changes',
      exact: true,
    });
  }

  async readFormLabelTexts() {
    // parity-check: allow-read-only-measurement-evaluate -- read visible form-label text without driving application state
    return this.formLabels.evaluateAll((labels) => labels.map(
      (label) => Array.from(label.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => String(node.textContent || '').trim())
        .filter(Boolean)
        .join(' '),
    ));
  }

  async readAutoNumberResponsiveMetrics() {
    // parity-check: allow-read-only-measurement-evaluate -- measure approved responsive footer geometry without driving application state
    return this.overlay.evaluate((overlay, selectors) => {
      const dialog = overlay.querySelector(selectors.dialogSelector);
      const footer = overlay.querySelector(selectors.footerSelector);
      const controls = overlay.querySelector(selectors.autoNumberControlsSelector);
      const cancel = overlay.querySelector(selectors.cancelButtonSelector);
      const apply = overlay.querySelector(selectors.applyButtonSelector);
      const rect = (element) => {
        const box = element?.getBoundingClientRect();
        return box ? { bottom: box.bottom, left: box.left, right: box.right, top: box.top } : null;
      };
      return {
        cancel: rect(cancel),
        controls: rect(controls),
        dialog: rect(dialog),
        footer: rect(footer),
        apply: rect(apply),
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    }, {
      applyButtonSelector: this.applyButtonSelector,
      autoNumberControlsSelector: this.autoNumberControlsSelector,
      cancelButtonSelector: this.cancelButtonSelector,
      dialogSelector: this.dialogSelector,
      footerSelector: this.footerSelector,
    });
  }

  async readBackdropGesturePoint() {
    const overlayBox = await this.overlay.boundingBox();
    const dialogBox = await this.dialog.boundingBox();
    if (!overlayBox || !dialogBox) {
      throw new Error('The visible tag editor backdrop and dialog are required for a pointer gesture.');
    }
    const point = {
      x: overlayBox.x + 8,
      y: overlayBox.y + 8,
    };
    const pointOverlapsDialog = (
      point.x >= dialogBox.x
      && point.x <= dialogBox.x + dialogBox.width
      && point.y >= dialogBox.y
      && point.y <= dialogBox.y + dialogBox.height
    );
    if (pointOverlapsDialog) {
      throw new Error('The tag editor backdrop gesture point overlaps the dialog.');
    }
    return point;
  }

  async startRepairAlertLifecycleObservation() {
    // parity-check: allow-read-only-measurement-evaluate -- observe production notification text and visibility without driving application state
    const observation = await this.repairAlert.evaluateHandle((alert, messageSelector) => {
      const samples = [];
      const inspect = (phase) => {
        const message = alert.querySelector(messageSelector);
        const style = getComputedStyle(alert);
        samples.push({
          error: alert.classList.contains('is-error'),
          phase,
          text: String(message?.textContent || '').trim(),
          visible: !alert.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        });
      };
      inspect('initial');
      const observer = new MutationObserver(() => inspect('mutation'));
      observer.observe(alert, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      return {
        finish() {
          const pending = observer.takeRecords();
          if (pending.length) inspect('pending-mutation');
          inspect('final');
          observer.disconnect();
          return [...samples];
        },
      };
    }, this.repairAlertMessageSelector);
    let finished = false;
    return {
      async finish() {
        if (finished) return [];
        finished = true;
        // parity-check: allow-read-only-measurement-evaluate -- disconnect the notification observer and return buffered observations without mutating application state
        return observation.evaluate((ownedObservation) => ownedObservation.finish());
      },
    };
  }
}
