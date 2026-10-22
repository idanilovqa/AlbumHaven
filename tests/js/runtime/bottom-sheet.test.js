'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,drain}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
function mounted(t, options={}) {
  const h=fixture(t),c=h.context,close=[];let current=true,foreground=true;
  h.overlay.hidden=false;h.overlay.classList.add('is-artist-discography-sheet');
  assert.equal(typeof c.AlbumHavenBottomSheet?.mount,'function','actual registered presenter loaded');
  const api=c.AlbumHavenBottomSheet.mount({overlay:h.overlay,panel:h.panel,handle:h.handle,scroller:h.scroller,toggle:h.toggle,
    readBounds:()=>({header:h.header}),isCurrent:()=>current,foreground:()=>foreground,
    requestClose:reason=>{close.push(reason);return options.close?.(h,api);},backgroundNodes:[h.main,h.player,h.document.body]});
  t.after(()=>api.dispose());h.tick();
  return {...h,api,close,retire(){current=false;},foreground(value){foreground=value;api.update();h.tick();}};
}
const px=(node,name)=>Number.parseFloat(node.style.getPropertyValue(name));
function drag(h,dy,{dx=0,ms=1000,release=true}={}) {
  h.pointer(h.handle,'pointerdown',100,200);h.advance(ms);
  const move=h.pointer(h.context,'pointermove',100+dx,200+dy);h.tick();
  if(release){h.pointer(h.context,'pointerup',100+dx,200+dy);h.tick();}return move;
}
const state=h=>h.overlay.getAttribute('data-sheet-state');

