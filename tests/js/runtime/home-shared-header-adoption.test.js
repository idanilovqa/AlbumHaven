// Contract-first genuine shared owner and original native Gallery markup.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load}=require('./home-friends-native-app-fixture.cjs');
let mount;
test.before(async()=>{({mountSharedHeader:mount}=await load('shared-header.mjs'));});
function gallery(t){
  const h=fixture(t),root=h.document.createElement('section');
  root.className='gallery-bar legacy-gallery';root.setAttribute('data-gallery-bar-instance','gallery');
  root.setAttribute('data-gallery-bar','true');root.setAttribute('aria-label','Original Gallery');root.setAttribute('tabindex','-1');
  root.innerHTML=h.c.buildGalleryBarHtml({contextKind:'single-artist',artist:'Exact Artist',albumCount:3});h.host.append(root);
  const originals=[...root.children],context=originals[0],actions=originals[1],button=actions.querySelector('[data-gallery-bar-action="artist-family"]');
  let clicks=0;const listener=()=>clicks++;button.addEventListener('click',listener);
  for(const node of originals)node.remove();
  const baseline=h.listeners(),observerStart=h.observers.length;
  return {...h,root,originals,context,actions,button,clicks:()=>clicks,baseline,observerStart,
    insert(owner){owner.slots.identity.append(context);owner.slots.actions.append(actions);owner.refresh();},
    clean(){assert.deepEqual(h.listeners(),baseline);assert.equal(h.frames.size,0);assert.ok(h.observers.slice(observerStart).every(owner=>!owner.connected));}};
}
function measure(h,owner,width){
  for(const node of [h.root,...h.root.querySelectorAll('*')]){node.scrollWidth=0;node.scrollHeight=24;node.clientHeight=24;node.offsetHeight=24;h.setRect(node,{width:0,height:24});}
  h.setRect(h.root,{width,height:40});h.setRect(owner.slots.identity,{width:100,height:24});
  h.setRect(h.actions,{width:220,height:24});h.setRect(h.root.querySelector('.home-header__tools'),{width:34,height:24});
  owner.refresh();h.drain();
}
function detachOriginals(h){for(const node of h.originals)node.remove();}
function adopted(h,props={}){return h.own(mount(h.root,h.runtime,{id:'artist-adopted',adoptRoot:true,...props}));}

test('adopts exact Gallery root and stable slots without cloning original controls',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);const slots={...owner.slots};
  assert.equal(owner.element,h.root);assert.equal(h.host.children.length,1);assert.equal(h.root.querySelectorAll('header').length,0);
  assert.equal(h.root.getAttribute('data-gallery-bar-instance'),'gallery');assert.equal(h.root.getAttribute('data-gallery-bar'),'true');
  for(const width of [1000,180,1000,180]){measure(h,owner,width);for(const [key,node] of Object.entries(slots))assert.equal(owner.slots[key],node);assert.equal(h.root.querySelector('[data-gallery-bar-action="artist-family"]'),h.button);}
  measure(h,owner,1000);h.click(h.button);assert.equal(h.clicks(),1);
  detachOriginals(h);owner.dispose();h.clean();h.root.append(...h.originals);assert.deepEqual([...h.root.children],h.originals);
  h.click(h.button);assert.equal(h.clicks(),2);assert.equal(h.root.parentNode,h.host);
});

test('compact Tools moves focus using original controls and expands without replacement',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);measure(h,owner,1000);h.button.focus();
  measure(h,owner,180);const tools=h.root.querySelector('[data-header-tools]');
  assert.equal(h.document.activeElement,tools);assert.equal(tools.getAttribute('aria-expanded'),'false');
  h.click(tools);h.drain();assert.equal(tools.getAttribute('aria-expanded'),'true');
  h.button.focus();assert.equal(h.document.activeElement,h.button);h.click(h.button);assert.equal(h.clicks(),1);
  h.click(tools);h.drain();measure(h,owner,1000);assert.notEqual(h.document.activeElement,tools);
  assert.equal(h.root.querySelector('[data-gallery-bar-action="artist-family"]'),h.button);
});

test('native child Choice remains owned inside the shared Tools disclosure',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);measure(h,owner,180);
  const tools=h.root.querySelector('[data-header-tools]');h.click(tools);h.drain();
  const choice=h.runtime.openChoice(h.button,{formats:[{value:'artist',label:'Artist'}],selected:'artist',label:'Artist scope',onSelect(){}});
  try{h.drain();const menu=h.document.querySelector('[role="menu"]');assert.ok(menu);assert.equal(h.button.getAttribute('aria-expanded'),'true');
    const item=menu.querySelector('[role="menuitemradio"]');assert.ok(item);
    item.dispatchEvent(new h.c.Event('pointerdown',{bubbles:true}));assert.equal(tools.getAttribute('aria-expanded'),'true');
  }finally{choice?.dispose?.();choice?.close?.();h.document.dispatchEvent(new h.c.Event('keydown',{key:'Escape',bubbles:true}));h.drain();}
});

