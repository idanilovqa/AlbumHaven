// Idle reveal is deliberate; active loop selection gets an exit grace period.
const capsuleFoldTimers=new WeakMap();
const capsuleRevealTimers=new WeakMap();
document.addEventListener('pointerover',event=>{
  const control=event.target.closest('.cluster.capsule,.cluster.companion');
  if(!control||control.contains(event.relatedTarget))return;
  clearTimeout(capsuleFoldTimers.get(control));
  clearTimeout(capsuleRevealTimers.get(control));
  if(control.classList.contains('is-editing')){
    control.classList.add('is-pointer-revealed');
  }else{
    capsuleRevealTimers.set(control,setTimeout(()=>{
      control.classList.add('is-pointer-revealed');
      capsuleRevealTimers.delete(control);
    },300));
  }
});
document.addEventListener('pointerout',event=>{
  const control=event.target.closest('.cluster.capsule,.cluster.companion');
  if(!control||control.contains(event.relatedTarget))return;
  clearTimeout(capsuleRevealTimers.get(control));
  clearTimeout(capsuleFoldTimers.get(control));
  if(!control.classList.contains('is-editing')){
    control.classList.remove('is-pointer-revealed');
    return;
  }
  capsuleFoldTimers.set(control,setTimeout(()=>{
    control.classList.remove('is-pointer-revealed');
    capsuleFoldTimers.delete(control);
  },500));
});