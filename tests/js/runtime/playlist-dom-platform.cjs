'use strict';
// Additive, bounded DOM APIs. Never replaces product methods or suppresses errors.
const {withDomPlatform}=require('./artist-host-fixtures/dom-platform.cjs');
function withPlaylistDomPlatform(env){
 const {context:c,document}=env,proto=c.Element.prototype,basicMatches=proto.matches;
 const disabled=node=>{
  const tag=node.tagName?.toLowerCase();
  if(!['button','fieldset','input','optgroup','option','select','textarea'].includes(tag))return false;
  if(node.hasAttribute('disabled'))return true;
  if(tag==='option')return node.parentElement?.tagName==='OPTGROUP'&&node.parentElement.hasAttribute('disabled');
  if(tag==='optgroup')return false;
  for(let parent=node.parentElement;parent;parent=parent.parentElement){
   if(parent.tagName!=='FIELDSET'||!parent.hasAttribute('disabled'))continue;
   const legend=[...parent.children].find(child=>child.tagName==='LEGEND');
   if(!legend?.contains(node))return true;
  }
  return false;
 };
 // The existing platform compiler handles :not and compounds. Extend only its
 // basic-selector predicate before it captures this method; preserve validation.
 proto.matches=function(selector){
  let basic='',requiresDisabled=false,quote='',brackets=0;
  for(let i=0;i<selector.length;){
   const ch=selector[i];
   if(quote){basic+=ch;if(ch===quote&&selector[i-1]!=='\\')quote='';i++;continue;}
   if(ch==='"'||ch==="'"){quote=ch;basic+=ch;i++;continue;}
   if(ch==='[')brackets++;if(ch===']')brackets--;
   if(!brackets&&selector.slice(i,i+9)===':disabled'&&!/[\w-]/.test(selector[i+9]||'')){requiresDisabled=true;i+=9;continue;}
   basic+=ch;i++;
  }
  const matches=basicMatches.call(this,basic||'*');
  return matches&&(!requiresDisabled||disabled(this));
 };
 const platform=withDomPlatform(env),textRects=new WeakMap();
 const rect=value=>{const r={x:0,y:0,width:0,height:0,...value};return {...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height};};
 const installWindow=win=>{win.NodeFilter={...(win.NodeFilter||{}),SHOW_TEXT:4};return win;};
 installWindow(c);if(document.defaultView)installWindow(document.defaultView);
 document.createTreeWalker=(root,whatToShow,filter=null)=>{
  if(whatToShow!==4||filter!==null)throw new Error('Playlist platform supports SHOW_TEXT traversal without a filter only');
  const walker={root,whatToShow,filter,currentNode:root,nextNode(){
   const nodes=[];const visit=node=>{nodes.push(node);for(const child of node.childNodes)visit(child);};visit(root);
   const index=nodes.indexOf(this.currentNode);if(index<0)throw new Error('TreeWalker currentNode is outside its root');
   const next=nodes.slice(index+1).find(node=>node.nodeType===3);if(!next)return null;this.currentNode=next;return next;
  }};return walker;
 };
 document.createRange=()=>{
  let selected=null;
  return {selectNodeContents(node){if(!node||typeof node.nodeType!=='number')throw new TypeError('Range requires a node');selected=node;},
   getBoundingClientRect(){if(!selected)return rect({});if(textRects.has(selected))return rect(textRects.get(selected));return rect({});},
   detach(){selected=null;}};
 };
 proto.before=function(...values){
  const parent=this.parentNode;if(!parent)return;
  const nodes=values.map(value=>value&&typeof value.nodeType==='number'?value:document.createTextNode(String(value)));
  let previous=parent.childNodes[parent.childNodes.indexOf(this)-1]||null;
  while(previous&&nodes.includes(previous))previous=parent.childNodes[parent.childNodes.indexOf(previous)-1]||null;
  const fragment=document.createDocumentFragment();for(const node of nodes)fragment.appendChild(node);
  parent.insertBefore(fragment,previous?previous.nextSibling:parent.firstChild);
 };
 proto.replaceWith=function(...values){
  const parent=this.parentNode;if(!parent)return;
  const nodes=values.map(value=>value&&typeof value.nodeType==='number'?value:document.createTextNode(String(value)));
  let next=this.nextSibling;while(next&&nodes.includes(next))next=next.nextSibling;
  const fragment=document.createDocumentFragment();for(const node of nodes)fragment.appendChild(node);
  if(this.parentNode===parent){parent.insertBefore(fragment,this);parent.removeChild(this);}
  else parent.insertBefore(fragment,next);
 };
 return {...platform,installWindow,setTextRect(node,value){if(node.nodeType!==3)throw new TypeError('Text geometry requires a text node');textRects.set(node,rect(value));}};
}
module.exports={withPlaylistDomPlatform};
