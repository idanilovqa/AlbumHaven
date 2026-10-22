const vm=require('node:vm');
const {createNativeHomeRuntime,readRepo}=require('./native-home-harness.cjs');
const {withPlaylistDomPlatform:withDomPlatform}=require('./playlist-dom-platform.cjs');
function fixture(){
 const env=withDomPlatform(createNativeHomeRuntime()),{context:c,document}=env;
 document.defaultView=c;env.installWindow(c);c.innerWidth=1400;c.innerHeight=900;
 c.Element.prototype.focus=function(){if(this.isConnected&&!this.disabled&&!this.closest('[hidden],[inert]'))document.activeElement=this;};
 const tasks=new Map();let taskId=0;c.requestAnimationFrame=callback=>{tasks.set(++taskId,callback);return taskId;};c.cancelAnimationFrame=id=>tasks.delete(id);
 c.addEventListener=()=>{};c.removeEventListener=()=>{};c.getComputedStyle=()=>({display:'block',columnGap:'8px'});
 c.MutationObserver=class{observe(){}disconnect(){}};c.ResizeObserver=class{observe(){}disconnect(){}};
 for(const file of ['in-page-tabs.js','compact-data-table.js','album-track-table.js'])vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`),c);
 const buttons=c.ButtonComponent,menus=[];
 const runtime={escapeHtml:c.escapeHtml,buttonHtml:value=>buttons.renderButton(value),actionHtml:value=>buttons.renderActionButton(value),iconHtml:(name,options)=>buttons.renderIconSvg(name,options),alertHtml:env.owner('buildOnPageAlertHtml'),artboxHtml:env.owner('buildAlbumArtboxHtml'),detailHeaderHtml:value=>`<h3>${c.escapeHtml(value.title)}</h3>`,tableHtml:env.owner('buildCompactDataTable'),albumTrackRow:(track,index)=>env.owner('buildAlbumTrackTableRow')({...track,duration:track.duration_display},index,{readOnly:true}),tabsHtml:env.owner('buildInPageTabsHtml'),mountTabs:env.owner('mountInPageTabs'),canTrackIntent:()=>false,
  openChoice(trigger,config){const menu={trigger,config,isOpen:true,closes:0,close(){menu.isOpen=false;menu.closes++;}};menus.push(menu);return menu;},
  openForm(options){const target=document.createElement('section');document.body.append(target);let closed=false;const close=(_host,value)=>{if(closed)return false;closed=true;options.onClose(target,value);target.remove();return true;};options.onMount(target,close);return {close,updatePresentation(){},setDismissDisabled(){}};}
 };
 const host=document.createElement('section');document.body.append(host);
 return {...env,host,runtime,menus,visible:node=>Boolean(node?.isConnected&&!node.closest('[hidden]')),settle:()=>new Promise(resolve=>setImmediate(resolve))};
}
module.exports={fixture};
