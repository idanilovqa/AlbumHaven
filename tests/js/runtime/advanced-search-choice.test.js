'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./search-native-fixtures/advanced-runtime.cjs');
const state=h=>h.owner('advancedSearchState'),panel=h=>h.document.getElementById('search-advanced-panel');
function open(h){h.input.value='';h.dispatch(h.input,'input');h.click(h.document.getElementById('search-advanced-toggle'));return state(h).session;}
function menu(h){return h.document.querySelector('.settings-foobar-format-menu');}
function trigger(h){return panel(h).querySelector('[data-advanced-choice="family"]');}
test('portaled Choice rejects a moved anchor before the next event without a resize',t=>{
  const h=fixture(t),session=open(h),parent=panel(h),button=trigger(h);
  h.click(button);const child=session.child,portal=menu(h);
  assert.ok(child?.isOpen);assert.equal(portal.parentElement,h.document.body);
  assert.equal(parent.contains(portal),false);assert.equal(parent.contains(button),true);
  assert.equal(session.visible,true);assert.equal(parent.hidden,false);
  const target=portal.querySelector('[data-foobar-format="love"]'),draft=session.draft;
  h.document.body.append(button);
  const event=h.dispatch(target,'click');
  assert.equal(child.ownsEvent(event),false);assert.equal(h.c.admitsAdvancedEvent(event),false);
  assert.equal(session.draft,draft,'a moved anchor cannot authorize a field edit');
  assert.equal(child.isOpen,false);assert.equal(session.child,null);assert.equal(menu(h),null);
  assert.equal(session.visible,true);assert.equal(parent.hidden,false);
});
test('a disconnected Choice anchor cannot retain a portaled child',t=>{
  const h=fixture(t),session=open(h),button=trigger(h);h.click(button);const child=session.child;
  assert.ok(child?.isOpen);const target=menu(h).querySelector('[data-foobar-format="love"]'),draft=session.draft;
  button.remove();const event=h.dispatch(target,'click');
  assert.equal(child.ownsEvent(event),false);assert.equal(session.draft,draft);
  assert.equal(child.isOpen,false);assert.equal(menu(h),null);assert.equal(session.child,null);
  assert.equal(session.visible,true);assert.equal(panel(h).hidden,false);
});
test('a connected anchor moved outside its parent retires Choice on mutation delivery without resize',async t=>{
  const h=fixture(t),session=open(h),button=trigger(h);h.click(button);const child=session.child;
  assert.ok(child?.isOpen);h.document.body.append(button);await h.flush();
  assert.equal(button.isConnected,true);assert.equal(child.isOpen,false);assert.equal(menu(h),null);
  assert.equal(session.child,null);assert.equal(session.visible,true);assert.equal(panel(h).hidden,false);
});
test('an unrelated Choice still dismisses the prior anchored parent',t=>{
  const h=fixture(t),session=open(h),foreign=h.document.createElement('button');h.document.body.append(foreign);
  const child=h.c.openUtilityChoiceDropdown(foreign,{formats:['x'],selected:'x',label:'Foreign',onSelect:()=>true});
  assert.ok(child?.isOpen);assert.equal(session.visible,false);assert.equal(panel(h).hidden,true);
  assert.equal(h.owner('galleryMainSurfaceController').current(),null);
});
test('same actual click proof survives early portal removal and preserves mobile Search',t=>{const h=fixture(t);h.c.innerWidth=390;h.c.setMobileSearchOpen(true);h.document.addEventListener('click',h.c.handleMobileSearchOutsideClick,true);const session=open(h);h.click(trigger(h));const child=session.child,target=menu(h).querySelector('[data-foobar-format="love"]');assert.equal(menu(h).parentElement,h.document.body);let bubbled=0;h.document.addEventListener('click',event=>{if(event.target!==target)return;bubbled++;assert.equal(child.isOpen,false);assert.equal(target.isConnected,false);assert.equal(session.child,null);assert.equal(h.c.admitsAdvancedEvent(event),true,'same event retains window-capture proof after child detached');assert.equal(h.owner('mobilePageState').searchOpen,true);});const event=h.dispatch(target,'click',{detail:0});assert.equal(bubbled,1);assert.equal(event.stopped,false);assert.equal(session.visible,true);assert.equal(session.draft.family,'love');assert.equal(h.input.inert,false);assert.equal(h.document.activeElement,trigger(h));});
test('pointer proof cannot authorize distinct click; a closed portal target is not exempt',t=>{const h=fixture(t);const session=open(h);h.click(trigger(h));const target=menu(h).querySelector('[data-foobar-format="love"]');const pointer=h.dispatch(target,'pointerdown');assert.equal(h.c.admitsAdvancedEvent(pointer),true);session.child.close({restoreFocus:false});const foreign=new h.c.Event('click');foreign.target=target;assert.equal(h.c.admitsAdvancedEvent(foreign),false);assert.equal(h.owner('galleryMainSurfaceController').handlePointerDown(foreign),true);assert.equal(session.visible,false);});
test('old proof is rejected after close/reopen visibility epoch and after scope retirement',t=>{const h=fixture(t);const session=open(h);h.click(trigger(h));const event=h.dispatch(menu(h).querySelector('[data-foobar-format="love"]'),'pointerdown');assert.equal(h.c.admitsAdvancedEvent(event),true);h.c.closeGalleryMainSurface(false,{reason:'cancel'});const toggle=h.document.getElementById('search-advanced-toggle');h.dispatch(toggle,'pointerdown');h.dispatch(toggle,'pointerup');const reopened=h.dispatch(toggle,'click');assert.equal(reopened.defaultPrevented,true,'actual toggle handles the fresh click');assert.equal(reopened.stopped,false,'fresh gesture is not the old child drag tail');assert.equal(session.visible,true);assert.equal(panel(h).hidden,false);assert.equal(state(h).session,session);assert.equal(h.c.admitsAdvancedEvent(event),false);h.click(trigger(h));const next=h.dispatch(menu(h).querySelector('[data-foobar-format="love"]'),'pointerdown');h.change('actor');assert.equal(h.c.admitsAdvancedEvent(next),false);});
test('unrelated real Choice events do not acquire Advanced exemption',t=>{const h=fixture(t);open(h);const foreign=h.document.createElement('button');h.document.body.append(foreign);const owner=h.c.openUtilityChoiceDropdown(foreign,{formats:[{value:'x',label:'X'}],selected:'x',label:'Foreign',onSelect:()=>false});assert.ok(owner?.isOpen);const event=h.dispatch(menu(h).querySelector('[data-foobar-format="x"]'),'pointerdown');assert.equal(owner.ownsEvent(event),true);assert.equal(h.c.admitsAdvancedEvent(event),false);});
test('child Escape owns held key sequence; IME parent Escape stays open',t=>{const h=fixture(t);const session=open(h);h.click(trigger(h));const target=menu(h).querySelector('button');const first=h.dispatch(target,'keydown',{key:'Escape'});assert.equal(first.defaultPrevented,true);assert.equal(session.child,null);assert.equal(session.visible,true);const repeat=h.dispatch(trigger(h),'keydown',{key:'Escape',repeat:true});assert.equal(repeat.defaultPrevented,true);assert.equal(session.visible,true);h.dispatch(trigger(h),'keyup',{key:'Escape'});for(const extra of [{isComposing:true},{keyCode:229}]){h.dispatch(trigger(h),'keydown',{key:'Escape',...extra});assert.equal(session.visible,true);}h.dispatch(trigger(h),'keydown',{key:'Escape'});assert.equal(session.visible,false);});
test('Choice legacy default label update, same-trigger toggle and closed-owner idempotence',t=>{const h=fixture(t),button=h.document.createElement('button');button.innerHTML='<span class="ui-button__content">Old</span>';h.document.body.append(button);const values=[];const options={formats:['a','b'],selected:'a',label:'Legacy',onSelect:value=>values.push(value)};let owner=h.c.openUtilityChoiceDropdown(button,options);assert.ok(owner.isOpen);h.click(menu(h).querySelector('[data-foobar-format="b"]'));assert.deepEqual(values,['b']);assert.equal(button.querySelector('.ui-button__content').textContent,'b');assert.equal(owner.isOpen,false);assert.equal(owner.close(),undefined);owner=h.c.openUtilityChoiceDropdown(button,options);assert.equal(h.c.openUtilityChoiceDropdown(button,options),null);assert.equal(owner.isOpen,false);assert.equal(menu(h),null);});
test('Choice onClose successor is not overwritten by stale outer acquisition or cleanup',t=>{const h=fixture(t);const add=()=>{const b=h.document.createElement('button');h.document.body.append(b);return b;},a=add(),b=add(),c=add();const opts={formats:['a'],selected:'a',label:'Witness',onSelect:()=>true};let successor;const old=h.c.openUtilityChoiceDropdown(a,{...opts,onClose:()=>{successor=h.c.openUtilityChoiceDropdown(c,opts);}});const stale=h.c.openUtilityChoiceDropdown(b,opts);assert.equal(stale,null);assert.ok(successor?.isOpen);old.close();assert.ok(successor.isOpen);assert.equal(c.getAttribute('aria-expanded'),'true');assert.equal(h.document.querySelectorAll('.settings-foobar-format-menu').length,1);});
test('Choice Tab, Home/End and disabled options retain common keyboard behavior',t=>{const h=fixture(t),b=h.document.createElement('button');h.document.body.append(b);const owner=h.c.openUtilityChoiceDropdown(b,{formats:[{value:'a',label:'A'},{value:'x',label:'X',disabled:true},{value:'z',label:'Z'}],selected:'a',label:'Keys',onSelect:()=>true});const a=menu(h).querySelector('[data-foobar-format="a"]'),z=menu(h).querySelector('[data-foobar-format="z"]');h.dispatch(a,'keydown',{key:'End'});assert.equal(h.document.activeElement,z);h.dispatch(z,'keydown',{key:'Home'});assert.equal(h.document.activeElement,a);const tab=h.dispatch(a,'keydown',{key:'Tab'});assert.equal(tab.defaultPrevented,false);assert.equal(owner.isOpen,false);assert.equal(h.document.activeElement,b);});
test('generic anchored controller detaches before callbacks and preserves successor focus',t=>{const h=fixture(t),controller=h.c.createAnchoredSurfaceController();const a=h.document.createElement('button'),b=h.document.createElement('button');h.document.body.append(a,b);const first={key:'one',anchor:a,surface:a,onDismiss:()=>controller.activate({key:'successor',anchor:b,surface:b})};controller.activate(first);assert.equal(controller.activate({key:'stale',anchor:a,surface:a}),'superseded');assert.equal(controller.current().key,'successor');assert.equal(h.document.activeElement===a,false);});
test('close wrapper cannot dismiss same retained session reopened by its descriptor callback',t=>{const h=fixture(t),session=open(h);const controller=h.owner('galleryMainSurfaceController'),descriptor=controller.current(),dismiss=descriptor.onDismiss;let calls=0;assert.equal(typeof dismiss,'function');
  // Reentrancy injector at the public descriptor callback boundary: run the
  // actual captured Search hook unchanged, then use the actual reopen owner.
  // Preserve R2's exact hook ownership identity on both descriptor and session.
  // No close/session policy is implemented by this callback.
  descriptor.onDismiss=session.dismissHook=options=>{calls++;dismiss(options);assert.equal(session.visible,false);assert.equal(h.c.toggleSearchAdvancedFilters(),true);};
  const priorVisibility=session.visibility;h.c.closeSearchAdvancedFilters({reason:'cancel'});
  assert.equal(calls,1);assert.equal(state(h).session,session);assert.ok(session.visibility>priorVisibility);assert.equal(session.visible,true,'old fallback must not hide successor epoch');assert.equal(panel(h).hidden,false);assert.ok(panel(h).childNodes.length);assert.equal(controller.isOpen('search-filters'),true);assert.notEqual(controller.current(),descriptor);
});
test('unowned opening fallback cleans local session without closing a foreign descriptor hook',t=>{const h=fixture(t),session=open(h),controller=h.owner('galleryMainSurfaceController'),descriptor=controller.current();h.click(trigger(h));const child=session.child;assert.ok(child?.isOpen);let foreignCalls=0;
  // A descriptor with a different hook does not own this opening. Only this
  // callback boundary is changed; the real session/model/child are untouched.
  descriptor.onDismiss=()=>{foreignCalls++;};assert.notEqual(descriptor.onDismiss,session.dismissHook);
  h.c.closeSearchAdvancedFilters({reason:'cancel'});
  assert.equal(foreignCalls,0);assert.equal(controller.current(),descriptor);assert.equal(session.visible,false);assert.equal(child.isOpen,false);assert.equal(session.child,null);assert.equal(panel(h).hidden,true);assert.equal(panel(h).childNodes.length,0);assert.equal(state(h).session,session);
});
test('aborted acquisition before descriptor ownership invokes real unowned-opening cleanup',t=>{const h=fixture(t),nativeAcquire=h.c.openGalleryMainSurface;let opening,calls=0;
  // Acquisition-boundary fault injection, not a browser propagation witness.
  // Actual toggle creates the model/session and renders the opening. A failed
  // external acquisition invokes the real close owner before returning false.
  h.c.openGalleryMainSurface=function(key,...args){if(key!=='search-filters')return nativeAcquire.call(this,key,...args);calls++;opening=state(h).session;assert.equal(opening.visible,true);assert.equal(h.owner('galleryMainSurfaceController').current(),null);h.c.closeSearchAdvancedFilters({reason:'cancel'});return false;};
  try {assert.equal(h.c.toggleSearchAdvancedFilters(),false);} finally {h.c.openGalleryMainSurface=nativeAcquire;}
  assert.equal(calls,1);assert.ok(opening);assert.equal(opening.visible,false);assert.equal(opening.child,null);assert.equal(h.owner('galleryMainSurfaceController').current(),null);assert.equal(panel(h).hidden,true);assert.equal(panel(h).childNodes.length,0);assert.equal(h.document.getElementById('search-advanced-toggle').getAttribute('aria-expanded'),'false');
});

