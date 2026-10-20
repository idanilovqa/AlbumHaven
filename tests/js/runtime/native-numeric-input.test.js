'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load}=require('./home-friends-native-app-fixture.cjs');
let mount;test.before(async()=>{({mountNumericInput:mount}=await load('native-controls.mjs'));});
const props=(patch={})=>({id:'numeric-owner',label:'Year',value:'',...patch});
function setup(t){const h=fixture(t),host=h.document.createElement('span');h.host.append(host);return {...h,host,baseline:h.listeners(),ownNumeric(value){return h.own(mount(host,value));}};}
const input=(h,node,value)=>{node.value=value;node.dispatchEvent(new h.c.Event('input',{bubbles:true}));};

test('numeric owner uses the shared class and native attributes without default domain bounds',t=>{
  const h=setup(t),owner=h.ownNumeric(props()),node=owner.element;assert.equal(node.tagName,'INPUT');assert.equal(node.parentNode,h.host);
  assert.ok(node.classList.contains('ui-numeric-input'));assert.equal(node.getAttribute('type'),'number');assert.equal(node.getAttribute('inputmode'),'numeric');
  assert.equal(node.id,'numeric-owner');assert.equal(node.getAttribute('aria-label'),'Year');assert.equal(node.getAttribute('step'),'1');assert.equal(node.hasAttribute('min'),false);assert.equal(node.hasAttribute('max'),false);assert.equal(node.disabled,false);
});

test('complete controlled updates keep input identity and focus and remove omitted bounds and handler',t=>{
  const h=setup(t),calls=[],owner=h.ownNumeric(props({value:'7',min:1,max:10,step:2,onChange:value=>calls.push(value)})),node=owner.element;node.focus();
  owner.update(props({value:'9',label:'Rating',min:0,max:12,step:3,onChange:value=>calls.push('new:'+value)}));
  assert.equal(owner.element,node);assert.equal(h.document.activeElement,node);assert.equal(node.value,'9');assert.equal(node.getAttribute('min'),'0');assert.equal(node.getAttribute('max'),'12');assert.equal(node.getAttribute('step'),'3');assert.deepEqual(calls,[]);
  input(h,node,'');assert.deepEqual(calls,['new:']);owner.update(props({value:''}));assert.equal(node.hasAttribute('min'),false);assert.equal(node.hasAttribute('max'),false);assert.equal(node.getAttribute('step'),'1');input(h,node,'2');assert.deepEqual(calls,['new:']);
});

for(const value of ['', '0', '-3', '1.5', '0007'])test('raw current input string reaches caller without domain parsing '+JSON.stringify(value),t=>{
  const h=setup(t),calls=[],owner=h.ownNumeric(props({onChange:next=>calls.push(next)}));input(h,owner.element,value);assert.deepEqual(calls,[value]);
});

test('unchanged controlled value is not rewritten while editing',t=>{
  const h=setup(t),owner=h.ownNumeric(props({value:'12'})),node=owner.element;let current=node.value,writes=0;
  Object.defineProperty(node,'value',{configurable:true,get:()=>current,set:value=>{writes++;current=value;}});node.focus();
  owner.update(props({value:'12',label:'New label'}));assert.equal(writes,0);assert.equal(h.document.activeElement,node);
  owner.update(props({value:'13'}));assert.equal(writes,1);assert.equal(current,'13');
});

test('disabled and disposed owners never dispatch and reenable uses latest callback',t=>{
  const h=setup(t),calls=[],owner=h.ownNumeric(props({disabled:true,onChange:value=>calls.push(value)})),node=owner.element;
  assert.equal(node.disabled,true);assert.equal(node.getAttribute('aria-disabled'),'true');input(h,node,'4');assert.deepEqual(calls,[]);
  owner.update(props({onChange:value=>calls.push('live:'+value)}));assert.equal(node.disabled,false);assert.equal(node.getAttribute('aria-disabled'),'false');input(h,node,'5');assert.deepEqual(calls,['live:5']);
  owner.dispose();input(h,node,'6');assert.deepEqual(calls,['live:5']);owner.dispose();assert.deepEqual(h.listeners(),h.baseline);
});

