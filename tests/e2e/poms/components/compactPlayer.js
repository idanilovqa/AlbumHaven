import { PlaybackControlCluster } from './playbackControlCluster.js';
import { SharedButton } from './sharedButton.js';

export class CompactPlayer {
  constructor(playerRoot) {
    this.playerRoot = playerRoot;
    this.root = playerRoot.locator('.compact-player-shell');
    this.coverButton = this.root.locator('[data-compact-player-cover]');
    this.controls = new PlaybackControlCluster(
      this.root.locator('[data-playback-control-variant="compact-player"]'),
    );
    this.expand = new SharedButton(
      this.root.locator('[data-ui-button-action="player-expand"]'),
    );
  }

  async readViewCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- observe the reusable compact-player composition
    return this.root.evaluate((compactShell, expandedSelector) => {
      const player = compactShell.closest('.global-player');
      if (!(player instanceof HTMLElement)) {
        throw new Error('Compact player is not owned by the global player.');
      }
      const rectangle = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      };
      const expanded = player.querySelector(expandedSelector);
      const cover = compactShell.querySelector('[data-compact-player-cover]');
      const transport = compactShell.querySelector('[data-playback-control-variant="compact-player"]');
      const expand = compactShell.querySelector('[data-ui-button-action="player-expand"]');
      const playerStyle = getComputedStyle(player);
      const coverStyle = cover instanceof HTMLElement ? getComputedStyle(cover) : null;
      return {
        mode: player.classList.contains('is-compact') ? 'compact' : 'expanded',
        style: player.classList.contains('is-floating-compact') ? 'floating'
          : player.classList.contains('is-docked-compact') ? 'docked' : 'expanded',
        player: rectangle(player),
        expandedShell: rectangle(expanded),
        compactShell: rectangle(compactShell),
        cover: rectangle(cover),
        transport: rectangle(transport),
        expand: rectangle(expand),
        expandOwnedByCompactShell: expand instanceof HTMLElement && compactShell.contains(expand),
        floatingAppearance: {
          borderColor: playerStyle.borderColor,
          boxShadow: playerStyle.boxShadow,
          coverBorderColor: coverStyle?.borderColor || '',
          coverBoxShadow: coverStyle?.boxShadow || '',
        },
        expandedAriaHidden: expanded?.getAttribute('aria-hidden') || '',
        compactAriaHidden: compactShell.getAttribute('aria-hidden') || '',
        rootClasses: [...document.documentElement.classList],
      };
    }, '.player-shell');
  }
}
