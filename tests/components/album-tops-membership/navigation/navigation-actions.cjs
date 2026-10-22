const {expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const title=page=>page.getByRole('textbox',{name:'Album Top name',exact:true});
const subtitle=page=>page.getByRole('textbox',{name:'Album Top subtitle',exact:true});
const prompt=page=>page.locator('#app-confirm-modal');
const keys=page=>page.locator('[data-album-draft-key]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-album-draft-key')));
async function edit(page,options={},dirty=true){
  const result=await mount(page,options),before=await page.evaluate(()=>({length:history.length,state:structuredClone(history.state),url:location.href}));
  await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();await expect(title(page)).toBeEnabled();
  expect(await page.evaluate(()=>({length:history.length,state:structuredClone(history.state),url:location.href}))).toEqual(before);
  expect(await page.evaluate(()=>navFixture.calls.forms)).toBe(0);
  if(dirty){await title(page).fill('Unsaved navigation title');await subtitle(page).fill('Unsaved navigation subtitle');await page.getByRole('button',{name:/Reorder Retained nonlocal/i}).press('Home');}
  return result;
}
async function depart(page,kind){
  if(kind==='sidebar')await page.getByRole('button',{name:'All Album Tops',exact:true}).click();
  else if(kind==='other-top')await page.getByRole('link',{name:'Other Top',exact:true}).click();
  else if(kind==='settings')await page.getByRole('link',{name:'Open Settings',exact:true}).click();
  else await page.evaluate(()=>history.back());
}
async function unchanged(page){
  await expect(title(page)).toHaveValue('Unsaved navigation title');await expect(subtitle(page)).toHaveValue('Unsaved navigation subtitle');
  expect(await keys(page)).toEqual(['00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000011']);
  expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);expect(await page.evaluate(()=>navFixture.getPersisted())).toEqual(await page.evaluate(()=>navFixture.original));
}


module.exports={title,subtitle,prompt,keys,edit,depart,unchanged};
