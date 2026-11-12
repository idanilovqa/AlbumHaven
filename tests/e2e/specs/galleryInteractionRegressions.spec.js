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
  let firstPaintSummary;
  let firstPaintArtistCount;
  await stepLogger.step('Server first paint shows known totals before any JavaScript hydration',async()=>{
    const response=await page.goto(new URL('/?surface=albums',test.info().project.use.baseURL).href);
    const html=await response.text();
    const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
    const payload=parseProductionBootstrapPayloadScriptSources(scripts);
    const view=payload.initial_view;
    firstPaintArtistCount=String(view.artist_count);
    firstPaintSummary = `${view.artist_count} artists · ${view.album_count} albums`;
    expect(html).toContain(`data-gallery-context-summary>${firstPaintSummary}`);
    expect(view.album_count).toBeGreaterThan(7);
  });
  await galleryActions.waitForGalleryReady();
  await expect(ui.summary).toHaveText(firstPaintSummary);
  await stepLogger.step('Root totals remain authoritative after scrolling beyond the initial viewport',async()=>{
    await expect(ui.rootArtistCount).toHaveText(firstPaintArtistCount);
    await galleryActions.scrollGalleryToMiddle();
    await expect.poll(()=>ui.readCompletedStartupPartialView(),{timeout:60000}).toBe(false);
    const scroll=await galleryActions.readGalleryScrollState();
    await galleryActions.scrollGalleryBy(-scroll.scrollTop);
    await expect.poll(async()=> (await galleryActions.readGalleryScrollState()).scrollTop).toBeLessThan(2);
    await expect(ui.summary).toHaveText(firstPaintSummary);
    await expect(ui.rootArtistCount).toHaveText(firstPaintArtistCount);
  });
  await stepLogger.step('Artist Family is hidden at root and closes when returning from a selected artist',async()=>{
    const familyToggle=ui.familyToggle;
    const familyPanel=ui.familyPanel;
    await expect(familyToggle).toBeHidden();
    await expect(familyPanel).toBeHidden();
    const neal=ui.nealSidebar;
    await neal.click();
    await galleryActions.waitForGalleryReady();
    await expect(neal).toHaveAttribute('aria-current','true');
    await expect(familyToggle).toBeVisible();
    await familyToggle.click();
    await expect(familyPanel).toBeVisible();
    const root=ui.rootSidebar;
    await root.click();
    await galleryActions.waitForGalleryReady();
    await expect(root).toHaveAttribute('aria-current','true');
    await expect(familyToggle).toBeHidden();
    await expect(familyPanel).toBeHidden();
    await expect(ui.summary).toHaveText(firstPaintSummary);
  });
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
    await expect(year).toHaveCSS('-webkit-text-stroke-width','1px');
    // parity-check: allow-read-only-measurement-evaluate -- inspect the animated border gap and luminous tip
    await expect.poll(()=>yearCard.evaluate(e=>getComputedStyle(e).getPropertyValue('--gallery-year-gap').trim())).toBe('34px');
    // parity-check: allow-read-only-measurement-evaluate -- verify the glowing border-gap endpoint remains rendered
    expect(await year.evaluate(e=>getComputedStyle(e,'::before').boxShadow)).toContain('rgb(85, 199, 255)');
    await ui.noInfo.click(); await ui.cardsView.click();
    await expect(ui.cards.first()).toHaveAttribute('data-gallery-display','cards');
    await ui.cards.first().hover();
    await expect(ui.yearWithin(ui.cards.first())).not.toBeVisible();
  });
  // Owner (11-08, UI-SEARCH-INFO): the header "i" shows during a search and must open the artist information when clicked.
  await stepLogger.step('During a search the header and result-heading info buttons both open the artist information',async()=>{
    const openAndCloseInfo=async(trigger,artist)=>{
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(ui.infoPanel).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded','true');
      await expect(ui.infoPanel.getByRole('heading',{name:artist,exact:true})).toBeVisible();
      await expect(ui.infoSummary).toBeVisible();
      await expect(ui.infoSummary).not.toHaveText('');
      await page.keyboard.press('Escape');
      await expect(ui.infoPanel).not.toBeVisible();
    };
    // A search that finds one artist names it in the header, with its "i" (owner example: Dragonland).
    await searchToolbarActions.search('Mastodon',{submitWithEnter:true});
    await searchToolbarActions.waitForQuery('Mastodon');
    await expect(page.locator('[data-gallery-bar-instance="gallery"][data-gallery-context-kind="single-artist"] [data-gallery-context-name]')).toHaveText('Mastodon');
    await openAndCloseInfo(ui.toolbarInfo,'Mastodon');
    await searchToolbarActions.search('Neal Morse',{submitWithEnter:true});
    await searchToolbarActions.waitForQuery('Neal Morse');
    await openAndCloseInfo(ui.headingInfo,'Neal Morse');
    await searchToolbarActions.clearSearch({submitWithEnter:true});
    await searchToolbarActions.waitForQuery('');
    await galleryActions.waitForGalleryReady();
    await ui.nealSidebar.click();
    await galleryActions.waitForGalleryReady();
    await expect(ui.nealSidebar).toHaveAttribute('aria-current','true');
  });
  await stepLogger.step('UI-ARTIST-INFO-SCROLL clears the player, retains its connector and follows background scrolling',async()=>{
    const originalViewport=page.viewportSize();
    await page.setViewportSize({width:1200,height:500});
    try {
      await ui.headingInfo.click();
      await expect(ui.infoPanel).toBeVisible();
      const readGeometry=()=>ui.infoPanel.evaluate((panel)=>{
        const trigger=document.querySelector('[data-artist-info-trigger][data-artist="Neal Morse"][aria-expanded="true"]');
        const player=document.querySelector('[data-shell-slot="bottom_player"]');
        const panelBounds=panel.getBoundingClientRect();
        const triggerBounds=trigger?.getBoundingClientRect();
        const playerBounds=player?.getBoundingClientRect();
        const connector=getComputedStyle(panel,'::before');
        return {
          connectorHeight:parseFloat(connector.height),
          connectorVisible:connector.display!=='none'&&connector.visibility!=='hidden',
          connectorWidth:parseFloat(connector.width),
          panelClipPath:getComputedStyle(panel).clipPath,
          panelBottom:panelBounds.bottom,
          panelTop:panelBounds.top,
          playerTop:playerBounds?.top??window.innerHeight,
          triggerTop:triggerBounds?.top??null,
          triggerBottom:triggerBounds?.bottom??null,
          triggerExpanded:trigger?.getAttribute('aria-expanded')==='true',
          viewportHeight:window.innerHeight,
        };
      });
      await expect.poll(async()=>{
        const geometry=await readGeometry();
        return Math.abs(geometry.panelTop-(geometry.triggerBottom-1));
      }).toBeLessThanOrEqual(1);
      const opened=await readGeometry();
      expect(opened.connectorVisible).toBe(true);
      expect(opened.connectorWidth).toBeGreaterThan(0);
      expect(opened.connectorHeight).toBeGreaterThan(0);
      expect(opened.panelClipPath).toBe('none');
      expect(opened.panelBottom).toBeLessThanOrEqual(opened.playerTop+1);
      expect(opened.panelTop).toBeCloseTo(opened.triggerBottom-1,0);

      const galleryBounds=await ui.galleryScroll.boundingBox();
      expect(galleryBounds).not.toBeNull();
      await page.mouse.move(galleryBounds.x+galleryBounds.width-24,galleryBounds.y+galleryBounds.height/2);
      const scrollBefore=await ui.galleryScroll.evaluate(node=>node.scrollTop);
      await page.mouse.wheel(0,80);
      await expect.poll(()=>ui.galleryScroll.evaluate(node=>node.scrollTop)).toBeGreaterThan(scrollBefore);
      await expect(ui.infoPanel).toBeVisible();
      await expect.poll(async()=>{
        const geometry=await readGeometry();
        return Math.abs(geometry.panelTop-(geometry.triggerBottom-1));
      }).toBeLessThanOrEqual(1);
      const scrolled=await readGeometry();
      expect(scrolled.panelTop).toBeLessThan(opened.panelTop);
      expect(scrolled.panelTop).toBeCloseTo(scrolled.triggerBottom-1,0);

      const farScrollBefore=await ui.galleryScroll.evaluate(node=>node.scrollTop);
      await page.mouse.wheel(0,900);
      await expect.poll(()=>ui.galleryScroll.evaluate(node=>node.scrollTop)).toBeGreaterThan(farScrollBefore);
      await expect(ui.infoPanel).toBeVisible();
      await expect.poll(async()=>{
        const geometry=await readGeometry();
        return Math.abs(geometry.panelTop-(geometry.triggerBottom-1));
      }).toBeLessThanOrEqual(1);
      const farScrolled=await readGeometry();
      expect(farScrolled.triggerExpanded).toBe(true);
      expect(farScrolled.connectorVisible).toBe(true);
      expect(farScrolled.connectorWidth).toBeGreaterThan(0);
      expect(farScrolled.connectorHeight).toBeGreaterThan(0);
      expect(farScrolled.panelClipPath).toBe('none');
      expect(farScrolled.triggerTop).toBeGreaterThanOrEqual(0);
      expect(farScrolled.triggerBottom).toBeLessThanOrEqual(farScrolled.viewportHeight);
      expect(farScrolled.panelTop).toBeGreaterThanOrEqual(0);
      expect(farScrolled.panelBottom).toBeLessThanOrEqual(farScrolled.playerTop+1);
      expect(farScrolled.panelTop).toBeCloseTo(farScrolled.triggerBottom-1,0);
      await page.keyboard.press('Escape');
      await expect(ui.infoPanel).toBeHidden();
    } finally {
      if(await ui.infoPanel.isVisible())await page.keyboard.press('Escape');
      const scrollTop=await ui.galleryScroll.evaluate(node=>node.scrollTop);
      if(scrollTop>0)await galleryActions.scrollGalleryBy(-scrollTop);
      if(originalViewport)await page.setViewportSize(originalViewport);
    }
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

test(TABLE_CASE,{tag:'@area:album-details'},async({page,context,galleryActions,searchToolbarActions,trackModalActions,globalPlayerActions,playbackEvidence,stepLogger})=>{
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
      const trackPath=await ui.readTrackPath(row);
      expect(trackPath).not.toBe('');
      const playbackMark=await playbackEvidence.playbackMark();
      await title.dblclick(); await expect(row).toHaveAttribute('data-track-playing','true');
      await globalPlayerActions.waitForPlaybackState({paused:false,minimumCurrentTime:0.1});
      const evidence=await playbackEvidence.waitForTrackPlaybackEvidence({after:playbackMark,path:trackPath});
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
      await expect.poll(()=>ui.selection()).toBe('');
      await page.mouse.move(1,1); await expect(ui.play(row)).toHaveCSS('opacity','1');
      await title.dblclick(); await expect(row).toHaveAttribute('data-track-playing','true');
      await expect.poll(()=>ui.selection()).toBe('');
      const box=await title.boundingBox();
      await page.mouse.move(box.x+2,box.y+8);await page.mouse.down();
      try {await page.mouse.move(box.x+Math.min(110,box.width-3),box.y+8,{steps:12});} finally {await page.mouse.up();}
      await expect.poll(()=>ui.selection()).toContain('Clean');
      const selectedText=await ui.selection();
      await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(page.url()).origin});
      await page.keyboard.press('ControlOrMeta+C');
      // parity-check: allow-read-only-measurement-evaluate -- read the clipboard after the real native copy gesture
      expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(selectedText);
      await ui.play(row).click(); await expect(row).not.toHaveAttribute('data-track-playing','true');
      await globalPlayerActions.waitForPlaybackState({paused:true});
    });
    await stepLogger.step('Only the table scrolls; header and art stay fixed',async()=>{
      await trackModalActions.trackModal.releaseTabs.nth(1-initialReleaseIndex).click();await trackModalActions.waitForReady();
      await page.setViewportSize({width:1200,height:430});
      const header=await ui.header.boundingBox(),art=await ui.art.boundingBox();
      const dialog=await ui.dialog.boundingBox();
      expect(Math.abs(art.width-art.height)).toBeLessThanOrEqual(1);
      expect(art.y + art.height, 'The fixed artwork must fit inside the modal instead of being clipped').toBeLessThanOrEqual(dialog.y + dialog.height);
      await ui.tracks.hover();await page.mouse.wheel(0,700);
      // parity-check: allow-read-only-measurement-evaluate -- measure scroll owner after real wheel input
      await expect.poll(()=>ui.tracks.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
      expect((await ui.header.boundingBox()).y).toBeCloseTo(header.y,0);
      expect((await ui.art.boundingBox()).y).toBeCloseTo(art.y,0);
    });
    // INT-007 / UI-11 (owner, 11-08 evening): the album already linked shows selected; clicking it deselects it and
    // Save unlinks it, and the gallery updates in the background without the Loading page.
    await stepLogger.step('Mark As A Version shows the linked album selected and unlinks it in the background',async()=>{
      await page.setViewportSize({width:1440,height:960});
      await page.keyboard.press('Escape'); await expect(ui.dialog).toBeHidden();
      await galleryActions.openAlbumContextMenu('Featured Signal Collection');
      const menu=galleryActions.galleryPage.albumCard.contextMenu;
      await expect(menu.getByRole('button',{name:'Unmark as a version',exact:true})).toHaveCount(0);
      await menu.getByRole('button',{name:'Mark as a version',exact:true}).click();
      const dialog=page.locator('#app-form-modal');
      const linked=dialog.locator('[data-version-picker-target]').filter({hasText:'Ordinary Numeric Disc Control'});
      const save=dialog.locator('#app-form-submit');
      await expect(dialog).toBeVisible();
      await expect(linked).toHaveClass(/\bis-selected\b/);
      await expect(linked).toHaveAttribute('aria-current','true');
      await expect(save).toBeDisabled();
      await linked.click();
      await expect(linked).not.toHaveClass(/\bis-selected\b/);
      await expect(save).toBeEnabled();
      // parity-check: allow-read-only-measurement-evaluate -- record whether the Loading page shows on any frame
      await page.evaluate(()=>{const seen=[];window.__versionLoaderFrames=seen;const read=()=>{const l=document.getElementById('library-loader');seen.push(Boolean(l&&!l.hidden));if(!window.__versionLoaderStop)requestAnimationFrame(read);};requestAnimationFrame(read);});
      await save.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Album is no longer manually marked as a version.')).toBeVisible();
      await expect.poll(async()=>{await galleryActions.openAlbumContextMenu('Featured Signal Collection');const offered=await menu.getByRole('button',{name:'Mark as a version',exact:true}).count();await galleryActions.dismissAlbumContextMenu();return offered;},{message:'the link is gone, so nothing is left to mark'}).toBe(0);
      const loaderFrames=await page.evaluate(()=>{window.__versionLoaderStop=true;return window.__versionLoaderFrames;});
      expect(loaderFrames.length).toBeGreaterThan(5);
      expect(loaderFrames.filter(Boolean),'the gallery never goes behind the Loading page').toEqual([]);
    });
  } finally {await fixture.restore();}
});

