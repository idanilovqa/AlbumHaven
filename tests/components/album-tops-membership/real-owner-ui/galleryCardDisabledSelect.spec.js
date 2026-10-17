const fs=require('node:fs'),path=require('node:path');
const {test,expect}=require('@playwright/test');
const {mount,root}=require('./browser-fixture.cjs');
const {visual}=require('./gallery-card-measurements.cjs');



// Shared CSS is exercised without an Album Top ancestor or Top layout CSS.
// These are renderer/style assertions, not assertions on a fixture event handler.
for(const mode of ['native-disabled','aria-disabled'])test(`shared GalleryCard Select is visibly inactive for ${mode} without a Top wrapper`,async({page})=>{
  await page.setContent('<!doctype html><html><body><main id="shared-card" style="width:180px"></main></body></html>');
  for(const file of ['button-component.js','runtime/markup-format-helpers.js','runtime/album-artbox.js','runtime/gallery-main-components.js','runtime/gallery-card-component.js']){
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  }
  for(const file of ['runtime/base-layout.css','button-component.css','runtime/album-artbox-and-gallery-card.css']){
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static/css',file),'utf8')});
  }
  await page.evaluate(()=>{document.querySelector('#shared-card').innerHTML=buildGalleryCardHtml({identity:'shared-album',actionRef:'shared-album',interaction:'controlled',actions:{select:true},title:'Shared disabled probe',artist:'Artist',displayMode:'cards',artboxHtml:buildAlbumArtboxHtml({state:'empty',label:'Album artwork'})});});
  const card=page.getByRole('button',{name:'Select Shared disabled probe',exact:true}),node=await card.elementHandle(),enabled=await visual(card);
  expect(enabled.cursor).toBe('pointer');expect(enabled.opacity).toBeGreaterThan(0);
  await card.evaluate((button,mode)=>{if(mode==='native-disabled')button.disabled=true;else button.setAttribute('aria-disabled','true');},mode);
  const disabled=await visual(card);expect(disabled.cursor).not.toBe('pointer');expect(disabled.opacity).toBeLessThan(enabled.opacity);
  expect(await node.evaluate(button=>button.isConnected)).toBe(true);
  await card.hover({force:true});const hovered=await visual(card);expect(hovered.cursor).not.toBe('pointer');expect(hovered.opacity).toBeLessThan(enabled.opacity);
  await card.evaluate(button=>{button.disabled=false;button.removeAttribute('aria-disabled');});
  expect(await visual(card)).toEqual(enabled);expect(await node.evaluate(button=>button.isConnected)).toBe(true);
  await card.focus();await expect(card).toBeFocused();
});

for(const outcome of ['accepted','rejected'])test(`held album admission ${outcome} dims stable Select controls and blocks repeat activation`,async({page})=>{
  const {search,errors}=await mount(page,'top-create',{multiResults:true,holdAdmit:true});await page.getByRole('button',{name:'Find albums',exact:true}).click();await search.fill('edition');
  const first=page.getByRole('button',{name:'Select Found edition',exact:true}),second=page.getByRole('button',{name:'Select Second edition',exact:true});
  const firstNode=await first.elementHandle(),secondNode=await second.elementHandle(),enabled=await visual(second);
  await first.focus();await first.press('Enter');await expect(first).toBeDisabled();await expect(second).toBeDisabled();
  for(const card of [first,second]){const style=await visual(card);expect(style.aria).toBe('true');expect(style.cursor).not.toBe('pointer');expect(style.opacity).toBeLessThan(enabled.opacity);}
  expect(await firstNode.evaluate(button=>button.isConnected)).toBe(true);expect(await secondNode.evaluate(button=>button.isConnected)).toBe(true);
  // Exercise the actual consumer through disabled browser activation paths.
  await second.click({force:true});await first.evaluate(button=>button.click());await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>reviewFixture.calls.admit)).toEqual([13]);expect(await page.evaluate(()=>reviewFixture.calls.writes)).toEqual([]);
  await page.evaluate(outcome=>outcome==='accepted'?reviewFixture.resolveAdmission():reviewFixture.rejectAdmission(),outcome);
  await expect(second).toBeEnabled();expect(await visual(second)).toEqual(enabled);expect(await secondNode.evaluate(button=>button.isConnected)).toBe(true);
  if(outcome==='accepted'){await expect(first).toHaveCount(0);await expect(second).toBeFocused();}
  else{await expect(first).toBeEnabled();expect(await firstNode.evaluate(button=>button.isConnected)).toBe(true);await expect(first).toBeFocused();}
  expect(errors).toEqual([]);
});

test('held Save dims existing search cards and a definitive rejection restores the same controls',async({page})=>{
  const {search,errors}=await mount(page,'top-inline',{multiResults:true,holdWrite:true,rejectWriteAfterRelease:true});
  await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();await page.getByRole('tab',{name:'All',exact:true}).click();await search.fill('edition');
  const first=page.getByRole('button',{name:'Select Found edition',exact:true}),second=page.getByRole('button',{name:'Select Second edition',exact:true});
  const node=await first.elementHandle(),enabled=await visual(first);
  await page.getByRole('textbox',{name:'Album Top name',exact:true}).fill('Pending Save');await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(first).toBeDisabled();await expect(second).toBeDisabled();
  const disabled=await visual(first);expect(disabled.cursor).not.toBe('pointer');expect(disabled.opacity).toBeLessThan(enabled.opacity);expect(disabled.aria).toBe('true');
  expect(await node.evaluate(button=>button.isConnected)).toBe(true);await first.click({force:true});await second.evaluate(button=>button.click());
  expect(await page.evaluate(()=>reviewFixture.calls.admit)).toEqual([]);expect(await page.evaluate(()=>reviewFixture.calls.writes.length)).toBe(1);
  await page.evaluate(()=>reviewFixture.resolveWrite());await expect(first).toBeEnabled();expect(await visual(first)).toEqual(enabled);
  expect(await node.evaluate(button=>button.isConnected)).toBe(true);await first.focus();await expect(first).toBeFocused();
  await first.press('Enter');await expect.poll(()=>page.evaluate(()=>reviewFixture.calls.admit.length)).toBe(1);
  expect(await page.evaluate(()=>reviewFixture.getPersisted())).toEqual(await page.evaluate(()=>reviewFixture.original));expect(errors).toEqual([]);
});
