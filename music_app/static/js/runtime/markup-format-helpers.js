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

// Owner 2026-11-18: a search result shows, in a neutral highlight, the characters the search matched.
// The ranges come from the server's search matcher as [start, end) code-point offsets; every part stays escaped.
function buildHighlightedTextHtml(value, ranges) {
  const text = String(value ?? '');
  if (!Array.isArray(ranges) || !ranges.length) return escapeHtml(text);
  const chars = Array.from(text);
  let html = '';
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Number(range?.[0]));
    const end = Math.min(chars.length, Number(range?.[1]));
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
    html += `${escapeHtml(chars.slice(cursor, start).join(''))}<mark class="search-match-highlight">${escapeHtml(chars.slice(start, end).join(''))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(chars.slice(cursor).join(''));
}
