
/* v002 composition extensions over frozen current-stack component snapshots. */
iconPaths.trash='M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7';
const albumsV2=[['Northern Lights','The Meridian',null],['Paper Gardens','Lena Vale',2022],['Low Tide','Stillwater',2019]];
const problemFilters=new Set();
let openSongs=new Set([0]), chosenLoop=0, pendingDelete=null;
const oldRender=render;
render=function(){oldRender();$('.aside-head')?.remove();$('.review b').textContent='DESIGN REVIEW · v002';document.title='Utilities · Component review v002';
$('header').classList.add('album-details-header');$('header h1').classList.add('album-details-header__primary');$('#close').classList.add('action-button');
const search=$('.search');search.className='search-field';const input=search.querySelector('input');const filter=search.querySelector('button');filter.className='search-field-button';filter.setAttribute('aria-haspopup','menu');filter.setAttribute('aria-expanded','false');search.replaceChildren();const control=document.createElement('div');control.className='search-field-control';const action=document.createElement('span');action.className='search-field-action';action.append(filter);control.append(input,action);search.append(control);
if(tab===0){$('#nav-list').innerHTML=albumsV2.map((a,i)=>navItem(a[0],a[1]+(a[2]?' · '+a[2]:''),i,art(false,i===0))).join('');$('#nav-list').querySelectorAll('.count').forEach((c,i)=>{c.hidden=true;c.textContent='5 tracks';c.className='navigation-tree-count'})}
if(tab===2){$('#nav-list').innerHTML=['A New Horizon','The Quiet Hours'].map((n,i)=>'<div class="song-group"><button class="nav song-item '+(selected===i?'active':'')+'" data-song="'+i+'" aria-expanded="'+openSongs.has(i)+'" title="Double-click to expand or collapse">'+art()+'<span class="title">'+n+'<small>The Meridian · Northern Lights</small></span><span class="chevron" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m7 4 6 6-6 6"/></svg></span></button><div class="loop-children" '+(openSongs.has(i)?'':'hidden')+'>'+['Opening phrase','Chorus'].map((n,j)=>'<div class="nav loop-child" draggable="true" data-child="'+j+'" data-song-owner="'+i+'"><span class="drag-grip">⠿</span><span class="title">'+n+'</span><span class="meta">'+(j?'0:24':'0:18')+'</span></div>').join('')+'</div></div>').join('')}
if(tab===4){$('#nav-list').innerHTML=['Library','Scrobbling','Foobar2000','Import Local Playlist'].map((n,i)=>navItem(n,'',i)).join('')}
if(tab===5){$('#nav-list').innerHTML=['Main elements','Player & Seekbar','Selection & Hover','Alerts','Album page'].map((n,i)=>navItem(n,'',i)).join('')}
document.querySelectorAll('.nav').forEach(n=>{n.classList.add('navigation-tree-item','artist-link');n.classList.toggle('is-selected',n.classList.contains('active'));n.querySelectorAll('small:empty').forEach(s=>s.remove())});
document.querySelectorAll('button:not(.pill):not(.tab):not(.nav):not(.search-field-button):not(.loop-play-control-button):not(.loop-edit-action):not(.utility-loop-speed-step):not(.utility-loop-speed-value):not(.utility-loop-repeat)').forEach(b=>b.classList.add('ui-button'));
document.querySelectorAll('.icon').forEach(b=>b.classList.add('action-button'));
};
problemView=function(){const a=albumsV2[selected];$('.detail').innerHTML=summary(a[0],a[1]+'<br>'+(a[2]?a[2]+' · ':'')+'5 tracks',selected===0,true)+'<div class="labels album-problems">'+pill('Missing year','album-year')+pill('Missing cover art','album-cover')+'</div><div class="divider"><h3>Detected problems</h3></div><div class="table-wrap"><table class="compact-data-table"><thead><tr><th>Track / file</th><th>Problems</th></tr></thead><tbody>'+tracks.map((n,i)=>'<tr><td>'+String(i+1).padStart(2,'0')+' &nbsp; '+n+'<small>FLAC · Stereo</small></td><td>'+pill('Missing year','track-'+i)+(i===1||i===3?pill('Missing track number','number-'+i):'')+'</td></tr>').join('')+'</tbody></table></div><div class="actions"><button id="exception" class="primary" disabled>Create Exception</button></div>'};
selectionUpdate=function(){$('#exception').disabled=!document.querySelector('.pill[aria-pressed=true]')};
loopsView=function(){$('.detail').innerHTML=summary(selected?'The Quiet Hours':'A New Horizon','The Meridian · Northern Lights<br>2008 · 2 saved loops')+'<div class="divider"><h3>Saved loops (2)</h3></div><div class="loop-panels">'+['Opening phrase','Chorus'].map((n,i)=>'<section class="loop utility-loop-entry" draggable="true" data-loop-panel="'+i+'"><div class="loop-title"><span class="drag-grip loop-segment-grip" title="Drag to reorder loop" aria-label="Drag to reorder loop">⠿</span><h3>'+n+'</h3><span class="loop-source-range" aria-label="Original timestamps">Original timestamps '+(i?'1:12 – 1:36':'0:08 – 0:26')+'</span><button class="icon action-button" data-delete-loop="'+i+'" title="Delete loop" aria-label="Delete '+n+'">'+svg('trash')+'</button></div><div class="utility-loop-shell"><div class="loop-play-control-cluster utility-loop-play-cluster"><button class="loop-play-control-button utility-loop-play" data-preview-play="'+i+'" aria-label="Play '+n+'">▶</button><span class="loop-play-control-actions"><button class="loop-edit-action" aria-label="Slice '+n+'" data-demo="Slice loop"><span class="slice-symbol">✂</span></button></span></div><div class="utility-loop-main"><div class="utility-loop-player-top-row"><div class="utility-loop-control utility-loop-pitch-control"><button data-pitch="-1" aria-label="Lower pitch">−</button><span class="pitch">0 pst</span><button data-pitch="1" aria-label="Raise pitch">+</button></div><div class="utility-loop-time">0:00 / '+(i?'0:24':'0:18')+'</div></div><div class="utility-loop-timeline-wrap">'+wave()+'</div></div><button class="utility-loop-repeat" aria-label="Repeat '+n+'" aria-pressed="false" data-repeat="1">↻</button><div class="utility-loop-speed-control"><button class="utility-loop-speed-step" data-loop-speed="-1" aria-label="Decrease speed">−</button><button class="utility-loop-speed-value" data-speed-menu="1" aria-haspopup="menu" aria-expanded="false">1x</button><button class="utility-loop-speed-step" data-loop-speed="1" aria-label="Increase speed">+</button></div></div></section>').join('')+'</div>'};
integrationsView=function(){
if(selected===0){$('.detail').innerHTML='<h2>Library</h2>'+['Main Library','Hoard','New Arrivals'].map((n,i)=>'<section class="settings-section root-group"><div class="section-line"><h3>'+n+'</h3></div>'+(i?'<p>'+['','Unlistened music.','Folders watched for new music.'][i]+'</p>':'')+'<div class="path-rows"><div class="path-row"><input aria-label="'+n+' path" placeholder="'+['Main library folder','Hoard folder','New arrivals folder'][i]+'"><button class="icon action-button" data-remove-path="1" aria-label="Remove '+n+' path">'+svg('trash')+'</button></div></div></section>').join('')+'<div class="actions"><button data-demo="Save library paths">Save</button></div>'}
if(selected===1){$('.detail').innerHTML='<h2 class="scrobbling-heading">Last.FM <span class="status"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg><span>Connected</span></span></h2><p class="meta">Scrobbled: 34 · Queued: 0</p><div class="credentials"><label for="scrobble-user">Username</label><input id="scrobble-user" value="demo_listener" disabled><label for="scrobble-password">Password</label><input id="scrobble-password" type="password" placeholder="Disconnect to reconnect" disabled></div><div class="actions integration-actions"><button disabled>Connect Last.FM</button><button data-disconnect-preview="1">Disconnect</button></div><section class="settings-section playback-statistics" aria-labelledby="playback-statistics-title"><div class="divider"><h3 id="playback-statistics-title">Playback statistics</h3></div><dl><div><dt>Local playcount</dt><dd>1,248</dd></div><div><dt>Total listening time</dt><dd>86 hours 32 minutes</dd></div></dl></section>'}
if(selected===2){$('.detail').innerHTML='<h2>Foobar2000</h2><section class="settings-section"><label class="field-label" for="foobar-db">SQLite database</label><input id="foobar-db" class="full-input" placeholder="Path to customdb_sqlite.db"><div class="actions"><button data-demo="Save Foobar database path">Save</button></div></section><section class="settings-section"><h3>Import playback history</h3><div class="foobar-import"><button id="foobar-format" class="ui-button foobar-format-trigger" aria-label="Foobar export format" aria-haspopup="menu" aria-expanded="false"><span>Playback Statistics XML</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></button><button data-demo="Import Foobar playback history">Import</button></div></section><div class="actions instructions-action"><button id="foobar-help">Read setup instructions</button></div>'}
if(selected===3){$('.detail').innerHTML='<h2>Import Local Playlist</h2><div class="actions" style="justify-content:flex-start"><button disabled aria-disabled="true">Import</button></div>'}
};
appearanceView=function(){$('.detail').innerHTML='<iframe class="appearance-frame" title="Existing Appearance — '+['Main elements','Player & Seekbar','Selection & Hover','Alerts','Album page'][selected]+'" src="appearance-'+selected+'.html"></iframe>'};
function closeDropdown(){const menu=$('#review-dropdown');if(menu){clearTriggerAnchor(menu);menu.remove()}document.querySelectorAll('[aria-expanded=true][aria-haspopup=menu]').forEach(b=>b.setAttribute('aria-expanded','false'))}
function dropdown(anchor,content,label){closeDropdown();const m=document.createElement('div');m.id='review-dropdown';m.className='review-dropdown gallery-anchored-menu';m.setAttribute('role','menu');m.setAttribute('aria-label',label);m.innerHTML=content;document.body.append(m);const r=anchor.getBoundingClientRect();m.style.width='240px';m.style.left=Math.max(8,r.right-240)+'px';m.style.top=(r.bottom+8)+'px';anchor.setAttribute('aria-expanded','true');syncTriggerAnchor(m,anchor)}
document.addEventListener('click',e=>{const t=e.target.closest('button');
if(t?.id==='foobar-format'){e.stopImmediatePropagation();if(t.getAttribute('aria-expanded')==='true'){closeDropdown();return}const value=t.querySelector('span').textContent;dropdown(t,['Playback Statistics XML','Text Tools — standard','Text Tools — enhanced'].map(n=>'<button role="menuitemradio" aria-checked="'+(value===n)+'" data-foobar-format="'+n+'"><span aria-hidden="true">'+(value===n?'✓':'')+'</span>'+n+'</button>').join(''),'Foobar export format');document.querySelector('#review-dropdown').classList.add('format-options-menu');return}
if(t?.dataset.foobarFormat){e.stopImmediatePropagation();const anchor=document.querySelector('#foobar-format');anchor.querySelector('span').textContent=t.dataset.foobarFormat;closeDropdown();anchor.focus();return}
if(t?.id==='filter'&&tab===3){e.stopImmediatePropagation();if(document.querySelector('#review-dropdown'))closeDropdown();else openLogRange(t);return}
if(t?.id==='filter'){e.stopImmediatePropagation();if($('#review-dropdown')){closeDropdown();return}dropdown(t,(tab===0?['Missing year','Missing cover art','Missing track number']:['All items','Recently changed']).map(n=>'<button role="menuitemcheckbox" aria-checked="'+(tab===0&&problemFilters.has(n))+'" data-filter-choice="'+n+'"><span aria-hidden="true">'+(tab===0&&problemFilters.has(n)?'✓':'')+'</span> '+n+'</button>').join(''),'Filter');if(tab===0)$('#review-dropdown').classList.add('problem-filter-menu');return}
if(t?.dataset.filterChoice){e.stopImmediatePropagation();const value=t.getAttribute('aria-checked')!=='true';t.setAttribute('aria-checked',value);t.querySelector('span').textContent=value?'✓':'';if(tab===0){value?problemFilters.add(t.dataset.filterChoice):problemFilters.delete(t.dataset.filterChoice);applyProblemFilters()}return}
if(!e.target.closest('#review-dropdown')&&!t?.dataset.speedMenu)closeDropdown();
if(t?.dataset.song!==undefined){e.stopImmediatePropagation();selected=+t.dataset.song;loopsView();document.querySelectorAll('.song-item').forEach(b=>{const on=+b.dataset.song===selected;b.classList.toggle('active',on);b.classList.toggle('is-selected',on)});return}
if(t?.dataset.child!==undefined){e.stopImmediatePropagation();chosenLoop=+t.dataset.child;selected=+t.dataset.songOwner;render();return}
if(t?.dataset.deleteLoop!==undefined){e.stopImmediatePropagation();pendingDelete=t.closest('.loop');modal('Delete loop?','<p>Delete <strong>'+t.closest('.loop').querySelector('h3').textContent+'</strong>?</p>','Delete loop');return}
if(t?.dataset.confirm&&pendingDelete){e.stopImmediatePropagation();pendingDelete.remove();pendingDelete=null;$('#modal').close();return}
if(t?.dataset.dismiss)pendingDelete=null;
if(t?.id==='exception'){e.stopImmediatePropagation();const ps=[...document.querySelectorAll('.pill[aria-pressed=true]')];modal('Create Exception?','<p>Create a rule excluding the selected problems in <strong>'+albumsV2[selected][0]+'</strong> from Problematic Files?</p><p>'+[...new Set(ps.map(p=>p.dataset.problem))].join(', ')+'</p><p>You can revert this rule under Rules.</p>','Create Exception');return}
if(t?.dataset.previewPlay!==undefined){e.stopImmediatePropagation();t.textContent=t.textContent==='▶'?'Ⅱ':'▶';return}
if(t?.dataset.repeat){e.stopImmediatePropagation();t.setAttribute('aria-pressed',t.getAttribute('aria-pressed')!=='true');return}
if(t?.dataset.pitch){e.stopImmediatePropagation();const s=t.parentElement.querySelector('.pitch');s.textContent=(parseInt(s.textContent)+Number(t.dataset.pitch))+' pst';return}
if(t?.dataset.loopSpeed){e.stopImmediatePropagation();const s=t.parentElement.querySelector('.utility-loop-speed-value');s.textContent=Math.max(.25,Math.min(2,parseFloat(s.textContent)+Number(t.dataset.loopSpeed)*.05)).toFixed(2)+'x';return}
if(t?.dataset.speedMenu){e.stopImmediatePropagation();dropdown(t,['0.5x','0.75x','1x','1.25x','1.5x','2x'].map(x=>'<button role="menuitem" data-speed-option="'+x+'">'+x+'</button>').join(''),'Playback speed');window.speedOwner=t;return}
if(t?.dataset.speedOption){e.stopImmediatePropagation();window.speedOwner.textContent=t.dataset.speedOption;closeDropdown();return}
if(t?.dataset.addPath!==undefined){e.stopImmediatePropagation();const rows=t.closest('.root-group').querySelector('.path-rows');const row=rows.firstElementChild.cloneNode(true);row.querySelector('input').value='';rows.append(row);return}
if(t?.dataset.removePath){e.stopImmediatePropagation();const row=t.closest('.path-row');if(row.parentElement.children.length>1)row.remove();else row.querySelector('input').value='';return}
if(t?.dataset.disconnectPreview){e.stopImmediatePropagation();$('#scrobble-user').disabled=false;$('#scrobble-password').disabled=false;$('.status').textContent='Disconnected';$('.integration-actions button').disabled=false;t.disabled=true;return}
if(t?.id==='foobar-help'){e.stopImmediatePropagation();modal('Foobar2000 setup instructions','<article class="guide-content gallery-scrollbar" tabindex="0" aria-label="Foobar2000 setup instructions">'+document.querySelector('#foobar-instructions-content').innerHTML+'</article>','Close');const dialog=document.querySelector('#modal');dialog.classList.add('instructions-dialog');dialog.querySelector('[data-dismiss]').hidden=true;return}
},true);
document.addEventListener('pointerdown',e=>{const p=e.target.closest('.album-problems .pill');if(p){e.stopImmediatePropagation();e.preventDefault();const on=p.getAttribute('aria-pressed')!=='true';document.querySelectorAll('.pill').forEach(x=>{if(x.dataset.problem===p.dataset.problem)x.setAttribute('aria-pressed',on)});selectionUpdate()}},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDropdown();const p=e.target.closest('.album-problems .pill');if(p&&['Enter',' '].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();const on=p.getAttribute('aria-pressed')!=='true';document.querySelectorAll('.pill').forEach(x=>{if(x.dataset.problem===p.dataset.problem)x.setAttribute('aria-pressed',on)});selectionUpdate()}},true);
document.addEventListener('dblclick',e=>{const b=e.target.closest('[data-song]');if(b){const n=+b.dataset.song;openSongs.has(n)?openSongs.delete(n):openSongs.add(n);render()}});
let draggedReviewElement=null;
function clearLoopDropCue(){document.querySelectorAll('.drop-before,.drop-after').forEach(n=>n.classList.remove('drop-before','drop-after'))}
document.addEventListener('dragstart',e=>{draggedReviewElement=e.target.closest('.loop-child,.loop[data-loop-panel]');if(!draggedReviewElement)return;e.stopImmediatePropagation();e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedReviewElement.dataset.loopPanel??draggedReviewElement.dataset.child);requestAnimationFrame(()=>draggedReviewElement?.classList.add('is-dragging'))},true);
document.addEventListener('dragover',e=>{if(!draggedReviewElement)return;const t=e.target.closest('.loop-child,.loop[data-loop-panel]');clearLoopDropCue();if(!t||t===draggedReviewElement||t.parentElement!==draggedReviewElement.parentElement)return;e.preventDefault();e.dataTransfer.dropEffect='move';const r=t.getBoundingClientRect();t.classList.add(e.clientY>r.y+r.height/2?'drop-after':'drop-before')},true);
document.addEventListener('drop',e=>{if(!draggedReviewElement)return;const t=e.target.closest('.loop-child,.loop[data-loop-panel]');if(t&&t!==draggedReviewElement&&t.parentElement===draggedReviewElement.parentElement){e.preventDefault();e.stopImmediatePropagation();const parent=t.parentElement,positions=new Map([...parent.children].map(n=>[n,n.getBoundingClientRect().top]));const r=t.getBoundingClientRect();if(e.clientY>r.y+r.height/2)t.after(draggedReviewElement);else t.before(draggedReviewElement);draggedReviewElement.classList.remove('is-dragging');clearLoopDropCue();if(!matchMedia('(prefers-reduced-motion: reduce)').matches)[...parent.children].forEach(n=>{const delta=positions.get(n)-n.getBoundingClientRect().top;if(delta)n.animate([{transform:'translateY('+delta+'px)'},{transform:'translateY(0)'}],{duration:220,easing:'ease-out'})});const panels=parent.matches('.loop-panels')?parent:document.querySelector('.loop-panels');const children=document.querySelector('.song-item.active')?.nextElementSibling;if(panels&&children){const source=parent===panels?[...panels.children].map(n=>n.dataset.loopPanel):[...children.children].map(n=>n.dataset.child);const target=parent===panels?children:panels;source.forEach(id=>{const n=[...target.children].find(n=>(n.dataset.loopPanel??n.dataset.child)===id);if(n)target.append(n)})}}draggedReviewElement?.classList.remove('is-dragging');clearLoopDropCue();draggedReviewElement=null},true);
document.addEventListener('dragend',()=>{draggedReviewElement?.classList.remove('is-dragging');clearLoopDropCue();draggedReviewElement=null},true);
window.addEventListener('resize',closeDropdown);
render();
const v2Composition=render;
render=function(){v2Composition();const input=document.querySelector('.search-field input');if(input)input.type='search';document.querySelectorAll('.meta').forEach(n=>{n.classList.remove('meta');n.classList.add('review-meta')})};
render();

