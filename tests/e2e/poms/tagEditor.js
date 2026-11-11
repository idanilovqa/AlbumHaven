import { BasePage } from './basePage.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

// Runs in the page. Measures the alert's bounds against independently hit-tested actionable controls;
// given its message selector, instead returns a live list that a read-only observer fills with the
// message and measurement of each presentation, taken as the alert becomes visible.
function inspectRepairAlert(alert, messageSelector) {
  const measure = () => {
    const bounds = alert.getBoundingClientRect();
    const overlaps = [];
    const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [data-loop-range-surface], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]';
    for (const control of document.querySelectorAll(selector)) {
      if (alert.contains(control) || control.matches(':disabled')
        || control.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) continue;
      const style = getComputedStyle(control);
      if (style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
      const rect = control.getBoundingClientRect();
      const left = Math.max(0, bounds.left, rect.left);
      const right = Math.min(innerWidth, bounds.right, rect.right);
      const top = Math.max(0, bounds.top, rect.top);
      const bottom = Math.min(innerHeight, bounds.bottom, rect.bottom);
      if (right <= left || bottom <= top) continue;
      const hit = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2)
        .find((element) => !alert.contains(element));
      if (hit && (hit === control || control.contains(hit))) {
        overlaps.push(control.getAttribute('aria-label') || control.textContent.trim() || control.tagName);
      }
    }
    // Shown as Playwright judges visibility, read in the same evaluation as its placement.
    const rendered = bounds.width > 0 && bounds.height > 0
      && getComputedStyle(alert).visibility === 'visible';
    return {
      rendered,
      withinViewport: rendered
        && bounds.left >= 0 && bounds.top >= 0
        && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      overlaps,
    };
  };
  if (!messageSelector) return measure();
  const presentations = [];
  let shown = false;
  const record = () => {
    const visible = alert.classList.contains('is-visible');
    if (visible && !shown) {
      const message = String(alert.querySelector(messageSelector)?.textContent || '').trim();
      presentations.push({ message, ...measure() });
    }
    shown = visible;
  };
  const observer = new MutationObserver(record);
  observer.observe(alert, { attributes: true, attributeFilter: ['class'] });
  record();
  // The alert node outlives the delivery, so the caller stops observing once it has read the list.
  presentations.stop = () => observer.disconnect();
  return presentations;
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
    this.artwork = this.overlay.locator('#tag-editor-artwork');
    this.artworkVisual = this.artwork.locator('img, .tag-editor-artwork-placeholder').first();
    this.folderPath = this.overlay.locator('.tag-editor-folder-path');
    this.folderOpenButton = this.overlay.locator('.tag-editor-open-folder');
    this.folderLoadButton = this.artwork.getByRole('button', {
      name: 'Load all tracks from the folder',
      exact: true,
    });
    this.reorderCueRows = this.trackList.locator(
      '[data-tag-editor-track].is-reorder-before, [data-tag-editor-track].is-reorder-dragged',
    );
    this.activeTrackButtons = this.trackButtons.filter({
      has: this.page.locator('.tag-editor-track-select[aria-pressed="true"]'),
    });
    this.activeTrackTitles = this.activeTrackButtons.locator('.tag-editor-track-title');
    this.albumNameInput = this.overlay.locator('input[data-tag-field="album"]');
    this.artistInput = this.overlay.locator('input[data-tag-field="artist"]');
    this.albumArtistInput = this.overlay.locator('input[data-tag-field="album_artist"]');
    this.trackNameInput = this.overlay.locator('input[data-tag-field="title"]');
    this.genreInput = this.overlay.locator('input[data-tag-field="genre"]');
    this.yearInput = this.overlay.locator('input[data-tag-field="year"]');
    this.trackNumberInput = this.overlay.locator('input[data-tag-field="track_number"]');
    this.discNumberInput = this.overlay.locator('input[data-tag-field="disc_number"]');
    this.exceptionSelect = this.overlay.locator('input[data-tag-field="exception_type"]');
    this.exceptionNoneOption = page.locator(
      '#tag-editor-exception-menu [data-tag-editor-exception-option=""]',
    );
    this.customCollectionNameInput = this.overlay.locator(
      'input[data-tag-field="custom_collection_name"]',
    );
    this.autoNumberButton = this.overlay.getByRole('button', {
      name: 'Auto-number',
      exact: true,
    });
    this.startAtInput = this.overlay.getByLabel('Start at', { exact: true });
    this.autoNumberHelp = this.overlay.locator('#tag-editor-auto-number-help');
    this.autoNumberStatus = this.overlay.locator('#tag-editor-auto-number-status');
    this.applyButton = this.overlay.getByRole('button', { name: 'Apply', exact: true });
    this.closeButton = this.overlay.getByRole('button', { name: 'Close tag editor', exact: true });
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
      '.on-page-alert__icon',
    );
    this.nonAlbumRarityWarningIconSvg = this.nonAlbumRarityWarningIcon.locator('svg');
    this.nonAlbumRarityWarningText = this.nonAlbumRarityWarning.locator(
      '.on-page-alert__message',
    );
    this.repairAlertMessageSelector = '#repair-alert-message';
    this.repairAlertLogHistorySelector = '#repair-alert-log-history';
    this.repairAlert = page.locator('#repair-alert');
    this.repairAlertMessage = page.locator(this.repairAlertMessageSelector);
    this.repairAlertLogHistory = page.locator(this.repairAlertLogHistorySelector);
    this.repairAlertDismiss = this.repairAlert.getByRole('button', { name: 'Dismiss repair alert', exact: true });
  }

  async readLibraryReturnState() {
    // parity-check: allow-read-only-measurement-evaluate -- compare the canonical library view and real scroll before and after native Status navigation
    return this.page.evaluate(() => {
      const scroll = document.querySelector('#albums-scroll');
      if (!scroll || typeof state === 'undefined' || !state.view) {
        throw new Error('Saved notification delivery requires the canonical library view');
      }
      return {
        url: location.href,
        artist: String(state.view.selected_artist || ''),
        query: String(state.view.query || ''),
        scrollTop: scroll.scrollTop,
      };
    });
  }

  async readRepairAlertOverlap() {
    // parity-check: allow-read-only-measurement-evaluate -- measure notification bounds against independently hit-tested actionable controls
    return this.repairAlert.evaluate(inspectRepairAlert);
  }

  // A live list of each presentation from now on, measured as readRepairAlertOverlap does while it is
  // shown, so a timed toast that closes before it can be read is still proven rendered and placed.
  async recordRepairAlertPresentations() {
    // parity-check: allow-read-only-measurement-evaluate -- observe the alert's class without changing it and measure each presentation
    return this.repairAlert.evaluateHandle(inspectRepairAlert, this.repairAlertMessageSelector);
  }

  async stopRecordingRepairAlertPresentations(presentations) {
    // parity-check: allow-read-only-measurement-evaluate -- disconnect this probe's own observer; the app is untouched
    await presentations.evaluate((list) => list.stop());
    await presentations.dispose();
  }

  async readFormAndStripeColors() {
    // parity-check: allow-read-only-measurement-evaluate -- read the existing tag form and alternating unselected rows.
    return this.overlay.evaluate(node => {
      const paint = element => {
        const layers = [];
        for (let node = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          const values = color.match(/[\d.]+/g).map(Number);
          const rgb = values.slice(0, 3).map(value => color.startsWith('color(') ? value * 255 : value);
          const alpha = values[3] ?? 1;
          layers.unshift({ rgb, alpha });
          if (alpha === 1) break;
        }
        const rgb = layers.reduce((under, layer) => layer.rgb.map((value, index) => value * layer.alpha + under[index] * (1 - layer.alpha)), [255, 255, 255]);
        return { background: `rgb(${rgb.join(', ')})`, ink: getComputedStyle(element).color };
      };
      const rows = [...node.querySelectorAll('.tag-editor-track:not(.is-active)')].slice(0, 3);
      return { rows: rows.map(paint), input: paint(node.querySelector('[data-tag-field="album"]')), apply: paint(node.querySelector('[data-open-tag-edit-confirm]')) };
    });
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
    return '#tag-editor-footer [data-close-tag-editor="1"]';
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

  selectionToggleByFilename(filename) {
    return this.trackButtonByFilename(filename).locator('.tag-editor-track-select');
  }

  reorderGripByFilename(filename) {
    return this.trackButtonByFilename(filename).getByRole('button', {
      name: exactNormalizedText(`Reorder ${filename}; use Arrow Up or Arrow Down`),
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
