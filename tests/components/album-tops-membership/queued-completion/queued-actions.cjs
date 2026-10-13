const {expect}=require('@playwright/test');
const error=page=>page.getByText('This Album Top could not be opened. Try again.',{exact:true});
const retry=page=>page.getByRole('button',{name:'Retry opening Album Top',exact:true});
const other=page=>page.getByRole('link',{name:'Other Top',exact:true});
const settlePaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const target='/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002';
async function queued(page){
  await page.getByRole('button',{name:'Hold noninterruptible request',exact:true}).click();
  await other(page).click();await settlePaint(page);
  expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);
  expect(await page.evaluate(()=>state.ui.pendingViewRequest?.url)).toBe(target);
  await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);
}
function noErrors(observed){expect(observed.errors).toEqual([]);expect(observed.consoleMessages.filter(row=>row.type==='error')).toEqual([]);}
async function noUnhandled(page,observed){await settlePaint(page);expect(await page.evaluate(()=>navFixture.calls.unhandled)).toEqual([]);noErrors(observed);}


module.exports={error,retry,other,settlePaint,target,queued,noErrors,noUnhandled};
