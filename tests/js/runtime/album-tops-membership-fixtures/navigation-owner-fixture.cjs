const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('./top-builder-fixtures.cjs');
const {createNativeHomeRuntime}=require(path.join(F.ROOT,'tests/js/runtime/native-home-harness.cjs'));
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const settle=async()=>{for(let index=0;index<20;index++)await Promise.resolve();};
function harness(){
  const native=createNativeHomeRuntime(),{context,document}=native;
  const add=(id,attribute)=>{const node=document.createElement('div');if(id)node.id=id;if(attribute)node.setAttribute(attribute,'');document.body.appendChild(node);return node;};
  const shell=add('app-shell');add('shell-main-surface');const settings=add(null,'data-settings-host');settings.hidden=true;
  add(null,'data-settings-outlet');add(null,'data-settings-nav');
  const location=new URL('https://albumhaven.test/?surface=album_tops&top_ref='+F.TOP),listeners=[];
  const entries=[{url:'https://albumhaven.test/?surface=album_tops',state:{albumHavenNavigationPosition:0}},
    {url:location.href,state:{albumHavenNavigationPosition:1,display:'original'}}];let index=1;
  const calls={fetch:[],history:[],gallery:0,confirm:0,discard:0,navigation:[]};
  const dispatch=()=>{const event={state:entries[index].state,stopped:false,stopImmediatePropagation(){this.stopped=true;}};
    for(const capture of [true,false])for(const listener of [...listeners].filter(row=>row.name==='popstate'&&row.capture===capture)){if(!event.stopped)listener.callback(event);}
    if(!event.stopped)context.handleGalleryBootstrapPopState();};
  const history={get state(){return entries[index].state;},
    pushState(value,title,url){location.href=new URL(url,location).href;entries.splice(++index,Infinity,{url:location.href,state:structuredClone(value)});calls.history.push({mode:'push',state:structuredClone(value)});},
    replaceState(value,title,url){location.href=new URL(url||location.href,location).href;entries[index]={url:location.href,state:structuredClone(value)};calls.history.push({mode:'replace',state:structuredClone(value)});},
    go(delta){queueMicrotask(()=>{if(index+delta<0||index+delta>=entries.length)return;index+=delta;location.href=entries[index].url;dispatch();});}};
  Object.assign(context,{URL,URLSearchParams,AbortController,structuredClone,location,history,innerWidth:1200,state:{view:{surface:{active:'album_tops'},top_ref:F.TOP},ui:{}},
    CustomEvent:context.Event,DOMParser:class{},NavigationTree:{setSelection(){}},
    addEventListener(name,callback,capture=false){listeners.push({name,callback,capture:capture===true});},
    dispatchEvent(event){for(const listener of [...listeners].filter(row=>row.name===event.type))listener.callback(event);return !event.defaultPrevented;},
    removeEventListener(name,callback,capture=false){const found=listeners.findIndex(row=>row.name===name&&row.callback===callback&&row.capture===(capture===true));if(found>=0)listeners.splice(found,1);},
    fetch(...args){calls.fetch.push(args);return Promise.reject(new Error('Synthetic destination transport unavailable'));},
    handleGalleryBootstrapPopState(){calls.gallery++;},getActiveAppFormPage:()=>null,
  });
  for(const file of ['settings-navigation.js','runtime/mobile-navigation.js'])vm.runInContext(fs.readFileSync(path.join(F.ROOT,'music_app/static/js',file),'utf8'),context,{filename:file});
  context.handleMobilePagePopState=()=>false;
  const navigation=context.AlbumHavenSettingsNavigation.instance;
  let current=true,decision=false;
  const owner={token:'top:inline:one',scopeKey:F.SCOPE,isCurrent:()=>current,
    ownsHistoryEntry:(snapshot,url)=>snapshot?.albumHavenNavigationPosition===1&&url===entries[1].url,
    confirmLeave:()=>{calls.confirm++;return decision;},discard:()=>{calls.discard++;current=false;}};
  return{...native,navigation,owner,calls,entries,history,location,shell,settings,index:()=>index,
    decision(value){decision=value;},invalidate(){current=false;},destination(){calls.navigation.push(location.href);return true;}};
}
module.exports={harness,plain,deferred,settle,F};