const sharedDialogPreview=modal;
modal=function(title,body,yes,no='Cancel'){sharedDialogPreview(title,body,yes,no);document.querySelector('#modal').classList.add('confirm-modal-dialog');document.querySelectorAll('#modal button').forEach(b=>b.classList.add('ui-button'))};
const composeV2=render;
render=function(){composeV2();document.querySelector('.appearance-review-footer')?.remove();if(tab===5){const footer=document.createElement('div');footer.className='appearance-review-footer';footer.innerHTML='<button class="ui-button" disabled>Reset '+['Main elements','Player & Seekbar','Selection & Hover','Alerts','Album page'][selected]+'</button><span></span><button class="ui-button" disabled>Cancel</button><button class="ui-button" disabled>Save</button>';document.querySelector('.shell').append(footer)}};
render();

function applyProblemFilters(){
  if(tab!==0)return;
  document.querySelectorAll('.detail .pill').forEach(p=>{
    p.hidden=problemFilters.size>0&&!problemFilters.has(p.dataset.problem);
    if(p.hidden)p.setAttribute('aria-pressed','false');
  });
  document.querySelectorAll('.detail tbody tr').forEach(row=>{
    row.hidden=![...row.querySelectorAll('.pill')].some(p=>!p.hidden);
  });
  const trigger=document.querySelector('#filter');
  if(trigger){trigger.classList.toggle('has-problem-filters',problemFilters.size>0);trigger.setAttribute('aria-label',problemFilters.size?'Filter Albums — '+problemFilters.size+' problem types':'Filter Albums')}
  selectionUpdate();
}
const renderWithProblemFilters=render;
render=function(){renderWithProblemFilters();applyProblemFilters()};
render();
// Range searches are preview-only, retained as one temporary navigation entry.
let logRange=null,showLogRange=false;
const sampleLogEvents=[
  {at:'2026-09-08T09:12',title:'Library indexing failed',lines:['[ERROR] Library unavailable','Existing library data retained.']},
  {at:'2026-09-08T10:42',title:'Tags edited',lines:['[INFO] Tag update started','[OK] 5 files updated']},
  {at:'2026-09-08T11:18',title:'Cover art update completed',lines:['[INFO] Cover art lookup completed','[DONE] Artwork updated']},
  {at:'2026-09-09T08:05',title:'Library status error',lines:['[ERROR] Selected source could not be reached','Existing library data retained.']}
];
function rangeLabel(){return logRange.start.replace('T',' ')+' – '+logRange.end.replace('T',' ')}
function openLogRange(anchor){
  dropdown(anchor,'<form id="log-range-form"><strong>Log period</strong><label>From<input name="start" aria-label="Logs from" type="datetime-local" required value="'+(logRange?.start||'2026-09-08T00:00')+'"></label><label>To<input name="end" aria-label="Logs to" type="datetime-local" required value="'+(logRange?.end||'2026-09-09T23:59')+'"></label><small>Local time · sample logs</small><p id="log-range-error" role="alert"></p><div class="range-actions"><button type="button" data-clear-log-range="1">Clear</button><button type="submit">Apply</button></div></form>','Log period');
  const menu=$('#review-dropdown');menu.classList.add('log-range-dropdown');menu.setAttribute('role','dialog');menu.style.width='300px';menu.style.left=Math.max(8,anchor.getBoundingClientRect().right-300)+'px';syncTriggerAnchor(menu,anchor);
}
function rangeConsole(){
  const events=sampleLogEvents.filter(e=>e.at>=logRange.start&&e.at<=logRange.end);
  $('.detail').innerHTML='<h2>Logs for selected period</h2><p>'+rangeLabel()+'</p><div class="console"><div class="console-head"><span>Console log · '+events.length+' events</span></div><pre>'+ (events.length?events.map(e=>e.at.replace('T',' ')+'  '+e.title+'\n'+e.lines.map(line=>'<span class="'+(/\[(OK|DONE)\]/.test(line)?'ok':'')+'">  '+line+'</span>').join('\n')).join('\n\n'):'No logs in this period.')+'</pre></div>';
}
const renderBeforeLogRange=render;
render=function(){renderBeforeLogRange();if(tab===3&&logRange){const list=$('#nav-list');list.insertAdjacentHTML('afterbegin','<button class="nav navigation-tree-item artist-link range-nav '+(showLogRange?'active is-selected':'')+'" data-log-range-entry="1"><span class="title">Custom period<small>'+rangeLabel()+'</small></span></button>');if(showLogRange){list.querySelectorAll('[data-nav]').forEach(b=>b.classList.remove('active','is-selected'));rangeConsole()}}};
document.addEventListener('click',e=>{
  if(e.target.closest('[data-log-range-entry]')){showLogRange=true;render()}
  if(tab===3&&e.target.closest('[data-nav]')){showLogRange=false;render()}
  if(e.target.closest('[data-clear-log-range]')){logRange=null;showLogRange=false;closeDropdown();render()}
});
document.addEventListener('submit',e=>{if(e.target.id!=='log-range-form')return;e.preventDefault();const start=e.target.elements.start.value,end=e.target.elements.end.value;if(!start||!end||start>end){$('#log-range-error').textContent='Choose an end at or after the start.';return}logRange={start,end};showLogRange=true;closeDropdown();render()});
render();
// Library path rows reuse the input + anchored action pattern.
let browsingPathRow=null,browseFolder='Music';
function enhancePathRows(){
  if(tab!==4||selected!==0)return;
  document.querySelectorAll('.root-group').forEach(group=>{
    group.querySelector('[data-add-path]')?.remove();
    group.querySelectorAll('.path-row').forEach(row=>{
      const input=row.querySelector('input');
      if(!row.querySelector('.path-input-control')){
        const wrap=document.createElement('div');wrap.className='path-input-control';
        input.before(wrap);wrap.append(input);
        const browse=document.createElement('button');browse.className='path-browse ui-button';browse.dataset.browseLibraryPath='1';browse.textContent='Browse…';browse.setAttribute('aria-label','Browse '+group.querySelector('h3').textContent+' folder');wrap.append(browse);
      }
      row.querySelector('[data-remove-path]').hidden=!input.value;
    });
  });
}
const renderBeforePathBrowse=render;
render=function(){renderBeforePathBrowse();enhancePathRows()};
function folderPreview(){toast('Browse opens the folder picker in the app. For this preview, paste a path into the field.')}
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.browseLibraryPath){e.stopImmediatePropagation();browsingPathRow=b.closest('.path-row');browseFolder='Music';folderPreview();return}
  if(b.dataset.folderLocation){e.stopImmediatePropagation();browseFolder=b.dataset.folderLocation;folderPreview();return}
  if(b.dataset.folderOpen){e.stopImmediatePropagation();browseFolder+='/'+b.dataset.folderOpen;folderPreview();return}
  if(b.dataset.chooseLibraryFolder){e.stopImmediatePropagation();const row=browsingPathRow,rows=row.parentElement;row.querySelector('input').value=browseFolder;
    if(![...rows.querySelectorAll('input')].some(input=>!input.value)){const blank=row.cloneNode(true);blank.querySelector('input').value='';rows.append(blank)}
    document.querySelector('#modal').close();browsingPathRow=null;enhancePathRows();return}
},true);
render();
function syncTabDividerGlow(){
  const strip=document.querySelector('.tabs'),active=strip?.querySelector('[aria-selected=true]');
  if(!active)return;
  const stripRect=strip.getBoundingClientRect(),tabRect=active.getBoundingClientRect();
  strip.style.setProperty('--active-tab-left',(tabRect.left-stripRect.left+strip.scrollLeft)+'px');
  strip.style.setProperty('--active-tab-right',(tabRect.right-stripRect.left+strip.scrollLeft)+'px');
}
const renderBeforeDividerGlow=render;
render=function(){renderBeforeDividerGlow();syncTabDividerGlow()};
window.addEventListener('resize',syncTabDividerGlow);
render();

