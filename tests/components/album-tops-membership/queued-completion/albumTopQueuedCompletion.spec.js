const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const {error,retry,other,settlePaint,target,queued,noErrors,noUnhandled}=require('./queued-actions.cjs');

for(const failure of ['http','network','wrong-resource'])test(`later queued ${failure} completion reaches the Top error owner and one exact-target Retry`,async({page})=>{
  const observed=await mount(page,{navigationFailure:failure});await queued(page);
  await page.getByRole('button',{name:'Release native blocker',exact:true}).click();
  await expect(error(page)).toBeVisible();await expect(retry(page)).toBeVisible();
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([target]);
  expect(await page.evaluate(()=>navFixture.requests.length)).toBe(2);
  await page.getByRole('button',{name:'Allow destination retry',exact:true}).click();await retry(page).click();
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Other Top',{exact:true})).toBeVisible();
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([target,target]);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);await noUnhandled(page,observed);
});

for(const change of ['Change actor scope','Change private context','Server revision change'])test(`a held queued failure retired by ${change} cannot notify or revive the old Session`,async({page})=>{
  const observed=await mount(page,{navigationFailure:'http'});await page.getByRole('checkbox',{name:'Hold destination responses',exact:true}).check();
  await queued(page);await page.getByRole('button',{name:'Release native blocker',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.navigation.length)).toBe(1);
  await page.getByRole('button',{name:change,exact:true}).click();await settlePaint(page);
  await page.getByRole('button',{name:'Release destination response',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>state.busy)).toBe(false);await settlePaint(page);
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
  expect(await page.evaluate(()=>state.view.top_ref)).toBe('00000000-0000-4000-8000-000000000001');
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([target]);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);await noUnhandled(page,observed);
});

test('a newer real directory request supersedes a held queued error without stale Retry or unhandled rejection',async({page})=>{
  const observed=await mount(page,{navigationFailure:'network'});await page.getByRole('checkbox',{name:'Hold destination responses',exact:true}).check();
  await queued(page);await page.getByRole('button',{name:'Release native blocker',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navFixture.calls.navigation.length)).toBe(1);
  await page.getByRole('button',{name:'Allow destination retry',exact:true}).click();
  await page.getByRole('checkbox',{name:'Hold destination responses',exact:true}).uncheck();
  await page.getByRole('button',{name:'All Album Tops',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>state.view.top_ref)).toBe(null);
  await page.getByRole('button',{name:'Release destination response',exact:true}).click();await settlePaint(page);
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([target,'/view-data?surface=album_tops']);
  expect(await page.evaluate(()=>navFixture.requests.filter(row=>row.kind==='destination')[0].aborted)).toBe(true);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);await noUnhandled(page,observed);
});
