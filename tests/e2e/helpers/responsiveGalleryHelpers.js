import { expect } from '@playwright/test';

const GEOMETRY_TOLERANCE_PX = 1;

export function resolveSelectedScaleCardCeiling(baseCardWidthPx, scalePercent) {
  const baseWidth = Number(baseCardWidthPx);
  const scale = Number(scalePercent);
  if (!(baseWidth > 0) || !(scale > 0)) {
    throw new Error('A positive base card width and gallery scale are required.');
  }
  return baseWidth * (scale / 100);
}

function roundedGeometryValue(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function responsiveLayoutSignature(snapshot) {
  return JSON.stringify({
    cardWidths: snapshot.cardWidths.map(roundedGeometryValue),
    columnCount: snapshot.columnCount,
    galleryWidth: roundedGeometryValue(snapshot.galleryBounds?.width),
    ratingStarLineCount: snapshot.rating?.starLineCount,
    ratingAttached: snapshot.rating?.attached,
    viewport: snapshot.viewport,
  });
}

export async function readResponsiveGalleryLayout(galleryPage, options = {}) {
  const artistName = String(options.artistName || '').trim();
  const ratedAlbumName = String(options.ratedAlbumName || '').trim();
  if (!artistName || !ratedAlbumName) {
    throw new Error('Responsive gallery measurement requires an artist and rated album.');
  }

  const section = galleryPage.sectionByArtistHeading(artistName);
  await expect(section).toBeVisible();

  // parity-check: allow-read-only-measurement-evaluate -- responsive card and rating geometry only
  return section.evaluate((sectionElement, selectors) => {
    const normalize = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const boundsOf = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const gallery = document.querySelector(selectors.galleryScrollSelector);
    if (!(gallery instanceof HTMLElement)) {
      throw new Error('Expected the production gallery scroll surface.');
    }
    const galleryBounds = boundsOf(gallery);
    const rows = Array.from(sectionElement.querySelectorAll(selectors.albumRowSelector));
    const rowCardCounts = rows.map((row) => (
      Array.from(row.querySelectorAll(selectors.albumCardSelector))
        .filter((card) => boundsOf(card)?.width > 0)
        .length
    ));
    const cards = Array.from(sectionElement.querySelectorAll(selectors.albumCardSelector));
    const cardBounds = cards.map(boundsOf).filter(Boolean);
    const ratedCard = cards.find((card) => (
      normalize(card.querySelector(selectors.albumTitleSelector)?.textContent)
        === selectors.ratedAlbumName
    ));
    const ratingRow = ratedCard instanceof HTMLElement
      ? ratedCard.querySelector(selectors.ratingRowSelector)
      : null;
    const ratingStars = ratedCard instanceof HTMLElement
      ? ratedCard.querySelector(selectors.ratingStarsSelector)
      : null;
    const ratingText = ratedCard instanceof HTMLElement
      ? ratedCard.querySelector(selectors.ratingTextSelector)
      : null;
    const stars = ratedCard instanceof HTMLElement
      ? Array.from(ratedCard.querySelectorAll(selectors.ratingStarSelector))
      : [];
    const starBounds = stars.map(boundsOf).filter(Boolean);
    const uniqueStarTops = [];
    starBounds.forEach((bounds) => {
      if (!uniqueStarTops.some((top) => Math.abs(top - bounds.top) <= 1)) {
        uniqueStarTops.push(bounds.top);
      }
    });
    const ratedCardBounds = boundsOf(ratedCard);
    const ratingRowBounds = boundsOf(ratingRow);
    const ratingStarsBounds = boundsOf(ratingStars);
    const ratingTextBounds = boundsOf(ratingText);
    const ratingInsideCard = Boolean(
      ratedCardBounds
      && ratingRowBounds
      && ratingRowBounds.left >= ratedCardBounds.left - 1
      && ratingRowBounds.right <= ratedCardBounds.right + 1
    );
    const ratingItemsShareRow = Boolean(
      ratingStarsBounds
      && ratingTextBounds
      && Math.min(ratingStarsBounds.bottom, ratingTextBounds.bottom)
        > Math.max(ratingStarsBounds.top, ratingTextBounds.top)
    );
    const cardsInsideGallery = Boolean(
      galleryBounds
      && cardBounds.every((bounds) => (
        bounds.left >= galleryBounds.left - 1
        && bounds.right <= galleryBounds.right + 1
      ))
    );

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      galleryBounds,
      columnCount: rowCardCounts.length ? Math.max(...rowCardCounts) : 0,
      rowCardCounts,
      cardWidths: cardBounds.map((bounds) => bounds.width),
      maxCardWidth: cardBounds.length ? Math.max(...cardBounds.map((bounds) => bounds.width)) : 0,
      cardsInsideGallery,
      galleryHasHorizontalOverflow: gallery.scrollWidth > gallery.clientWidth + 1,
      documentHasHorizontalOverflow: document.documentElement.scrollWidth
        > document.documentElement.clientWidth + 1,
      rating: {
        attached: ratedCard instanceof HTMLElement,
        starCount: starBounds.length,
        starLineCount: uniqueStarTops.length,
        itemsShareRow: ratingItemsShareRow,
        insideCard: ratingInsideCard,
        text: normalize(ratingText?.textContent),
      },
    };
  }, {
    albumCardSelector: galleryPage.albumCardWithinSectionSelector,
    albumRowSelector: galleryPage.albumRowWithinSectionSelector,
    albumTitleSelector: galleryPage.albumTitleButtonWithinSectionSelector,
    galleryScrollSelector: galleryPage.galleryScrollSelector,
    ratedAlbumName,
    ratingRowSelector: galleryPage.albumCard.ratingRowWithinCardSelector,
    ratingStarSelector: galleryPage.albumCard.ratingStarWithinCardSelector,
    ratingStarsSelector: galleryPage.albumCard.ratingStarsWithinCardSelector,
    ratingTextSelector: galleryPage.albumCard.ratingTextWithinCardSelector,
  });
}

