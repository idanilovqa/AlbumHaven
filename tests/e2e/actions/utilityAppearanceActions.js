import { expect } from '@playwright/test';

export class UtilityAppearanceActions {
  constructor(utilityAppearanceTab) {
    this.utilityAppearanceTab = utilityAppearanceTab;
  }

  async waitForReady(options = {}) {
    const timeout = options.timeout || 60000;
    await this.utilityAppearanceTab.waitForPageCondition(() => (
      typeof state !== 'undefined' && state.utility?.activeTab === 'appearance'
    ), { timeout });
    await expect(this.utilityAppearanceTab.navigationTree.items).toHaveCount(5, { timeout });
    await expect(this.utilityAppearanceTab.editorHeading).toHaveText(
      /^(Main elements|Player & Seekbar|Selection & Hover|Alerts|Album page)$/,
      { timeout },
    );
    await expect(this.utilityAppearanceTab.editor).toHaveAttribute('aria-busy', 'false', { timeout });
  }

  async readSummary() {
    return {
      itemCount: await this.utilityAppearanceTab.navigationTree.items.count(),
      sectionLabels: await this.utilityAppearanceTab.sectionButtons.allTextContents()
        .then((labels) => labels.map((label) => label.trim())),
      seekbarModeCount: await this.utilityAppearanceTab.seekbarModeInputs.count(),
      colorInputCount: await this.utilityAppearanceTab.colorInputs.count(),
      detailTitle: String(await this.utilityAppearanceTab.editorHeading.textContent() || '').trim(),
    };
  }

  async selectSeekbarMode(mode) {
    const normalized = mode === 'waveform' ? 'waveform' : 'default';
    if (await this.utilityAppearanceTab.seekbarModeInputs.count() === 0) {
      await this.openSection('seekbar');
    }
    const input = this.utilityAppearanceTab.seekbarModeInput(normalized);
    await input.check();
    await this.utilityAppearanceTab.waitForPageCondition((expected) => {
      const selected = document.querySelector(expected.selector);
      return selected instanceof HTMLInputElement
        && selected.checked
        && state.player?.appearance?.seekbarMode === expected.mode;
    }, { timeout: 60000 }, {
      mode: normalized,
      selector: this.utilityAppearanceTab.seekbarModeSelectorFor(normalized),
    });
  }

  async saveCompactPlayerStyle(style) {
    const normalized = style === 'floating' ? 'floating' : 'docked';
    if (await this.utilityAppearanceTab.compactPlayerStyle.buttons.count() === 0) {
      await this.openSection('seekbar');
    }
    const button = this.utilityAppearanceTab.compactStyleButton(normalized);
    await expect(button).toBeVisible({ timeout: 60000 });
    const alreadySaved = await this.utilityAppearanceTab.documentRoot
      .getAttribute('data-compact-player-style') === normalized;
    if (alreadySaved) {
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      return;
    }
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(this.utilityAppearanceTab.editorFooter.primary.root).toBeEnabled();
    await this.utilityAppearanceTab.editorFooter.primary.root.click();
    await expect(this.utilityAppearanceTab.editorFooter.status).toHaveText('Saved to your account', { timeout: 60000 });
    await expect(this.utilityAppearanceTab.documentRoot).toHaveAttribute('data-compact-player-style', normalized);
  }

  async openSection(key) {
    const normalized = ['backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'].includes(key)
      ? key
      : 'backgrounds';
    const button = this.utilityAppearanceTab.sectionButton(normalized);
    await expect(button).toBeVisible({ timeout: 60000 });
    await button.click();
    const heading = {
      backgrounds: 'Main elements',
      seekbar: 'Player & Seekbar',
      'selection-accent': 'Selection & Hover',
      alerts: 'Alerts',
      'album-page': 'Album page',
    }[normalized];
    await expect(this.utilityAppearanceTab.editor.getByRole('heading', { name: heading, exact: true }))
      .toBeVisible({ timeout: 60000 });
    await expect(this.utilityAppearanceTab.editor).toHaveAttribute('aria-busy', 'false');
  }

