function formatLoopTime(seconds, includeMillis = false) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  if (!includeMillis) return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
  const totalMillis = Math.round(value * 1000);
  const roundedMinutes = Math.floor(totalMillis / 60000);
  const roundedSeconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${roundedMinutes}:${String(roundedSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
// Both proposals use the current loop action and range controllers.
let controlMounts=[],rangeMounts=[];
const ranges={capsule:{startSeconds:8,endSeconds:26},companion:{startSeconds:8,endSeconds:26}};
cluster=function(id,large=false){return '<div class="cluster '+id+(large?' large-demo':'')+'"><button class="play" data-action="play" aria-label="'+(state[id].playing?'Pause':'Play')+'">'+(state[id].playing?pauseIcon:playIcon)+'</button>'+buildLoopEditActionControl({ownerId:id+'-preview'})+'</div>'};
function syncOption(id){const s=state[id],section=document.querySelector('[data-variant='+id+']');section.classList.toggle('editing',s.editing);controlMounts.filter(m=>m.id===id).forEach(m=>m.controller.update({active:s.editing,enabled:true,busy:false}));section.querySelectorAll('.cluster').forEach(c=>c.classList.toggle('is-editing',s.editing));section.querySelector('.message').textContent=s.editing?'Choose the range; scissors creates the loop, X cancels.':s.message||(id==='capsule'?'Hover or focus Play to reveal the scissors.':'Scissors enters loop selection.');}
const baseOptionsRender=render;
render=function(){controlMounts.forEach(m=>m.controller.destroy());rangeMounts.forEach(m=>m.destroy());controlMounts=[];rangeMounts=[];baseOptionsRender();for(const id of ['capsule','companion']){const section=document.querySelector('[data-variant='+id+']');section.querySelectorAll('.loop-edit-actions').forEach(root=>controlMounts.push({id,controller:mountLoopEditActionControl({root,enabled:true,active:state[id].editing,onEnter:()=>{state[id].editing=true;syncOption(id)},onCreate:()=>{state[id].editing=false;state[id].message='Loop created in preview.';syncOption(id)},onCancel:()=>{state[id].editing=false;state[id].message='Loop selection cancelled.';syncOption(id)}})}));const wave=section.querySelector('.wave');wave.setAttribute('data-loop-range-surface','');wave.insertAdjacentHTML('beforeend','<button class="range-handle" data-loop-range-handle="start" role="slider" aria-label="Loop start"></button><button class="range-handle" data-loop-range-handle="end" role="slider" aria-label="Loop end"></button>');rangeMounts.push(createLoopRangeController({root:wave,getDuration:()=>252,getRange:()=>ranges[id],onRangePreview:r=>ranges[id]=r,onRangeCommit:r=>ranges[id]=r,onCancel:()=>{state[id].editing=false;syncOption(id)}}));syncOption(id)}};
render();