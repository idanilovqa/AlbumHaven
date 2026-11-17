function normalizeAlbumDetailsLayout(value) {
  const layout = String(value || '').trim().toLowerCase();
  return ['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(layout)
    ? layout
    : 'classic_bar';
}

// The MusicBrainz artist an album certainly belongs to replaces a tag that names someone
// else. Display only: the tag itself changes only through an approved tag edit.
function albumIdentityArtist(album) {
  const tagged = album?.album_artist || album?.artist || '';
  const identity = album?.musicbrainz_artist;
  return identity?.tag_differs && identity.canonical_name ? identity.canonical_name : tagged;
}

// An applied MusicBrainz data correction (S4) shows in place of the album artist tag.
function albumDisplayArtist(album) {
  return album?.display_artist || albumIdentityArtist(album);
}

function albumTaggedArtistNote(album) {
  const tagged = album?.album_artist || album?.artist || '';
  if (albumIdentityArtist(album) !== tagged && tagged) return `Tagged as ${tagged}`;
  // A name shared by several MusicBrainz artists (Amarok): say which one this album is.
  const identity = album?.musicbrainz_artist;
  return identity?.split && identity.canonical_name
    ? `MusicBrainz: ${[identity.canonical_name, identity.disambiguation ? `(${identity.disambiguation})` : ''].filter(Boolean).join(' ')}`
    : '';
}

// The romanized form of the album's original-script artist name (J3), or empty.
function albumDetailsRomanizedArtist(album) {
  return typeof romanizedArtistName === 'function' ? romanizedArtistName(albumDisplayArtist(album)) : '';
}

// J3 (owner 2026-11-15): hover text on desktop; on phones its own line, shown by mobile-layout.css.
function buildAlbumDetailsRomanizedArtistHtml(romanized) {
  const latin = String(romanized || '').trim();
  return latin ? `<div class="album-details-header__romanized">(${escapeHtml(latin)})</div>` : '';
}

// MusicBrainz's release type ("Live", "EP • Live"; owner 2026-11-15) wins over the local tag.
function albumDetailsReleaseType(album) {
  return album?.musicbrainz_release?.type_label || album?.release_type || 'ALBUM';
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
    return `<header class="album-details-header" data-album-details-layout="classic_bar" data-album-details-variant="copy"><div class="album-details-header__identity"><div class="album-details-header__copy">${eyebrow ? `<div class="album-details-header__eyebrow">${eyebrow}</div>${buildAlbumDetailsRomanizedArtistHtml(config.eyebrowRomanized)}` : ''}<div class="album-details-header__primary-row"><h3 class="album-details-header__primary" id="${titleId}">${title}</h3>${qualityAlertHtml}</div><div class="album-details-header__secondary" id="${subtitleId}">${subtitle}</div></div></div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}</header>`;
  }
  const artistRomanized = String(config.artistRomanized || '').trim();
  const artist = artistRomanized && config.artist
    ? `<span title="${escapeHtml(artistRomanized)}">${escapeHtml(config.artist)}</span>`
    : escapeHtml(config.artist || '');
  // Owner 2026-11-15 (I): "Title (a.k.a. Other title)", dimmed, after the title and before the year.
  const alternatives = Array.isArray(config.alternativeTitles) ? config.alternativeTitles.filter(Boolean) : [];
  const album = `${escapeHtml(config.album || 'Album')}${alternatives.length
    ? ` <span class="album-details-header__aka">(a.k.a. ${escapeHtml(alternatives.join(', '))})</span>` : ''}`;
  const year = escapeHtml(config.year || '');
  const releaseType = escapeHtml(config.releaseType || 'ALBUM');
  const tags = Array.isArray(config.tags) ? config.tags.filter(Boolean) : [];
  const tagParts = tags.map((tag) => {
    const label = String(tag).trim();
    const missingClass = label.toLowerCase() === 'missing' ? ' album-details-header__tag--missing' : '';
    return `<span class="album-details-header__tag${missingClass}">${escapeHtml(label)}</span>`;
  });
  const tagHtml = tagParts.join('');
  const compactIdentity = [artist, album, year].filter(Boolean).join(' <span aria-hidden="true">•</span> ');
  const stackedPrimary = [artist, album].filter(Boolean).join(' <span aria-hidden="true">•</span> ');
  const secondaryValues = layout === 'editorial_canvas'
    ? [{ value: artist }, { value: year }, { value: releaseType, releaseType: true }]
    : [{ value: year }, { value: releaseType, releaseType: true }];
  const secondaryParts = secondaryValues
    .filter((part) => part.value)
    .map((part) => `<span${part.releaseType ? ' class="album-details-header__release-type"' : ''}>${part.value}</span>`);
  const secondaryHtml = [...secondaryParts, ...tagParts].join('<span aria-hidden="true">•</span>');
  const primary = layout === 'classic_bar' ? compactIdentity : (layout === 'editorial_canvas' ? album : stackedPrimary);
  return `<header class="album-details-header" data-album-details-layout="${layout}"><div class="album-details-header__identity"><div class="album-details-header__primary-row"><h3 class="album-details-header__primary" id="${titleId}">${primary}</h3>${qualityAlertHtml}</div>${buildAlbumDetailsRomanizedArtistHtml(artistRomanized)}${layout === 'classic_bar' ? `<div class="album-details-header__tags">${releaseType ? `<span class="album-details-header__release-type">${releaseType}</span>` : ''}${tagHtml}</div>` : `<div class="album-details-header__secondary" id="${subtitleId}">${secondaryHtml}</div>`}</div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}${layout === 'classic_bar' ? `<div class="track-modal-subtitle" id="${subtitleId}"></div>` : ''}</header>`;
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
      ariaLabel: editLabel,
      title: editLabel,
      disabled: missing,
      className: 'track-modal-edit-tags album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
      attributes: editAttributes,
    }),
    ButtonComponent.renderActionButton({
      ariaLabel: folderLabel,
      title: folderLabel,
      disabled: missing,
      className: 'track-modal-folder album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--folder',
      attributes: folderAttributes,
    }),
    ButtonComponent.renderActionButton({
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
      ariaLabel: 'Edit tags',
      title: 'Edit tags',
      className: 'track-modal-edit-tags album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
      attributes: { id: 'non-album-modal-edit-tags', 'data-open-non-album-tag-editor': '1' },
    }),
    ButtonComponent.renderActionButton({
      ariaLabel: 'Close loose tracks',
      className: 'album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--close',
      attributes: { id: 'non-album-modal-close', 'data-close-non-album-modal': '1' },
    }),
  ].join('');
}