for(const initiallyHidden of [false,true])test('adoption preserves externally owned hidden '+initiallyHidden,t=>{
  const h=gallery(t);h.root.hidden=initiallyHidden;const owner=adopted(h,{hidden:!initiallyHidden});h.insert(owner);
  assert.equal(h.root.hidden,initiallyHidden);owner.update({id:'artist-adopted',hidden:!initiallyHidden});assert.equal(h.root.hidden,initiallyHidden);
  detachOriginals(h);owner.dispose();assert.equal(h.root.hidden,initiallyHidden);h.clean();
});

test('external hide closes Tools without focus theft and reshow does not reopen',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);measure(h,owner,180);const tools=h.root.querySelector('[data-header-tools]');
  h.click(tools);h.drain();assert.equal(tools.getAttribute('aria-expanded'),'true');
  const external=h.document.createElement('button');h.host.append(external);external.focus();h.root.hidden=true;
  for(const observer of h.observers.slice(h.observerStart))if(observer.connected)observer.callback([{type:'attributes',attributeName:'hidden',target:h.root}]);
  h.drain();assert.equal(tools.getAttribute('aria-expanded'),'false');assert.equal(h.document.activeElement,external);
  h.root.hidden=false;owner.refresh();h.drain();assert.equal(tools.getAttribute('aria-expanded'),'false');
});

test('detached Gallery root can rehost in mobile container under the same lease',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);measure(h,owner,180);
  const mobile=h.document.createElement('div');h.host.append(mobile);h.root.remove();owner.refresh();h.drain();
  assert.equal(owner.element,h.root);mobile.append(h.root);measure(h,owner,1000);
  assert.equal(h.root.parentNode,mobile);assert.equal(h.root.querySelector('[data-gallery-bar-action="artist-family"]'),h.button);
  detachOriginals(h);owner.dispose();assert.equal(h.root.parentNode,mobile);h.clean();
});

test('second simultaneous adoption refuses before DOM listeners refs or attrs change',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);h.drain();const html=h.root.outerHTML,listeners=h.listeners(),frames=h.frames.size;
  let called=0;assert.throws(()=>mount(h.root,h.runtime,{id:'intruder',adoptRoot:true,headerRef(){called++;}}));
  assert.equal(called,0);assert.equal(h.root.outerHTML,html);assert.deepEqual(h.listeners(),listeners);assert.equal(h.frames.size,frames);
});

test('stale disposal and queued callback cannot alter later root owner',t=>{
  const h=gallery(t),old=adopted(h);h.insert(old);const callbacks=[...h.frames.values()];detachOriginals(h);old.dispose();
  const next=adopted(h,{id:'successor'});h.insert(next);h.drain();const html=h.root.outerHTML,listeners=h.listeners();
  old.dispose();old.update({id:'stale'});old.refresh();for(const callback of callbacks)callback();
  assert.equal(h.root.outerHTML,html);assert.deepEqual(h.listeners(),listeners);assert.equal(next.element,h.root);
});

test('owned attributes restore originals and owned class tokens only',t=>{
  const h=gallery(t);h.root.setAttribute('data-shared-header','old');h.root.setAttribute('data-header-open','old-open');
  const owner=adopted(h,{className:'new-owner',ariaLabel:'New label',tabIndex:0});
  detachOriginals(h);owner.dispose();h.clean();
  assert.equal(h.root.getAttribute('aria-label'),'Original Gallery');assert.equal(h.root.getAttribute('tabindex'),'-1');
  assert.equal(h.root.getAttribute('data-shared-header'),'old');assert.equal(h.root.getAttribute('data-header-open'),'old-open');
  assert.ok(h.root.classList.contains('gallery-bar'));assert.ok(h.root.classList.contains('legacy-gallery'));
  assert.equal(h.root.classList.contains('home-header'),false);assert.equal(h.root.classList.contains('new-owner'),false);
});

test('external attribute and class changes survive disposal last-written guards',t=>{
  const h=gallery(t),owner=adopted(h,{className:'shared-owned',ariaLabel:'Owner label',tabIndex:0});
  h.root.setAttribute('aria-label','External label');h.root.setAttribute('tabindex','5');h.root.setAttribute('data-shared-header','external');
  h.root.setAttribute('data-extra','preserve');h.root.classList.add('external-class');h.root.classList.remove('legacy-gallery');h.root.hidden=true;
  owner.dispose();h.clean();assert.equal(h.root.getAttribute('aria-label'),'External label');assert.equal(h.root.getAttribute('tabindex'),'5');
  assert.equal(h.root.getAttribute('data-shared-header'),'external');assert.equal(h.root.getAttribute('data-extra'),'preserve');
  assert.ok(h.root.classList.contains('external-class'));assert.equal(h.root.classList.contains('legacy-gallery'),false);assert.equal(h.root.hidden,true);
});

