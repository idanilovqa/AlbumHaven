// Parse only the displayed card metadata, preserving artist spelling and spacing.
export const VISIBLE_ALBUM_YEAR_PATTERN = '^.* · (\\d{1,4})$';

export function parseVisibleAlbumMetadata(subtitle, separateYear = null) {
  const text = String(subtitle || '').trim();
  if (separateYear !== null) return { artist: text, year: String(separateYear || '').trim() };
  const match = text.match(new RegExp(VISIBLE_ALBUM_YEAR_PATTERN));
  return match
    ? { artist: text.slice(0, text.length - match[1].length - 3), year: match[1].trim() }
    : { artist: text, year: '' };
}