const invalid=[{id:''},{id:2},{label:''},{label:null},{value:3},{disabled:1},{min:NaN},{max:Infinity},{min:1.5},{max:2.5},{min:5,max:4},{step:0},{step:-1},{step:1.5},{onChange:true}];
for(const [index,patch] of invalid.entries())test('invalid complete update is atomic '+index,t=>{
  const h=setup(t),calls=[],owner=h.ownNumeric(props({value:'3',min:1,max:10,onChange:value=>calls.push(value)})),node=owner.element,before=node.outerHTML;node.focus();
  assert.throws(()=>owner.update(props(patch)),TypeError);assert.equal(owner.element,node);assert.equal(node.outerHTML,before);assert.equal(node.value,'3');assert.equal(h.document.activeElement,node);
  input(h,node,'4');assert.deepEqual(calls,['4']);
});

test('invalid successor mount preserves the current node and handler',t=>{
  const h=setup(t),calls=[],owner=h.ownNumeric(props({onChange:value=>calls.push(value)})),node=owner.element;
  assert.throws(()=>mount(h.host,props({step:0})),TypeError);assert.equal(node.parentNode,h.host);input(h,node,'8');assert.deepEqual(calls,['8']);
});

test('valid successor retires old input and stale disposal or update cannot touch it',t=>{
  const h=setup(t),oldCalls=[],newCalls=[],old=h.ownNumeric(props({onChange:value=>oldCalls.push(value)})),oldNode=old.element;
  const next=h.ownNumeric(props({id:'successor',value:'6',onChange:value=>newCalls.push(value)}));assert.notEqual(next.element,oldNode);assert.equal(oldNode.parentNode,null);
  old.dispose();old.update(props({value:'99'}));assert.equal(next.element.parentNode,h.host);assert.equal(next.element.value,'6');input(h,oldNode,'2');assert.deepEqual(oldCalls,[]);input(h,next.element,'7');assert.deepEqual(newCalls,['7']);
});

test('callback update cannot be followed by a stale value write or duplicate dispatch',t=>{
  const h=setup(t),calls=[];let owner;owner=h.ownNumeric(props({onChange:value=>{calls.push(value);owner.update(props({value:'42'}));}}));input(h,owner.element,'7');assert.deepEqual(calls,['7']);assert.equal(owner.element.value,'42');
});

test('callback replacement preserves successor and detaches old listener',t=>{
  const h=setup(t),calls=[];let old,next;old=h.ownNumeric(props({onChange:value=>{calls.push(value);old.dispose();next=h.ownNumeric(props({id:'new',value:'11'}));}}));const oldNode=old.element;
  input(h,oldNode,'8');assert.deepEqual(calls,['8']);assert.equal(next.element.value,'11');assert.equal(next.element.parentNode,h.host);input(h,oldNode,'9');assert.deepEqual(calls,['8']);
});

test('constructor insertion failure removes its allocated input and listener and releases host ownership',t=>{
  const h=setup(t),methods=['append','appendChild','replaceChildren','insertBefore'],originals=new Map(),failure=new Error('insertion failed');let thrown=false;
  for(const name of methods){const original=h.host[name];if(typeof original!=='function')continue;originals.set(name,original);h.host[name]=function(...args){const result=original.apply(this,args);if(!thrown&&this.querySelector('input')){thrown=true;throw failure;}return result;};}
  try{assert.throws(()=>mount(h.host,props()),error=>error===failure);assert.equal(thrown,true);}finally{for(const [name,original]of originals)h.host[name]=original;}
  assert.equal(h.host.querySelector('input'),null);assert.deepEqual(h.listeners(),h.baseline);const next=h.ownNumeric(props({value:'2'}));assert.equal(next.element.parentNode,h.host);assert.equal(next.element.value,'2');
});
