'use strict';
const assert=require('node:assert/strict');
const H=require('../artist-creation-fixtures/facade.cjs');
const N=require('../album-tops-native-fixtures/actual-native-runtime.cjs');
const {F}=H;
const tick=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const scope=mode=>({root_artist_id:'3',mode:mode||'artist'});
const album=(id,patch={})=>F.album(id,{creation_metadata:{rating:null,rating_state:'available',release_type:'studio',artwork_url:null},...patch});
async function setup(t,options={}){
 const h=await H.fixture(t),calls=[],acknowledged=[],closed=[],ordinary=[],forms=[];let live=true,editor=null;
 const service=N.service({...options.providers,execute:options.execute||(async(action,command)=>({action,request_key:command.request_key,top_ref:F.TOP,revision:'1'}))});
 service.data.detail=N.detail({top_ref:F.TOP,revision:'1',items:[]});
 service.providers.listScopedAlbums=async intent=>{calls.push(intent);return options.population?options.population(intent):{albums:intent.artistScope.mode==='family'?[album(11),album(12)]:[album(11)],next_cursor:null};};
 const controller=await N.preparedController(service,{selected:null,scopeKey:h.origin.scopeKey});
 const runtime={...h.bridge,openForm(props){forms.push(props);return h.origin.openForm(props);},confirm:(...args)=>h.origin.confirm(...args)};
 const {openAlbumTopBuilder}=await F.load('album-tops/builder.mjs');
 const props={runtime,controller,providers:service.providers,state:controller.getSnapshot(),artistScope:scope(),artistLabel:h.origin.artistLabel,
  isCurrent:()=>live&&h.origin.isOwnerCurrent(),onScopedCreateAcknowledged(value){acknowledged.push(value);return options.ack?.(value,{h,controller,editor});},
  onFormSaved:value=>ordinary.push(value),onClose:()=>closed.push(true)};
 editor=openAlbumTopBuilder(props);
 const unsubscribe=controller.subscribe(()=>editor.update({state:controller.getSnapshot()}));
 const form=()=>h.document.querySelector('form[aria-label="Create Album Top"]');
 const field=label=>{const node=form()?.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);return node;};
 const button=label=>{const node=[...form().querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())===label&&!n.closest('[hidden]'));assert.ok(node,label);return node;};
 const input=(label,value)=>{const node=field(label);node.value=value;h.dispatch(node,'input');};
 const submit=()=>h.dispatch(form(),'submit');
 const rows=()=>[...form().querySelectorAll('[data-album-draft-key]')].map(n=>n.getAttribute('data-album-draft-key'));
 t.after(async()=>{unsubscribe();editor.dispose();controller.dispose();await N.nextTask();});
 await tick();
 return {...h,service,controller,editor,runtime,calls,acknowledged,closed,ordinary,forms,form,field,button,input,submit,rows,
  invalidate(){live=false;editor.update({state:controller.getSnapshot()});}};
}
module.exports={setup,H,N,F,tick,scope,album};
