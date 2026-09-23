import { BasePage } from './basePage.js';
import { UtilityLoopEntryCard } from './utilityLoopEntryCard.js';
import { UtilityLoopTree } from './utilityLoopTree.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

export class UtilityLoopsTab extends BasePage {
  async observeWaveformPresentationFrames(expectedNames) {
    // parity-check: allow-read-only-measurement-evaluate -- sample real canvas paint and seekbar visibility without mutating app state
    return this.page.evaluate((names) => new Promise((resolve) => {
      const samples = [];
      const deadline = performance.now() + 10000;
      const sample = () => {
        const entries = [...document.querySelectorAll('[data-utility-loop-entry]')];
        const mountedNames = entries.map((entry) => (
          entry.querySelector('.utility-detail-title')?.textContent || ''
        ).trim());
        const expectedMounted = names.length === mountedNames.length
          && names.every((name) => mountedNames.includes(name));
        const wrappers = expectedMounted
          ? entries.map((entry) => entry.querySelector('.utility-loop-timeline-wrap')).filter(Boolean)
          : [];
        let allPainted = wrappers.length > 0;
        const presentations = wrappers.map((wrapper) => {
          const canvas = wrapper.querySelector('[data-loop-stereo-waveform]');
          const timeline = wrapper.querySelector('[data-loop-timeline]');
          const canvasStyle = canvas ? getComputedStyle(canvas) : null;
          const timelineStyle = timeline ? getComputedStyle(timeline) : null;
          let painted = false;
          if (canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0) {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            painted = pixels.some((value, index) => index % 4 === 3 && value > 0);
          }
          allPainted = allPainted && painted;
          return {
            waveformMode: wrapper.classList.contains('is-stereo-waveform'),
            waveformVisible: canvasStyle?.display !== 'none' && canvasStyle?.visibility !== 'hidden',
            regularVisible: Number(timelineStyle?.opacity ?? 1) > 0.01,
          };
        });
        if (presentations.length) samples.push(presentations);
        if (allPainted || performance.now() >= deadline) resolve(samples);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }), expectedNames);
  }

  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.loopTree = new UtilityLoopTree(page, testInfo);
    this.loopEntryCard = new UtilityLoopEntryCard(page, testInfo);
    this.neutralKeyboardTarget = page.locator('body');
    this.emptyState = page.locator('#utility-problematic-detail .utility-empty-state').first();
    this.headerArtbox = page.locator('.utility-loop-detail-header .album-artbox');
    this.headerArtworkTrigger = page.locator('.utility-loop-detail-header .utility-artbox-trigger');
    this.lightbox = page.locator('#image-lightbox');
    this.lightboxImage = page.locator('#image-lightbox-image');
    this.lightboxClose = page.getByRole('button', { name: 'Close full-screen cover', exact: true });
  }
}
