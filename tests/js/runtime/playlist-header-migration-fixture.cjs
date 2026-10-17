const vm=require('node:vm');
const {readRepo}=require('./native-home-harness.cjs');
const {nativeDialogFixture}=require('./playlist-native-dialog-fixture.cjs');
const {installNativeSearch}=require('./native-search-harness.cjs');
function fixture(t) {
  const h=nativeDialogFixture(),template=h.document.createElement('script');
  template.id='navigation-tree-item-template';template.textContent=readRepo('music_app/templates/components/navigation-tree-item.html');
  h.document.body.append(template);vm.runInContext(readRepo('music_app/static/js/navigation-tree.js'),h.context);
  h.runtime.navigationItemHtml=h.context.NavigationTree.renderItem;h.runtime.searchHtml=installNativeSearch(h).render;
  h.click=target=>{if(!target)throw new Error('Missing real activation target');target.dispatchEvent(new h.context.Event('click',{bubbles:true}));};
  h.runtime.downloadText=()=>{};h.settle=()=>new Promise(resolve=>setImmediate(resolve));
  h.forms=[];const open=h.runtime.openForm;
  h.runtime.openForm=options=>{const record={options,owner:null};h.forms.push(record);record.owner=open(options);return record.owner;};
  t.after(()=>{h.host.remove();h.modal.remove();template.remove();});
  return h;
}
function driver(t,h,mount,initial){let owner,disposed=false;const render=props=>{if(disposed)throw new Error('Cannot update a disposed owner');if(owner)owner.update(props);else owner=mount(h.host,h.runtime,props);return h.host;};
 const dispose=()=>{if(disposed)return;disposed=true;owner?.dispose();};t.after(dispose);if(initial)render(initial);return {render,dispose,get owner(){return owner;}};}
const action=(host,key,draft=false)=>host.querySelector(`[data-playlists${draft?'-draft':''}-action="${key}"]`);
const actions=(host,draft=false)=>[...host.querySelectorAll(`[data-playlists${draft?'-draft':''}-action]`)].filter(node=>!node.closest('[hidden]')).map(node=>node.getAttribute(`data-playlists${draft?'-draft':''}-action`));
function targets(h,draft=false){const opener=action(h.host,'filters',draft),owner=opener.closest('[data-shared-header]');return {root:h.host,owner,opener,capsule:owner.querySelector('[data-header-action-capsule]'),tools:owner.querySelector('[data-header-tools]')};}
// Focus-policy tests explicitly vary DOM visibility; browser geometry is a separate gate.
function revealTools(h){const value=targets(h,true);value.tools.parentNode.hidden=false;return value;}
module.exports={fixture,driver,action,actions,targets,revealTools};
function pageFixture(t,mount,controller,extra={}) {
 const h=fixture(t);h.context.innerWidth=600;
 const frames=new Map();let serial=0;
 h.context.requestAnimationFrame=callback=>{frames.set(++serial,callback);return serial;};h.context.cancelAnimationFrame=id=>frames.delete(id);
 const view=driver(t,h,mount),render=(current=controller,providers=extra.integrationProviders)=>view.render({...extra,controller:current,state:current.getSnapshot(),...(providers===undefined?{}:{integrationProviders:providers}),onSelect(){},onClose(){}});
 render();const refs=targets(h,extra.draft===true),root=refs.owner;
 for(const node of [root,...root.querySelectorAll('*')]){node.scrollWidth=0;node.scrollHeight=0;node.offsetHeight=0;node.clientHeight=0;}
 h.setRect(refs.tools,{width:34,height:34});
 root.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:100,bottom:40,width:100,height:40});
 const measuredNodes=[...root.querySelectorAll('.home-header__identity,.home-header__content'),
   ...[...root.querySelectorAll('.home-header__primary-actions,.home-header__final-action')]
     .flatMap(slot=>[...slot.children].filter(child=>child.tagName==='SPAN'))];
 for(const node of measuredNodes)node.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:100,bottom:30,width:100,height:30});
 for(const [id,callback]of [...frames]){frames.delete(id);callback();}
 h.click(refs.tools);
 const collapse=()=>{if(refs.tools.getAttribute('aria-expanded')==='true')h.click(refs.tools);};
 const expand=()=>{if(refs.tools.getAttribute('aria-expanded')!=='true')h.click(refs.tools);};
 const open=async(current=controller)=>{render(current);expand();h.click(action(h.host,'filters',extra.draft===true));await Promise.resolve();const form=h.forms.at(-1);if(!form?.owner)throw new Error('Real native filter form did not open');return form;};
 return {...h,...refs,controller,view,render,open,collapse,expand};
}
module.exports.pageFixture=pageFixture;