function buildMissingAlbumDetailsHtml(config = {}) {
  const albumKey = escapeHtml(config.albumKey || '');
  const removeButton = config.canRemove
    ? `<button class="button ui-button ui-button--primary ui-button--medium on-page-alert__remove" type="button" data-remove-missing-album="1" data-album-key="${albumKey}"><span class="ui-button__content">Remove from library</span></button>`
    : '';
  const keepButton = '<button class="button ui-button ui-button--secondary ui-button--medium" type="button" data-close-track-modal="1"><span class="ui-button__content">Keep as missing</span></button>';
  const message = config.canRemove
    ? 'This album cannot be found under the current libraries. Its library entry is still saved.'
    : 'This album cannot be found under the current libraries. Ask an owner or administrator to remove it.';
  return buildOnPageAlertHtml({
    severity: 'error',
    title: 'Album details unavailable',
    message,
    actionsHtml: `${removeButton}${keepButton}`,
  });
}

// The MusicBrainz series the album is part of: a Series line for real series and a Featured
// In line for the lists, awards and collections that name the album (owner 2026-11-15).
// Each shows only when it has an entry; every name is a link to that series' gallery.
// Web: one line, "Series: <name>" (owner 2026-11-15). Several names are comma-separated and,
// when they do not fit, wrap left-aligned under the first name (owner 2026-11-16). Phone
// (approved 4A): the label above its names.
function buildAlbumDetailsSeriesHtml(album, { inline = false } = {}) {
  const series = Array.isArray(album?.musicbrainz_series) ? album.musicbrainz_series.filter((item) => item?.mbid) : [];
  return [['series', 'Series'], ['featured_in', 'Featured In']].map(([kind, label]) => {
    const links = series.filter((item) => (item.kind === 'featured_in' ? 'featured_in' : 'series') === kind)
      .map((item) => `<button type="button" class="album-open-trigger album-title-button album-details-series__link" title="Show all albums in this series" data-open-series="${escapeHtml(item.mbid)}">${escapeHtml(item.name || '')}</button>`);
    if (!links.length) return '';
    return inline
      ? `<div class="album-details-series album-details-series--inline" data-album-details-series="${kind}"><span class="album-details-series__label">${label}:</span><span class="album-details-series__names">${links.join(', ')}</span></div>`
      : `<div class="album-details-series" data-album-details-series="${kind}"><div class="section-split-label">${label}</div>${links.join('')}</div>`;
  }).join('');
}

// Web: under the cover. Phone: below the track table; the header never grows.
function syncAlbumDetailsSeries(album, { cover, list, mobile } = {}) {
  document.querySelectorAll('#track-modal [data-album-details-series]').forEach((block) => block.remove());
  const html = buildAlbumDetailsSeriesHtml(album, { inline: !mobile });
  if (!html) return;
  if (mobile) list?.insertAdjacentHTML('afterend', html);
  else cover?.insertAdjacentHTML('beforeend', html);
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
  const freshSourceMarkers = cover.querySelector(':scope > .album-details-cover-source-markers');
  const retainedSourceMarkers = overview?.querySelector('.album-details-cover-source-markers')
    || mobileHeader?.querySelector(':scope > .album-details-cover-source-markers');
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
    if (inline && rail) rail.appendChild(sourceMarkers);
    else if (mobile && mobileHeader) mobileHeader.appendChild(sourceMarkers);
    else cover.appendChild(sourceMarkers);
  }
  if (identity) {
    identity.hidden = !inline;
    if (inline) {
      const centered = layout === 'editorial_canvas';
      const artist = albumDisplayArtist(album);
      identity.innerHTML = buildAlbumDetailsHeaderHtml({
        variant: 'copy', titleId: 'mobile-album-identity-title', subtitleId: 'mobile-album-identity-summary',
        title: album.display_title || album.display_name || album.name || 'Album',
        eyebrow: centered ? [artist, album.display_year || album.year].filter(Boolean).join(' • ') : artist,
        eyebrowRomanized: albumDetailsRomanizedArtist(album),
        subtitle: centered ? '' : [album.display_year || album.year, album.total_duration_display].filter(Boolean).join(' • '),
        poorArtQuality: album.poor_art_quality === true,
      });
      // B has exactly two visible lines. Keep the shared header builder unchanged.
      identity.querySelector('.album-details-header__secondary').hidden = centered;
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
  // Here rather than at render time: album details render before the phone page is presented,
  // and this also runs after presentation and on every breakpoint change (approved 1B / 4A).
  syncAlbumDetailsSeries(album, { cover, list: document.getElementById('track-modal-list'), mobile });
  if (mobile) {
    const descriptor = mobilePageState.pages.find(page => page.kind === 'album');
    if (descriptor) Object.assign(descriptor, mobilePageDescriptor('album', album));
    syncMobilePageShell();
  }
}