test('stale Choice rejection consumes only its captured child event, without granting proof',t=>{
  const h=fixture(t),session=open(h),button=trigger(h);h.click(button);
  const child=session.child,target=menu(h).querySelector('[data-foobar-format="love"]'),draft=session.draft;
  button.remove();let bubbled=0;h.document.addEventListener('click',()=>{bubbled++;});
  const event=h.dispatch(target,'click');
  assert.equal(event.defaultPrevented,true);assert.equal(event.stopped,true);assert.equal(bubbled,0);
  assert.equal(child.ownsEvent(event),false);assert.equal(h.c.admitsAdvancedEvent(event),false);
  assert.equal(child.isOpen,false);assert.equal(session.child,null);assert.equal(menu(h),null);
  assert.equal(session.draft,draft);assert.equal(session.visible,true);assert.equal(panel(h).hidden,false);
});
test('invalid Choice anchor does not consume an unrelated outside event or preserve the parent',t=>{
  const h=fixture(t),session=open(h),button=trigger(h);h.click(button);const child=session.child;
  const outside=h.document.createElement('button');h.document.body.append(outside);button.remove();
  let bubbled=0;h.document.addEventListener('click',event=>{if(event.target===outside)bubbled++;});
  const event=h.dispatch(outside,'click');
  assert.equal(event.defaultPrevented,false);assert.equal(event.stopped,false);assert.equal(bubbled,1);
  assert.equal(child.ownsEvent(event),false);assert.equal(h.c.admitsAdvancedEvent(event),false);
  assert.equal(child.isOpen,false);assert.equal(session.visible,false);assert.equal(panel(h).hidden,true);
});
test('closed Choice cannot consume a later event even when its former anchor remains connected',t=>{
  const h=fixture(t),session=open(h),button=trigger(h);h.click(button);const child=session.child;
  child.close({restoreFocus:false});let bubbled=0;
  h.document.addEventListener('click',event=>{if(event.target===button)bubbled++;});
  const event=h.dispatch(button,'click');
  assert.equal(event.stopped,false);assert.equal(bubbled,1);assert.equal(child.ownsEvent(event),false);
  assert.equal(child.isOpen,false);assert.ok(session.child?.isOpen);assert.notEqual(session.child,child);
  assert.equal(session.visible,true);assert.equal(panel(h).hidden,false);
});
