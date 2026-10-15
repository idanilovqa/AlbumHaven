const test=require('node:test'),assert=require('node:assert/strict');
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
const {withPlaylistDomPlatform}=require('./playlist-dom-platform.cjs');
const fixture=()=>withPlaylistDomPlatform(createNativeHomeRuntime());
test('Playlist platform walks actual descendant text in order and retains currentNode at exhaustion',()=>{
 const h=fixture(),d=h.document,root=d.createElement('div'),span=d.createElement('span');
 const one=d.createTextNode('one'),blank=d.createTextNode(' '),two=d.createTextNode('two');root.append(one,span);span.append(blank,two);
 const walker=d.createTreeWalker(root,h.context.NodeFilter.SHOW_TEXT);assert.equal(walker.currentNode,root);
 assert.equal(walker.nextNode(),one);assert.equal(one.parentElement,root);assert.equal(walker.nextNode(),blank);assert.equal(walker.nextNode(),two);assert.equal(two.parentElement,span);assert.equal(walker.nextNode(),null);assert.equal(walker.currentNode,two);
 const three=d.createTextNode('three');span.append(three);assert.equal(walker.nextNode(),three);
 assert.throws(()=>d.createTreeWalker(root,1),/SHOW_TEXT/);
});
test('Playlist platform measures selected text only through explicit geometry and installs effective window constants',()=>{
 const h=fixture(),text=h.document.createTextNode('measured'),range=h.document.createRange(),win={};h.installWindow(win);assert.equal(win.NodeFilter.SHOW_TEXT,4);
 range.selectNodeContents(text);assert.equal(range.getBoundingClientRect().width,0);h.setTextRect(text,{x:5,y:7,width:42,height:12});const r=range.getBoundingClientRect();assert.equal(r.width,42);assert.equal(r.left,5);assert.equal(r.right,47);assert.equal(r.bottom,19);
});
test('Playlist platform disabled predicates include fieldset rules and preserve literal attribute values',()=>{
 const h=fixture(),d=h.document,host=d.createElement('div');d.body.append(host);
 host.innerHTML='<button id="enabled"></button><button id="disabled" disabled></button><div id="ordinary" disabled data-label=":disabled"></div><fieldset disabled><legend><input id="exempt"></legend><input id="inherited"></fieldset><select><optgroup disabled><option id="option"></option></optgroup></select>';
 assert.equal(host.querySelector('#enabled').matches(':disabled'),false);assert.equal(host.querySelector('#disabled').matches(':disabled'),true);assert.equal(host.querySelector('#ordinary').matches(':disabled'),false);assert.ok(host.querySelector('[data-label=":disabled"]'));assert.equal(host.querySelector('#exempt').matches(':disabled'),false);assert.equal(host.querySelector('#inherited').matches(':disabled'),true);assert.equal(host.querySelector('#option').matches(':disabled'),true);
 assert.equal(host.querySelector('button:not(:disabled)').id,'enabled');assert.throws(()=>host.querySelector(':unknown-fixture-pseudo'),/Unsupported/);
});
test('Playlist platform before preserves sibling movement, text insertion and detached no-op',()=>{
 const h=fixture(),d=h.document,host=d.createElement('div'),a=d.createElement('a'),b=d.createElement('b'),c=d.createElement('i');host.append(a,b,c);
 c.before(a,'text');assert.deepEqual([...host.childNodes],[b,a,host.childNodes[2],c]);assert.equal(host.childNodes[2].textContent,'text');assert.equal(host.childNodes[2].nodeType,3);
 const detached=d.createElement('p');detached.before(a);assert.equal(a.parentNode,host);
 b.before(b,a);assert.equal(host.firstChild,b);assert.equal(b.nextSibling,a);
});

test('Playlist platform replaceWith promotes actual children and handles siblings, strings, self and detached receivers',()=>{
 const h=fixture(),d=h.document,parent=d.createElement('div'),before=d.createElement('i'),label=d.createElement('span'),after=d.createElement('b');
 const first=d.createTextNode('first'),second=d.createElement('em');label.append(first,second);parent.append(before,label,after);
 label.replaceWith(...label.childNodes);assert.deepEqual([...parent.childNodes],[before,first,second,after]);assert.equal(label.parentNode,null);assert.equal(label.childNodes.length,0);assert.equal(first.parentNode,parent);
 second.replaceWith(after,'tail');assert.deepEqual([...parent.childNodes].slice(0,3),[before,first,after]);assert.equal(parent.childNodes[3].textContent,'tail');assert.equal(parent.childNodes[3].nodeType,3);
 before.replaceWith(before,after);assert.equal(parent.firstChild,before);assert.equal(before.nextSibling,after);
 const detached=d.createElement('p');detached.replaceWith(after);assert.equal(after.parentNode,parent);
 before.replaceWith();assert.equal(before.parentNode,null);assert.equal(parent.firstChild,after);
});
