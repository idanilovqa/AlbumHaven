function normalizeAlbumDetailsLayout(value) {
  const layout = String(value || '').trim().toLowerCase();
  return ['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(layout)
    ? layout
    : 'classic_bar';
}

// The MusicBrainz artist an album certainly belongs to replaces a tag that names someone
// else. Display only: the tag itself changes only through an approved tag edit.
function albumDisplayArtist(album) {
  const tagged = album?.album_artist || album?.artist || '';
  const identity = album?.musicbrainz_artist;
  return identity?.tag_differs && identity.canonical_name ? identity.canonical_name : tagged;
}

function albumTaggedArtistNote(album) {
  const tagged = album?.album_artist || album?.artist || '';
  if (albumDisplayArtist(album) !== tagged && tagged) return `Tagged as ${tagged}`;
  // A name shared by several MusicBrainz artists (Amarok): say which one this album is.
  const identity = album?.musicbrainz_artist;
  return identity?.split && identity.canonical_name
    ? `MusicBrainz: ${[identity.canonical_name, identity.disambiguation ? `(${identity.disambiguation})` : ''].filter(Boolean).join(' ')}`
    : '';
}

function resolveAlbumDetailsCoverSlots(album) {
  if (album?.selected_covers_loaded !== true || !Array.isArray(album.selected_covers)) return [];
  return album.selected_covers.slice(0, 3).map((slot) => ({
    selectionId: String(slot?.selectionId || slot?.selection_id || ''),
    // A downloaded local cover's provider, for its badge (owner 2026-11-17).
    ...(slot?.kind ? { kind: String(slot.kind) } : {}),
    ...(slot?.source ? { source: String(slot.source) } : {}),
    imageUrl: String(slot?.imageUrl || slot?.image_url || ''),
    unavailable: slot?.unavailable === true || !String(slot?.imageUrl || slot?.image_url || ''),
  })).filter((slot) => slot.selectionId);
}

// The rear-cover preview Album Details shows; the gallery preloads the same URL (owner 2026-11-16).
function albumDetailsCoverPreviewUrl(slot) {
  const url = String(slot?.imageUrl || '');
  return url ? `${url}${url.includes('?') ? '&' : '?'}size=480` : '';
}

function buildAlbumDetailsCoverStackHtml(config = {}) {
  const frontHtml = String(config.frontHtml || '');
  const slots = resolveAlbumDetailsCoverSlots({
    selected_covers_loaded: true,
    selected_covers: Array.isArray(config.slots) ? config.slots : [],
  });
  if (slots.length < 2) return frontHtml;
  const canBrowse = slots.filter((slot) => !slot.unavailable).length > 1;
  const activeIndex = Math.min(
    slots.length - 1,
    Math.max(0, Number.isInteger(config.activeIndex) ? config.activeIndex : 0),
  );
  const albumName = String(config.albumName || 'Album');
  const rearHtml = slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ index }) => index !== activeIndex)
    .map(({ slot, index }, rearIndex) => {
    const positionClass = rearIndex === 0 ? 'is-top' : 'is-bottom';
    const label = `Show cover ${index + 1} of ${slots.length} for ${albumName}`;
    if (slot.unavailable) {
      return `<span class="album-details-cover-stack__rear ${positionClass} is-unavailable" data-album-details-cover-index="${index}" role="img" aria-label="${escapeHtml(label)} unavailable"></span>`;
    }
    const previewUrl = albumDetailsCoverPreviewUrl(slot);
    return `<button class="album-details-cover-stack__rear ${positionClass}" type="button" data-album-details-cover-index="${index}" aria-label="${escapeHtml(label)}"><img src="${escapeHtml(previewUrl)}" alt="" loading="lazy" decoding="async"></button>`;
  }).join('');
  const previous = canBrowse ? ButtonComponent.renderActionButton({
    icon: 'previous',
    ariaLabel: 'Show previous selected cover',
    className: 'album-details-cover-nav album-details-cover-nav--previous',
    shape: 'round',
    presentation: 'bare',
    attributes: { 'data-album-details-cover-step': '-1' },
  }) : '';
  const next = canBrowse ? ButtonComponent.renderActionButton({
    icon: 'next',
    ariaLabel: 'Show next selected cover',
    className: 'album-details-cover-nav album-details-cover-nav--next',
    shape: 'round',
    presentation: 'bare',
    attributes: { 'data-album-details-cover-step': '1' },
  }) : '';
  return `<div class="album-details-cover-stack" data-album-details-cover-count="${slots.length}" data-album-details-cover-active-index="${activeIndex}"><div class="album-details-cover-stack__rear-layer">${rearHtml}</div><div class="album-details-cover-stack__front">${frontHtml}</div><div class="album-details-cover-stack__navigation">${previous}${next}</div></div>`;
}

