(async function(){
  const mode=String(window.GALLERY_VARIANT||'a');
  const response=await fetch('/files/gallery-main-v001-refined-5.html');
  if(!response.ok)throw new Error('Unable to load Gallery mock');
  const html=await response.text();
  document.open();document.write(html);document.close();
  function ready(){
    const doc=document;
    const gallery=doc.getElementById('gallery-scroll');
    if(!gallery){setTimeout(ready,30);return}
    const toolbar=doc.createElement('nav');
    toolbar.setAttribute('aria-label','GalleryBar mock variants');
    toolbar.style.cssText='position:fixed;z-index:120;left:50%;top:64px;transform:translateX(-50%);display:flex;gap:5px;padding:5px;background:rgba(10,14,13,.94);border:1px solid #40514d;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5)';
    [['a','A · Gallery summary'],['b','B · Scroll-aware'],['c','C · Family scope']].forEach(([key,label])=>{const button=doc.createElement('button');button.textContent=label;button.style.cssText='height:30px;padding:0 10px;border:1px solid '+(key===mode?'#42d4a5':'transparent')+';border-radius:7px;background:'+(key===mode?'#20352f':'transparent')+';color:#edf4f2;cursor:pointer';button.onclick=()=>location.href='/files/gallerybar-variant-'+key+'.html';toolbar.append(button)});
    doc.body.append(toolbar);
    let row=doc.getElementById('comparison-primary-heading');
    if(mode!=='b'&&!row){row=doc.createElement('div');row.id='comparison-primary-heading';row.className='family-heading';row.innerHTML='<span>Transatlantic</span><button class="info-button" aria-label="Information about Transatlantic">ⓘ</button><span class="divider-line"></span><span class="family-count">7 albums</span>';doc.getElementById('cards').before(row)}
    function setContext(visible){
      const context=doc.querySelector('.artist-context');
      if(mode==='a')context.innerHTML='<div><div class="artist-name">Gallery</div><div style="font-size:11px;color:#82918d;margin-top:2px">Transatlantic family · 5 artists · 30 albums</div></div>';
      if(mode==='b')context.innerHTML='<div><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#82918d">Now viewing</div><div class="artist-name" id="comparison-current">'+visible+'</div></div><button class="info-button" aria-label="Information about '+visible+'">ⓘ</button>';
      if(mode==='c')context.innerHTML='<div><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#82918d">Family scope</div><div class="artist-name">Transatlantic family</div></div><button class="info-button" aria-label="Information about Transatlantic">ⓘ</button>';
    }
    setContext('Transatlantic');
    gallery.addEventListener('scroll',()=>{if(mode!=='b')return;const threshold=doc.getElementById('gallerybar').getBoundingClientRect().bottom+18;let visible='Transatlantic';doc.querySelectorAll('[data-scroll-artist]').forEach(heading=>{if(heading.getBoundingClientRect().top<=threshold)visible=heading.dataset.scrollArtist});const current=doc.getElementById('comparison-current');if(current&&current.textContent!==visible)setContext(visible)});
  }
  setTimeout(ready,30);
})().catch(error=>{document.body.innerHTML='<main style="font:16px system-ui;color:white;background:#111;padding:32px;min-height:100vh"><h1>Gallery mock could not load</h1><p>'+error.message+'</p></main>'});
