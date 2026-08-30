function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(String(value ?? ''));
  }
  return String(value ?? '').replace(/["\\]/g, '\\$&');
}

function renderStars(rating) {
  const safeRating = Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : 0;
  let html = '';
  for (let i = 1; i <= 10; i += 1) {
    html += i <= safeRating
      ? '<span class="star filled">&#9733;</span>'
      : '<span class="star">&#9734;</span>';
  }
  return html;
}

function formatScanSummary(lastScanDisplay = '') {
  const view = state?.view || {};
  return `Found ${view.album_count} album${view.album_count === 1 ? '' : 's'} by ${view.artist_count} artist${view.artist_count === 1 ? '' : 's'} in ${escapeHtml(view.music_dir)}${view.selected_artist ? ' (family context)' : ''}<br>Last scan: ${escapeHtml(lastScanDisplay || '—')}`;
}
