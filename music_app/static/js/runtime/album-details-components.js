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
  if (variant === 'copy') {
    const title = escapeHtml(config.title || '');
    const subtitle = escapeHtml(config.subtitle || '');
    return `<header class="album-details-header" data-album-details-layout="classic_bar" data-album-details-variant="copy"><div class="album-details-header__identity"><div class="album-details-header__copy"><h3 class="album-details-header__primary" id="${titleId}">${title}</h3><div class="album-details-header__secondary" id="${subtitleId}">${subtitle}</div></div></div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}</header>`;
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
  return `<header class="album-details-header" data-album-details-layout="${layout}"><div class="album-details-header__identity"><h3 class="album-details-header__primary" id="${titleId}">${primary}</h3>${layout === 'classic_bar' ? `<div class="album-details-header__tags">${releaseType ? `<span class="album-details-header__release-type">${releaseType}</span>` : ''}${tagHtml}</div>` : `<div class="album-details-header__secondary" id="${subtitleId}">${secondaryHtml}</div>`}</div>${actionHtml ? `<div class="album-details-header__actions">${actionHtml}</div>` : ''}${layout === 'classic_bar' ? `<div class="track-modal-subtitle" id="${subtitleId}"></div>` : ''}</header>`;
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
