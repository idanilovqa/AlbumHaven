const previewCanCreateLoops=new URLSearchParams(location.search).get('canCreateLoops')!=='false';
let previewLoopStyle='capsule';
// Reuse the reviewed capsule and the existing loop-action controller in Loops.
let utilityCapsuleMounts=[];
const loopsBeforeCapsule=loopsView;
loopsView=function(){
  utilityCapsuleMounts.forEach(m=>m.destroy());utilityCapsuleMounts=[];
  loopsBeforeCapsule();
  document.querySelectorAll('.utility-loop-play-cluster').forEach((old,i)=>{
    const capsule=document.createElement('div');capsule.className='cluster '+previewLoopStyle+' utility-loop-play-cluster';
    capsule.innerHTML='<button class="play" aria-label="Play loop" aria-pressed="false">▶</button>'+buildLoopEditActionControl({ownerId:'utility-loop-'+i});
    old.replaceWith(capsule);
    const play=capsule.querySelector('.play');
    play.addEventListener('click',()=>{const playing=play.getAttribute('aria-pressed')!=='true';play.setAttribute('aria-pressed',String(playing));play.setAttribute('aria-label',playing?'Pause loop':'Play loop');play.textContent=playing?'Ⅱ':'▶'});
    const setEditing=active=>{capsule.classList.toggle('is-editing',active);controller.update({active,enabled:true,busy:false})};
    const controller=mountLoopEditActionControl({root:capsule.querySelector('.loop-edit-actions'),enabled:true,active:false,onEnter:()=>setEditing(true),onCreate:()=>{setEditing(false);toast('Loop slice created in preview.')},onCancel:()=>setEditing(false)});
    utilityCapsuleMounts.push(controller);
  });
};
if(tab===2)loopsView();const appearanceBeforeLoopStyle=appearanceView;
appearanceView=function(){
  appearanceBeforeLoopStyle();
  if(selected!==1||!previewCanCreateLoops)return;
  const section=document.createElement('section');section.className='settings-section loop-style-setting';
  section.innerHTML='<h3>Loop controls</h3><div role="group" aria-label="Loop control style"><button class="ui-button" data-loop-style="capsule" aria-pressed="'+(previewLoopStyle==='capsule')+'">A · Joined capsule</button> <button class="ui-button" data-loop-style="companion" aria-pressed="'+(previewLoopStyle==='companion')+'">B · Companion button</button></div>';
  document.querySelector('.detail').append(section);
  section.addEventListener('click',e=>{const b=e.target.closest('[data-loop-style]');if(!b)return;previewLoopStyle=b.dataset.loopStyle;section.querySelectorAll('[data-loop-style]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.loopStyle===previewLoopStyle)))});
};