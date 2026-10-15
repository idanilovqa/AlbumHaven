import {mountTabs} from '/music_app/static/js/home-friends/native-controls.mjs';
import {mountViewControl} from '/music_app/static/js/home-friends/view-control.mjs';
const runtime={tabsHtml:config=>window.buildInPageTabsHtml(config),mountTabs:host=>window.mountInPageTabs(host),
  viewChooserHtml:config=>window.UnfoldingActionButton.render(config),mountViewChooser:(host,config)=>window.UnfoldingActionButton.mount(host,config)};
window.wrapperCalls=[];
const root=document.querySelector('#fixture'), output=document.createElement('output'), tabsHost=document.createElement('div'), viewHost=document.createElement('span');
output.setAttribute('data-probe-revision','');root.replaceChildren(output,tabsHost,viewHost);
let revision=0, tab='recent', view='grouped', tabs, chooser, disposed=false;
const tabsProps=()=>({id:'native-wrapper-tabs',label:'Probe tabs',items:[['recent','Recent'],['news','News']],value:tab,
  onChange:value=>{window.wrapperCalls.push('tab:'+value);tab=value;render();}});
const viewProps=()=>({kind:'tracks',value:view,onChange:value=>{window.wrapperCalls.push('view:'+value);view=value;render();}});
function render(){if(disposed)return;output.textContent=String(revision);tabs?.update(tabsProps());chooser?.update(viewProps());}
window.refreshWrappers=()=>{if(!disposed){revision++;render();}};
window.fixtureUnmount=()=>{if(disposed)return;disposed=true;try{chooser?.dispose();}finally{try{tabs?.dispose();}finally{root.replaceChildren();}}};
try{tabs=mountTabs(tabsHost,runtime,tabsProps());chooser=mountViewControl(viewHost,runtime,viewProps());render();}catch(error){window.fixtureUnmount();throw error;}
