const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const {title,subtitle,prompt,keys,edit,depart,unchanged}=require('./navigation-actions.cjs');

for(const kind of ['sidebar','other-top','settings','history'])test(`dirty ${kind} departure declines through the real shared owner without losing the inline draft`,async({page})=>{
  const {errors}=await edit(page,{previousSettings:kind==='history'});const url=page.url();await depart(page,kind);await expect(prompt(page)).toBeVisible();
  await expect(title(page)).toBeVisible();expect(await page.evaluate(()=>navFixture.calls.navigation.length+navFixture.calls.settings.length)).toBe(0);
  await page.locator('#app-confirm-cancel').click();await expect(prompt(page)).toBeHidden();await expect.poll(()=>page.url()).toBe(url);await unchanged(page);
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(1);expect(errors).toEqual([]);
});

for(const kind of ['sidebar','settings','history'])test(`dirty ${kind} acceptance commits one intended departure and never restores the abandoned editor`,async({page})=>{
  const {errors}=await edit(page,{previousSettings:kind==='history',holdSearch:true});
  await page.getByRole('tab',{name:'All',exact:true}).click();await page.getByRole('searchbox').fill('Pending source');
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.search.length)).toBe(1);await depart(page,kind);await expect(prompt(page)).toBeVisible();
  await page.locator('#app-confirm-accept').click();await expect(title(page)).toHaveCount(0);
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(1);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);
  expect(await page.evaluate(()=>navFixture.calls.navigation.length)).toBe(kind==='sidebar'?1:0);
  expect(await page.evaluate(()=>navFixture.calls.settings.length)).toBe(kind==='sidebar'?0:1);
  expect(await page.evaluate(()=>navFixture.calls.aborts)).toBe(1);await page.evaluate(()=>navFixture.resolveSearch());
  if(kind==='history')await page.evaluate(()=>history.forward());else await page.evaluate(()=>history.back());
  await expect(page.getByRole('button',{name:'Edit Album Top',exact:true})).toBeVisible();await expect(title(page)).toHaveCount(0);
  await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();await expect(title(page)).toHaveValue('Curated Top');
  expect(await page.evaluate(()=>navFixture.getPersisted())).toEqual(await page.evaluate(()=>navFixture.original));expect(errors).toEqual([]);
});

for(const kind of ['sidebar','settings','history'])test(`clean inline ${kind} departure needs no discard prompt`,async({page})=>{
  const {errors}=await edit(page,{previousSettings:kind==='history'},false);await depart(page,kind);await expect(title(page)).toHaveCount(0);
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(0);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);expect(errors).toEqual([]);
});

test('sidebar, inline Cancel and header Back re-entry share one pending native confirmation and one destination',async({page})=>{
  const {errors}=await edit(page);await depart(page,'sidebar');await expect(prompt(page)).toBeVisible();
  await page.getByRole('button',{name:'All Album Tops',exact:true}).dispatchEvent('click');
  await page.locator('form[aria-label="Edit Album Top"]').getByRole('button',{name:'Cancel',exact:true}).dispatchEvent('click');
  await page.getByRole('button',{name:'Back',exact:true}).dispatchEvent('click');
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(1);await page.locator('#app-confirm-accept').click();
  await expect(title(page)).toHaveCount(0);expect(await page.evaluate(()=>navFixture.calls.navigation.length)).toBe(1);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);expect(errors).toEqual([]);
});

for(const uncertain of [false,true])test(`${uncertain?'uncertain':'busy'} Save blocks sidebar and Settings without replacement navigation or a discard prompt`,async({page})=>{
  const {errors}=await edit(page,{holdWrite:!uncertain,uncertain});await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);
  await depart(page,'sidebar');await depart(page,'settings');
  expect(await page.evaluate(()=>navFixture.calls.navigation.length+navFixture.calls.settings.length)).toBe(0);
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(0);await expect(title(page)).toHaveValue('Unsaved navigation title');
  expect(await page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);expect(errors).toEqual([]);
});

for(const change of ['changeScope','changeGeneration','revise','revoke','newerHistory','dispose'])test(`late native confirmation after ${change} cannot navigate or revive obsolete draft authority`,async({page})=>{
  const {errors}=await edit(page);await depart(page,'sidebar');await expect(prompt(page)).toBeVisible();
  await page.evaluate(change=>navFixture[change](),change);
  // The production adapter may actively cancel the native dialog. If still pending, settle its actual accept control.
  if(await prompt(page).isVisible())await page.locator('#app-confirm-accept').click();
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.navigation.length)).toBe(0);
  expect(await page.evaluate(()=>navFixture.calls.settings.length)).toBe(0);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(1);
  if(await title(page).count())await expect(title(page)).toBeDisabled();expect(errors).toEqual([]);
});

for(const change of ['changeScope','changeGeneration','revise','revoke'])test(`external ${change} without a user departure retires unsafe actions without a discard prompt`,async({page})=>{
  const {errors}=await edit(page);await page.evaluate(change=>navFixture[change](),change);
  expect(await page.evaluate(()=>navFixture.calls.confirm)).toBe(0);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);
  if(await title(page).count())await expect(title(page)).toBeDisabled();expect(errors).toEqual([]);
});

test('declining navigation then Save keeps exact reordered original item/source bindings',async({page})=>{
  const {errors}=await edit(page);await depart(page,'settings');await expect(prompt(page)).toBeVisible();await page.locator('#app-confirm-cancel').click();await unchanged(page);
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navFixture.calls.writes.length)).toBe(1);
  expect(await page.evaluate(()=>navFixture.calls.writes[0].command.items)).toEqual(await page.evaluate(()=>[...navFixture.original.edit_draft.items].reverse()));
  expect(await page.evaluate(()=>navFixture.calls.navigation.length+navFixture.calls.settings.length)).toBe(0);expect(errors).toEqual([]);
});

for(const flag of ['missingRegistration','rejectedRegistration'])test(`${flag} cannot enable a modern inline editor without a departure owner`,async({page})=>{
  const {errors}=await mount(page,{[flag]:true});await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  await expect(title(page)).toBeDisabled();await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>navFixture.calls.forms)).toBe(0);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);expect(errors).toEqual([]);
});
