// Real Chromium DOM + unchanged production React/native renderers. Isolated DTOs,
// no server routes, database, global Rating mutation or app-E2E claim.
const {test, assert, mount, bind, header, pointer, initialGeometry, tableGeometry, waitForMobilePress, waitForVisibleRating, renderConsumer, bodyOverflows, observeSorts} = require('./mobileTrackColumnsFixture');

test('actual native table uses one aligned grid and explicit Rating below480 stays table-local',async ({page})=>{
 await mount(page,320);await bind(page);
 const initial=await initialGeometry(page);
 assert.ok(initial.title>=140);assert.equal(initial.body,initial.viewport);
 await page.evaluate(()=>binding.openColumns(document.querySelector('.compact-data-table-header')));
 const menu=await page.evaluate(()=>{const c=calls.choices.at(-1).config;return {formats:c.formats,menuWidth:c.menuWidth,matchTriggerWidth:c.matchTriggerWidth};});
 assert.equal(menu.menuWidth,'content');assert.equal(menu.matchTriggerWidth,false);
 assert.deepEqual(menu.formats.map(x=>x.value).filter(key=>key!=='__defaults').sort(),['artist','rating']);
 assert.ok(menu.formats.some(x=>x.value==='__defaults'&&x.label==='Restore default columns'));
 await page.evaluate(()=>calls.choices.at(-1).config.onSelect('rating'));
 const out=await tableGeometry(page);
 assert.deepEqual(out.rows[0].map(c=>c.key),['number','title','love','rating','duration']);
 for(const row of out.rows.slice(1))for(let i=0;i<row.length;i++){assert.ok(Math.abs(row[i].x-out.rows[0][i].x)<1);assert.ok(Math.abs(row[i].width-out.rows[0][i].width)<1);}
 assert.ok(out.scroll>out.client);assert.equal(out.body,out.viewport);assert.deepEqual(out.changes,[{artist:false,rating:true}]);
});
for(const key of ['Alt+ArrowDown','Shift+F10','ContextMenu'])test('header keyboard equivalent '+key,async ({page})=>{
 await mount(page);await bind(page);await page.locator(header).focus();await page.keyboard.press(key);
 assert.equal(await page.evaluate(()=>calls.choices.length),1);
});
for(const cancel of ['movement','scroll','multitouch','resize','source','rehost','dispose'])test('pending header longpress cancels on '+cancel,async ({page})=>{
 await mount(page);await bind(page);await pointer(page,'pointerdown');
 if(cancel==='movement')await pointer(page,'pointermove',header,{clientX:65});
 if(cancel==='scroll')await page.evaluate(()=>window.dispatchEvent(new Event('scroll')));
 if(cancel==='multitouch')await pointer(page,'pointerdown',header,{pointerId:2,isPrimary:false});
 if(cancel==='resize')await page.setViewportSize({width:400,height:800});
 if(cancel==='source')await page.evaluate(()=>binding.update({source:{id:'B'}}));
 if(cancel==='rehost')await page.evaluate(()=>{const p=document.createElement('section');document.body.append(p);p.append(host);});
 if(cancel==='dispose')await page.evaluate(()=>binding.dispose());
 await waitForMobilePress(page);assert.equal(await page.evaluate(()=>calls.choices.length),0);
});
test('consumed longpress suppresses only its trailing pointer click; keyboard and next ordinary sort survive',async ({page})=>{
 await mount(page);await bind(page);
 await observeSorts(page);
 const sort='[data-cdt-sort]';await pointer(page,'pointerdown',sort);await waitForMobilePress(page);assert.equal(await page.evaluate(()=>calls.choices.length),1);
 await pointer(page,'pointerup',sort);await page.locator(sort).dispatchEvent('click',{bubbles:true,detail:1,button:0});assert.equal(await page.evaluate(()=>sorts),0);
 await page.locator(sort).dispatchEvent('click',{bubbles:true,detail:0});assert.equal(await page.evaluate(()=>sorts),1);
 await page.locator(sort).click();assert.equal(await page.evaluate(()=>sorts),2);
});
for(const kind of ['playlist','recent'])test('real React '+kind+' owns native columns toolbar, resource-local choices, facts and missing playback',async ({page})=>{
 await mount(page,390);await renderConsumer(page,kind);
 const action=page.locator('[data-track-table-columns]');assert.equal(await action.count(),1);assert.equal(await action.getAttribute('aria-haspopup'),'menu');
 await action.click();const menu=await page.evaluate(()=>calls.choices.at(-1).config.formats.map(x=>({value:x.value,label:x.label})));
 const rating=menu.find(x=>/rating/i.test(x.label));assert.ok(rating,'Projected Rating is an optional choice');
 await page.evaluate(key=>calls.choices.at(-1).config.onSelect(key),rating.value);
 await waitForVisibleRating(page, rating);
 assert.match(await page.locator(`[role="cell"][data-cdt-column="${rating.value}"]`).innerText(),/4/);
 assert.equal(await page.evaluate(()=>calls.plays.length),0);
 const play=page.locator(kind==='playlist'?'[data-playlists-play]':'[data-home-activity-play]');
 for(let i=0;i<await play.count();i++)assert.ok(await play.nth(i).isHidden()||await play.nth(i).isDisabled());
 await renderConsumer(page,kind,'B');
 assert.equal(await page.locator(`[role="cell"][data-cdt-column="${rating.value}"]`).isVisible(),false,'New resource does not inherit explicit Rating');
 assert.equal(await bodyOverflows(page),false);
});
