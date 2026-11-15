// One read-only snapshot of the startup progress overlay as rendered now.
function readOverlaySnapshot() {
  const root = document.querySelector('[data-startup-progress]');
  const path = window.location.pathname;
  if (!root) return { path, overlayPresent: false, overlayVisible: false };
  const bar = root.querySelector('[role="progressbar"]');
  const fill = root.querySelector('.progress-fill');
  const label = root.querySelector('[data-startup-percent]');
  const overlayVisible = !root.hidden && getComputedStyle(root).display !== 'none';
  const barBox = bar.getBoundingClientRect();
  const fillBox = fill.getBoundingClientRect();
  const colored = (element) => {
    const color = getComputedStyle(element).backgroundColor;
    return color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color);
  };
  return {
    path,
    overlayPresent: true,
    overlayVisible,
    percent: Number.parseInt(label.textContent, 10),
    barVisible: overlayVisible && !bar.hidden && barBox.width > 0 && barBox.height > 0,
    trackColored: colored(bar),
    fillColored: colored(fill),
    fillPercent: barBox.width > 0 ? (fillBox.width / barBox.width) * 100 : 0,
  };
}

const NAVIGATION_RACE = /Execution context was destroyed|Cannot find context|frame was detached|navigat/i;

export class StartupProgress {
  constructor(page) {
    this.page = page;
    this.overlay = page.locator('[data-startup-progress]');
  }

  // Samples the overlay back to back, across document navigations, until the
  // app document has shown the overlay and then released it.
  async sampleUntilAppReleasesOverlay({ timeout = 60000 } = {}) {
    const samples = [];
    const deadline = Date.now() + timeout;
    let appOverlaySeen = false;
    while (Date.now() < deadline) {
      let sample;
      try {
        // parity-check: allow-read-only-measurement-evaluate -- reads the rendered overlay without driving it
        sample = await this.page.evaluate(readOverlaySnapshot);
      } catch (error) {
        if (!NAVIGATION_RACE.test(String(error?.message || error))) throw error;
        sample = { path: 'navigating', overlayPresent: false, overlayVisible: false };
      }
      samples.push(sample);
      const onApp = sample.overlayPresent && sample.path !== '/login';
      if (onApp && sample.overlayVisible) appOverlaySeen = true;
      if (onApp && appOverlaySeen && !sample.overlayVisible) return samples;
    }
    throw new Error(`Startup progress overlay was not released within ${timeout} ms (${samples.length} samples).`);
  }
}
