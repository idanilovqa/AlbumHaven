function buildMissingAlbumMarkHtml() {
  return `<span class="album-artbox__missing-mark" aria-hidden="true">
    <svg viewBox="0 0 96 96">
      <circle class="album-artbox__missing-disc" cx="48" cy="48" r="31"></circle>
      <circle class="album-artbox__missing-groove" cx="48" cy="48" r="23"></circle>
      <circle class="album-artbox__missing-groove" cx="48" cy="48" r="17"></circle>
      <circle class="album-artbox__missing-label" cx="48" cy="48" r="10"></circle>
      <circle class="album-artbox__missing-hub" cx="48" cy="48" r="3"></circle>
      <path class="album-artbox__missing-slash" d="M22 22 74 74"></path>
    </svg>
  </span>`;
}

function buildAlbumArtboxHtml(config = {}) {
  const requestedState = String(config.state || '').trim().toLowerCase();
  const state = ['ready', 'loading', 'empty', 'missing'].includes(requestedState)
    ? requestedState
    : 'empty';
  const label = String(config.label || 'Album artwork').trim();
  const coverHtml = String(config.coverHtml || '');
  const actionHtml = String(config.actionHtml || '');
  const content = state === 'missing' || state === 'empty'
    ? buildMissingAlbumMarkHtml()
    : (coverHtml || `<span class="album-artbox__placeholder">${state === 'loading' ? 'Loading cover art' : 'No cover art'}</span>`);
  return `<span class="album-artbox album-artbox--${state}" data-album-artbox-state="${state}" aria-label="${escapeHtml(label)}">${content}${actionHtml ? `<span class="album-artbox__action">${actionHtml}</span>` : ''}</span>`;
}
