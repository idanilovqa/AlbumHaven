// Additive actual-native-owner regression cases. Authored only; headless browser
// blocked in current environment. Do not count an unrun case as passing evidence.
const {test, assert, fixture, sort, title, header, pointer, click, waitForReleasedSequence, settleCorrectionFrames, focusedLabelGeometry, mountLongPlaylistTitle, playlistTitleGeometry, documentOverflows, waitForColumnMenu, waitForColumnMenuDetached, waitForResponsivePlaylist, waitForMenu, menuBounds, titleBounds, tableBounds} = require('./mobileTrackColumnsCorrectionsFixture');

test('consumed longpress remains consumed through a hold beyond the old one-second expiry',async ({page})=>{
 await fixture(page);await pointer(page,'pointerdown');
 await waitForColumnMenu(page);
 await waitForReleasedSequence(page); // >1.7 seconds since pointerdown; pointer still held.
 await pointer(page,'pointerup');await click(page);
 assert.equal(await page.evaluate(()=>sorts),0,'Release trailing click must not sort after a long hold');
 await click(page,0);assert.equal(await page.evaluate(()=>sorts),1,'Independent keyboard activation is not suppressed');
 await pointer(page,'pointerdown');await pointer(page,'pointerup');await click(page);
 assert.equal(await page.evaluate(()=>sorts),2,'The next ordinary pointer sequence remains sortable');
});

test('abandoned released sequence expires separately and cannot consume a later click',async ({page})=>{
 await fixture(page);await pointer(page,'pointerdown');await waitForColumnMenu(page);
 await pointer(page,'pointerup'); // No trailing click from this consumed sequence.
 await waitForReleasedSequence(page);await click(page);
 assert.equal(await page.evaluate(()=>sorts),1,'Finite retirement is measured after release, not menu opening');
});

test('pointercancel retires the consumed sequence immediately',async ({page})=>{
 await fixture(page);await pointer(page,'pointerdown');await waitForColumnMenu(page);
 await pointer(page,'pointercancel');await click(page);
 assert.equal(await page.evaluate(()=>sorts),1,'Cancelled sequence cannot swallow another click');
});

for(const opening of ['contextmenu','longpress'])test('native Choice Escape restores a non-sortable header opening to its focusable content label: '+opening,async ({page})=>{
 await fixture(page);await page.locator('#outside').focus();
 if(opening==='contextmenu')await page.locator(title).dispatchEvent('contextmenu',{bubbles:true,cancelable:true,button:2});
 else {await pointer(page,'pointerdown',title);await waitForColumnMenu(page);await pointer(page,'pointerup',title);}
 await waitForColumnMenu(page);
 await page.keyboard.press('Escape');await waitForColumnMenuDetached(page);
 assert.equal(await page.locator(title).evaluate(node=>node.contains(document.activeElement)&&document.activeElement!==node&&document.activeElement.getAttribute('tabindex')==='-1'&&document.activeElement.textContent==='Track'),true,'Actual native close returns to the content-sized focusable label, never BODY or the table-wide row');
});

test('native column menu anchors to intrinsic label width and disposal restores bare text without touching native sort',async ({page})=>{
 await fixture(page);await page.setViewportSize({width:1200,height:800});
 await page.evaluate(()=>{document.querySelector('#host').style.width='1100px';});
 await settleCorrectionFrames(page);
 await page.locator(title).dispatchEvent('contextmenu',{bubbles:true,cancelable:true,button:2});
 const menu=page.getByRole('menu',{name:'Track columns'});await waitForMenu(menu);
 const rect=await menuBounds(menu),cell=await titleBounds(page),table=await tableBounds(page);
 assert.ok(rect.width<cell.width,'Native Choice width does not inherit the stretched title-cell width');
 assert.ok(rect.width<table.width/2,'Wide table cannot force native content menu to table width');
 await page.keyboard.press('Escape');
 const label=await focusedLabelGeometry(page);
 assert.equal(label.text,'Track');assert.equal(label.tabindex,'-1');assert.ok(label.width<cell.width/2);
 await page.evaluate(()=>binding.dispose());
 assert.equal(await page.locator(title).evaluate(node=>node.innerHTML===pristineTitle),true,'Owner-created wrapper is removed with original text preserved');
 assert.equal(await page.locator(title).evaluate(node=>node.firstChild===pristineTitleNode),true,'Original text node identity survives wrapping and disposal');
 assert.equal(await page.locator('[data-cdt-column-label]').count(),0,'Disposed owner leaves no synthetic label wrappers');
 assert.equal(await page.locator(sort).evaluate(node=>node===pristineSort),true,'Native sort button is retained rather than wrapped/replaced');
 assert.equal(await page.locator(header).getAttribute('tabindex'),null,'Original header tab order restored');
});

test('header keyboard opening uses real visible content label rather than whole-header menu anchor',async ({page})=>{
 await fixture(page);await page.locator(header).focus();await page.keyboard.press('Alt+ArrowDown');
 await waitForColumnMenu(page);await page.keyboard.press('Escape');
 assert.equal(await page.locator(title).evaluate(node=>node.contains(document.activeElement)&&document.activeElement.getAttribute('tabindex')==='-1'),true);
});

test('actual React Playlist long title shrinks inside artwork identity and receives native ellipsis',async ({page})=>{
 await fixture(page);
 await mountLongPlaylistTitle(page);
 await waitForResponsivePlaylist(page);
 const geometry=await playlistTitleGeometry(page);
 assert.ok(geometry.title>0);assert.ok(geometry.title<=geometry.identity-geometry.art,'Text child shrinks to space left after actual native artwork');
 assert.ok(geometry.parent<=geometry.identity-geometry.art);assert.ok(geometry.titleRight<=geometry.cellRight+1,'Title element itself fits; ancestor clipping alone cannot satisfy this');
 assert.ok(geometry.scroll>geometry.client,'Long source title remains present beyond rendered text width');
 assert.equal(geometry.overflow,'hidden');assert.equal(geometry.ellipsis,'ellipsis');assert.equal(geometry.whiteSpace,'nowrap');
 assert.equal(await documentOverflows(page),false);
});
