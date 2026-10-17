// Actual app transition and canonical CSS cascade. No fixture rule targets or
// compresses the header, identity, inputs, labels or actions under test.
const {test,expect}=require('@playwright/test');
const {mount}=require('./browser-fixture.cjs');

const {measure}=require('./inline-header-measurements.cjs');

for(const width of [320,390,480,1100,1440])test(`inline gallery header has only two compact editable identity rows at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const {errors}=await mount(page,'top-inline');
  await page.getByRole('button',{name:'Edit Album Top',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  const title=page.getByRole('textbox',{name:'Album Top name',exact:true}),subtitle=page.getByRole('textbox',{name:'Album Top subtitle',exact:true});
  await expect(title).toBeVisible();await expect(subtitle).toBeVisible();
  for(const phase of ['initial','long values']){
    if(phase==='long values'){
      await title.fill('A long editable Album Top title that should stay on its one compact row');
      await subtitle.fill('A long editable subtitle that must not create extra visible label rows');
    }
    const g=await measure(page),reason=phase+' '+JSON.stringify(g);
    expect(g.headers,reason).toBe(1);expect(g.paintedLabels,reason).toEqual([]);expect(g.fieldTypes).toEqual(['text','text']);
    expect(g.subtitle.top,reason).toBeGreaterThanOrEqual(g.title.bottom-1);
    expect(g.subtitle.top-g.title.bottom,reason).toBeLessThanOrEqual(8.5);
    expect(Math.abs(g.title.left-g.subtitle.left),reason).toBeLessThanOrEqual(1);
    expect(Math.abs(g.title.right-g.subtitle.right),reason).toBeLessThanOrEqual(1);
    expect(g.title.top-g.identity.top,reason).toBeLessThanOrEqual(4);
    expect(g.identity.bottom-g.subtitle.bottom,reason).toBeLessThanOrEqual(4);
    expect(g.identity.height,reason).toBeLessThanOrEqual(g.title.height+g.subtitle.height+9);
    expect(g.title.height,reason).toBeLessThanOrEqual(Math.max(g.save.height,g.cancel.height)+4);
    expect(g.subtitle.height,reason).toBeLessThanOrEqual(Math.max(g.save.height,g.cancel.height)+4);
    expect(Math.abs(g.save.top-g.cancel.top),reason).toBeLessThanOrEqual(1);
    expect(Math.abs(g.save.height-g.cancel.height),reason).toBeLessThanOrEqual(1);
    for(const control of [g.title,g.subtitle,g.save,g.cancel]){
      expect(control.width,reason).toBeGreaterThan(0);expect(control.left,reason).toBeGreaterThanOrEqual(Math.max(0,g.header.left)-1);
      expect(control.right,reason).toBeLessThanOrEqual(Math.min(g.viewport,g.header.right)+1);
    }
    expect(g.documentWidth,reason).toBeLessThanOrEqual(g.viewport);
  }
  // Accessible names remain actionable even though extra painted labels vanish.
  await title.focus();await expect(title).toBeFocused();await title.press('Tab');await expect(subtitle).toBeFocused();
  expect(await page.evaluate(()=>reviewFixture.calls.writes)).toEqual([]);expect(errors).toEqual([]);
});
