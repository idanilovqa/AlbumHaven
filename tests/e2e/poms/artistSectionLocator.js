function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export function artistSectionByName(page, artistName) {
  const expectedArtist = exactNormalizedText(artistName);
  const namedSection = page.locator('#artist-groups .artist-section').filter({
    has: page.locator('.artist-name').filter({ hasText: expectedArtist }),
  });
  const singleArtistContext = page.locator(
    '[data-gallery-bar][data-gallery-context-kind="single-artist"]',
  ).filter({
    has: page.locator('[data-gallery-context-name]').filter({ hasText: expectedArtist }),
  });
  const contextualSection = page.locator('body').filter({
    has: singleArtistContext,
  }).locator('#artist-groups .artist-section').first();
  return namedSection.or(contextualSection).first();
}
