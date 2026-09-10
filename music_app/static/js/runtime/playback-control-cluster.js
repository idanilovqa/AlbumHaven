(function (scope) {
  'use strict';

  const PLAYBACK_CONTROL_VARIANTS = new Set(['expanded-player', 'compact-player', 'saved-loop']);

  function escapePlaybackControlAttribute(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderPreviousIcon() {
    return '<svg class="compact-player-skip-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6l-6 6 6 6"></path><path d="M11 6l-6 6 6 6"></path></svg>';
  }

  function renderNextIcon() {
    return '<svg class="compact-player-skip-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l6 6-6 6"></path><path d="M13 6l6 6-6 6"></path></svg>';
  }

  function renderPlaybackControlCluster({ variant, ownerId = '', loopId = '' } = {}) {
    if (!PLAYBACK_CONTROL_VARIANTS.has(variant)) {
      throw new TypeError('Unknown PlaybackControlCluster variant.');
    }
    if (variant === 'compact-player') {
      return `
        <div class="playback-control-cluster playback-control-cluster--compact compact-player-transport" data-playback-control-cluster data-playback-control-variant="compact-player">
          <button class="compact-player-skip" type="button" data-playback-control-action="previous" data-compact-player-previous aria-label="Previous track">${renderPreviousIcon()}</button>
          <button class="compact-player-play" type="button" data-playback-control-action="play-pause" data-compact-player-play aria-label="Play">&#9654;</button>
          <button class="compact-player-skip" type="button" data-playback-control-action="next" data-compact-player-next aria-label="Next track">${renderNextIcon()}</button>
        </div>
      `;
    }
    if (variant === 'expanded-player') {
      const owner = escapePlaybackControlAttribute(ownerId || 'global-player');
      return `
        <span class="playback-control-cluster playback-control-cluster--expanded loop-play-control-cluster player-play-cluster" data-playback-control-cluster data-playback-control-variant="expanded-player">
          <button class="loop-play-control-button player-play" type="button" id="player-play" data-playback-control-action="play-pause" aria-label="Play or pause">Play</button>
          <span class="loop-play-control-actions player-loop-actions" data-playback-control-loop-actions data-loop-action-mount="${owner}" data-loop-action-owner="${owner}"></span>
        </span>
      `;
    }
    const owner = escapePlaybackControlAttribute(ownerId);
    const id = escapePlaybackControlAttribute(loopId);
    const renderLoopActions = typeof buildLoopEditActionControl === 'function'
      ? buildLoopEditActionControl
      : scope?.buildLoopEditActionControl;
    if (typeof renderLoopActions !== 'function') {
      throw new TypeError('PlaybackControlCluster requires the loop action renderer.');
    }
    return `
      <div class="playback-control-cluster playback-control-cluster--saved-loop loop-play-control-cluster utility-loop-play-cluster" data-playback-control-cluster data-playback-control-variant="saved-loop">
        <button class="loop-play-control-button utility-loop-play" type="button" data-playback-control-action="play-pause" data-loop-play="${id}" aria-label="Play or pause">&#9654;</button>
        <span class="loop-play-control-actions utility-loop-actions" data-playback-control-loop-actions>
          ${renderLoopActions({ ownerId: owner, enterLabel: 'Create another loop', createLabel: 'Create loop', cancelLabel: 'Cancel loop creation' })}
        </span>
      </div>
    `;
  }

  function getPlaybackControlClusterElements(root) {
    return {
      previous: root?.querySelector?.('[data-playback-control-action="previous"]') || null,
      playPause: root?.querySelector?.('[data-playback-control-action="play-pause"]') || null,
      next: root?.querySelector?.('[data-playback-control-action="next"]') || null,
      loopActions: root?.querySelector?.('[data-playback-control-loop-actions]') || null,
    };
  }

  const api = { getPlaybackControlClusterElements, renderPlaybackControlCluster };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) Object.assign(scope, api);
})(typeof window !== 'undefined' ? window : globalThis);
