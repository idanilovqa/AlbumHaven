function normalizeAlbumDetailsLayout(value) {
  const layout = String(value || '').trim().toLowerCase();
  return ['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(layout)
    ? layout
    : 'classic_bar';
}

function buildAlbumDetailsHeaderHtml(config = {}) {
  const layout = normalizeAlbumDetailsLayout(config.layout);
  const variant = config.variant === 'copy' ? 'copy' : 'album';
  const titleId = escapeHtml(config.titleId || 'track-modal-title');
  const subtitleId = escapeHtml(config.subtitleId || 'track-modal-subtitle');
  const actionHtml = String(config.actionsHtml || '');
  const qualityAlertHtml = config.poorArtQuality === true
    ? buildSmallAlertHtml({
      severity: 'warning',
      message: 'Poor art quality',
      className: 'album-details-header__quality-alert',
      focusable: true,
    })
    : '';
  if (variant === 'copy') {
    const title = escapeHtml(config.title || '');
    const subtitle = escapeHtml(config.subtitle || '');
    const eyebrow = escapeHtml(config.eyebrow || '');
    return `<header class="album-details-header" data-album-details-layout="classic_bar" data-album-details-variant="copy"><div class="album-details-header__identity"><div class="album-details-header__copy">${eyebrow ? `<div class="album-details-header__eyebrow">${eyebrow}</div>` : ''}<div class="album-details-header__primary-row"><h3 class="album-details-header__primary" id="${titleId}">${title}</h3>${qualityAlertHtml}</div><div class="album-details-header__secondary" id="${subtitleId}">${subtitle}</div></div></div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}</header>`;
  }
  const artist = escapeHtml(config.artist || '');
  const album = escapeHtml(config.album || 'Album');
  const year = escapeHtml(config.year || '');
  const releaseType = escapeHtml(config.releaseType || 'ALBUM');
  const tags = Array.isArray(config.tags) ? config.tags.filter(Boolean) : [];
  const tagParts = tags.map((tag) => {
    const label = String(tag).trim();
    const missingClass = label.toLowerCase() === 'missing' ? ' album-details-header__tag--missing' : '';
    return `<span class="album-details-header__tag${missingClass}">${escapeHtml(label)}</span>`;
  });
  const sourceMarkersHtml = String(config.sourceMarkersHtml || '');
  const tagHtml = sourceMarkersHtml + tagParts.join('');
  const compactIdentity = [artist, album, year].filter(Boolean).join(' <span aria-hidden="true">•</span> ');
  const stackedPrimary = [artist, album].filter(Boolean).join(' <span aria-hidden="true">•</span> ');
  const secondaryValues = layout === 'editorial_canvas'
    ? [{ value: artist }, { value: year }, { value: releaseType, releaseType: true }]
    : [{ value: year }, { value: releaseType, releaseType: true }];
  const secondaryParts = secondaryValues
    .filter((part) => part.value)
    .map((part) => `<span${part.releaseType ? ' class="album-details-header__release-type"' : ''}>${part.value}</span>`);
  const secondaryHtml = [...secondaryParts, sourceMarkersHtml, ...tagParts].join('');
  const primary = layout === 'classic_bar' ? compactIdentity : (layout === 'editorial_canvas' ? album : stackedPrimary);
  return `<header class="album-details-header" data-album-details-layout="${layout}"><div class="album-details-header__identity"><div class="album-details-header__primary-row"><h3 class="album-details-header__primary" id="${titleId}">${primary}</h3>${qualityAlertHtml}</div>${layout === 'classic_bar' ? `<div class="album-details-header__tags">${releaseType ? `<span class="album-details-header__release-type">${releaseType}</span>` : ''}${tagHtml}</div>` : `<div class="album-details-header__secondary" id="${subtitleId}">${secondaryHtml}</div>`}</div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}${layout === 'classic_bar' ? `<div class="track-modal-subtitle" id="${subtitleId}"></div>` : ''}</header>`;
}

function buildAlbumDetailsHeaderActionsHtml(config = {}) {
  const missing = Boolean(config.missing);
  const editLabel = missing ? 'Edit album tags unavailable while album is missing' : 'Edit album tags';
  const folderLabel = missing ? 'Open album folder unavailable while album is missing' : 'Open album in File Explorer';
  const editAttributes = { id: 'track-modal-edit-tags' };
  const folderAttributes = { id: 'track-modal-folder' };
  if (!missing) {
    editAttributes['data-open-track-modal-editor'] = '1';
    folderAttributes['data-open-track-modal-folder'] = '1';
  }
  return [
    ButtonComponent.renderActionButton({
      presentation: 'bare',
      ariaLabel: editLabel,
      title: editLabel,
      disabled: missing,
      className: 'track-modal-edit-tags album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
      attributes: editAttributes,
    }),
    ButtonComponent.renderActionButton({
      presentation: 'bare',
      ariaLabel: folderLabel,
      title: folderLabel,
      disabled: missing,
      className: 'track-modal-folder album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--folder',
      attributes: folderAttributes,
    }),
    ButtonComponent.renderActionButton({
      presentation: 'bare',
      ariaLabel: 'Close tracklist',
      className: 'track-modal-close album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--close',
      attributes: { id: 'track-modal-close', 'data-close-track-modal': '1' },
    }),
  ].join('');
}

function buildLooseTracksHeaderActionsHtml() {
  return [
    ButtonComponent.renderActionButton({
      presentation: 'bare',
      ariaLabel: 'Edit tags',
      title: 'Edit tags',
      className: 'track-modal-edit-tags album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
      attributes: { id: 'non-album-modal-edit-tags', 'data-open-non-album-tag-editor': '1' },
    }),
    ButtonComponent.renderActionButton({
      presentation: 'bare',
      ariaLabel: 'Close loose tracks',
      className: 'album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--close',
      attributes: { id: 'non-album-modal-close', 'data-close-non-album-modal': '1' },
    }),
  ].join('');
}

const MISSING_ALBUM_REASON_TEXT = {
  deleted: 'The files of this album were deleted from disk.',
  unreachable: 'The drive or network share holding this album cannot be reached. It returns on its own once the drive is reachable again.',
};

function buildMissingAlbumDetailsHtml(config = {}) {
  const rescanButton = config.canRemove
    ? ButtonComponent.renderButton({ label: 'Re-scan', size: 'small', attributes: { 'data-rescan-missing-album': '1', 'data-album-key': config.albumKey || '' } })
    : '';
  const removeButton = config.canRemove
    ? ButtonComponent.renderButton({ label: 'Remove from library', variant: 'primary', size: 'small', className: 'on-page-alert__remove', attributes: { 'data-remove-missing-album': '1', 'data-album-key': config.albumKey || '' } })
    : '';
  const keepButton = ButtonComponent.renderButton({ label: 'Keep as missing', size: 'small', attributes: { 'data-close-track-modal': '1' } });
  const reason = MISSING_ALBUM_REASON_TEXT[config.reason] || 'This album cannot be found under the current libraries.';
  const message = config.canRemove
    ? `${reason} Its library entry is still saved.`
    : `${reason} Ask an owner or administrator to remove it.`;
  return buildOnPageAlertHtml({
    severity: 'error',
    title: 'Album details unavailable',
    message,
    actionsHtml: `${rescanButton}${removeButton}${keepButton}`,
  });
}

/* Inline album metadata and the pinned Gallery Bar never own visible identity
   simultaneously. A taller wrapped identity must finish scrolling out too. */
function resolveMobileAlbumHeaderState({ albumPage, hasInlineIdentity, hasCover,
  viewportTop, coverBottom, identityBottom } = {}) {
  const bodyOwnsIdentity = Boolean(albumPage && hasInlineIdentity
    && (!Number.isFinite(identityBottom) || identityBottom > viewportTop + 1
      || (hasCover && Number.isFinite(coverBottom) && coverBottom > viewportTop + 1)));
  return {
    bodyOwnsIdentity,
    showCover: Boolean(albumPage && hasCover && !bodyOwnsIdentity
      && Number.isFinite(coverBottom) && coverBottom <= viewportTop + 1),
  };
}

/* Both approved small layouts reuse the live artwork, actions and track table.
   Relocate the existing action nodes, rather than duplicating their state/handlers. */
function syncMobileAlbumComposition(album) {
  const overlay = document.getElementById('track-modal');
  const cover = document.getElementById('track-modal-cover');
  const body = cover?.closest('.track-modal-body');
  if (!overlay || !cover || !body || !album) return;
  const mobile = overlay.classList.contains('is-mobile-page') && usesMobilePageLayout();
  const layout = normalizeAlbumDetailsLayout(document.documentElement.getAttribute('data-album-details-layout'));
  const inline = mobile && layout !== 'classic_bar';
  overlay.dataset.mobileAlbumLayout = mobile ? layout : '';
  let overview = body.querySelector('.mobile-album-overview');
  let identity = body.querySelector('.mobile-album-identity');
  let rail = overview?.querySelector(':scope > .mobile-album-overview__rail');
  const mobileHeader = document.getElementById('mobile-page-header');
  const freshSourceMarkers = overlay.querySelector('.album-details-header .album-details-cover-source-markers');
  const retainedSourceMarkers = overview?.querySelector('.album-details-cover-source-markers')
    || mobileHeader?.querySelector('.album-details-cover-source-markers');
  if (freshSourceMarkers && retainedSourceMarkers && freshSourceMarkers !== retainedSourceMarkers) {
    retainedSourceMarkers.remove();
  }
  const sourceMarkers = freshSourceMarkers || retainedSourceMarkers;
  if (inline && !overview) {
    overview = document.createElement('div');
    overview.className = 'mobile-album-overview';
    cover.before(overview);
    overview.appendChild(cover);
  }
  if (inline && !rail) {
    rail = document.createElement('div');
    rail.className = 'mobile-album-overview__rail';
    overview.prepend(rail);
  }
  if (inline && !identity) {
    identity = document.createElement('div');
    identity.className = 'mobile-album-identity';
  }
  // Classic/desktop keeps the copy outside its retired overview; reattach on return.
  if (inline && identity.parentElement !== overview) overview.appendChild(identity);
  if (sourceMarkers) {
    if (mobile && mobileHeader) mobileHeader.querySelector('.gallery-bar__context').appendChild(sourceMarkers);
    else overlay.querySelector('.album-details-header__release-type')?.after(sourceMarkers);
  }
  if (identity) {
    identity.hidden = !inline;
    if (inline) {
      const centered = layout === 'editorial_canvas';
      const artist = album.album_artist || album.artist || '';
      identity.innerHTML = buildAlbumDetailsHeaderHtml({
        variant: 'copy', titleId: 'mobile-album-identity-title', subtitleId: 'mobile-album-identity-summary',
        title: album.display_name || album.name || 'Album',
        eyebrow: centered ? [artist, album.display_year || album.year].filter(Boolean).join(' • ') : artist,
        subtitle: centered ? '' : [album.display_year || album.year, album.total_duration_display].filter(Boolean).join(' • '),
        poorArtQuality: album.poor_art_quality === true,
      });
      // B has exactly two visible lines. Keep the shared header builder unchanged.
      identity.querySelector('.album-details-header__secondary').hidden = centered;
      if (sourceMarkers) identity.querySelector('.album-details-header__copy').appendChild(sourceMarkers);
    }
  }
  const freshActions = cover.querySelector('.album-artbox__overlay');
  const previousActions = overview?.querySelector('.mobile-album-actions');
  if (inline) {
    // A cover refresh creates a new overlay; retire the old, relocated one.
    if (freshActions && previousActions && freshActions !== previousActions) previousActions.remove();
    const actions = freshActions || previousActions;
    if (String(album.inventory_status || '').toLowerCase() === 'missing') actions?.remove();
    else if (actions) {
      actions.classList.add('mobile-album-actions');
      overview.appendChild(actions);
    }
  } else if (overview) {
    const actions = freshActions || previousActions;
    if (freshActions && previousActions && freshActions !== previousActions) previousActions.remove();
    if (actions) {
      actions.classList.remove('mobile-album-actions');
      cover.querySelector('.album-artbox')?.appendChild(actions);
    }
    // The one Back control returns to its shared bar when leaving the inline layout.
    const back = overview.querySelector('#mobile-back-button');
    if (back) document.getElementById('mobile-page-header')?.prepend(back);
    overview.before(cover);
    if (identity) overview.before(identity);
    overview.remove();
  }
  if (mobile) {
    const descriptor = mobilePageState.pages.find(page => page.kind === 'album');
    if (descriptor) Object.assign(descriptor, mobilePageDescriptor('album', album));
    syncMobilePageShell();
  }
}