export async function waitForResponsiveGalleryLayout(galleryPage, options = {}) {
  let previousSignature = '';
  let latestSnapshot = null;
  await expect.poll(async () => {
    latestSnapshot = await readResponsiveGalleryLayout(galleryPage, options);
    const signature = responsiveLayoutSignature(latestSnapshot);
    const settled = latestSnapshot.rating.attached && signature === previousSignature;
    previousSignature = signature;
    return settled;
  }, {
    message: `Expected responsive gallery geometry for ${options.artistName} to settle.`,
    timeout: options.timeout || 10000,
  }).toBe(true);
  return latestSnapshot;
}

export async function captureResponsiveGalleryScreenshot(galleryPage, testArtifacts, name) {
  const outputPath = testArtifacts.outputPath(name);
  await galleryPage.galleryScroll.screenshot({
    animations: 'disabled',
    path: outputPath,
  });
  testArtifacts.queuePathAttachment(name, outputPath, 'image/png');
  return outputPath;
}

export function expectResponsiveRatingSingleLine(expectApi, snapshot) {
  expectApi(snapshot.rating).toMatchObject({
    attached: true,
    starCount: 10,
    starLineCount: 1,
    itemsShareRow: true,
    insideCard: true,
    text: '8/10',
  });
}

export function expectCardsWithinSelectedScale(expectApi, snapshot, selectedScaleCeilingPx) {
  expectApi(snapshot.columnCount).toBeGreaterThan(0);
  expectApi(snapshot.maxCardWidth).toBeLessThanOrEqual(
    selectedScaleCeilingPx + GEOMETRY_TOLERANCE_PX,
  );
  expectApi(snapshot.cardsInsideGallery).toBe(true);
  expectApi(snapshot.galleryHasHorizontalOverflow).toBe(false);
  expectApi(snapshot.documentHasHorizontalOverflow).toBe(false);
}
