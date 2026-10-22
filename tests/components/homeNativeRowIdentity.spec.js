const {test, expect, mount, settleFrames} = require('./homeNativeRowIdentityFixture');

test('ArtistRow retains focused native row through unrelated, selected and label refreshes with latest callback', async ({page}) => {
  await mount(page); const artist=page.locator('[data-home-artist-select="artist:one"]');
  await artist.focus(); await artist.evaluate(node=>{window.artistOriginal=node;});
  for (const patch of [{},{artistSelected:true},{artistTitle:'Updated Artist'}]) {
    await page.evaluate(patch=>window.rowUpdate(patch),patch);
    await expect(artist).toBeFocused(); expect(await artist.evaluate(node=>node===window.artistOriginal)).toBe(true);
  }
  await expect(artist).toHaveAttribute('aria-current','true'); await expect(artist).toContainText('Updated Artist');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>window.rowCalls)).toEqual(['artist:3:Updated Artist']);
});

test('ArtistRow readability revocation changes the same native node and suppresses its old action', async ({page}) => {
  await mount(page); const artist=page.locator('[data-home-artist-select="artist:one"]');
  await artist.evaluate(node=>{window.artistOriginal=node;});
  await page.evaluate(()=>window.rowUpdate({readable:false}));
  await expect(artist).toBeDisabled(); await expect(artist).toContainText('Unavailable artist');
  expect(await artist.evaluate(node=>node===window.artistOriginal)).toBe(true);
  await page.evaluate(()=>window.artistOriginal.click()); expect(await page.evaluate(()=>window.rowCalls)).toEqual([]);
  await page.evaluate(()=>window.rowUpdate({readable:true})); await expect(artist).toBeEnabled();
  expect(await artist.evaluate(node=>node===window.artistOriginal)).toBe(true);
  await artist.click(); expect(await page.evaluate(()=>window.rowCalls)).toEqual(['artist:2:Artist One']);
});

test('PersonNavigation preserves focus and current selected markup across no-op and label refreshes', async ({page}) => {
  await mount(page); const person=page.locator('[data-home-person-row="person:one"]');
  await person.focus(); await person.evaluate(node=>{window.personOriginal=node;});
  for (const patch of [{},{personSelected:true},{personTitle:'Updated Person'}]) {
    await page.evaluate(patch=>window.rowUpdate(patch),patch);
    expect(await person.evaluate(node=>node===window.personOriginal)).toBe(true); await expect(person).toBeFocused();
  }
  await expect(person).toHaveAttribute('aria-current','true'); await expect(person).toContainText('Updated Person');
});

test('PersonNavigation onSelect parent render preserves its native node and completes deferred activation once', async ({page}) => {
  await mount(page); const person=page.locator('[data-home-person-row="person:one"]');
  await person.evaluate(node=>{window.personOriginal=node;}); await person.click();
  await expect(person).toHaveAttribute('aria-current','true'); await expect(person).toBeFocused();
  expect(await person.evaluate(node=>node===window.personOriginal)).toBe(true);
  await settleFrames(page);
  expect(await page.evaluate(()=>window.rowCalls)).toEqual(['select','activate:1:true']);
});

for (const mode of ['revoke','hide','unmount']) test(`PersonNavigation ${mode} during onSelect suppresses deferred activation`, async ({page}) => {
  await mount(page); await page.evaluate(mode=>window.rowUpdate({mode}),mode);
  await page.locator('[data-home-person-row="person:one"]').click(); await settleFrames(page);
  expect(await page.evaluate(()=>window.rowCalls)).toEqual(['select']);
  if (mode==='revoke') await expect(page.locator('[data-home-person-row="person:one"]')).toBeDisabled();
  if (mode==='hide') await expect(page.locator('[data-home-person-row="person:one"]')).toBeHidden();
  if (mode==='unmount') await expect(page.locator('[data-home-person-row="person:one"]')).toHaveCount(0);
});

test('newer same-row activation cancels the first pending frame sequence and uses latest parent callback', async ({page}) => {
  await mount(page); await page.evaluate(()=>window.clickPersonTwice()); await settleFrames(page);
  expect(await page.evaluate(()=>window.rowCalls)).toEqual(['select','select','activate:2:true']);
});
