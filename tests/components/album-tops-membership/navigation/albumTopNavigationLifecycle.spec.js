const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const {name,navigationError,retry,settlePaint,editing,noNavigationFailure,noRenderErrors}=require('./lifecycle-actions.cjs');

test('held Save and held authoritative refresh retire the inline owner after commit without a render-phase update warning',async({page})=>{
  const observed=await editing(page,{holdWrite:true,holdRefresh:true});await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);await expect(name(page)).toBeDisabled();
  await page.evaluate(()=>navFixture.resolveWrite());await expect.poll(()=>page.evaluate(()=>navFixture.getPersisted().revision)).toBe('8');
  await expect(name(page)).toBeDisabled();await page.evaluate(()=>navFixture.resolveRefresh());await expect(name(page)).toHaveCount(0);await settlePaint(page);
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Authored retained title',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Edit Album Top',exact:true})).toBeFocused();
  expect(await page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);await noNavigationFailure(page);noRenderErrors(observed);
});

test('a sidebar attempt blocked by busy Save leaves no false navigation error after successful saved-detail refresh',async({page})=>{
  const observed=await editing(page,{holdWrite:true});await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);
  await page.getByRole('button',{name:'All Album Tops',exact:true}).click();await page.getByRole('link',{name:'Other Top',exact:true}).click();await settlePaint(page);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(0);await noNavigationFailure(page);
  await page.evaluate(()=>navFixture.resolveWrite());await expect(name(page)).toHaveCount(0);await settlePaint(page);await noNavigationFailure(page);noRenderErrors(observed);
});

for(const mode of ['decline','cancel-editor','busy','uncertain'])test(`${mode} is an intentional no-navigation result, not a destination load failure`,async({page})=>{
  const observed=await editing(page,{holdWrite:mode==='busy',uncertain:mode==='uncertain'});
  if(mode==='busy'||mode==='uncertain'){await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);}
  if(mode==='cancel-editor')await page.locator('form[aria-label="Edit Album Top"]').getByRole('button',{name:'Cancel',exact:true}).click();
  else await page.getByRole('button',{name:'All Album Tops',exact:true}).click();
  if(mode==='decline'||mode==='cancel-editor'){await expect(page.locator('#app-confirm-modal')).toBeVisible();await page.locator('#app-confirm-cancel').click();}
  await settlePaint(page);await noNavigationFailure(page);await expect(name(page)).toHaveValue('Authored retained title');
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);expect(await page.evaluate(()=>navFixture.calls.writes.length)).toBe(mode==='busy'||mode==='uncertain'?1:0);noRenderErrors(observed);
});

for(const failure of ['reject','false','wrong-resource'])test(`a genuinely started ${failure} destination failure still offers a working exact-target retry`,async({page})=>{
  const observed=await mount(page,{navigationFailure:failure});await page.getByRole('link',{name:'Other Top',exact:true}).click();
  await expect(navigationError(page)).toBeVisible();await expect(retry(page)).toBeVisible();
  expect(await page.evaluate(()=>navFixture.calls.navigation.length)).toBe(1);expect(await page.evaluate(()=>navFixture.calls.navigation[0])).toContain('top_ref=00000000-0000-4000-8000-000000000002');
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);await page.evaluate(()=>navFixture.allowNavigation());await retry(page).click();
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Other Top',{exact:true})).toBeVisible();await noNavigationFailure(page);
  expect(await page.evaluate(()=>navFixture.calls.navigation.length)).toBe(2);
  expect(await page.evaluate(()=>navFixture.calls.navigation[1])).toBe(await page.evaluate(()=>navFixture.calls.navigation[0]));noRenderErrors(observed);
});

for(const change of ['changeScope','changeGeneration','newerHistory','revise'])test(`${change} retirement has no render warning and no queued old close can erase a replacement editor`,async({page})=>{
  const observed=await editing(page);await page.evaluate(change=>navFixture[change](),change);await settlePaint(page);
  if(await name(page).count()){
    await expect(name(page)).toBeDisabled();await page.locator('form[aria-label="Edit Album Top"]').getByRole('button',{name:'Cancel',exact:true}).click();
  }
  await expect(page.getByRole('button',{name:'Edit Album Top',exact:true})).toBeVisible();await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  await expect(name(page)).toBeEnabled();await name(page).fill('Replacement editor remains');
  const replacement=await name(page).elementHandle();await page.evaluate(()=>AlbumHavenAlbumTopsRuntime.snapshot());await settlePaint(page);
  await expect(name(page)).toHaveValue('Replacement editor remains');expect(await name(page).evaluate((node,original)=>node===original,replacement)).toBe(true);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);noRenderErrors(observed);
});
