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
    return this.artistFamily.chips.allTextContents();
  }

  async readPanelState() {
    return {
      visible: await this.artistFamily.box.isVisible(),
      chipTexts: (await this.artistFamily.chips.allTextContents())
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
    await this.artistFamily.primaryChip.click({ noWaitAfter: true, ...options });
  }

  async clickChipByName(name, options = {}) {
    await this.artistFamily.chipByName(name).click({ noWaitAfter: true, ...options });
  }

  async waitForPrimaryChipActive(expectedText, options = {}) {
    await this.artistFamily.waitForPageCondition((selectors) => {
      const chip = document.querySelector(selectors.primaryChipSelector);
      if (!(chip instanceof HTMLElement)) return false;
      return chip.classList.contains('is-primary')
        && (chip.textContent || '').trim() === selectors.expectedText;
    }, {
      timeout: options.timeout || 30000,
    }, {
      primaryChipSelector: this.artistFamily.primaryChipSelector,
      expectedText,
    });
  }

  async waitForChipActive(name, active = true, options = {}) {
    await this.artistFamily.waitForPageCondition((selectors) => {
      const chip = Array.from(document.querySelectorAll(selectors.chipSelector)).find((element) => (
        (element.textContent || '').trim() === selectors.expectedText
      ));
      if (!(chip instanceof HTMLElement)) return false;
      return chip.classList.contains('active') === selectors.active;
    }, {
      timeout: options.timeout || 30000,
    }, {
      chipSelector: this.artistFamily.chipSelector,
      expectedText: name,
      active: Boolean(active),
    });
  }

  async waitForPrimaryAndRelatedFilterActive(relatedArtist, options = {}) {
    await this.artistFamily.waitForPageCondition((expectedArtist) => {
      if (typeof state === 'undefined') return false;
      return Boolean(state.view?.primary_filter_active)
        && Array.isArray(state.view?.related_filter_artists)
        && state.view.related_filter_artists.includes(expectedArtist);
    }, {
      timeout: options.timeout || 60000,
    }, String(relatedArtist || '').trim());
  }
}
