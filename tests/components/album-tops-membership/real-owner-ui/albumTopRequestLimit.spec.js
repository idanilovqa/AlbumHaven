const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
// Presentation seam: the independent actual provider suite proves local byte-limit enforcement.
for(const phase of ['preview','command'])test(`${phase} command_too_large gives actionable selection-limit guidance and Cancel preserves the saved Top`,async({page})=>{
  const options={confirmDiscard:true,[phase==='preview'?'previewSourceError':'commandSourceError']:'command_too_large'};
  const {errors}=await mount(page,'top-inline',options);await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  const title=page.getByRole('textbox',{name:'Album Top name',exact:true}),subtitle=page.getByRole('textbox',{name:'Album Top subtitle',exact:true});
  await title.fill('Preserve my title');await subtitle.fill('Preserve my subtitle');
  if(phase==='command')await page.getByRole('button',{name:/Remove Retained nonlocal/i}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('alert').first()).toBeVisible();
  const text=(await page.getByRole('alert').allTextContents()).join(' ');
  expect(text).toMatch(/too (large|many)|size|limit/i);expect(text).toMatch(/album|selection/i);
  expect(text).toMatch(/draft/i);expect(text).toMatch(/preserv|retain|kept|still/i);expect(text).toMatch(/cancel/i);expect(text).toMatch(/saved/i);
  expect(text).not.toMatch(/saved successfully|changes were saved|will automatically split|select a source|choose a source/i);
  await expect(title).toHaveValue('Preserve my title');await expect(subtitle).toHaveValue('Preserve my subtitle');
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>reviewFixture.controller.canRetryMutation())).toBe(false);
  expect(await page.evaluate(()=>reviewFixture.getPersisted())).toEqual(await page.evaluate(()=>reviewFixture.original));
  expect(await page.evaluate(()=>reviewFixture.calls.writes.length)).toBe(phase==='preview'?0:1);
  if(phase==='command')expect(await page.evaluate(()=>reviewFixture.calls.writes[0].command.items)).toEqual(await page.evaluate(()=>reviewFixture.original.edit_draft.items.slice(0,1)));
  else expect(await page.evaluate(()=>reviewFixture.calls.preview[0].payload.items)).toEqual(await page.evaluate(()=>reviewFixture.original.edit_draft.items));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('dialog',{name:'Discard Album Top changes',exact:true}).getByRole('button',{name:'Discard',exact:true}).click();await expect(title).toHaveCount(0);
  await expect(page.getByText('Curated Top',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>reviewFixture.getPersisted())).toEqual(await page.evaluate(()=>reviewFixture.original));expect(errors).toEqual([]);
});
