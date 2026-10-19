(function (scope) {
  'use strict';

  const PLAYBACK_CONTROL_VARIANTS = new Set(['expanded-player', 'compact-player', 'saved-loop', 'collection-play']);

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

  function renderPlaybackControlCluster({
    variant, ownerId = '', loopId = '',
    loopControlStyle = scope.AlbumHavenAppearance?.instance?.getSavedLoopControlStyle?.() || 'capsule',
    resourceKind = '', disabled = false, showOptions = true, modeBadge = '', modeLabel = '',
  } = {}) {
    if (!PLAYBACK_CONTROL_VARIANTS.has(variant)) {
      throw new TypeError('Unknown PlaybackControlCluster variant.');
    }
    const style = loopControlStyle === 'companion' ? 'companion' : 'capsule';
    if (variant === 'collection-play') {
      if (resourceKind !== 'album_top') return '';
      const renderLoopActions = typeof buildLoopEditActionControl === 'function'
        ? buildLoopEditActionControl
        : scope?.buildLoopEditActionControl;
      if (typeof renderLoopActions !== 'function' || typeof scope.ButtonComponent?.renderIconSvg !== 'function') {
        throw new TypeError('PlaybackControlCluster requires the native action and icon renderers.');
      }
      const label = escapePlaybackControlAttribute(modeLabel ? `Play Top from the beginning: ${modeLabel}` : 'Play Top from the beginning');
      return `
        <span class="playback-control-cluster playback-control-cluster--collection loop-play-control-cluster collection-play-cluster" data-playback-control-cluster data-playback-control-variant="collection-play" data-collection-resource-kind="album_top" data-loop-control-style="capsule">
          <button class="loop-play-control-button collection-play" type="button" data-playback-control-action="play" aria-label="${label}"${disabled ? ' disabled aria-disabled="true"' : ''}>${scope.ButtonComponent.renderIconSvg('play', { className: 'player-transport-icon' })}${modeBadge ? `<span class="collection-play-mode-badge" data-playback-mode-badge aria-hidden="true">${escapePlaybackControlAttribute(modeBadge)}</span>` : ''}</button>
          <span class="loop-play-control-actions collection-play-actions" data-playback-control-loop-actions>
            ${showOptions ? renderLoopActions({ ownerId, enterLabel: 'Top playback options', presentation: 'options' }) : ''}
          </span>
        </span>
      `;
    }
    if (variant === 'compact-player') {
      return `
        <div class="playback-control-cluster playback-control-cluster--compact compact-player-transport" data-playback-control-cluster data-playback-control-variant="compact-player">
          <button class="compact-player-skip" type="button" data-playback-control-action="previous" data-compact-player-previous aria-label="Previous track">${renderPreviousIcon()}</button>
          <button class="compact-player-play" type="button" data-playback-control-action="play-pause" data-compact-player-play aria-label="Play"><svg class="compact-player-play-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l12-7z"></path></svg></button>
          <button class="compact-player-skip" type="button" data-playback-control-action="next" data-compact-player-next aria-label="Next track">${renderNextIcon()}</button>
        </div>
      `;
    }
    if (variant === 'expanded-player') {
      const owner = escapePlaybackControlAttribute(ownerId || 'global-player');
      return `
        <span class="playback-control-cluster playback-control-cluster--expanded loop-play-control-cluster player-play-cluster" data-playback-control-cluster data-playback-control-variant="expanded-player" data-loop-control-style="${style}">
          <button class="loop-play-control-button player-play" type="button" id="player-play" data-playback-control-action="play-pause" aria-label="Play or pause"><svg class="ui-icon player-transport-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6.4v11.2l9-5.6-9-5.6Z"/></svg></button>
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
      <div class="playback-control-cluster playback-control-cluster--saved-loop loop-play-control-cluster utility-loop-play-cluster" data-playback-control-cluster data-playback-control-variant="saved-loop" data-loop-control-style="${style}">
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
      play: root?.querySelector?.('[data-playback-control-action="play"]') || null,
      next: root?.querySelector?.('[data-playback-control-action="next"]') || null,
      loopActions: root?.querySelector?.('[data-playback-control-loop-actions]') || null,
      actionRoot: root?.querySelector?.('.loop-edit-actions[data-loop-action-owner]') || null,
      optionsTrigger: root?.querySelector?.('[data-playback-control-action="options"]') || null,
      modeBadge: root?.querySelector?.('[data-playback-mode-badge]') || null,
    };
  }

  const api = { getPlaybackControlClusterElements, renderPlaybackControlCluster };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) Object.assign(scope, api);
})(typeof window !== 'undefined' ? window : globalThis);
