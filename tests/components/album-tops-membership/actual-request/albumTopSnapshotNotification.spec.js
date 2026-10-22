const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');
const {settlePaint,title}=require('./snapshot-notification-actions.cjs');

for(const change of ['Change actor scope','Change private context','Server revision change']) {
  test(`real queued Top departure retired by ${change} keeps replacement Session current without render-phase subscription updates`,async({page})=>{
    const observed=await mount(page);
    await page.getByRole('button',{name:'Hold noninterruptible request',exact:true}).click();
    await page.getByRole('link',{name:'Other Top',exact:true}).click();await settlePaint(page);
    expect(await page.evaluate(()=>navFixture.requests.length)).toBe(1);
    expect(await page.evaluate(()=>state.ui.pendingViewRequest?.url)).toBe('/view-data?surface=album_tops&top_ref=00000000-0000-4000-8000-000000000002');
    await page.getByRole('button',{name:change,exact:true}).click();await settlePaint(page);
    await page.getByRole('button',{name:'Release native blocker',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>state.busy)).toBe(false);await settlePaint(page);
    await expect(page.locator('header[aria-label="Album Tops header"]').getByText('Curated Top',{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>navFixture.requests.length)).toBe(1);
    expect(await page.evaluate(()=>navFixture.calls.navigation)).toEqual([]);
    expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);
    await expect(page.getByText('This Album Top could not be opened. Try again.',{exact:true})).toHaveCount(0);
    await expect(page.locator('#app-confirm-modal')).toBeHidden();
    // A current replacement Session remains functional; suppressing all store
    // notifications to hide the warning cannot satisfy this editing lifecycle.
    await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();await expect(title(page)).toBeEnabled();
    await title(page).fill('Current replacement draft');await settlePaint(page);
    await expect(title(page)).toHaveValue('Current replacement draft');
    await page.locator('form[aria-label="Edit Album Top"]').getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(page.locator('#app-confirm-modal')).toBeVisible();await page.locator('#app-confirm-accept').click();
    await expect(page.getByRole('button',{name:'Edit Album Top',exact:true})).toBeVisible();await settlePaint(page);
    expect(await page.evaluate(()=>navFixture.calls.writes)).toEqual([]);
    expect(observed.errors).toEqual([]);
    expect(observed.consoleMessages.filter(row=>row.type==='error')).toEqual([]);
    expect(observed.consoleMessages.map(row=>row.text).join('\n')).not.toMatch(/Cannot update.*while rendering|rendering a different component|state update on an unmounted component/i);
  });
}