for(const failure of ['renderer','ref','invalid-id'])test('constructor '+failure+' failure cleans ownership and permits successor',t=>{
  const h=gallery(t),before=h.root.outerHTML,runtime={...h.runtime},props={id:'bad',adoptRoot:true};
  if(failure==='renderer')runtime.actionHtml=()=>{throw new Error('render failure');};
  if(failure==='ref')props.headerRef=()=>{throw new Error('ref failure');};
  if(failure==='invalid-id')props.id='';
  assert.throws(()=>mount(h.root,runtime,props));assert.equal(h.root.outerHTML,before);h.clean();
  const owner=adopted(h);assert.equal(owner.element,h.root);owner.dispose();h.clean();
});

test('reentrant adoption from constructor ref rejects without changing first owner',t=>{
  const h=gallery(t);let rejected=0;const owner=adopted(h,{headerRef(node){if(node){assert.equal(node,h.root);assert.throws(()=>mount(h.root,h.runtime,{id:'nested',adoptRoot:true}));rejected++;}}});
  assert.equal(rejected,1);assert.equal(h.root.getAttribute('data-shared-header'),'artist-adopted');owner.dispose();h.clean();
});

test('lease stays held through callback cleanup and releases only after teardown',t=>{
  const h=gallery(t);let cleaned=0;const owner=adopted(h,{headerRef(node){assert.equal(node,h.root);return ()=>{assert.throws(()=>mount(h.root,h.runtime,{id:'too-early',adoptRoot:true}));cleaned++;};}});
  owner.dispose();owner.dispose();assert.equal(cleaned,1);h.clean();const next=adopted(h,{id:'next'});assert.equal(next.element,h.root);
});

test('object ref clears only its exact adopted root',t=>{
  const h=gallery(t),ref={current:null},owner=adopted(h,{headerRef:ref});assert.equal(ref.current,h.root);
  const external=h.document.createElement('section');ref.current=external;owner.dispose();assert.equal(ref.current,external);h.clean();
  const next=adopted(h,{headerRef:ref});assert.equal(ref.current,h.root);next.dispose();assert.equal(ref.current,null);h.clean();
});

test('ref replacement invokes cleanup before successor and stale cleanup preserves external ref',t=>{
  const h=gallery(t),events=[],next={current:null};const first=node=>{events.push(node);return()=>events.push('cleanup');};
  const owner=adopted(h,{headerRef:first});owner.update({id:'artist-adopted',headerRef:next});
  assert.deepEqual(events,[h.root,'cleanup']);assert.equal(next.current,h.root);
  const external=h.document.createElement('div');next.current=external;owner.dispose();assert.equal(next.current,external);assert.deepEqual(events,[h.root,'cleanup']);
});

test('dispose reentry during ref replacement cannot install a stale next ref or attributes',t=>{
  const h=gallery(t);let owner;const next={current:null};owner=adopted(h,{headerRef(){return()=>owner.dispose();}});
  owner.update({id:'must-not-install',headerRef:next,ariaLabel:'stale'});
  assert.equal(next.current,null);assert.equal(h.root.getAttribute('aria-label'),'Original Gallery');assert.equal(h.root.hasAttribute('data-shared-header'),false);h.clean();
  assert.equal(adopted(h,{id:'later'}).element,h.root);
});

test('adoption is mount-time and explicit changed update rejects before mutation',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);h.drain();const before=h.root.outerHTML;
  assert.throws(()=>owner.update({id:'changed',adoptRoot:false}));assert.equal(h.root.outerHTML,before);
  owner.update({id:'artist-adopted'});owner.update({id:'artist-adopted',adoptRoot:true});assert.equal(owner.element,h.root);
});

test('transferred consumer nodes and external appended children are never removed by stale cleanup',t=>{
  const h=gallery(t),owner=adopted(h);h.insert(owner);const mobile=h.document.createElement('div');h.host.append(mobile);mobile.append(h.actions);
  const external=h.document.createElement('span');h.root.append(external);owner.dispose();
  assert.equal(h.actions.parentNode,mobile);assert.equal(h.button.closest('.gallery-bar__actions'),h.actions);assert.equal(external.parentNode,h.root);assert.equal(h.root.parentNode,h.host);
});

test('ordinary callers still create and remove their own child header',t=>{
  const h=gallery(t),owner=h.own(mount(h.host,h.runtime,{id:'ordinary',hidden:true}));
  assert.notEqual(owner.element,h.host);assert.equal(owner.element.tagName,'HEADER');assert.equal(owner.element.parentNode,h.host);assert.equal(owner.element.hidden,true);
  owner.update({id:'ordinary',hidden:false});assert.equal(owner.element.hidden,false);owner.dispose();assert.equal(owner.element.parentNode,null);
});
