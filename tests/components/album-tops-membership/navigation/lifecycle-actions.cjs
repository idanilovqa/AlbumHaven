const {expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const name=page=>page.getByRole('textbox',{name:'Album Top name',exact:true});
const navigationError=page=>page.getByText('This Album Top could not be opened. Try again.',{exact:true});
const retry=page=>page.getByRole('button',{name:'Retry opening Album Top',exact:true});
const settlePaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function editing(page,options={}){const result=await mount(page,options);await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();await expect(name(page)).toBeEnabled();await name(page).fill('Authored retained title');return result;}
async function noNavigationFailure(page){await expect(navigationError(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);}
function noRenderErrors(result){expect(result.errors).toEqual([]);expect(result.consoleMessages.filter(row=>row.type==='error')).toEqual([]);
  expect(result.consoleMessages.map(row=>row.text).join('\n')).not.toMatch(/Cannot update.*while rendering|rendering a different component|state update on an unmounted component/i);}


module.exports={name,navigationError,retry,settlePaint,editing,noNavigationFailure,noRenderErrors};