function bindAlbumDetailsCoverStackPointer(stack) {
  if (!stack?.addEventListener || stack.dataset?.pointerTrackingBound === '1') return;
  if (!stack.dataset) stack.dataset = {};
  stack.dataset.pointerTrackingBound = '1';
  const clear = () => {
    stack.style.removeProperty('--album-cover-pointer-x');
    stack.style.removeProperty('--album-cover-pointer-y');
    stack.style.removeProperty('--album-cover-pointer-rotation');
  };
  stack.addEventListener('pointermove', (event) => {
    const bounds = stack.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
    const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
    stack.style.setProperty('--album-cover-pointer-x', `${(x * 2).toFixed(3)}px`);
    stack.style.setProperty('--album-cover-pointer-y', `${(y * 2).toFixed(3)}px`);
    stack.style.setProperty('--album-cover-pointer-rotation', `${(x * 0.6).toFixed(3)}deg`);
  });
  // Owner 2026-11-16: quick clicks on the arrows or rear covers are double clicks that selected the table's "#"
  // header, and a mouse-focused arrow flashed a ring when it lost focus. A mouse press neither starts a text
  // selection nor moves focus; the click still browses, and keyboard focus is unchanged.
  stack.addEventListener('mousedown', (event) => {
    if (event.button === 0 && event.target?.closest?.('[data-album-details-cover-step], [data-album-details-cover-index]')) {
      event.preventDefault();
    }
  });
  stack.addEventListener('pointerup', clear);
  stack.addEventListener('pointerleave', clear);
  stack.addEventListener('pointercancel', clear);
}

const ALBUM_DETAILS_COVER_REAR_POSES = {
  'is-top': 'translate(-8px, -8px) rotate(-1.8deg)',
  'is-bottom': 'translate(8px, 8px) rotate(1.8deg)',
};

function albumDetailsCoverRearPose(stack, index) {
  const rear = stack?.querySelector?.(`.album-details-cover-stack__rear[data-album-details-cover-index="${index}"]`);
  return rear?.classList?.contains('is-bottom') ? 'is-bottom' : (rear ? 'is-top' : '');
}

// What the stack looks like before a cover switch re-renders it: the shuffle animates from here.
function captureAlbumDetailsCoverStack(stack) {
  const front = stack?.querySelector?.('.album-details-cover-stack__front');
  if (!front) return null;
  const poses = {};
  const rearImages = {};
  stack.querySelectorAll('.album-details-cover-stack__rear').forEach((rear) => {
    const index = rear.getAttribute('data-album-details-cover-index');
    poses[index] = albumDetailsCoverRearPose(stack, index);
    // The decoded rear picture stands in for the rising cover until its own image arrives (owner 2026-11-17:
    // "the cover that appears from underneath is absent").
    const image = rear.querySelector('img');
    if (image?.complete && image.naturalWidth > 0) rearImages[index] = image;
  });
  return {
    front: front.cloneNode(true),
    activeIndex: Number(stack.getAttribute('data-album-details-cover-active-index')),
    poses,
    rearImages,
  };
}

