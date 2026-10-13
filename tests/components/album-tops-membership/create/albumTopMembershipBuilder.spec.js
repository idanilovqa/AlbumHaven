// Actual React reconciliation, native shared controls and NativeDialog portal.
// Synthetic transport and native-host lifecycle keep this a component test,
// not authenticated Postgres E2E or native modal-stack/focus-trap acceptance.
const {test, expect} = require('@playwright/test');
const {mount,pick,primary}=require('./builder-fixture.cjs');

test('mounted create is query-first and submits selected canonical identity exactly once', async ({page}) => {
  const {errors, search, name} = await mount(page, {holdWrite: true});
  expect(await page.evaluate(() => topFixture.calls.search)).toEqual([]); await expect(primary(page)).toBeDisabled();
  await name.fill('New curated Top'); await search.fill('edition'); await pick(page).click();
  await page.getByRole('tab', {name: /^Selected/}).click(); await expect(page.getByText('Found edition', {exact: true})).toBeVisible();
  await primary(page).click(); await expect(primary(page)).toBeDisabled();
  expect(await page.evaluate(() => topFixture.calls.writes)).toEqual([{action:'create',command:{title:'New curated Top',description:'',album_refs:['00000000-0000-4000-8000-000000000013'],request_key:'00000000-0000-4000-8000-000000000100'}}]);
  await expect(page.getByRole('button', {name:'Cancel',exact:true})).toBeDisabled();
  await page.evaluate(() => topFixture.resolveWrite()); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#opener')).toBeFocused(); expect(errors).toEqual([]);
});

test('mounted edit removes and keyboard-reorders retained identities in one changed Save', async ({page}) => {
  const {errors, name} = await mount(page, {editing:true}); const save=page.getByRole('button',{name:'Save',exact:true});
  await expect(save).toBeDisabled(); await page.getByRole('tab',{name:/^Selected/}).click();
  await page.getByRole('button',{name:/Reorder Retained nonlocal/i}).press('Home');
  await page.getByRole('button',{name:/Remove Retained local/i}).click(); await name.fill('Renamed nonlocal Top'); await save.click();
  const calls=await page.evaluate(()=>topFixture.calls.writes); expect(calls).toHaveLength(1); expect(calls[0].action).toBe('save');
  expect(calls[0].command).toEqual({title:'Renamed nonlocal Top',description:'Subtitle',revision:'7',top_ref:'00000000-0000-4000-8000-000000000001',request_key:'00000000-0000-4000-8000-000000000100',
    items:[{item_ref:'00000000-0000-4000-8000-000000000022',album_ref:'00000000-0000-4000-8000-000000000012'}]});
  expect(errors).toEqual([]);
});

test('dirty Cancel requests confirmation and leaves persisted membership untouched', async ({page}) => {
  const {name,errors}=await mount(page,{editing:true,confirmDiscard:true}); await name.fill('Cancelled rename');
  await page.getByRole('tab',{name:/^Selected/}).click(); await page.getByRole('button',{name:/Remove Retained local/i}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const result=await page.evaluate(()=>({writes:topFixture.calls.writes,confirms:topFixture.calls.confirms.length,persisted:topFixture.getPersisted(),original:topFixture.original}));
  expect(result.writes).toEqual([]);expect(result.confirms).toBe(1);expect(result.persisted).toEqual(result.original);expect(errors).toEqual([]);
});

test('search clearing, failures and Selected tabs preserve the membership draft', async ({page}) => {
  const {search,errors}=await mount(page); await search.fill('edition');await pick(page).click();
  await search.fill('failure');await page.getByRole('tab',{name:/^Selected/}).click();await expect(page.getByText('Found edition',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:/^All/}).click();await search.fill('');await page.getByRole('tab',{name:/^Selected/}).click();
  await expect(page.getByText('Found edition',{exact:true})).toBeVisible();expect(await page.evaluate(()=>topFixture.calls.writes)).toEqual([]);expect(errors).toEqual([]);
});

test('a filtered empty page offers continuation to authorized album metadata', async ({page}) => {
  const {search}=await mount(page);await search.fill('filtered');await page.getByRole('button',{name:/load more|show more|continue/i}).click();await expect(pick(page)).toBeVisible();
  expect(await page.evaluate(()=>topFixture.calls.search.map(row=>row.cursor??null))).toEqual([null,'continued']);
});

test('unmount during search cannot repaint a disposed builder or admit albums', async ({page}) => {
  const {search,errors}=await mount(page,{holdSearch:true});await search.fill('edition');
  await expect.poll(()=>page.evaluate(()=>topFixture.calls.search.length)).toBe(1);await page.evaluate(()=>{topFixture.dispose();topFixture.resolveSearch();});
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Found edition',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>({admit:topFixture.calls.admit,writes:topFixture.calls.writes}))).toEqual({admit:[],writes:[]});expect(errors).toEqual([]);
});

for (const width of [390,1100]) test(`compact native cards and builder controls fit ${width}px without document overflow`, async ({page})=>{
  await page.setViewportSize({width,height:844});const {search,errors}=await mount(page);await search.fill('edition');await expect(pick(page)).toBeVisible();
  expect(await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}))).toEqual({scroll:width,width});
  const button=await pick(page).boundingBox();expect(button.width).toBeGreaterThan(0);expect(button.x).toBeGreaterThanOrEqual(0);expect(button.x+button.width).toBeLessThanOrEqual(width);
  expect(errors).toEqual([]);
});
