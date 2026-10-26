import {MAPPING} from './contract.mjs';
import {OBSERVATION_FIELDS,displayRawEvidence} from './observation-contract.mjs';

export function mountObservationPreview(host,{id,isCurrent,onInspect,onFamily,onReturn,renderTable}){
  const d=host.ownerDocument,releases=[];
  let disposed=false,state=null,page=null,renderedPage=null,renderedFamily=null;
  const el=(tag,text)=>{const n=d.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const section=el('section'),title=el('h4','Count precedence and original observations');
  title.id=id+'-observation-title';section.setAttribute('aria-labelledby',title.id);
  const hint=el('p','Choose which TSV count family is displayed in this review and import summary. Both original families remain separate and retained; they are never added. Missing or invalid selected counts stay unavailable, with no fallback. Changing the choice clears import confirmation.');
  const family=el('select');family.id=id+'-count-family';
  for(const [value,text] of [['standard','Standard TSV count'],['enhanced','Enhanced TSV count']]){const o=el('option',text);o.value=value;family.append(o);}
  const familyLabel=el('label','Displayed count family');familyLabel.htmlFor=family.id;
  const summary=el('p'),open=el('button','Inspect original and effective observations'),next=el('button','Inspect next observation page'),back=el('button','Return to problem and conflict review');
  for(const b of [open,next,back])b.type='button';
  const cost=el('p','Each inspection page or raw-field chunk sends the same original file and runs a fresh review. Previous selections and confirmation are cleared. Raw date text is evidence, not a resolved timestamp.');
  const status=el('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const tableHost=el('div');tableHost.className='foobar-import__table-wrap';
  const detail=el('fieldset');detail.append(el('legend','Inspect one complete original or effective raw field'));
  const selects={};
  for(const [key,text] of [['row','Source row'],['side','Evidence side'],['field','Source field']]){
    const select=el('select');select.id=id+'-observation-'+key;const label=el('label',text);label.htmlFor=select.id;
    detail.append(label,select);selects[key]=select;
  }
  for(const [value,text] of [['incoming','Original observation in this upload'],['effective','Effective observation after the proposed merge']]){const o=el('option',text);o.value=value;selects.side.append(o);}
  for(const value of OBSERVATION_FIELDS){const o=el('option',value.replaceAll('_',' '));o.value=value;selects.field.append(o);}
  const rawStart=el('button','Inspect raw field from beginning'),rawNext=el('button','Inspect next raw characters');rawStart.type=rawNext.type='button';
  const rawStatus=el('p'),rawText=el('pre');rawText.style.whiteSpace='pre-wrap';rawText.style.overflowWrap='anywhere';
  detail.append(rawStart,rawNext,rawStatus,rawText);
  section.append(title,hint,familyLabel,family,summary,open,cost,status,tableHost,next,back,detail);host.append(section);
  const live=()=>!disposed&&host.isConnected&&isCurrent()===true;
  const ready=()=>live()&&state?.phase==='review_ready'&&state.review?.command.mapping_name===MAPPING;
  const on=(n,event,fn)=>{n.addEventListener(event,fn);releases.push(()=>n.removeEventListener(event,fn));};
  const selectedRaw=()=>({ordinal:Number(selects.row.value),side:selects.side.value,field:selects.field.value,offset:0});
  function matchingChunk(){const c=page?.raw_chunk,r=selectedRaw();return c&&c.ordinal===r.ordinal&&c.side===r.side&&c.field===r.field?c:null;}
  function paintRaw(){
    const c=matchingChunk();rawNext.disabled=!ready()||!c||c.next_offset===null;
    if(!c){rawStatus.textContent='Choose a field and inspect it. Short table prefixes are not the complete raw observation.';rawText.textContent='';return;}
    rawStatus.textContent=`Source row ${c.ordinal}, ${c.side}, ${c.field}: characters ${c.total_characters?c.offset+1:0}–${c.offset+Array.from(c.text).length} of ${c.total_characters}. Controls are shown as escaped Unicode codes; no characters are silently omitted.`;
    rawText.textContent=displayRawEvidence(c.text);
  }
  on(family,'change',()=>{const value=family.value;if(live())onFamily(value);});
  on(open,'click',()=>{if(ready())onInspect(null,null);});
  on(next,'click',()=>{const after=page?.next;if(ready()&&after!==null&&after!==undefined)onInspect(after,null);});
  on(back,'click',()=>{if(ready())onReturn();});
  on(rawStart,'click',()=>{const raw=selectedRaw();if(ready()&&page)onInspect(page.after,raw);});
  on(rawNext,'click',()=>{const c=matchingChunk();if(ready()&&c&&c.next_offset!==null)onInspect(page.after,{ordinal:c.ordinal,side:c.side,field:c.field,offset:c.next_offset});});
  for(const n of Object.values(selects))on(n,'change',paintRaw);
  const field=(row,side,name)=>row[side].find(f=>f.field===name);
  const count=f=>f.count===null?`Unavailable (${f.state})`:f.count;
  const raw=f=>f.raw_prefix===null?'Not supplied':`${displayRawEvidence(f.raw_prefix)}${f.raw_characters>Array.from(f.raw_prefix).length?'… [prefix only]':''} (${f.state}; raw date)`;
  const dates=(row,side,suffix)=>`First: ${raw(field(row,side,'first_played'+suffix))}; last: ${raw(field(row,side,'last_played'+suffix))}`;
  function update(value){
    if(disposed)return;state=value;const tsv=state.mapping===MAPPING;section.hidden=!tsv;
    family.value=state.countFamily||'standard';family.disabled=!live()||state.submitted===true||['checking','reviewing','submitting','importing','saving_personal'].includes(state.phase);
    summary.textContent=`Supported export mapping: ${MAPPING}. This is the supported TSV snapshot contract, not a claim about the installed component version. Displayed count family: ${family.value==='enhanced'?'Enhanced TSV':'Standard TSV'}. This affects the displayed count, not the retained evidence or imported source totals. No families or providers are summed.`;
    page=state.review?.observations||null;const can=ready();open.disabled=!can;next.disabled=!can||!page||page.next===null;back.disabled=!can;
    next.hidden=back.hidden=detail.hidden=!page;
    for(const n of Object.values(selects))n.disabled=!can;
    rawStart.disabled=!can||!page||!page.items.length;
    if(page!==renderedPage||family.value!==renderedFamily){
      const pageChanged=page!==renderedPage;renderedPage=page;renderedFamily=family.value;tableHost.replaceChildren();
      if(page){
        if(pageChanged){const selected=selects.row.value;selects.row.replaceChildren();for(const row of page.items){const o=el('option',`${row.source_artist||'Unknown artist'} / ${row.source_title||'Untitled source track'} · row ${row.row}`);o.value=String(row.row);selects.row.append(o);}selects.row.value=page.items.some(r=>String(r.row)===selected)?selected:String(page.items[0]?.row||'');}
        const chosen=family.value==='enhanced'?'play_count_enhanced':'play_count';
        const columns=[['song','Song from source'],['selected','Selected effective count'],['standard','Standard count: original / effective'],['enhanced','Enhanced count: original / effective'],['originalDates','Original first / last text'],['effectiveDates','Effective first / last text'],['origin','Effective selected-count origin']].map(([key,label])=>({key,label,width:'minmax(180px,1fr)'}));
        const suffix=family.value==='enhanced'?'_enhanced':'';
        const rows=page.items.map(row=>{const f=field(row,'effective',chosen),origin=f.origin;return {song:`${row.source_artist||'Unknown artist'} / ${row.source_title||'Untitled source track'}${row.source_album?' ('+row.source_album+')':''} · row ${row.row}`,selected:count(f),standard:count(field(row,'incoming','play_count'))+' / '+count(field(row,'effective','play_count')),enhanced:count(field(row,'incoming','play_count_enhanced'))+' / '+count(field(row,'effective','play_count_enhanced')),originalDates:dates(row,'incoming',suffix),effectiveDates:dates(row,'effective',suffix),origin:origin?`Upload ${origin[0]}, row ${origin[1]}, column ${origin[2]+1}`:'No effective observation'};});
        tableHost.append(renderTable('Original and effective source observations',columns,rows,'source-observations'));
        status.textContent=`${page.items.length} source rows shown, ${page.remaining} later rows remain in the reviewed scope. Both count families are shown. Date columns follow the selected family; every raw field is available below.`;
      }else status.textContent=state.phase==='reviewing'?'Reviewing the original file; prior observation detail is not current.':'Run a review, then inspect both original and effective observations before confirming.';
    }
    paintRaw();
  }
  return Object.freeze({update,dispose(){if(disposed)return;disposed=true;for(const release of releases.splice(0).reverse())release();state=page=renderedPage=null;section.remove();}});
}
