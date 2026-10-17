async function measure(page){return page.evaluate(()=>{
  const title=document.querySelector('input[aria-label="Album Top name"]'),subtitle=document.querySelector('input[aria-label="Album Top subtitle"]');
  const header=title.closest('header');
  if(!header||!header.contains(subtitle))throw new Error('Both inline fields must live in the owning gallery header.');
  let identity=title.parentElement;while(identity&&!identity.contains(subtitle))identity=identity.parentElement;
  const buttons=[...header.querySelectorAll('button')],save=buttons.find(button=>button.textContent.trim()==='Save'),cancel=buttons.find(button=>button.textContent.trim()==='Cancel');
  if(!save||!cancel)throw new Error('Save and Cancel must remain in the same owning header.');
  const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  // Determine painted standalone label text using the real browser's hit test.
  // This permits accessible visually-hidden labels; class names alone do not
  // establish visibility, and Playwright's nonzero-box test is not enough for sr-only.
  const paintedLabels=[];const walker=document.createTreeWalker(header,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
    const node=walker.currentNode,text=node.textContent.trim();
    if(!/^(?:name|title|subtitle|album top name|album top subtitle)$/i.test(text))continue;
    const parent=node.parentElement;if(!parent||parent.closest('button'))continue;
    let hidden=false;for(let element=parent;element&&element!==header.parentElement;element=element.parentElement){
      const style=getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0){hidden=true;break;}
    }
    if(hidden)continue;
    const range=document.createRange();range.selectNodeContents(node);
    const painted=[...range.getClientRects()].some(r=>{
      if(r.width<=1||r.height<=1)return false;
      const x=r.left+r.width/2,y=r.top+r.height/2;
      if(x<0||x>=innerWidth||y<0||y>=innerHeight)return false;
      return document.elementsFromPoint(x,y).some(hit=>hit===parent||parent.contains(hit));
    });
    if(painted)paintedLabels.push(text);
  }
  return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,header:rect(header),identity:rect(identity),title:rect(title),subtitle:rect(subtitle),save:rect(save),cancel:rect(cancel),paintedLabels,
    fieldTypes:[title.type,subtitle.type],headers:document.querySelectorAll('#mount header.gallery-bar').length};
});}


module.exports={measure};