  async selectAlertFamily(family) {
    const button = this.utilityAppearanceTab.alertFamilyButton(family);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  async selectAlertPreviewSeverity(severity) {
    const button = this.utilityAppearanceTab.alertSeverityButton(severity);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(this.utilityAppearanceTab.alertLivePreview)
      .toHaveAttribute('data-alert-preview-active-severity', severity);
  }

  async selectAlbumLayout(layout) {
    const button = this.utilityAppearanceTab.albumLayoutButton(layout);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(this.utilityAppearanceTab.albumPageLivePreview)
      .toHaveAttribute('data-layout', layout);
  }

  async setAlbumPlayingRowAnimation(enabled) {
    const value = enabled ? 'enabled' : 'disabled';
    const button = this.utilityAppearanceTab.albumPlayingRowAnimationButton(value);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  async selectAlbumPreviewState(previewState) {
    const button = this.utilityAppearanceTab.albumPreviewStateButton(previewState);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(this.utilityAppearanceTab.albumPageLivePreview)
      .toHaveAttribute('data-preview-state', previewState);
  }

  async readStickyPreviewCheckpoint(preview) {
    const scroller = this.utilityAppearanceTab.detailScroller;
    await expect(scroller).toBeVisible();
    await expect(preview).toBeVisible();
    await scroller.hover({ position: { x: 8, y: 8 } });
    await this.utilityAppearanceTab.page.mouse.wheel(0, -10000);
    // parity-check: allow-read-only-measurement-evaluate -- read scroll geometry after user-equivalent wheel input
    await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBe(0);

    const initialPreviewBox = await preview.boundingBox();
    const scrollerBox = await scroller.boundingBox();
    expect(initialPreviewBox).not.toBeNull();
    expect(scrollerBox).not.toBeNull();

    await this.utilityAppearanceTab.page.mouse.wheel(0, 1400);
    // parity-check: allow-read-only-measurement-evaluate -- read scroll geometry after user-equivalent wheel input
    await expect.poll(async () => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100);

    const scrolledPreviewBox = await preview.boundingBox();
    // parity-check: allow-read-only-measurement-evaluate -- record the final scroll position in the E2E checkpoint
    const scrollTop = await scroller.evaluate((element) => element.scrollTop);
    expect(scrolledPreviewBox).not.toBeNull();
    return {
      initialPreviewTop: initialPreviewBox.y,
      previewTop: scrolledPreviewBox.y,
      previewBottom: scrolledPreviewBox.y + scrolledPreviewBox.height,
      viewportTop: scrollerBox.y,
      viewportBottom: scrollerBox.y + scrollerBox.height,
      scrollTop,
    };
  }

  async readAlbumPlayingRowAppearance() {
    const row = this.utilityAppearanceTab.albumPreviewPlayingTrack;
    await expect(row).toHaveCount(1);
    // parity-check: allow-read-only-measurement-evaluate -- inspect the resolved active-row perimeter effect
    return row.evaluate((element) => {
      const rowStyle = getComputedStyle(element);
      const perimeterStyle = getComputedStyle(element, '::after');
      return {
        outlineColor: rowStyle.outlineColor,
        perimeter: {
          animationName: perimeterStyle.animationName,
          backgroundImage: perimeterStyle.backgroundImage,
          display: perimeterStyle.display,
          maskComposite: perimeterStyle.maskComposite,
          opacity: perimeterStyle.opacity,
          paddingTop: perimeterStyle.paddingTop,
          transform: perimeterStyle.transform,
          webkitMaskComposite: perimeterStyle.webkitMaskComposite,
        },
      };
    });
  }

  async choosePalette(paletteId, panelIndex = 0) {
    const palette = this.utilityAppearanceTab.paletteButton(paletteId);
    await palette.click();
    await expect(palette).toHaveAttribute('aria-pressed', 'true');
    const panel = this.utilityAppearanceTab.panelButton(panelIndex);
    await expect(panel).toBeVisible();
    await panel.click();
    await expect(panel).toHaveAttribute('aria-pressed', 'true');
  }

  async choosePlayerTheme(themeId) {
    const theme = this.utilityAppearanceTab.playerThemeButton(themeId);
    await theme.click();
    await expect(theme).toHaveAttribute('aria-pressed', 'true');
  }

  async setPlayerStyleColor(path, color) {
    const input = this.utilityAppearanceTab.playerStyleHex(path);
    await expect(input).toBeVisible();
    await input.fill(color);
    await expect(input).toHaveValue(color.toUpperCase());
  }

  async setWaveformColor(field, color) {
    const input = this.utilityAppearanceTab.waveformHex(field);
    await expect(input).toBeVisible();
    await input.fill(color);
    await expect(input).toHaveValue(color.toUpperCase());
  }

  async chooseRecentWaveformColor(field, color) {
    const button = this.utilityAppearanceTab.waveformRecentButton(field, color);
    await expect(button).toBeVisible();
    await button.click();
    await expect(this.utilityAppearanceTab.waveformHex(field)).toHaveValue(color.toUpperCase());
    const preview = await this.utilityAppearanceTab.readPlayerPreviewColors();
    expect(preview[field === 'fill' ? 'waveformFill' : 'waveformEdge'].toUpperCase())
      .toBe(color.toUpperCase());
  }

  async setPlayerAngle(angle) {
    await this.utilityAppearanceTab.playerAngleInput.fill(String(angle));
    await expect(this.utilityAppearanceTab.playerAngleOutput)
      .toHaveText(`${angle}°`);
  }

  async selectPlayerTab(tab, group = ['waveform', 'handles'].includes(tab) ? 'waveform' : 'player') {
    const button = this.utilityAppearanceTab.playerTabButton(tab, group);
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true');
  }

  async selectPlayerSurfaceMode(mode) {
    const button = this.utilityAppearanceTab.playerSurfaceModeButton(mode);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  async selectCompactPlayerStyle(style) {
    const button = this.utilityAppearanceTab.compactStyleButton(style);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  async setSelectionAccent(color) {
    await this.utilityAppearanceTab.selectionAccentCustomInput.fill(color);
    await expect(this.utilityAppearanceTab.selectionAccentCustomInput)
      .toHaveValue(color.toLowerCase());
  }

  async setSelectionAccentEnabled(enabled) {
    await this.utilityAppearanceTab.selectionAccentEnabledInput.setChecked(enabled);
    await expect(this.utilityAppearanceTab.selectionAccentEnabledInput).toBeChecked({ checked: enabled });
  }

  async chooseSelectionAccent(color) {
    const button = this.utilityAppearanceTab.selectionAccentButton(color);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  async setInteractionFamily(family) {
    const roles = [
      'item_hover',
      'item_selected',
      'button_hover_background',
      'item_outline',
      'button_pressed',
    ];
    for (const role of roles) {
      const button = this.utilityAppearanceTab.interactionColorButton(role, family);
      await expect(button).toBeEnabled();
      if (await button.getAttribute('aria-pressed') !== 'true') {
        await button.click();
      }
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    }
  }

  async save() {
    await expect(this.utilityAppearanceTab.editorFooter.primary.root).toBeEnabled();
    await this.utilityAppearanceTab.editorFooter.primary.root.click();
    await expect(this.utilityAppearanceTab.editorFooter.status)
      .toHaveText('Saved to your account', { timeout: 60000 });
  }

  async cancel() {
    await expect(this.utilityAppearanceTab.editorFooter.secondary.root).toBeEnabled();
    await this.utilityAppearanceTab.editorFooter.secondary.root.click();
    await expect(this.utilityAppearanceTab.editorFooter.status).toHaveText('Saved to your account');
  }

  async readPreviewStyles() {
    const states = [
      'navigation-hover',
      'navigation-selected',
      'item-hover-background',
      'item-outline',
      'item-pressed',
    ];
    const entries = await Promise.all(states.map(async (state) => {
      // parity-check: allow-read-only-measurement-evaluate -- read computed Appearance preview colors
      const value = await this.utilityAppearanceTab.previewState(state).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          accentColor: style.accentColor,
          backgroundColor: style.backgroundColor,
          borderLeftColor: style.borderLeftColor,
          borderColor: style.borderColor,
          outlineColor: style.outlineColor,
        };
      });
      return [state, value];
    }));
    return Object.fromEntries(entries);
  }

  async readAppliedStyleSnapshot() {
    // parity-check: allow-read-only-measurement-evaluate -- read applied tokens and computed real-element styles
    const snapshot = await this.utilityAppearanceTab.page.evaluate(() => {
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      const read = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return {
          accentColor: style.accentColor,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderColor: style.borderColor,
          borderLeftColor: style.borderLeftColor,
          borderRightColor: style.borderRightColor,
          boxShadow: style.boxShadow,
          color: style.color,
        };
      };
      const tokens = [
        'main-surface',
        'panel-background',
        'player-surface-start',
        'player-surface-end',
        'player-surface-angle',
        'play',
        'player-control-border',
        'waveform-fill',
        'waveform-edge',
        'player-handle',
        'item-hover',
        'item-selected',
        'item-action-hover-background',
        'item-action-pressed',
        'interaction-outline',
      ];
      return {
        palette: root.getAttribute('data-appearance-palette'),
        mode: root.getAttribute('data-appearance-mode'),
        compactPlayerStyle: root.getAttribute('data-compact-player-style'),
        alertFamily: root.getAttribute('data-alert-family'),
        albumDetailsLayout: root.getAttribute('data-album-details-layout'),
        albumPlayingRowAnimation: root.getAttribute('data-album-playing-row-animation'),
        selectionAccentColor: rootStyle.getPropertyValue('--navigation-tree-selection-accent-color').trim(),
        selectionAccentWidth: rootStyle.getPropertyValue('--navigation-tree-selection-accent-width').trim(),
        tokens: Object.fromEntries(tokens.map((token) => [
          token,
          rootStyle.getPropertyValue(`--appearance-${token}`).trim(),
        ])),
        body: read('body'),
        navigationRail: read('#shell-navigation-rail'),
        selectedAppearanceItem: read('#utility-problematic-list .navigation-tree-item.is-selected'),
        player: read('.global-player'),
        playButton: read('#player-play'),
        coverButton: read('#player-cover-button'),
        timeline: read('#player-timeline'),
        loopSelection: read('.global-player .loop-range-selection'),
      };
    });
    return {
      ...snapshot,
      appBar: await this.utilityAppearanceTab.appBar.readAppearanceCheckpoint(),
    };
  }
}
