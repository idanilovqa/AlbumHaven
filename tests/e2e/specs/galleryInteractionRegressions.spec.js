import { expect, test } from '../support/baseFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { createGalleryRegressionFixture } from '../helpers/galleryRegressionFixture.js';
import { PERFORMANCE_AUTH_USERNAME } from '../support/performanceAuthentication.js';
import { expectSelectionDragStaysInside } from '../poms/interactionSurfaces.js';
import { parseProductionBootstrapPayloadScriptSources } from '../poms/basePage.js';

const GALLERY_CASE='FTC-GALLERY-031 preserves startup totals, search suggestions, covers and hover-year interactions';
const TABLE_CASE='FTC-GALLERY-032 hydrates version tracks and preserves table playback, selection and fixed modal identity';
const WARNING_CASE='FTC-GALLERY-033 acknowledges warning alerts without hiding Scan health and resurfaces new warnings';

test(GALLERY_CASE,{tag:'@area:gallery-search'},async({page,context,galleryActions,searchToolbarActions,stepLogger})=>{
  test.setTimeout(180000);
  const ui=new GalleryRegressions(page);
  await stepLogger.step('Server first paint shows known totals before any JavaScript hydration',async()=>{
    const response=await page.goto(new URL('/?surface=albums',test.info().project.use.baseURL).href);
    const html=await response.text();
    const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
    const payload=parseProductionBootstrapPayloadScriptSources(scripts);
    const view=payload.initial_view;
    expect(html).toContain(`data-gallery-context-summary>${view.artist_count} artists · ${view.album_count} albums`);
    expect(view.album_count).toBeGreaterThan(7);
  });
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();
  await stepLogger.step('A search paints usable covers without switching artists',async()=>{
    await searchToolbarActions.search('Neal Morse',{submitWithEnter:true});
    await searchToolbarActions.waitForQuery('Neal Morse');
    await expect(ui.cards.first()).toBeVisible();
    await expect.poll(async()=> (await ui.cards.first().boundingBox())?.width || 0).toBeGreaterThan(80);
    // parity-check: allow-read-only-measurement-evaluate -- inspect decoded image and rendered cover size
    await expect.poll(()=>ui.cover(ui.cards.first()).evaluate(e=>e.complete && e.naturalWidth>0 && e.getBoundingClientRect().width>80)).toBe(true);
  });
  await stepLogger.step('Search history opens by click and after clearing, with a flat neutral hover',async()=>{
    await ui.search.click(); await expect(ui.options.first()).toBeVisible();
    await ui.search.fill(''); await ui.search.fill('Neal');
    await expect(ui.options.first()).toBeVisible(); await ui.options.first().hover();
    await expect(ui.options.first()).toHaveCSS('outline-style','none');
    await expect(ui.options.first()).toHaveCSS('box-shadow','none');
    // parity-check: allow-read-only-measurement-evaluate -- inspect low-saturation neutral hover in the configured palette
    const color=await ui.options.first().evaluate(e=>getComputedStyle(e).backgroundColor);
    const channels=color.match(/[\d.]+/g).map(Number).slice(0,3);
    const scale=color.startsWith('color(')?1:255;
    expect((Math.max(...channels)-Math.min(...channels))/scale).toBeLessThan(0.12);
    expect(color).not.toBe('rgba(0, 0, 0, 0)');
    expect((channels[1]-Math.max(channels[0],channels[2]))/scale).toBeLessThan(0.005);
    await ui.search.press('Escape');
    await searchToolbarActions.search('Neal Morse',{submitWithEnter:true});
    await searchToolbarActions.waitForQuery('Neal Morse');
  });
  await stepLogger.step('Year appears only on No info hover with white text, black stroke and blue gap tips',async()=>{
    await ui.cardsView.hover(); await expect(ui.cardsView).toHaveCSS('cursor','pointer');
    await ui.cardsView.click();
    await ui.noInfo.click();
    // The year attribute belongs to the card itself.
    const yearCard=ui.yearCard;
    const year=ui.year;
    await expect(yearCard).toHaveAttribute('data-gallery-display','covers');
    await page.mouse.move(1,1); await expect(year).toHaveCSS('opacity','0');
    await yearCard.hover(); await expect(year).toHaveCSS('opacity','1');
    await expect(year).toHaveCSS('color','rgb(255, 255, 255)');
    await expect(year).toHaveCSS('-webkit-text-stroke-color','rgb(0, 0, 0)');
    // parity-check: allow-read-only-measurement-evaluate -- inspect the animated border gap and luminous tip
    await expect.poll(()=>yearCard.evaluate(e=>getComputedStyle(e).getPropertyValue('--gallery-year-gap').trim())).toBe('34px');
    // parity-check: allow-read-only-measurement-evaluate -- verify the glowing border-gap endpoint remains rendered
    expect(await year.evaluate(e=>getComputedStyle(e,'::before').boxShadow)).not.toBe('none');
    await ui.noInfo.click(); await ui.cardsView.click();
    await expect(ui.cards.first()).toHaveAttribute('data-gallery-display','cards');
    await ui.cards.first().hover();
    await expect(ui.yearWithin(ui.cards.first())).not.toBeVisible();
  });
  await stepLogger.step('Info text has visible selection during drag and cannot select gallery cards',async()=>{
    await ui.info.click(); await expect(ui.infoPanel).toBeVisible();
    const text=ui.infoSummary;
    await text.hover();
    const box=await text.boundingBox();
    await page.mouse.move(box.x+5,box.y+8); await page.mouse.down();
    try {
      await page.mouse.move(box.x+130,box.y+8,{steps:10});
      await expect.poll(()=>ui.selection()).not.toBe('');
      // parity-check: allow-read-only-measurement-evaluate -- selection paint must be visible before mouseup
      const paint=await text.evaluate(e=>({selection:getComputedStyle(e,'::selection').backgroundColor,userSelect:getComputedStyle(e).userSelect}));
      expect(paint.selection).not.toBe('rgba(0, 0, 0, 0)'); expect(paint.userSelect).toBe('text');
    } finally {await page.mouse.up();}
    await ui.infoPanel.getByRole('heading',{name:'Neal Morse',exact:true}).click();
    await expectSelectionDragStaysInside(page,ui.infoPanel);
  });
});

