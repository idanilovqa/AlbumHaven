const test = require('node:test');
const assert = require('node:assert/strict');
const component = require('../../music_app/static/js/unfolding-action-button.js');
function fixture() {
  const doc = { activeElement: null, addEventListener(k,f){this[k]=f;}, removeEventListener(k){delete this[k];} };
  function element() {
    const classes = new Set();
    return { dataset: {}, attrs: {}, listeners: {}, disabled: false,
      classList: { add(...ns){ns.forEach(n=>classes.add(n));}, contains(n){return classes.has(n);}, toggle(n,v){v?classes.add(n):classes.delete(n);} },
      setAttribute(k,v){this.attrs[k]=v;}, removeAttribute(k){delete this.attrs[k];},
      addEventListener(k,f){this.listeners[k]=f;}, removeEventListener(k){delete this.listeners[k];},
      emit(k,e={}){this.listeners[k]?.({preventDefault(){},stopPropagation(){},...e});},
      focus(){doc.activeElement=this;}, closest(){return this;}
    };
  }
  const buttons = ['one','two','three'].map(value=>Object.assign(element(),{dataset:{actionValue:value}}));
  const root=Object.assign(element(),{ownerDocument:doc,style:{setProperty(){}},querySelectorAll:()=>buttons,contains:n=>buttons.includes(n)||n===root});
  const values=[]; const api=component.mount(root,{onSelect:v=>values.push(v)});
  return {root,buttons,doc,api,values};
}
test('three actions expand and selecting the third collapses to that action',()=>{
  const {root,buttons,values}=fixture();
  assert.deepEqual(buttons.map(b=>b.tabIndex),[0,-1,-1]);
  root.emit('click',{target:buttons[0],detail:1});
  assert.deepEqual(buttons.map(b=>b.tabIndex),[0,0,0]);
  root.emit('click',{target:buttons[2],detail:1});
  assert.deepEqual(values,['three']);
  assert.deepEqual(buttons.map(b=>b.tabIndex),[-1,-1,0]);
  assert.equal(root.classList.contains('is-open'),false);
});
test('keyboard expansion and arrows move focus; Escape restores selection without a callback',()=>{
  const {root,buttons,doc,values}=fixture();
  root.emit('click',{target:buttons[0],detail:0});
  assert.equal(doc.activeElement,buttons[1]);
  root.emit('keydown',{key:'ArrowRight'}); assert.equal(doc.activeElement,buttons[2]);
  root.emit('keydown',{key:'Escape'}); assert.equal(doc.activeElement,buttons[0]);
  assert.deepEqual(values,[]);
});
test('outside pointer, focus departure and destroy close or detach the controller',()=>{
  const {root,buttons,doc,api}=fixture();
  api.open();doc.pointerdown({target:{}});assert.equal(root.classList.contains('is-open'),false);
  api.select('two');assert.deepEqual(buttons.map(b=>b.tabIndex),[-1,0,-1]);
  api.open();root.emit('focusout',{relatedTarget:{}});assert.equal(root.classList.contains('is-open'),false);
  api.destroy();assert.equal(doc.pointerdown,undefined);
});
test('renderer uses ActionButton and escapes caller labels and values',()=>{
  const html=component.render({actions:[{value:'<one>',ariaLabel:'First <action>',icon:'play'}]});
  assert.match(html,/action-button/);assert.match(html,/data-action-value="&lt;one&gt;"/);
  assert.match(html,/First &lt;action&gt;/);assert.throws(()=>component.render(),/requires actions/);
});
