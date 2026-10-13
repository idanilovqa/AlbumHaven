const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
test('a real pending search completion cannot hide or discard the source while Back-to-Settings confirmation is open',async({page})=>{
  const {errors}=await mount(page,{previousSettings:true,holdSearch:true});await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  const title=page.getByRole('textbox',{name:'Album Top name',exact:true});await title.fill('Keep this through repaint');
  await page.getByRole('tab',{name:'All',exact:true}).click();await page.getByRole('searchbox').fill('Pending repaint');
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.search.length)).toBe(1);await page.evaluate(()=>history.back());
  await expect(page.locator('#app-confirm-modal')).toBeVisible();await expect.poll(()=>new URL(page.url()).pathname).toBe('/account');
  await page.evaluate(()=>navFixture.resolveSearch());
  await expect(page.getByRole('button',{name:/Select.*Found edition/i})).toBeVisible();await expect(title).toHaveValue('Keep this through repaint');
  expect(await page.evaluate(()=>AlbumHavenAlbumTopsRuntime.snapshot().visible)).toBe(true);
  expect(await page.evaluate(()=>navFixture.calls.settings.length)).toBe(0);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);
  await page.locator('#app-confirm-cancel').click();await expect.poll(()=>new URL(page.url()).pathname).toBe('/');
  await expect(title).toHaveValue('Keep this through repaint');expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(1);expect(errors).toEqual([]);
});