test(TABLE_CASE,{tag:'@area:album-details'},async({page,galleryActions,searchToolbarActions,trackModalActions,stepLogger})=>{
  const fixture=await createGalleryRegressionFixture(PERFORMANCE_AUTH_USERNAME);
  test.setTimeout(180000);
  const ui=new GalleryRegressions(page);
  try {
    let initialReleaseIndex=0;
    await fixture.linkVersions();
    await galleryActions.goto('/?surface=albums'); await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search('Various Artists',{submitWithEnter:true});
    await searchToolbarActions.waitForQuery('Various Artists');
    for(let attempt=0;attempt<12 && !await galleryActions.hasVisibleAlbum('Featured Signal Collection');attempt++) {
      const scroll=await galleryActions.readGalleryScrollState();
      if(scroll.scrollTop>=scroll.maxScrollTop-2)break;
      await galleryActions.scrollGalleryBy(scroll.clientHeight*0.75);
      await galleryActions.galleryPage.waitForGalleryScrollMovement(scroll.scrollTop,1,{timeout:5000});
    }
    await galleryActions.waitForAlbumVisible('Featured Signal Collection',{timeout:10000});
    await galleryActions.clickAlbumDetailsByAlbumName('Featured Signal Collection'); await trackModalActions.waitForReady();
    await stepLogger.step('Preview version switching fetches full track details on first opening',async()=>{
      await expect(trackModalActions.trackModal.releaseTabs).toHaveCount(2);
      const labels=await trackModalActions.trackModal.releaseTabs.allTextContents();
      const initialTrackTitle=await ui.title(ui.rows.first()).innerText();
      initialReleaseIndex=Number(await ui.activeReleaseTab.getAttribute('data-track-tab-index'));
      await trackModalActions.trackModal.releaseTabs.nth(1-initialReleaseIndex).click();
      await trackModalActions.waitForReady(); await expect(ui.rows.first()).toBeVisible();
      await expect(ui.title(ui.rows.first())).not.toBeEmpty();
      await expect(ui.title(ui.rows.first())).not.toHaveText(initialTrackTitle);
      await expect(trackModalActions.trackModal.releaseTabs).toHaveText(labels);
      await trackModalActions.trackModal.releaseTabs.nth(initialReleaseIndex).click(); await trackModalActions.waitForReady();
      await expect(ui.rows.filter({hasText:'Clean Signal'}).first()).toBeVisible();
      await expect(trackModalActions.trackModal.releaseTabs).toHaveText(labels);
    });
    await stepLogger.step('Number swaps to animated Play on any row hover, with aligned header and hand cursor',async()=>{
      const row=ui.rows.first();
      await page.mouse.move(1,1);
      await expect(ui.play(row)).toHaveCSS('opacity','0');
      await expect(ui.number(row)).toBeVisible();
      const header=ui.numberHeader;
      expect(Math.abs(await ui.center(header)-await ui.center(ui.numberPlay(row)))).toBeLessThan(1);
      await ui.title(row).hover();
      await expect(ui.play(row)).toHaveCSS('opacity','1'); await expect(ui.number(row)).toBeHidden();
      await expect(ui.title(row)).toHaveCSS('cursor','pointer');
    });
    await stepLogger.step('Double-click plays without a word highlight; dragging still selects copyable text',async()=>{
      const row=ui.rows.filter({hasText:'Clean Signal'}).first();
      const title=ui.title(row);
      await title.dblclick(); await expect(row).toHaveAttribute('data-track-playing','true');
      await expect.poll(()=>ui.selection()).toBe('');
      await page.mouse.move(1,1); await expect(ui.play(row)).toHaveCSS('opacity','1');
      await title.dblclick(); await expect(row).toHaveAttribute('data-track-playing','true');
      await expect.poll(()=>ui.selection()).toBe('');
      const box=await title.boundingBox();
      await page.mouse.move(box.x+2,box.y+8);await page.mouse.down();
      try {await page.mouse.move(box.x+Math.min(110,box.width-3),box.y+8,{steps:12});} finally {await page.mouse.up();}
      await expect.poll(()=>ui.selection()).toContain('Clean');
      await ui.play(row).click(); await expect(row).not.toHaveAttribute('data-track-playing','true');
    });
    await stepLogger.step('Only the table scrolls; header and art stay fixed',async()=>{
      await trackModalActions.trackModal.releaseTabs.nth(1-initialReleaseIndex).click();await trackModalActions.waitForReady();
      await page.setViewportSize({width:1200,height:430});
      const header=await ui.header.boundingBox(),art=await ui.art.boundingBox();
      await ui.tracks.hover();await page.mouse.wheel(0,700);
      // parity-check: allow-read-only-measurement-evaluate -- measure scroll owner after real wheel input
      await expect.poll(()=>ui.tracks.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
      expect((await ui.header.boundingBox()).y).toBeCloseTo(header.y,0);
      expect((await ui.art.boundingBox()).y).toBeCloseTo(art.y,0);
    });
  } finally {await fixture.restore();}
});

test(WARNING_CASE,{tag:'@area:gallery-search'},async({page,galleryActions,stepLogger})=>{
  const fixture=await createGalleryRegressionFixture(PERFORMANCE_AUTH_USERNAME);
  test.setTimeout(180000);
  const ui=new GalleryRegressions(page);
  try {
    await fixture.warn('2026-09-12T11:00:00Z');
    await galleryActions.goto('/?surface=albums');await galleryActions.waitForGalleryReady();
    await stepLogger.step('A warning icon opens the alert while Library stays green',async()=>{
      await expect(ui.warning).toBeVisible({timeout:60000});
      await expect(ui.libraryCheck).toHaveCSS('color','rgb(52, 211, 153)');
      await ui.warning.click();
      await expect(ui.warningPanel).toContainText('Some library changes may have been missed');
      await expect(ui.warningPanel.getByRole('button',{name:'Dismiss',exact:true})).toBeVisible();
      await ui.warningPanel.getByRole('button',{name:'Open Library/Scan',exact:true}).click();
      await expect(ui.scanWarning).toBeVisible();
      await page.getByRole('button',{name:'Back to previous library view'}).click();
    });
    await stepLogger.step('Dismiss survives reload but keeps the warning on Library/Scan',async()=>{
      await ui.warning.click();
      await ui.warningPanel.getByRole('button',{name:'Dismiss',exact:true}).click();
      await expect(ui.warning).toBeHidden(); await expect(ui.warningPanel).toBeHidden();
      await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.library).toHaveClass(/is-warning/,{timeout:60000});
      await expect(ui.warning).toBeHidden();
      await ui.library.click({button:'right'}); await ui.openScan.click();
      await expect(ui.scanWarning).toBeVisible();
      await page.getByRole('button',{name:'Back to previous library view'}).click();
    });
    await stepLogger.step('A new detection resurfaces the icon; resolving health removes the Scan notice',async()=>{
      await fixture.warn('2026-09-12T11:01:00Z');
      await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.warning).toBeVisible({timeout:60000});
      await fixture.clear();await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.library).not.toHaveClass(/is-warning/,{timeout:60000});await expect(ui.warning).toBeHidden();
      await ui.library.click({button:'right'});await ui.openScan.click();await expect(ui.scanWarning).toBeHidden();
    });
  } finally {await fixture.restore();}
});