test('actual policy and viewport geometry use Artist header and never subtract the player lane',t=>{
  const h=mounted(t),p=h.context.AlbumHavenBottomSheet.policy;
  assert.deepEqual(JSON.parse(JSON.stringify(p)),{layer:4550,restingRatio:.65,minimumHeight:192,intentSlop:8,verticalRatio:1.5,
    dismissRatio:.25,velocityDistance:48,dismissVelocity:.5,velocityWindow:100});
  assert.equal(px(h.panel,'top'),120);assert.equal(px(h.panel,'height'),442);
  assert.equal(state(h),'resting');assert.equal(h.player.inert,true);assert.equal(h.document.body.inert,false);
  h.api.expand();h.tick();assert.equal(px(h.panel,'height'),680);assert.equal(px(h.panel,'top'),120);
  assert.equal(h.toggle.getAttribute('aria-expanded'),'true');assert.equal(h.panel.getAttribute('role'),'dialog');
});
for(const height of [180,300,800])test(`visual viewport ${height} clamps resting and expanded bounds`,t=>{
  const h=mounted(t);h.viewport({offsetTop:30,height});h.tick();h.api.expand();h.tick();
  assert.equal(px(h.panel,'top'),120);assert.equal(px(h.panel,'height'),Math.max(0,height-90));
  h.api.collapse();h.tick();assert.ok(px(h.panel,'height')<=Math.max(0,height-90));assert.ok(px(h.panel,'height')>=0);
});
test('header observation and visualViewport scroll recompute the actual connected header edge',t=>{
  const h=mounted(t);h.api.expand();h.tick();h.setRect(h.header,{x:0,y:0,width:390,height:190});
  for(const observer of h.resizers)if(observer.nodes.has(h.header))observer.callback([{target:h.header}]);h.tick();
  assert.equal(px(h.panel,'top'),190);h.header.remove();h.viewport({offsetTop:45,height:500},'scroll');h.tick();
  assert.equal(px(h.panel,'top'),45);assert.equal(px(h.panel,'height'),500);
});
for(const [dy,closes] of [[110,false],[111,true]])test(`resting drag ${dy}px applies 25 percent threshold exactly`,t=>{
  const h=mounted(t);drag(h,dy);assert.equal(h.close.length,closes?1:0);
  assert.equal(state(h),closes?'awaiting-dismissal':'resting','undefined navigation result remains pending without disposing the old snap');assert.equal(h.overlay.hidden,false);
});
for(const [distance,time,closes] of [[47,50,false],[48,96,true],[48,97,false]])test(`recent velocity ${distance}px/${time}ms arbitration`,t=>{
  const h=mounted(t);drag(h,distance,{ms:time});assert.equal(h.close.length,closes?1:0);
});
test('stale velocity cannot dismiss a sub-threshold distance after holding the pointer',t=>{
  const h=mounted(t);drag(h,60,{ms:30,release:false});h.advance(101);h.pointer(h.context,'pointerup',100,260);h.tick();assert.deepEqual(h.close,[]);
});
test('upward travel clamps at header and release selects expanded without requesting history',t=>{
  const h=mounted(t);drag(h,-1000);assert.equal(state(h),'expanded');assert.equal(px(h.panel,'height'),680);assert.deepEqual(h.close,[]);
  h.api.collapse();h.tick();assert.equal(state(h),'resting');
});
for(const [dx,dy] of [[0,7],[20,20],[10,14],[80,30]])test(`slop and vertical intent ignore (${dx},${dy})`,t=>{
  const h=mounted(t);const event=drag(h,dy,{dx});assert.equal(event.defaultPrevented,false);assert.deepEqual(h.close,[]);assert.equal(h.captured(h.handle),undefined);
});
for(const kind of ['pointercancel','lostpointercapture','blur','resize','orientationchange'])test(`${kind} cancels a captured dismissal without phantom close`,t=>{
  const h=mounted(t);drag(h,200,{release:false});assert.equal(h.captured(h.handle),1);
  h.send(kind==='lostpointercapture'?h.handle:h.context,kind);h.pointer(h.context,'pointerup',100,400);h.tick();
  assert.deepEqual(h.close,[]);assert.equal(state(h),'resting');assert.equal(h.captured(h.handle),undefined);
});
test('foreground change, explicit suspension and retirement cancel drag authority',t=>{
  const h=mounted(t);drag(h,200,{release:false});h.foreground(false);h.pointer(h.context,'pointerup',100,400);assert.deepEqual(h.close,[]);
  h.foreground(true);h.api.expand();h.tick();h.api.suspend(true);h.tick();assert.equal(state(h),'suspended');
  assert.equal(h.panel.inert,true);h.api.suspend(false);h.tick();assert.equal(state(h),'expanded');assert.equal(h.panel.inert,false);
  drag(h,400,{release:false});h.retire();h.pointer(h.context,'pointerup',100,600);assert.deepEqual(h.close,[]);
});
test('content starts at top, claims only cancelable downward intent and requests one close',t=>{
  const h=mounted(t),target=h.document.createElement('div');h.scroller.append(target);
  h.touch(target,'touchstart',[[10,10]]);h.advance(500);const move=h.touch(target,'touchmove',[[10,150]]);
  assert.equal(move.defaultPrevented,true);h.touch(target,'touchend',[]);h.tick();assert.deepEqual(h.close,['drag']);
});
for(const scenario of ['scrolled','start-scrolled-return-top','horizontal','upward','uncancelable','multi-touch','cancel','nested-scroll'])
  test(`content preserves native ${scenario} input without dismissal`,t=>{
    const h=mounted(t),target=h.document.createElement('div');h.scroller.append(target);
    if(scenario==='scrolled'||scenario==='start-scrolled-return-top')h.scroller.scrollTop=20;
    if(scenario==='nested-scroll'){target.style.overflowY='auto';target.scrollHeight=200;target.clientHeight=40;}
    h.touch(target,'touchstart',[[10,100]]);if(scenario==='start-scrolled-return-top')h.scroller.scrollTop=0;
    if(scenario==='multi-touch')h.touch(target,'touchstart',[[10,100],[20,100,2]]);
    if(scenario==='cancel')h.touch(target,'touchcancel',[]);
    const move=h.touch(target,'touchmove',scenario==='horizontal'?[[180,120]]:scenario==='upward'?[[10,-100]]:[[10,300]],
      {cancelable:scenario!=='uncancelable'});
    h.touch(target,'touchend',[]);h.tick();assert.equal(move.defaultPrevented,false);assert.deepEqual(h.close,[]);
  });
