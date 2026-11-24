import { BasePage } from './basePage.js';
import { AlbumCard } from './albumCard.js';

// What the Gallery shows in each rendered frame, timed from the click that confirms a save.
export class SaveCardFrames extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.albumCard = new AlbumCard(page, testInfo);
  }

  get confirmButtonSelector() {
    return '#tag-edit-confirm-modal button';
  }

  async start() {
    // parity-check: allow-read-only-measurement-evaluate -- sample visible card titles per animation frame after the confirming click
    this.observation = await this.page.evaluateHandle((selectors) => {
      let seen = [];
      let clickedAt = null;
      let running = true;
      document.addEventListener('click', (event) => {
        const button = event.target.closest?.(selectors.confirmButton);
        // The event's own time, so the handler's work counts against the budget.
        if (clickedAt === null && button?.textContent.trim() === 'Yes, apply tags') clickedAt = event.timeStamp;
      }, { capture: true });
      const sample = () => {
        if (!running) return;
        if (clickedAt !== null) {
          const cards = [...document.querySelectorAll(selectors.card)].filter(card => card.getClientRects().length);
          const albums = cards.map(card => String(card.querySelector(selectors.title)?.textContent || '').trim());
          seen = [...seen, { at: performance.now() - clickedAt, albums: albums.sort() }];
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return {
        read: () => seen,
        finish() {
          running = false;
          return seen;
        },
      };
    }, {
      card: this.albumCard.cardSelector,
      title: this.albumCard.titleButtonSelector,
      confirmButton: this.confirmButtonSelector,
    });
  }

  async read() {
    // parity-check: allow-read-only-measurement-evaluate -- read the recorded frames
    return this.observation.evaluate(observation => observation.read());
  }

  async stop() {
    // parity-check: allow-read-only-measurement-evaluate -- stop the frame sampler and read it
    return this.observation.evaluate(observation => observation.finish());
  }
}
