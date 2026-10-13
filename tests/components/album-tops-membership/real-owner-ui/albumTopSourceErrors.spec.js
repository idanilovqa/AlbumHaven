const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
for(const phase of ['preview','command'])for(const code of ['evidence_unavailable','evidence_stale'])test(`${phase} ${code} is actionable and retains inline draft and saved source bindings`,async({page})=>{
  const options={confirmDiscard:true,[phase==='preview'?'previewSourceError':'commandSourceError']:code};
  const {errors}=await mount(page,'top-inline',options);await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  const title=page.getByRole('textbox',{name:'Album Top name',exact:true});await title.fill('Keep my authored draft');
  // Private metadata omission does not revalidate unchanged sources. Keep bound A and actually remove B.
  if(phase==='command')await page.getByRole('button',{name:/Remove Retained nonlocal/i}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('alert').first()).toBeVisible();const text=(await page.getByRole('alert').allTextContents()).join(' ');
  expect(text).toMatch(/source|metadata/i);expect(text).toMatch(code==='evidence_stale'?/chang|stale/i:/unavailable|cannot|could not/i);
  expect(text).toMatch(/draft/i);expect(text).toMatch(/preserv|retain|kept|still/i);expect(text).toMatch(/cancel/i);expect(text).toMatch(/saved/i);
  expect(text).not.toMatch(/select a source|choose a source|open the source selector/i);
  await expect(title).toHaveValue('Keep my authored draft');
  expect(await page.evaluate(()=>reviewFixture.getPersisted())).toEqual(await page.evaluate(()=>reviewFixture.original));
  expect(await page.evaluate(()=>reviewFixture.calls.writes.length)).toBe(phase==='preview'?0:1);
  if(phase==='command')expect(await page.evaluate(()=>reviewFixture.calls.writes[0].command.items)).toEqual(await page.evaluate(()=>reviewFixture.original.edit_draft.items.slice(0,1)));
  else expect(await page.evaluate(()=>reviewFixture.calls.preview)).toEqual(await page.evaluate(()=>[{ref:reviewFixture.original.top_ref,payload:{revision:reviewFixture.original.revision,items:reviewFixture.original.edit_draft.items}}]));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('dialog',{name:'Discard Album Top changes',exact:true}).getByRole('button',{name:'Discard',exact:true}).click();await expect(title).toHaveCount(0);
  await expect(page.getByText('Curated Top',{exact:true})).toBeVisible();expect(errors).toEqual([]);
});
for(const code of ['evidence_unavailable','evidence_stale'])test(`private metadata-only omission preserves existing bindings without invoking ${code} membership revalidation`,async({page})=>{
  const {errors}=await mount(page,'top-inline',{commandSourceError:code});await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();
  await page.getByRole('textbox',{name:'Album Top name',exact:true}).fill('Lawful metadata rename');
  await page.getByRole('textbox',{name:'Album Top subtitle',exact:true}).fill('Lawful subtitle');await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('button',{name:'Edit Album Top',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>reviewFixture.calls.writes.length)).toBe(1);
  expect(await page.evaluate(()=>Object.hasOwn(reviewFixture.calls.writes[0].command,'items'))).toBe(false);
  expect(await page.evaluate(()=>reviewFixture.getPersisted().edit_draft.items)).toEqual(await page.evaluate(()=>reviewFixture.original.edit_draft.items));
  expect(await page.evaluate(()=>reviewFixture.getPersisted().items)).toEqual(await page.evaluate(()=>reviewFixture.original.items));
  expect(await page.evaluate(()=>reviewFixture.calls.preview)).toEqual([]);await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
