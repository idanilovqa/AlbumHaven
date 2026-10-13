const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');

for(const kind of ['shared-search','playlist-create','top-create'])test(`${kind} preserves the actual input, incremental query, focus and caret through asynchronous resource repaint`,async({page})=>{
  const {errors,search}=await mount(page,kind,{holdSearch:true});
  if(kind==='top-create')await page.getByRole('button',{name:'Find albums',exact:true}).click();
  await search.focus();const original=await search.elementHandle();
  await search.pressSequentially('Pink');await expect(search).toHaveValue('Pink');await expect(search).toBeFocused();
  await search.press('ArrowLeft');await search.press('ArrowLeft');
  expect(await original.evaluate(node=>({connected:node.isConnected,focused:node===document.activeElement,start:node.selectionStart,end:node.selectionEnd,value:node.value})))
    .toEqual({connected:true,focused:true,start:2,end:2,value:'Pink'});
  await page.evaluate(()=>reviewFixture.resolveSearch('Pink'));
  if(kind==='top-create')await expect(page.getByRole('button',{name:/Select.*Found edition/i})).toBeVisible();
  else if(kind==='playlist-create')await expect.poll(()=>page.evaluate(()=>reviewFixture.controller.getSnapshot().pageStatus)).toBe('idle');
  else await expect(page.getByLabel('Resource phase')).toHaveText('ready');
  expect(await original.evaluate(node=>({connected:node.isConnected,focused:node===document.activeElement,start:node.selectionStart,end:node.selectionEnd,value:node.value})))
    .toEqual({connected:true,focused:true,start:2,end:2,value:'Pink'});
  await search.pressSequentially('x');await expect(search).toHaveValue('Pixnk');
  expect((await page.evaluate(()=>reviewFixture.calls.search)).at(-1).q).toBe('Pixnk');
  await page.getByRole('tab',{name:/^Selected/}).click();await expect(search).toHaveValue('Pixnk');
  await page.getByRole('tab',{name:'All',exact:true}).click();await expect(search).toHaveValue('Pixnk');
  expect(await original.evaluate(node=>node.isConnected)).toBe(true);expect(errors).toEqual([]);
});

test('failed replacement query removes obsolete clickable cards and its old continuation from the mounted Top',async({page})=>{
  const {search,errors}=await mount(page,'top-create');await page.getByRole('button',{name:'Find albums',exact:true}).click();
  await search.fill('old');await expect(page.getByRole('button',{name:/Select.*Found edition/i})).toBeVisible();await expect(page.getByRole('button',{name:/Load more albums/i})).toBeVisible();
  await search.fill('failure');await expect(page.getByRole('button',{name:/Retry search/i})).toBeVisible();
  await expect(page.getByRole('button',{name:/Select.*Found edition/i})).toHaveCount(0);await expect(page.getByRole('button',{name:/Load more albums/i})).toHaveCount(0);
  expect(await page.evaluate(()=>reviewFixture.calls.admit)).toEqual([]);expect(errors).toEqual([]);
});

test('selecting and removing focused album cards moves focus to a surviving action or current tab',async({page})=>{
  const {search,errors}=await mount(page,'top-create',{multiResults:true});await page.getByRole('button',{name:'Find albums',exact:true}).click();await search.fill('edition');
  const first=page.getByRole('button',{name:/Select.*Found edition/i}),second=page.getByRole('button',{name:/Select.*Second edition/i});
  await first.focus();await first.press('Enter');await expect(second).toBeFocused();
  await second.press('Enter');await expect(page.getByRole('tab',{name:'All',exact:true})).toBeFocused();
  await page.getByRole('tab',{name:/^Selected/}).click();
  const removeFirst=page.getByRole('button',{name:/Remove Found edition/i}),removeSecond=page.getByRole('button',{name:/Remove Second edition/i});
  await removeFirst.focus();await removeFirst.press('Enter');await expect(removeSecond).toBeFocused();
  await removeSecond.press('Enter');await expect(page.getByRole('tab',{name:/^Selected/})).toBeFocused();
  expect(await page.evaluate(()=>reviewFixture.calls.writes)).toEqual([]);expect(errors).toEqual([]);
});

for(const outcome of ['failure','focus-moved'])test(`pending selection ${outcome} retains intentional focus ownership`,async({page})=>{
  const {search,errors}=await mount(page,'top-create',{multiResults:true,holdAdmit:true});await page.getByRole('button',{name:'Find albums',exact:true}).click();await search.fill('edition');
  const pick=page.getByRole('button',{name:/Select.*Found edition/i});await pick.focus();await pick.press('Enter');
  await expect.poll(()=>page.evaluate(()=>reviewFixture.calls.admit.length)).toBe(1);
  if(outcome==='focus-moved'){
    await page.locator('#opener').focus();await page.evaluate(()=>reviewFixture.resolveAdmission());
    await expect(page.getByRole('button',{name:/Select.*Second edition/i})).toBeEnabled();await expect(page.locator('#opener')).toBeFocused();
  }else{
    await page.evaluate(()=>reviewFixture.rejectAdmission());await expect(pick).toBeEnabled();await expect(pick).toBeFocused();
  }
  expect(errors).toEqual([]);
});
