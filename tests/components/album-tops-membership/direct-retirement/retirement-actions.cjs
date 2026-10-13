const {expect}=require('@playwright/test');
const other=page=>page.getByRole('link',{name:'Other Top',exact:true});
const error=page=>page.getByText('This Album Top could not be opened. Try again.',{exact:true});
const retry=page=>page.getByRole('button',{name:'Retry opening Album Top',exact:true});
const target='/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002';
const settlePaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function clean(page,observed){
  await settlePaint(page);expect(await page.evaluate(()=>navFixture.calls.unhandled)).toEqual([]);
  expect(observed.errors).toEqual([]);expect(observed.consoleMessages.filter(row=>row.type==='error')).toEqual([]);
}

module.exports={other,error,retry,target,settlePaint,clean};