test(WARNING_CASE,{tag:'@area:gallery-search'},async({page,galleryActions,searchToolbarActions,stepLogger})=>{
  const fixture=await createGalleryRegressionFixture(PERFORMANCE_AUTH_USERNAME);
  test.setTimeout(180000);
  const ui=new GalleryRegressions(page);
  try {
    await fixture.warn('2026-09-12T11:00:00Z');
    await galleryActions.goto('/?surface=albums');await galleryActions.waitForGalleryReady();
    await stepLogger.step('One floating warning appears without a toolbar duplicate or premature Library notice',async()=>{
      await expect(ui.warning).toBeVisible({timeout:60000});
      await expect(ui.removedWarningButton).toHaveCount(0);
      await expect(ui.removedWarningPanel).toHaveCount(0);
      await expect(ui.libraryCheck).toHaveCSS('color','rgb(52, 211, 153)');
      await ui.library.click({button:'right'});await ui.openScan.click();
      await expect(ui.scanWarning).toBeHidden();
      await expect(ui.warning).toBeVisible();
      await page.getByRole('button',{name:'Back to previous library view'}).click();
    });
    await stepLogger.step('Searching replaces previous results with a loading state without a blocking warning',async()=>{
      const observation=await ui.observeSearchContinuity('Neal Morse');
      let evidence;
      try {
        await searchToolbarActions.search('Neal Morse',{submitWithEnter:true});
        await searchToolbarActions.waitForQuery('Neal Morse');
        await galleryActions.waitForGalleryReady();
      } finally { evidence=await ui.finishSearchContinuity(observation); }
      expect(evidence.pendingRequests).toBeGreaterThan(0);
      expect(evidence.samples).toBeGreaterThan(0);
      expect(evidence.pendingSearchSamples).toBeGreaterThan(0);
      expect(evidence.previousGalleryVisible).toBe(0);
      expect(evidence.missingSearchLoader).toBe(0);
      expect(evidence.blockingLoader).toBe(0);
      expect(evidence.searching).toBeGreaterThan(0);
      await expect(ui.loader).toBeHidden();
      expect(evidence.warningExposures).toBe(0);
      await expect(ui.scanWarning).toBeHidden();
      await expect(ui.warning).toBeVisible();
      await searchToolbarActions.clearSearch({ submitWithEnter: true });
      await searchToolbarActions.waitForQuery('');
      await galleryActions.waitForGalleryReady();
      await expect(ui.rootSidebar).toBeVisible();
      await ui.rootSidebar.click();
      await galleryActions.waitForGalleryReady();
    });
    await stepLogger.step('Dismiss survives reload and moves the unresolved notice to Library only',async()=>{
      await ui.warningDismiss.click();
      await expect(ui.warning).toBeHidden();
      await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.library).toHaveClass(/is-warning/,{timeout:60000});
      await expect(ui.warning).toBeHidden();
      await ui.library.click({button:'right'});await ui.openScan.click();
      await expect(ui.scanWarning).toBeVisible();
      await expect(ui.scanWarning.getByRole('button',{name:'Full Rescan',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Back to previous library view'}).click();
      await expect(ui.scanWarning).toBeHidden();
    });
    await stepLogger.step('A same-clock new warning resurfaces and Go to Library acknowledges that event',async()=>{
      await fixture.warn('2026-09-12T11:00:00Z',{eventId:'a3c91f73-2031-4e3b-9b44-f1e05c85ac36'});
      await expect(ui.warning).toBeVisible({timeout:60000});
      await ui.warningGoLibrary.click();
      await expect(ui.warning).toBeHidden();
      await expect(ui.scanWarning).toBeVisible();
      await page.getByRole('button',{name:'Back to previous library view'}).click();
      await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.library).toHaveClass(/is-warning/,{timeout:60000});
      await expect(ui.warning).toBeHidden();
      await ui.library.click({button:'right'});await ui.openScan.click();
      await expect(ui.scanWarning).toBeVisible();
      await page.getByRole('button',{name:'Back to previous library view'}).click();
    });
    await stepLogger.step('A later warning resurfaces and health recovery clears both surfaces',async()=>{
      await fixture.warn('2026-09-12T11:01:00Z');
      await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.warning).toBeVisible({timeout:60000});
      await fixture.clear();await page.reload();await galleryActions.waitForGalleryReady();
      await expect(ui.library).not.toHaveClass(/is-warning/,{timeout:60000});await expect(ui.warning).toBeHidden();
      await ui.library.click({button:'right'});await ui.openScan.click();await expect(ui.scanWarning).toBeHidden();
    });
  } finally {await fixture.restore();}
});
