function observeSourceSwitchFrames({ source }) {
  const visible = node => Boolean(node) && !node.hidden && node.getClientRects().length > 0;
  const samples = [];
  let frame;
  const sample = () => {
    const scroll = document.getElementById('albums-scroll');
    samples.push({
      sourceOn: document.querySelector(`#gallery-sources-menu [data-gallery-source="${source}"]`)?.getAttribute('aria-checked') === 'true',
      loaderVisible: visible(document.getElementById('library-loader')),
      loaderTitle: document.getElementById('library-loader-title')?.textContent.trim() || '',
      galleryVisible: visible(scroll),
      cards: scroll ? [...scroll.querySelectorAll('.album-card')].filter(visible).length : 0,
    });
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  return { finish() { cancelAnimationFrame(frame); return samples; } };
}

export class GallerySourceSwitch {
  constructor(page) {
    this.page = page;
    this.sourcesTrigger = page.getByRole('button', { name: 'Sources', exact: true });
    this.sourcesMenu = page.locator('#gallery-sources-menu');
    this.loader = page.locator('#library-loader');
    this.emptySelection = page.locator('#albums-scroll [data-gallery-empty-selection]');
    this.cards = page.locator('#albums-scroll .album-card');
  }

  source(label) { return this.sourcesMenu.getByRole('switch', { name: label, exact: true }); }

  async openSources() {
    if (!await this.sourcesMenu.isVisible()) await this.sourcesTrigger.click();
    await this.sourcesMenu.waitFor({ state: 'visible' });
  }

  async observeFramesWhileEnabling(source) {
    const handle = await this.page.evaluateHandle(observeSourceSwitchFrames, { source });
    let finished = false;
    return { async finish() {
      if (finished) return [];
      finished = true;
      try {
        // parity-check: allow-read-only-measurement-evaluate -- collect closure-owned frame samples and stop its frame
        return await handle.evaluate(observation => observation.finish());
      } finally { await handle.dispose(); }
    } };
  }
}
