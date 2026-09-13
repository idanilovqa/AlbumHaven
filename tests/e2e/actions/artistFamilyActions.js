export class ArtistFamilyActions {
  constructor(artistFamily) {
    this.artistFamily = artistFamily;
  }

  async waitForVisible(options = {}) {
    await this.artistFamily.waitForPageCondition((selectors) => {
      const toggle = document.querySelector(selectors.toggleSelector);
      const list = document.querySelector(selectors.listSelector);
      return toggle instanceof HTMLElement
        && list instanceof HTMLElement
        && list.childElementCount > 0;
    }, {
      timeout: options.timeout || 30000,
    }, {
      toggleSelector: this.artistFamily.toggleSelector,
      listSelector: this.artistFamily.listSelector,
    });
  }

  async waitForViewReady(expectedArtist, options = {}) {
    const expectedQuery = String(options.queryValue || '').trim();
    await this.artistFamily.waitForPageCondition((expected) => {
      if (typeof state === 'undefined' || !state?.view) {
        return false;
      }
      const view = state.view;
      if (String(view.selected_artist || '').trim() !== expected.artist) {
        return false;
      }
      if (expected.query && String(view.query || '').trim() !== expected.query) {
        return false;
      }
      const primaryGroups = Array.isArray(view.primary_artist_groups) ? view.primary_artist_groups : [];
      const familyGroups = Array.isArray(view.family_artist_groups) ? view.family_artist_groups : [];
      const relatedArtists = Array.isArray(view.related_artists) ? view.related_artists : [];
      return (primaryGroups.length > 0 || familyGroups.length > 0) && relatedArtists.length > 0;
    }, {
      timeout: options.timeout || 120000,
    }, {
      artist: String(expectedArtist || '').trim(),
      query: expectedQuery,
    });
  }

  async expand(options = {}) {
    const expanded = await this.artistFamily.toggle.getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await this.artistFamily.toggle.click({ noWaitAfter: true, ...options });
    }
    await this.artistFamily.waitForPageCondition((selectors) => {
      const toggle = document.querySelector(selectors.toggleSelector);
      return toggle instanceof HTMLElement && toggle.getAttribute('aria-expanded') === 'true';
    }, {
      timeout: options.timeout || 10000,
    }, {
      toggleSelector: this.artistFamily.toggleSelector,
    });
  }

  async readChipTexts() {
    return this.artistFamily.chipLabels.allTextContents();
  }

  async readPanelState() {
    return {
      visible: await this.artistFamily.box.isVisible(),
      chipTexts: (await this.artistFamily.chipLabels.allTextContents())
        .map((text) => String(text || '').trim())
        .filter(Boolean),
    };
  }

  async waitForHidden(options = {}) {
    await this.artistFamily.box.waitFor({
      state: 'hidden',
      timeout: options.timeout || 30000,
    });
  }

  async clickPrimaryChip(options = {}) {
    await this.expand(options);
    await this.artistFamily.primaryChip.click({ noWaitAfter: true, ...options });
  }

  async clickChipByName(name, options = {}) {
    await this.expand(options);
    await this.artistFamily.chipByName(name).click({ noWaitAfter: true, ...options });
  }

  async readPanelStructure() {
    const [headerBox, combineBox, panelBox, toggleBox] = await Promise.all([
      this.artistFamily.header.boundingBox(),
      this.artistFamily.combineRow.boundingBox(),
      this.artistFamily.box.boundingBox(),
      this.artistFamily.toggle.boundingBox(),
    ]);
    // parity-check: allow-read-only-measurement-evaluate -- measure the shared trigger envelope
    const envelope = await this.artistFamily.box.evaluate((panel) => ({
      anchorEnvelope: panel.dataset.anchorEnvelope || '',
      anchorWidth: getComputedStyle(panel).getPropertyValue('--gallery-anchor-width').trim(),
      anchorHeight: getComputedStyle(panel).getPropertyValue('--gallery-anchor-height').trim(),
    }));
    return {
      headerBox,
      combineBox,
      panelBox,
      toggleBox,
      total: String(await this.artistFamily.total.textContent() || '').trim(),
      primaryDraggable: await this.artistFamily.primaryChip.getAttribute('draggable'),
      ...envelope,
    };
  }

  async dragAcrossChips(sourceName, targetName) {
    await this.expand();
    const source = await this.artistFamily.chipByName(sourceName).boundingBox();
    const target = await this.artistFamily.chipByName(targetName).boundingBox();
    if (!source || !target) throw new Error('Both family chips must be visible before dragging.');
    const page = this.artistFamily.page;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 24 });
    } finally {
      await page.mouse.up();
    }
  }

  async selectOnlyChipByName(name, options = {}) {
    await this.expand(options);
    await this.artistFamily.chipByName(name).waitFor({
      state: 'visible', timeout: options.timeout || 30000,
    });
    const labels = (await this.readChipTexts())
      .map((text) => String(text || '').trim())
      .filter(Boolean);
    if (!labels.includes(name)) {
      throw new Error(`Artist Family does not contain ${JSON.stringify(name)}.`);
    }
    for (const label of labels) {
      if (label === name) continue;
      const chip = this.artistFamily.chipByName(label);
      if (String(await chip.getAttribute('class') || '').split(/\s+/).includes('is-active')) {
        await chip.click({ noWaitAfter: true, ...options });
        await this.waitForChipActive(label, false, options);
      }
    }
    const target = this.artistFamily.chipByName(name);
    if (!String(await target.getAttribute('class') || '').split(/\s+/).includes('is-active')) {
      await target.click({ noWaitAfter: true, ...options });
    }
    await this.waitForChipActive(name, true, options);
  }

  async expectInterviewAlbumExcludedFromFamily({ primaryArtist, excludedArtist, excludedAlbum,
    controls, query = '', galleryActions, navigationPanelActions, searchToolbarActions }) {
    await navigationPanelActions.selectSidebarArtistByName(primaryArtist);
    await navigationPanelActions.waitForSidebarSelection(primaryArtist);
    await searchToolbarActions.waitForQuery(query);
    await this.waitForViewReady(primaryArtist, { queryValue: query });
    await this.selectAllChips();
    for (const [artist, album] of controls) {
      await galleryActions.scrollToAlbumUnderHeading(artist, album);
      await galleryActions.waitForAlbumVisibleUnderHeading(artist, album);
    }
    await galleryActions.expectAlbumAbsentFromSettledGallery({
      artist: excludedArtist, album: excludedAlbum, query,
    });
  }

  async selectMemberAndVerifyAlbumScope({ primaryArtist, memberArtist, ownedAlbum, excludedAlbum,
    query = '', galleryActions, navigationPanelActions }) {
    await navigationPanelActions.selectSidebarArtistByName(primaryArtist);
    await navigationPanelActions.waitForSidebarSelection(primaryArtist);
    await this.waitForViewReady(primaryArtist, { queryValue: query });
    await this.selectOnlyChipByName(memberArtist);
    await galleryActions.waitForAlbumVisibleUnderHeading(memberArtist, ownedAlbum);
    await galleryActions.expectAlbumAbsentFromSettledGallery({ artist: memberArtist, album: excludedAlbum, query });
  }

  async waitForAllChipsActive(expectedNames, options = {}) {
    await this.artistFamily.waitForPageCondition((expected) => {
      const chips = Array.from(document.querySelectorAll(expected.chipSelector));
      const activeNames = new Set(chips
        .filter((chip) => chip.classList.contains('is-active'))
        .map((chip) => (chip.querySelector(expected.chipLabelSelector)?.textContent || '').trim()));
      return expected.names.every((name) => activeNames.has(name));
    }, {
      timeout: options.timeout || 30000,
    }, {
      chipSelector: this.artistFamily.chipSelector,
      chipLabelSelector: this.artistFamily.chipLabelSelector,
      names: expectedNames.map((name) => String(name || '').trim()).filter(Boolean),
    });
  }

  async selectAllChips(options = {}) {
    await this.expand(options);
    const labels = (await this.readChipTexts()).map((text) => String(text || '').trim()).filter(Boolean);
    for (const label of labels) {
      const chip = this.artistFamily.chipByName(label);
      if (!String(await chip.getAttribute('class') || '').split(/\s+/).includes('is-active')) {
        await chip.click({ noWaitAfter: true, ...options });
        await this.waitForChipActive(label, true, options);
      }
    }
    await this.waitForAllChipsActive(labels, options);
  }

  async waitForPrimaryChipActive(expectedText, options = {}) {
    await this.artistFamily.waitForPageCondition((selectors) => {
      const chip = document.querySelector(selectors.primaryChipSelector);
      if (!(chip instanceof HTMLElement)) return false;
      return chip.classList.contains('is-primary')
        && (chip.querySelector(selectors.chipLabelSelector)?.textContent || '').trim() === selectors.expectedText;
    }, {
      timeout: options.timeout || 30000,
    }, {
      primaryChipSelector: this.artistFamily.primaryChipSelector,
      chipLabelSelector: this.artistFamily.chipLabelSelector,
      expectedText,
    });
  }

  async waitForChipActive(name, active = true, options = {}) {
    await this.artistFamily.waitForPageCondition((selectors) => {
      const chip = Array.from(document.querySelectorAll(selectors.chipSelector)).find((element) => (
        (element.querySelector(selectors.chipLabelSelector)?.textContent || '').trim() === selectors.expectedText
      ));
      if (!(chip instanceof HTMLElement)) return false;
      return chip.classList.contains('is-active') === selectors.active;
    }, {
      timeout: options.timeout || 30000,
    }, {
      chipSelector: this.artistFamily.chipSelector,
      chipLabelSelector: this.artistFamily.chipLabelSelector,
      expectedText: name,
      active: Boolean(active),
    });
  }

  async waitForPrimaryAndRelatedFilterActive(relatedArtist, options = {}) {
    await this.artistFamily.waitForPageCondition((expectedArtist) => {
      if (typeof state === 'undefined') return false;
      const galleryState = state.gallery?.mainState;
      return galleryState?.familySelectionExplicit === true
        && Array.isArray(galleryState.familyArtists)
        && galleryState.familyArtists.includes(expectedArtist);
    }, {
      timeout: options.timeout || 60000,
    }, String(relatedArtist || '').trim());
  }
}
