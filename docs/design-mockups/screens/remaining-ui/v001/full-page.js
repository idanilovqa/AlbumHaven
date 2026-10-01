const layout=document.querySelector('#pageLayout'),expand=document.querySelector('#pageExpand'),fold=document.querySelector('#pageFold'),gallery=document.querySelector('.page-albums');
function setFolded(value){layout.classList.toggle('is-folded',value);expand.hidden=!value;fold.setAttribute('aria-expanded',String(!value));expand.setAttribute('aria-expanded',String(!value));(value?expand:fold).focus({preventScroll:true})}
fold.addEventListener('click',()=>setFolded(true));expand.addEventListener('click',()=>setFolded(false));
function updateCount(){const columns=getComputedStyle(gallery).gridTemplateColumns.split(' ').length;document.querySelector('#pageStatus').textContent=(layout.classList.contains('is-folded')?'Folded':'Expanded')+' · '+columns+' albums per row'}
new ResizeObserver(updateCount).observe(gallery);updateCount();
document.querySelectorAll('.page-sidebar a').forEach(a=>a.addEventListener('click',e=>e.preventDefault()));