for(const tag of ['a','button','input','select','textarea','label','editable','slider'])test(`${tag} content target never becomes a sheet gesture`,t=>{
  const h=mounted(t),target=h.document.createElement(['editable','slider'].includes(tag)?'div':tag);
  if(tag==='editable')target.setAttribute('contenteditable','true');if(tag==='slider')target.setAttribute('role','slider');h.scroller.append(target);
  h.touch(target,'touchstart',[[10,10]]);const move=h.touch(target,'touchmove',[[10,250]]);h.touch(target,'touchend',[]);
  assert.equal(move.defaultPrevented,false);assert.deepEqual(h.close,[]);
});
test('same touch cannot claim handle and content paths twice',t=>{
  const h=mounted(t);h.pointer(h.handle,'pointerdown',10,10);h.touch(h.scroller,'touchstart',[[10,10]]);
  h.advance(500);h.pointer(h.context,'pointermove',10,200);h.touch(h.scroller,'touchmove',[[10,200]]);
  h.pointer(h.context,'pointerup',10,200);h.touch(h.scroller,'touchend',[]);assert.deepEqual(h.close,['drag']);
});
test('committed drag consumes following player click even after synchronous teardown, only once',t=>{
  const h=mounted(t,{close:(_h,api)=>api.dispose()});let activations=0;
  h.playerButton.addEventListener('click',()=>activations++);drag(h,200);
  const blocked=h.send(h.playerButton,'click',{detail:1});assert.equal(blocked.defaultPrevented,true);assert.equal(activations,0);
  h.send(h.playerButton,'click',{detail:1});assert.equal(activations,1);assert.equal(h.player.inert,false);
});
for(const reset of ['pointerdown','keydown','blur','expiry'])test(`post-disposal one-shot tail clears on ${reset}`,t=>{
  const h=mounted(t,{close:(_h,api)=>api.dispose()});drag(h,200);
  if(reset==='expiry'){const expiry=[...h.timers.values()].filter(item=>item.delay===1000);assert.equal(expiry.length,1);expiry[0].callback();}
  else h.send(h.context,reset,reset==='keydown'?{key:'Tab'}:{pointerId:2,isPrimary:true,button:0});
  assert.equal(h.send(h.playerButton,'click',{detail:1}).defaultPrevented,false);
});
test('keyboard-generated click remains available through the drag teardown tail',t=>{
  const h=mounted(t,{close:(_h,api)=>api.dispose()});drag(h,200);
  assert.equal(h.send(h.playerButton,'click',{detail:0}).defaultPrevented,false);
});
test('actual shared backdrop owner closes once and never treats panel content as backdrop',t=>{
  const h=mounted(t);h.pointer(h.panel,'pointerdown',50,250);h.pointer(h.panel,'pointerup',50,250);h.send(h.panel,'click',{detail:1});assert.deepEqual(h.close,[]);
  h.pointer(h.overlay,'pointerdown',5,5);h.pointer(h.overlay,'pointerup',5,5);h.send(h.overlay,'click',{detail:1});assert.deepEqual(h.close,['backdrop']);
});
test('nested child leases restore original layers and inert values under out-of-order cleanup',t=>{
  const h=mounted(t),one=h.document.createElement('div'),two=h.document.createElement('div');h.document.body.append(one,two);
  one.style.setProperty('z-index','203','important');h.overlay.style.setProperty('z-index','4550');
  const first=h.context.AlbumHavenBottomSheet.acquireChildLayer(one,h.overlay);
  assert.equal(one.style.zIndex,'4551');assert.equal(h.overlay.inert,true);
  const second=h.context.AlbumHavenBottomSheet.acquireChildLayer(two,one);
  assert.equal(two.style.zIndex,'4552');assert.equal(one.inert,true);
  first();assert.equal(one.inert,true);assert.equal(two.style.zIndex,'4552');second();first();
  assert.equal(one.style.zIndex,'203');assert.equal(one.style.getPropertyPriority('z-index'),'important');assert.equal(one.inert,false);assert.equal(h.overlay.inert,false);
});
test('non-sheet parents and ancestors containing the child never acquire global inert locks',t=>{
  const h=mounted(t),child=h.document.createElement('div');h.document.body.append(child);
  const release=h.context.AlbumHavenBottomSheet.acquireChildLayer(child,h.document.body);assert.equal(h.document.body.inert,false);assert.equal(child.style.zIndex,'');release();
});
test('old presenter disposal cannot clear a successor or unrelated external style write',t=>{
  const h=mounted(t);h.panel.style.setProperty('top','19px');
  const successor=h.context.AlbumHavenBottomSheet.mount({overlay:h.overlay,panel:h.panel,handle:h.handle,scroller:h.scroller,toggle:h.toggle,
    readBounds:()=>({header:h.header}),isCurrent:()=>true,foreground:()=>true,requestClose:()=>{},backgroundNodes:[h.player]});
  successor.expand();h.tick();h.api.dispose();assert.equal(state(h),'expanded');assert.equal(h.player.inert,true);
  h.panel.style.top='23px';successor.dispose();assert.equal(h.panel.style.top,'23px');assert.equal(h.player.inert,false);
});
test('Tab wraps only actual foreground and presenter never adds an Escape close handler',t=>{
  const h=mounted(t),buttons=[...h.panel.querySelectorAll('button')].filter(node=>!node.disabled&&!node.hidden);
  buttons.at(-1).focus();const tab=h.send(h.document,'keydown',{key:'Tab'});assert.equal(tab.defaultPrevented,true);assert.equal(h.document.activeElement,buttons[0]);
  h.send(h.document,'keydown',{key:'Escape'});assert.deepEqual(h.close,[]);
  h.foreground(false);buttons.at(-1).focus();assert.equal(h.send(h.document,'keydown',{key:'Tab'}).defaultPrevented,false);
});
test('disposal removes owned listeners, viewport observers, frames and capture without a general interception tail',t=>{
  const h=mounted(t);drag(h,30,{release:false});h.api.dispose();h.api.dispose();
  assert.equal(h.captured(h.handle),undefined);assert.equal(h.viewportListeners.length,0);
  assert.equal(h.resizers.filter(row=>row.nodes.has(h.panel)||row.nodes.has(h.header)).length,0);
  const close=h.close.length;h.pointer(h.context,'pointerup',100,900);h.tick();assert.equal(h.close.length,close);
  assert.equal(h.send(h.playerButton,'click',{detail:1}).defaultPrevented,false);
});

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function tryPendingInputs(h){drag(h,200);h.send(h.toggle,'click',{detail:0});h.api.expand();h.api.collapse();
  h.pointer(h.overlay,'pointerdown',0,0);h.pointer(h.overlay,'pointerup',0,0);h.send(h.overlay,'click',{detail:1});h.tick();}
