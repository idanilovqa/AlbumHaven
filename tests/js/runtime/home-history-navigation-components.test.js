'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle} = require('./home-friends-native-app-fixture.cjs');
const numbered = (extra = {}) => ({mode:'numbered',status:'idle',page:2,pageSize:100,totalPages:3,totalRows:243,loadedCount:100,hasMore:false,requestedPage:null,...extra});
const progressive = (extra = {}) => ({mode:'progressive',status:'idle',page:null,pageSize:100,totalPages:null,totalRows:null,loadedCount:200,hasMore:true,requestedPage:null,...extra});
const value = {status:'ready',data:{rows:[{id:'listen:one'}],total_listens:9999999,next_cursor:'provider-cursor'}};
const visible = node => node && !node.closest('[hidden], [inert]');
const controls = host => [...host.querySelectorAll('button, input')].filter(visible);
async function setup(t, extra = {}) {
  const h = fixture(t), {mountHistoryNavigation} = await load('history-navigation.mjs');
  const nav=h.document.createElement('nav');h.host.append(nav);
  let props={runtime:h.runtime,value,navigation:numbered(),queryKey:'self:listens:week',onPage(){},onLoadMore(){},onRetry(){},...extra};
  const owner=h.own(mountHistoryNavigation(nav,h.runtime,props));
  return {...h,nav,owner,summary:nav.querySelector('[role="status"]'),
    update(next={}) {props={...props,...next};owner.update(props);},
    button(label) {return h.named(label,nav);},
    submit() {const event=new h.c.Event('submit',{bubbles:true,cancelable:true});nav.querySelector('form').dispatchEvent(event);assert.equal(event.defaultPrevented,true);},
    type(text) {h.input(nav.querySelector('input'),text);},
    choose(label) {h.click(h.named(`History page: Page ${props.navigation.page} of ${props.navigation.totalPages} · 100 per page`,nav));h.drain();const option=[...h.document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find(n=>n.textContent.includes(label));assert.ok(option,`native Choice option ${label}`);h.click(option);},
  };
}

test('numbered navigation uses native Choice/actions, committed range and submitted jump',async t=>{
  const h=await setup(t),host=h.nav;
  assert.equal(host.getAttribute('aria-label'),'Listening history pages');
  assert.equal(h.summary.textContent,'Page 2 of 3 · Items 101–200 of 243 · 100 per page');
  assert.equal(h.summary.getAttribute('aria-live'),'polite');assert.equal(h.summary.getAttribute('aria-atomic'),'true');
  assert.equal(h.button('Previous history page').classList.contains('action-button'),true);
  assert.equal(h.button('Next history page').disabled,false);
  assert.equal(h.button('History page: Page 2 of 3 · 100 per page').getAttribute('aria-haspopup'),'menu');
  assert.equal(h.button('Go').getAttribute('type'),'submit');assert.equal(host.querySelector('form').getAttribute('aria-label'),'Jump to history page');
  assert.equal(host.querySelector('input').inputMode,'numeric');assert.equal(host.querySelector('select'),null);assert.doesNotMatch(host.textContent,/9999999|provider-cursor/);
});

test('large authoritative totals create a bounded native Choice while preserving an arbitrary jump',async t=>{
  const calls=[],h=await setup(t,{navigation:numbered({page:44001,totalPages:90000,totalRows:9000000}),onPage:page=>calls.push(page)});
  h.click(h.button('History page: Page 44001 of 90000 · 100 per page'));h.drain();
  const options=[...h.document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
  assert.deepEqual(options.map(n=>n.textContent.match(/Page (\d+) of/)[1]),['1','43999','44000','44001','44002','44003','90000']);assert.equal(options.length,7);assert.ok(visible(h.nav.querySelector('form')));
  // Arbitrary pages remain available through the submitted jump, not an unbounded menu.
  h.type('12345');h.submit();assert.deepEqual(calls,[12345]);
});

test('row ranges keep item semantics for aggregate albums, tracks and artists as well as listen events',async t=>{
  for(const kind of ['albums','tracks','artists','listens']){const h=await setup(t,{queryKey:`self:${kind}:week`,navigation:numbered({query:{account_ref:null,kind,period:'week'}})});assert.match(h.summary.textContent,/Items 101–200 of 243/);assert.doesNotMatch(h.summary.textContent,/listens|9999999/i);}
});

test('empty numbered history has one disabled page and first/last bounds remain native',async t=>{
  const h=await setup(t,{value:{status:'empty',data:{rows:[]}},navigation:numbered({page:1,totalPages:1,totalRows:0,loadedCount:0})});
  assert.match(h.summary.textContent,/Page 1 of 1 · 0 items · 100 per page/);for(const b of controls(h.nav))assert.equal(b.disabled,true);assert.equal(visible(h.nav.querySelector('form')),false);
  h.update({value,navigation:numbered({page:1})});assert.equal(h.button('Previous history page').disabled,true);assert.equal(h.button('Next history page').disabled,false);
  h.update({navigation:numbered({page:3,loadedCount:43})});assert.match(h.summary.textContent,/Items 201–243 of 243/);assert.equal(h.button('Next history page').disabled,true);
});

test('unvalidated and first-load/denied/unavailable resources expose no paging authority',async t=>{
  for(const navigation of [{mode:'none'},null]){const h=await setup(t,{navigation});assert.equal(h.nav.hidden,true);assert.equal(controls(h.nav).length,0);}
  for(const status of ['loading','error','denied','unavailable']){const h=await setup(t,{value:{...value,status}});assert.equal(h.nav.hidden,true);assert.equal(controls(h.nav).length,0);assert.doesNotMatch(h.nav.textContent,/9999999|provider-cursor|Items 101/);}
});

test('progressive history reports only available rows and retains a disabled completion control',async t=>{
  const h=await setup(t,{navigation:progressive()});assert.match(h.summary.textContent,/200 items shown · More history available/);assert.equal(h.button('Load more history').disabled,false);assert.equal(visible(h.nav.querySelector('form')),false);assert.doesNotMatch(h.summary.textContent,/Page|9999999|of 200/);
  h.update({navigation:progressive({hasMore:false,loadedCount:231})});assert.match(h.summary.textContent,/231 items shown · End of available history/);assert.equal(h.button('Load more history').disabled,true);
});

test('busy and failed navigation retain committed page/range and native feedback/retry states',async t=>{
  const h=await setup(t,{navigation:numbered({status:'loading',requestedPage:3})});assert.equal(h.nav.getAttribute('aria-busy'),'true');assert.match(h.summary.textContent,/Page 2 of 3 · Items 101–200 of 243/);assert.match(h.nav.textContent,/Loading page 3/);for(const n of controls(h.nav))assert.equal(n.disabled,true);
  h.update({navigation:numbered({status:'error',requestedPage:3})});assert.match(h.nav.querySelector('[role="alert"]').textContent,/Page 3 could not be loaded/);assert.ok(h.nav.querySelector('.on-page-alert'));assert.equal(h.button('Retry history loading').disabled,false);
  h.update({navigation:progressive({status:'error'})});assert.match(h.summary.textContent,/200 items shown/);assert.match(h.nav.querySelector('[role="alert"]').textContent,/Your listening history is still shown/);
});

test('submitted jump rejects invalid text, accepts whole pages and blocks duplicate navigation immediately',async t=>{
  const calls=[],work=deferred(),h=await setup(t,{onPage:page=>{calls.push(page);return work.promise;}}),input=h.nav.querySelector('input');
  for(const text of ['','0','-1','1.5','1e2','4','9007199254740992']){h.type(text);h.submit();assert.equal(input.getAttribute('aria-invalid'),'true');assert.deepEqual(calls,[]);assert.equal(input.value,text);assert.ok(h.nav.querySelector(`#${input.getAttribute('aria-describedby')}`));}
  h.type(' 03 ');assert.equal(input.getAttribute('aria-invalid'),'false');h.submit();h.submit();h.click(h.button('Next history page'));assert.deepEqual(calls,[3]);assert.equal(h.nav.getAttribute('aria-busy'),'true');assert.equal(input.disabled,true);
  work.resolve();await settle();h.update({navigation:numbered({page:3,loadedCount:43})});assert.equal(h.nav.getAttribute('aria-busy'),'false');assert.equal(input.value,'3');
});

test('Choice and previous/next use committed page bounds and ignore stale descriptor callbacks',async t=>{
  const calls=[],h=await setup(t,{onPage:page=>calls.push(page)});
  h.choose('Page 2 of');await settle();assert.deepEqual(calls,[]);
  h.type('4');h.submit();assert.deepEqual(calls,[]);
  h.click(h.button('History page: Page 2 of 3 · 100 per page'));h.drain();const stale=[...h.document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find(n=>n.textContent.includes('Page 3 of'));assert.ok(stale);
  h.click(h.button('Previous history page'));await settle();assert.deepEqual(calls,[1]);h.update({navigation:numbered({page:1})});
  h.click(stale);assert.deepEqual(calls,[1]);h.choose('Page 3 of');await settle();assert.deepEqual(calls,[1,3]);
  // The form is one retained native owner, so a saved form is deliberately current.
  assert.equal(h.nav.querySelectorAll('form').length,1);
});

test('Load more and retry each issue one operation while pending and preserve display authority',async t=>{
  const work=deferred();let loads=0,retries=0;const h=await setup(t,{navigation:progressive(),onLoadMore:()=>{loads++;return work.promise;},onRetry:()=>{retries++;return work.promise;}});
  const more=h.button('Load more history');h.click(more);h.click(more);assert.equal(loads,1);assert.equal(more.disabled,true);work.resolve();await settle();h.update({navigation:progressive({status:'error'})});
  const retry=h.button('Retry history loading');h.click(retry);h.click(retry);assert.equal(retries,1);await settle();h.update({navigation:progressive({loadedCount:243,hasMore:false})});assert.equal(h.button('Load more history').disabled,true);h.click(h.button('Load more history'));assert.equal(loads,1);
});

test('throwing or rejected embedding callbacks report failure and release the navigation guard',async t=>{
  for(const rejectAsync of [false,true]){let calls=0;const h=await setup(t,{onPage:()=>{calls++;if(rejectAsync)return Promise.reject(new Error('Embedding failed'));throw new Error('Embedding failed');}});
    assert.doesNotThrow(()=>h.click(h.button('Next history page')));await settle();assert.equal(h.nav.getAttribute('aria-busy'),'false');assert.match(h.nav.querySelector('[role="alert"]').textContent,/History navigation could not be started/);assert.equal(h.button('Next history page').disabled,false);
    h.click(h.button('Next history page'));await settle();assert.equal(calls,2);h.update({queryKey:'another:query'});assert.doesNotMatch(h.nav.textContent,/History navigation could not be started/);
  }
});

test('request completion restores lost local focus without stealing focus from another control',async t=>{
  for(const movedOutside of [false,true]){const work=deferred(),h=await setup(t,{onPage:()=>work.promise});const source=h.button('Next history page');source.focus();h.click(source);h.update({navigation:numbered({status:'loading',requestedPage:3})});h.document.activeElement=h.document.body;
    const outside=h.document.createElement('button');h.document.body.append(outside);if(movedOutside)outside.focus();work.resolve();await settle();h.update({navigation:numbered({page:3,loadedCount:43})});assert.equal(h.document.activeElement,movedOutside?outside:h.summary);
  }
});

test('a replaced actor/query cannot receive stale jumps, completion focus or pending-state changes',async t=>{
  const oldWork=deferred(),newWork=deferred(),calls=[],h=await setup(t,{onPage:page=>{calls.push(`old:${page}`);return oldWork.promise;}});
  h.click(h.button('History page: Page 2 of 3 · 100 per page'));h.drain();const oldOption=[...h.document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find(n=>n.textContent.includes('Page 3 of'));
  const source=h.button('Next history page'),retainedForm=h.nav.querySelector('form'),retainedInput=h.nav.querySelector('input');source.focus();h.click(source);h.document.activeElement=h.document.body;
  h.update({queryKey:'friend:two:listens:month',navigation:numbered({page:1}),onPage:page=>{calls.push(`new:${page}`);return newWork.promise;}});h.click(oldOption);assert.deepEqual(calls,['old:3']);assert.equal(h.nav.querySelector('input').value,'1');
  // Stable native buttons and form now belong to the new query. Old popup nodes do not.
  assert.equal(h.button('Next history page'),source);assert.equal(h.nav.querySelector('form'),retainedForm);assert.equal(h.nav.querySelector('input'),retainedInput);
  h.click(h.button('Next history page'));oldWork.resolve();await settle();assert.equal(h.nav.getAttribute('aria-busy'),'true');assert.equal(h.document.activeElement,h.document.body);assert.deepEqual(calls,['old:3','new:2']);newWork.resolve();await settle();
});

test('revisiting a query or committed page does not resurrect abandoned busy state or a stale jump draft',async t=>{
  const work=deferred(),h=await setup(t,{onPage:()=>work.promise});h.type('3');h.submit();h.update({queryKey:'another:query',navigation:numbered({page:1})});h.update({queryKey:'self:listens:week',navigation:numbered()});assert.equal(h.nav.getAttribute('aria-busy'),'false');assert.equal(h.nav.querySelector('input').value,'2');h.type('3');h.update({navigation:numbered({page:1})});h.update({navigation:numbered()});assert.equal(h.nav.querySelector('input').value,'2');work.resolve();await settle();
});

test('denial or unmount discards pending completion focus and unavailable callbacks disable controls',async t=>{
  for(const unmount of [false,true]){const work=deferred(),h=await setup(t,{onPage:()=>work.promise}),source=h.button('Next history page');source.focus();h.click(source);h.document.activeElement=h.document.body;
    if(unmount)h.owner.dispose();else h.update({value:{status:'denied',data:null},navigation:{mode:'none'}});work.resolve();await settle();assert.equal(h.document.activeElement,h.document.body);
    if(!unmount){assert.equal(h.nav.hidden,true);assert.doesNotMatch(h.nav.textContent,/Items 101–200 of 243|Page 2 of 3/,'denial must clear private committed counts even in a retained hidden host');}else assert.equal(h.nav.textContent,'');
  }
  const h=await setup(t,{onPage:null});for(const n of controls(h.nav))assert.equal(n.disabled,true);h.update({navigation:progressive({status:'error'}),onLoadMore:null,onRetry:null});for(const n of controls(h.nav))assert.equal(n.disabled,true);
});

test('denial clears all raw navigation data and same-query recovery retires old work and focus',async t=>{
  for(const oldOutcome of ['resolve','reject'])await t.test(oldOutcome,async t=>{
    const oldWork=deferred(),newWork=deferred(),calls=[];
    const h=await setup(t,{onPage:page=>{calls.push(`old:${page}`);return oldWork.promise;}});
    h.type('998');h.submit();assert.ok(h.nav.querySelector('[role="alert"]'));
    const choice=h.button('History page: Page 2 of 3 · 100 per page');h.click(choice);h.drain();
    assert.ok(h.document.querySelector('[role="menu"]'));
    h.update({value:{status:'denied',data:null},navigation:{mode:'none'}});
    assert.equal(h.document.querySelector('[role="menu"]'),null,'unreadable Choice closes its actual external popup');
    assert.equal(h.nav.querySelector('input').value,'');assert.equal(h.nav.querySelector('[role="alert"]'),null);
    assert.doesNotMatch(h.nav.outerHTML,/243|101–200|Page 2 of 3|998|Enter a whole page/,'raw DOM includes hidden hosts and accessible-name attributes');
    h.update({value,navigation:numbered()});assert.equal(h.nav.hidden,false);assert.equal(h.nav.querySelector('input').value,'2');
    const source=h.button('Next history page');source.focus();h.click(source);assert.deepEqual(calls,['old:3']);assert.equal(h.nav.getAttribute('aria-busy'),'true');
    h.update({value:{status:'denied',data:null},navigation:{mode:'none'}});h.document.activeElement=h.document.body;
    assert.equal(h.nav.getAttribute('aria-busy'),'false');assert.equal(h.summary.textContent,'');assert.equal(h.nav.querySelector('input').value,'');
    assert.doesNotMatch(h.nav.outerHTML,/243|101–200|Page 2 of 3|Loading history page/);
    h.update({value,navigation:numbered(),onPage:page=>{calls.push(`new:${page}`);return newWork.promise;}});
    assert.equal(h.nav.getAttribute('aria-busy'),'false');assert.equal(h.nav.querySelector('input').value,'2');assert.equal(h.button('Next history page').disabled,false);assert.equal(h.document.activeElement,h.document.body,'denied local focus cannot resurrect on recovery');
    h.click(h.button('Next history page'));assert.deepEqual(calls,['old:3','new:3']);assert.equal(h.nav.getAttribute('aria-busy'),'true');
    if(oldOutcome==='reject')oldWork.reject(new Error('retired failure'));else oldWork.resolve();await settle();
    assert.equal(h.nav.getAttribute('aria-busy'),'true','old work cannot release the new same-query request');assert.equal(h.document.activeElement,h.document.body);assert.doesNotMatch(h.nav.textContent,/History navigation could not be started|retired failure/);
    newWork.resolve();await settle();assert.equal(h.nav.getAttribute('aria-busy'),'false');assert.equal(h.document.activeElement,h.document.body);
  });
});