// Owner pick 2026-11-17 (mock B, "Card shuffle"): the front cover slides out to the side, tucks behind the
// stack, and the next cover rises forward into its place. `direction` is 1 (next) or -1 (previous).
function animateAlbumDetailsCoverShuffle(previous, stack, direction) {
  if (!previous || !stack?.animate || typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
  const activeIndex = Number(stack.getAttribute('data-album-details-cover-active-index'));
  const front = stack.querySelector('.album-details-cover-stack__front');
  if (!front || activeIndex === previous.activeIndex) return false;
  const dir = direction < 0 ? -1 : 1;
  // 1100ms with an even ease-in-out: 900ms felt too fast (2026-11-17), 1400ms too slow (2026-11-18).
  const timing = { duration: 1100, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'backwards' };
  stack.classList.add('is-shuffling');
  // The old front cover leaves to the side and tucks in behind the stack, where its rear copy then shows.
  const ghost = previous.front;
  ghost.classList.add('album-details-cover-stack__ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  stack.append(ghost);
  const tuckedRear = stack.querySelector(`.album-details-cover-stack__rear[data-album-details-cover-index="${previous.activeIndex}"]`);
  const tuckedPose = ALBUM_DETAILS_COVER_REAR_POSES[albumDetailsCoverRearPose(stack, previous.activeIndex)] || 'none';
  if (tuckedRear) tuckedRear.style.visibility = 'hidden';
  const leaving = ghost.animate([
    { transform: 'none', zIndex: 3, filter: 'brightness(1)' },
    { transform: `translate(${dir * 70}%, -4%) rotate(${dir * 9}deg) scale(.96)`, zIndex: 3, filter: 'brightness(.95)', offset: 0.42 },
    { transform: `translate(${dir * 38}%, 2%) rotate(${dir * 5}deg) scale(.94)`, zIndex: 0, filter: 'brightness(.8)', offset: 0.55 },
    { transform: tuckedPose, zIndex: 0, filter: 'brightness(.82)' },
  ], { ...timing, fill: 'forwards' });
  const risingImage = front.querySelector('.track-modal-cover-visual img');
  const standIn = previous.rearImages?.[String(activeIndex)];
  if (standIn && risingImage && !(risingImage.complete && risingImage.naturalWidth > 0)) {
    standIn.classList.add('album-details-cover-stack__stand-in');
    standIn.setAttribute('aria-hidden', 'true');
    risingImage.parentElement?.append(standIn);
    const settle = () => standIn.remove();
    risingImage.addEventListener('load', settle, { once: true });
    risingImage.addEventListener('error', settle, { once: true });
  }
  // The next cover rises forward from the rear position it held.
  const risingPose = ALBUM_DETAILS_COVER_REAR_POSES[previous.poses[String(activeIndex)]] || 'none';
  front.animate([
    { transform: risingPose, filter: 'brightness(.82)' },
    { transform: 'translate(-3px, -3px) rotate(-.6deg) scale(.985)', offset: 0.45 },
    { transform: 'none', filter: 'brightness(1)' },
  ], timing);
  // The third cover moves to its new rear position.
  stack.querySelectorAll('.album-details-cover-stack__rear').forEach((rear) => {
    if (rear === tuckedRear) return;
    const index = rear.getAttribute('data-album-details-cover-index');
    const from = previous.poses[index];
    const to = albumDetailsCoverRearPose(stack, index);
    if (from && from !== to) {
      rear.animate([{ transform: ALBUM_DETAILS_COVER_REAR_POSES[from] }, { transform: ALBUM_DETAILS_COVER_REAR_POSES[to] }], timing);
    }
  });
  leaving.finished.catch(() => {}).finally(() => {
    ghost.remove();
    if (tuckedRear) tuckedRear.style.removeProperty('visibility');
    stack.classList.remove('is-shuffling');
  });
  return true;
}

function buildAlbumDetailsHeaderHtml(config = {}) {
  const layout = normalizeAlbumDetailsLayout(config.layout);
  const variant = config.variant === 'copy' ? 'copy' : 'album';
  const titleId = escapeHtml(config.titleId || 'track-modal-title');
  const subtitleId = escapeHtml(config.subtitleId || 'track-modal-subtitle');
  const actionHtml = String(config.actionsHtml || '');
  const leadingHtml = String(config.leadingHtml || '');
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
    return `<header class="album-details-header" data-album-details-layout="classic_bar" data-album-details-variant="copy"><div class="album-details-header__identity">${leadingHtml}<div class="album-details-header__copy">${eyebrow ? `<div class="album-details-header__eyebrow">${eyebrow}</div>` : ''}<div class="album-details-header__primary-row"><h3 class="album-details-header__primary" id="${titleId}">${title}</h3>${qualityAlertHtml}</div><div class="album-details-header__secondary" id="${subtitleId}">${subtitle}</div></div></div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}</header>`;
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

function buildLooseTracksHeaderActionsHtml(config = {}) {
  const capabilities = typeof window !== 'undefined' ? window.AlbumHavenCapabilities : null;
  const canEditTags = typeof capabilities?.allows !== 'function'
    || capabilities.allows('library.files.edit_tags');
  const editLabel = canEditTags ? 'Edit tags' : 'Edit tags unavailable for your account';
  const editAttributes = { id: 'non-album-modal-edit-tags' };
  if (canEditTags) editAttributes['data-open-non-album-tag-editor'] = '1';
  const selectionStatus = `<span class="album-details-header__selection-status" data-non-album-selection-status hidden><span class="album-details-header__selection-count" data-non-album-selection-count role="status" aria-live="polite"></span>${ButtonComponent.renderActionButton({
    ariaLabel: 'Clear track selection',
    title: 'Clear track selection',
    presentation: 'bare',
    className: 'album-details-header__selection-clear',
    iconClass: 'album-details-header__action-icon album-details-header__action-icon--close',
    attributes: { 'data-clear-non-album-track-selection': '1' },
  })}</span>`;
  return [
    selectionStatus,
    ButtonComponent.renderActionButton({
      ariaLabel: editLabel,
      title: editLabel,
      disabled: !canEditTags,
      presentation: 'bare',
      className: 'track-modal-edit-tags album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
      attributes: editAttributes,
    }),
    config.showClose === false ? '' : ButtonComponent.renderActionButton({
      ariaLabel: 'Close loose tracks',
      presentation: 'bare',
      className: 'album-details-header__action',
      iconClass: 'album-details-header__action-icon album-details-header__action-icon--close',
      attributes: { id: 'non-album-modal-close', 'data-close-non-album-modal': '1' },
    }),
  ].join('');
}

function buildLooseTracksPageHeaderHtml(config = {}) {
  return buildGalleryBarContentsHtml({
    pageHeading: true,
    leadingHtml: config.leadingHtml,
    title: config.title || 'Loose Tracks',
    titleId: 'non-album-modal-title',
    summary: config.subtitle,
    summaryId: 'non-album-modal-subtitle',
    actionsHtml: config.actionsHtml,
  });
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
  if (identity) {
    identity.hidden = !inline;
    if (inline) {
      const centered = layout === 'editorial_canvas';
      const artist = albumDisplayArtist(album);
      identity.innerHTML = buildAlbumDetailsHeaderHtml({
        variant: 'copy', titleId: 'mobile-album-identity-title', subtitleId: 'mobile-album-identity-summary',
        title: album.display_name || album.name || 'Album',
        eyebrow: centered ? [artist, album.display_year || album.year].filter(Boolean).join(' • ') : artist,
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
  if (mobile) {
    const descriptor = mobilePageState.pages.find(page => page.kind === 'album');
    if (descriptor) Object.assign(descriptor, mobilePageDescriptor('album', album));
    syncMobilePageShell();
  }
}