test('undefined dismissal outcome stays pending at old geometry and blocks all repeated presenter inputs',t=>{
  const h=mounted(t),top=h.panel.style.top,height=h.panel.style.height;drag(h,200);tryPendingInputs(h);
  assert.deepEqual(h.close,['drag']);assert.equal(state(h),'awaiting-dismissal');assert.equal(h.panel.style.top,top);assert.equal(h.panel.style.height,height);
  assert.equal(h.overlay.hidden,false);assert.equal(h.toggle.getAttribute('aria-expanded'),'false');
});
for(const outcome of ['false','rejected','accepted'])test(`${outcome} settlement uses real presenter pending lifetime`,async t=>{
  const gate=deferred(),h=mounted(t,{close:()=>gate.promise});drag(h,200);tryPendingInputs(h);assert.equal(h.close.length,1);
  if(outcome==='rejected')gate.reject(new Error('navigation rejected'));else gate.resolve(outcome==='accepted');
  await drain();h.tick();assert.equal(state(h),outcome==='accepted'?'awaiting-dismissal':'resting');
  assert.equal(h.overlay.hidden,false,'promise acceptance alone is not committed cleanup');
  h.send(h.toggle,'click',{detail:0});h.tick();assert.equal(h.toggle.getAttribute('aria-expanded'),outcome==='accepted'?'false':'true');
});
test('synchronous false or thrown dismissal restores input without remounting',t=>{
  const h=mounted(t,{close:()=>false});drag(h,200);assert.equal(state(h),'resting');h.api.expand();h.tick();assert.equal(state(h),'expanded');
  const throwing=mounted(t,{close:()=>{throw new Error('history.go rejected');}});drag(throwing,200);assert.equal(state(throwing),'resting');
  throwing.api.expand();throwing.tick();assert.equal(state(throwing),'expanded');
});
test('old rejected promise cannot reset expanded successor presentation',async t=>{
  const gate=deferred(),h=mounted(t,{close:()=>gate.promise});drag(h,200);h.api.dispose();
  const next=h.context.AlbumHavenBottomSheet.mount({overlay:h.overlay,panel:h.panel,handle:h.handle,scroller:h.scroller,toggle:h.toggle,
    readBounds:()=>({header:h.header}),isCurrent:()=>true,foreground:()=>true,requestClose:()=>{},backgroundNodes:[h.player]});
  t.after(()=>next.dispose());next.expand();h.tick();gate.resolve(false);await drain();h.tick();
  assert.equal(state(h),'expanded');assert.equal(h.toggle.getAttribute('aria-expanded'),'true');assert.equal(h.player.inert,true);
});
for(const timing of [20,1000])for(const where of ['before-rest','at-rest'])test(`expanded ${timing}ms downward collapse ${where} never dismisses`,t=>{
  const h=mounted(t),restingHeight=px(h.panel,'height');h.api.expand();h.tick();const rest=px(h.panel,'height')-restingHeight;
  drag(h,where==='at-rest'?rest:rest-1,{ms:timing});assert.deepEqual(h.close,[]);assert.equal(state(h),'resting');assert.equal(px(h.panel,'height'),restingHeight);
});
for(const [extra,ms,closes] of [[110,1000,false],[111,1000,true],[47,20,false],[48,20,true]])
  test(`expanded dismissal requires ${extra}px beyond rest with ${ms}ms movement`,t=>{
    const h=mounted(t),height=px(h.panel,'height');h.api.expand();h.tick();const rest=px(h.panel,'height')-height;
    assert.equal(height*.25,110.5,'threshold is based on actual resting visible geometry');
    drag(h,rest+extra,{ms});assert.equal(h.close.length,closes?1:0);assert.equal(state(h),closes?'awaiting-dismissal':'resting');
  });

