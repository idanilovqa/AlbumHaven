const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const {other,error,retry,target,settlePaint,clean}=require('./retirement-actions.cjs');

for(const failure of ['abort','wrong-resource','http','network'])test(`same-ID local claim before direct ${failure} termination does not manufacture a stale Retry`,async({page})=>{
  const observed=await mount(page,{navigationFailure:failure==='abort'?null:failure});
  await page.getByRole('checkbox',{name:'Hold destination responses',exact:true}).check();
  if(failure!=='abort')await page.getByRole('checkbox',{name:'Deliver held response after abort (fixture)',exact:true}).check();
  await other(page).click();await expect.poll(()=>page.evaluate(()=>navFixture.calls.navigation.length)).toBe(1);
  const before=await page.evaluate(()=>({id:state.ui.activeViewRequestId,revision:Number(state.ui.viewStateRevision||0),top:state.view.top_ref}));
  await page.getByRole('button',{name:'Claim local view navigation',exact:true}).click();
  const claimed=await page.evaluate(()=>({id:state.ui.activeViewRequestId,revision:Number(state.ui.viewStateRevision||0),top:state.view.top_ref}));
  expect(claimed).toEqual({...before,revision:before.revision+1});
  expect(await page.evaluate(()=>navFixture.requests[0].aborted)).toBe(true);
  await page.getByRole('button',{name:'Release destination response',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>state.busy)).toBe(false);await settlePaint(page);
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Curated Top',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([target]);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);await clean(page,observed);
});
for(const failure of ['wrong-resource','http','network'])test(`current direct ${failure} remains actionable and Retry opens the original target`,async({page})=>{
  const observed=await mount(page,{navigationFailure:failure});await other(page).click();
  await expect(error(page)).toBeVisible();await expect(retry(page)).toBeVisible();
  await page.getByRole('button',{name:'Allow destination retry',exact:true}).click();await retry(page).click();
  await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Other Top',{exact:true})).toBeVisible();
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([target,target]);await clean(page,observed);
});
test('local claim of an unstarted native queue stays quiet and never dispatches the obsolete destination',async({page})=>{
  const observed=await mount(page);await page.getByRole('button',{name:'Hold noninterruptible request',exact:true}).click();await other(page).click();
  await settlePaint(page);expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);
  await page.getByRole('button',{name:'Claim local view navigation',exact:true}).click();
  await page.getByRole('button',{name:'Release native blocker',exact:true}).click();await expect.poll(()=>page.evaluate(()=>state.busy)).toBe(false);
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
  expect(await page.evaluate(()=>navFixture.requests.length)).toBe(1);expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);await clean(page,observed);
});
