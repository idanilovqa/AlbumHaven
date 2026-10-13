const visual=control=>control.evaluate(node=>{const style=getComputedStyle(node);return {cursor:style.cursor,opacity:Number(style.opacity),disabled:node.disabled,aria:node.getAttribute('aria-disabled')};});
module.exports={visual};