test('bounded CSS declaration platform serializes zeros, fractional px and priority instead of raw strings',t=>{
  const h=fixture(t),node=h.document.createElement('div');node.style.setProperty('transform','translate3d(0, 12.123456789px, 0)','IMPORTANT');
  assert.equal(node.style.transform,'translate3d(0px, 12.1235px, 0px)');assert.equal(node.style.getPropertyPriority('transform'),'important');
  node.style.top='001.2500px';assert.equal(node.style.top,'1.25px');node.style.setProperty('height','30.000000px');assert.equal(node.style.height,'30px');
  node.style.setProperty('top','99px','invalid');assert.equal(node.style.top,'1.25px','invalid CSS priority cannot change declaration');
});
for(const existing of [false,true])test(`canonical geometry leases restore ${existing?'preexisting':'absent'} declarations and priorities`,t=>{
  const h=fixture(t);h.overlay.hidden=false;h.overlay.classList.add('is-artist-discography-sheet');
  if(existing){h.panel.style.setProperty('transform','translate3d(0, 9.125px, 0)','important');h.panel.style.setProperty('top','13.5px','important');h.panel.style.height='123.25px';}
  const before=['transform','top','height'].map(name=>[name,h.panel.style.getPropertyValue(name),h.panel.style.getPropertyPriority(name)]);
  const api=h.context.AlbumHavenBottomSheet.mount({overlay:h.overlay,panel:h.panel,handle:h.handle,scroller:h.scroller,toggle:h.toggle,
    readBounds:()=>({header:h.header}),isCurrent:()=>true,foreground:()=>true,requestClose:()=>false,backgroundNodes:[h.player]});
  h.viewport({height:799.1234567,offsetTop:1.23456789});h.tick();api.expand();h.tick();
  assert.match(h.panel.style.transform,/translate3d\(0px,/);api.dispose();
  assert.deepEqual(['transform','top','height'].map(name=>[name,h.panel.style.getPropertyValue(name),h.panel.style.getPropertyPriority(name)]),before);
});
test('canonical nested successor restoration preserves original transform while honoring a genuine external write',t=>{
  const h=mounted(t);h.api.dispose();h.panel.style.setProperty('transform','translate3d(0, 2.5px, 0)','important');
  const opts={overlay:h.overlay,panel:h.panel,handle:h.handle,scroller:h.scroller,toggle:h.toggle,readBounds:()=>({header:h.header}),
    isCurrent:()=>true,foreground:()=>true,requestClose:()=>false,backgroundNodes:[h.player]};
  const a=h.context.AlbumHavenBottomSheet.mount(opts);h.tick();const b=h.context.AlbumHavenBottomSheet.mount(opts);b.expand();h.tick();a.dispose();
  h.panel.style.top='24.125px';b.dispose();assert.equal(h.panel.style.transform,'translate3d(0px, 2.5px, 0px)');
  assert.equal(h.panel.style.getPropertyPriority('transform'),'important');assert.equal(h.panel.style.top,'24.125px');
});
