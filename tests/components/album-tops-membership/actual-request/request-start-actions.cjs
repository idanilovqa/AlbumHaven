const {expect}=require('@playwright/test');
const error=page=>page.getByText('This Album Top could not be opened. Try again.',{exact:true});
const retry=page=>page.getByRole('button',{name:'Retry opening Album Top',exact:true});
const other=page=>page.getByRole('link',{name:'Other Top',exact:true});
const settlePaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function noFailure(page){await expect(error(page)).toHaveCount(0);await expect(retry(page)).toHaveCount(0);}
function noErrors(observed){expect(observed.errors).toEqual([]);expect(observed.consoleMessages.filter(row=>row.type==='error')).toEqual([]);}


module.exports={error,retry,other,settlePaint,noFailure,noErrors};