function wireHeaderArtbox(){
  if(tab!==0&&tab!==2)return;
  const cover=document.querySelector('.summary .review-artbox');
  if(!cover||cover.parentElement.matches('button'))return;
  if(cover.querySelector('[data-album-artbox-state=empty]'))return;
  const button=document.createElement('button');button.className='header-artbox-trigger';button.dataset.openHeaderArt='1';button.setAttribute('aria-label','Open full-size album artwork');button.title='Open full-size artwork';cover.before(button);button.append(cover);
}
const renderBeforeHeaderArtwork=render;
render=function(){renderBeforeHeaderArtwork();wireHeaderArtbox()};
const loopsBeforeHeaderArtwork=loopsView;
loopsView=function(){loopsBeforeHeaderArtwork();wireHeaderArtbox()};
document.addEventListener('click',e=>{if(!e.target.closest('[data-open-header-art]'))return;
  const title=tab===0?albumsV2[selected][0]:'Northern Lights';
  modal(title+' — artwork','<div class="full-size-artbox">'+buildAlbumArtboxHtml({state:'ready',label:'Full-size sample artwork for '+title,coverHtml:'<span class="sample-album-cover" aria-hidden="true"></span>'})+'</div>','Close');
  document.querySelector('#modal').classList.add('artwork-preview-dialog');
  document.querySelector('#modal [data-dismiss]').hidden=true;
});
const modalBeforeArtworkClass=modal;
modal=function(...args){const result=modalBeforeArtworkClass(...args);document.querySelector('#modal').classList.remove('artwork-preview-dialog','instructions-dialog');return result};
render();

// Direct path entry is the primary field; keep one blank row for additional roots.
document.addEventListener('input',e=>{
  if(!e.target.matches('.path-input-control input'))return;
  const row=e.target.closest('.path-row'),rows=row.parentElement;
  if(e.target.value.trim()&&![...rows.querySelectorAll('input')].some(input=>!input.value.trim())){
    const next=row.cloneNode(true);next.querySelector('input').value='';rows.append(next);
  }
  enhancePathRows();
});
// One input shell owns the text field and both icon actions.
const enhancePathsBeforeInlineActions=enhancePathRows;
enhancePathRows=function(){enhancePathsBeforeInlineActions();if(tab!==4||selected!==0)return;
  document.querySelectorAll('.path-row').forEach(row=>{
    const wrap=row.querySelector('.path-input-control'),browse=row.querySelector('[data-browse-library-path]'),remove=row.querySelector('[data-remove-path]');
    if(!wrap||!browse||!remove)return;
    browse.innerHTML=svg('folder');browse.title=browse.getAttribute('aria-label');
    remove.title=remove.getAttribute('aria-label');wrap.append(remove);
  });
};
enhancePathRows();