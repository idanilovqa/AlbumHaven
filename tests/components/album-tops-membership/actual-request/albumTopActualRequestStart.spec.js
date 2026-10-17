const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const {error,retry,other,settlePaint,noFailure,noErrors}=require('./request-start-actions.cjs');

test('same-URL busy refusal in real fetchAndRender creates no false Top failure banner',async({page})=>{
  const observed=await mount(page);await page.getByRole('button',{name:'Hold same-URL request',exact:true}).click();
  await other(page).click();await settlePaint(page);await noFailure(page);
  expect(await page.evaluate(()=>navFixture.requests.map(row=>({url:row.url,kind:row.kind})))).toEqual([
    {url:'/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002',kind:'blocker'}]);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);
  await page.getByRole('button',{name:'Release native blocker',exact:true}).click();await settlePaint(page);await noFailure(page);
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Curated Top',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>navFixture.requests.length)).toBe(1);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);noErrors(observed);
});

test('real noninterruptible queue refusal is quiet and its still-current later dispatch opens the exact Top once',async({page})=>{
  const observed=await mount(page);await page.getByRole('button',{name:'Hold noninterruptible request',exact:true}).click();
  await other(page).click();await settlePaint(page);await noFailure(page);
  expect(await page.evaluate(()=>navFixture.requests.length)).toBe(1);expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);
  await page.getByRole('button',{name:'Release native blocker',exact:true}).click();
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Other Top',{exact:true})).toBeVisible();await noFailure(page);
  expect(await page.evaluate(()=>navFixture.requests.length)).toBe(2);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual(['/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002']);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);noErrors(observed);
});

for(const label of ['Change actor scope','Change private context','Server revision change'])test(`queued destination retired by ${label} cannot fetch after the real blocker finishes`,async({page})=>{
  const observed=await mount(page);await page.getByRole('button',{name:'Hold noninterruptible request',exact:true}).click();await other(page).click();
  await settlePaint(page);await noFailure(page);await page.getByRole('button',{name:label,exact:true}).click();await settlePaint(page);
  await page.getByRole('button',{name:'Release native blocker',exact:true}).click();await settlePaint(page);
  expect(await page.evaluate(()=>navFixture.requests.length)).toBe(1);expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);
  expect(await page.evaluate(()=>state.view.top_ref)).toBe('00000000-0000-4000-8000-000000000001');
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);noErrors(observed);
});

for(const failure of ['http','network','wrong-resource'])test(`actual ${failure} response remains actionable and Retry repeats exactly the failed destination`,async({page})=>{
  const observed=await mount(page,{navigationFailure:failure});await other(page).click();await expect(error(page)).toBeVisible();await expect(retry(page)).toBeVisible();
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual(['/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002']);
  await page.getByRole('button',{name:'Allow destination retry',exact:true}).click();await retry(page).click();
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Other Top',{exact:true})).toBeVisible();await noFailure(page);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([
    '/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002',
    '/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002']);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);noErrors(observed);
});

test('native discard decline remains before the genuine request owner with no failure banner or fetch',async({page})=>{
  const observed=await mount(page);await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  await page.getByRole('textbox',{name:'Album Top name',exact:true}).fill('Still authored');await other(page).click();
  await expect(page.locator('#app-confirm-modal')).toBeVisible();await page.locator('#app-confirm-cancel').click();await noFailure(page);
  await expect(page.getByRole('textbox',{name:'Album Top name',exact:true})).toHaveValue('Still authored');
  expect(await page.evaluate(()=>navFixture.requests)).toEqual([]);expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);noErrors(observed);
});
