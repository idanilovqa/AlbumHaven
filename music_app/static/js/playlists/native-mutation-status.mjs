import {mountButton} from '../home-friends/native-controls.mjs';
const messages = {loading:'Saving…',ready:'The server confirmed the change.',error:'The change was not confirmed. Your draft is still here.',denied:'You do not have permission to make this change.',unavailable:'This action is not available on this server yet.'};
export function mountRetryOriginalRequest(host,runtime,initialProps) {
  let props=initialProps, disposed=false, pending=false, error='';
  const buttonHost=host.ownerDocument.createElement('span'), errorHost=host.ownerDocument.createElement('div');
  host.replaceChildren(buttonHost,errorHost);
  const button=mountButton(buttonHost,runtime,{label:'Retry original request',onClick:run});
  async function run() {
    if(disposed||pending||props.disabled||!props.current?.()) return;
    const owner=props; pending=true;error='';render();let confirmed=false;
    try {
      if(await runtime.confirmRetryOriginal(owner.scopeKey)!==true||disposed||props.scopeKey!==owner.scopeKey||props.retry!==owner.retry||!owner.current())return;
      const result=await owner.retry();confirmed=Boolean(result);
      if(!disposed&&owner.current()&&result)await owner.onRecovered?.(result);
    } catch {if(!disposed)error=confirmed?'The original request was confirmed, but the view could not refresh.':'The original request is still unconfirmed. Check its result before starting another.';}
    finally {pending=false;if(!disposed)render();}
  }
  function render(){host.hidden=!props.available||typeof props.retry!=='function'||typeof props.current!=='function'||typeof runtime.confirmRetryOriginal!=='function';button.update({label:'Retry original request',disabled:Boolean(props.disabled||pending),onClick:run});errorHost.innerHTML=error?runtime.alertHtml({severity:'error',role:'alert',message:error}):'';}
  try{render();}catch(error){disposed=true;button.dispose();host.replaceChildren();throw error;}return {element:host,update(next){if(disposed)return;props=next;render();},dispose(){disposed=true;button.dispose();host.replaceChildren();}};
}
export function mountMutationStatus(host,runtime,initialProps){
  let props=initialProps,disposed=false;
  const status=host.ownerDocument.createElement('div'),retryHost=host.ownerDocument.createElement('div');host.replaceChildren(status,retryHost);
  const retry=mountRetryOriginalRequest(retryHost,runtime,{});
  function update(next){if(disposed)return;props=next;const value=props.value,controller=props.controller,scopeKey=controller?.getSnapshot().scopeKey;
    host.hidden=!value||value.status==='idle';
    status.innerHTML=host.hidden?'':runtime.alertHtml({severity:['error','denied'].includes(value.status)?'error':'info',role:['error','denied'].includes(value.status)?'alert':'status',message:props.message||messages[value.status]||'The change is still unconfirmed.'});
    retry.update({scopeKey,available:!host.hidden&&controller?.canRetryMutation?.()===true,retry:controller?.retryMutation,current:()=>controller?.getSnapshot().scopeKey===scopeKey});
  }
  try{update(props);}catch(error){disposed=true;retry.dispose();host.replaceChildren();throw error;}return {element:host,update,dispose(){disposed=true;retry.dispose();host.replaceChildren();}};
}
