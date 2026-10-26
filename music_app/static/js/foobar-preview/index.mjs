import {createPreviewController} from './controller.mjs';

const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const label = value => String(value).replaceAll('_',' ');

export function mountFoobarPreview(root,{fetch,transport,allows,isCurrent,renderButton,renderTable}) {
  const document=root.ownerDocument;
  root.innerHTML='<section class="library-settings-section"><h4>Preview Text Tools TSV</h4><p>Preview only. This does not import ratings, favourites, play counts or listening history.</p><p>Your selected file is sent to this server for a temporary preview. It is not saved as an upload.</p><label class="lastfm-inline-field"><span>Export mapping</span><select class="utility-search-input" data-foobar-mapping disabled><option>Foobar Text Tools snapshot v1 (UTF-8 TSV)</option></select></label><p>Use named columns from the Text Tools export, including the required path column. Other formats and custom column remapping are not supported.</p><label class="lastfm-inline-field"><span>TSV file (up to 64 MiB)</span><input type="file" accept=".tsv,text/tab-separated-values" data-foobar-file></label><p data-foobar-filename></p><div class="settings-integration-actions" data-foobar-actions></div><p role="status" aria-live="polite" data-foobar-status></p><div data-foobar-results></div></section>';
  const input=root.querySelector('[data-foobar-file]');
  const filename=root.querySelector('[data-foobar-filename]');
  const actions=root.querySelector('[data-foobar-actions]');
  const status=root.querySelector('[data-foobar-status]');
  const results=root.querySelector('[data-foobar-results]');
  const buttons={};
  for (const [key,title] of [['preview','Preview'],['next','Next 100 rows'],['clear','Clear'],['retry','Retry availability check']]) {
    const holder=document.createElement('div');
    holder.innerHTML=renderButton({label:title,attributes:{'data-foobar-preview-action':key}});
    const button=holder.firstElementChild;
    if (!button || button.tagName!=='BUTTON') throw new Error('Shared Button owner unavailable.');
    actions.append(button);buttons[key]=button;
  }
  let disposed=false;
  const live=()=>!disposed && root.isConnected && isCurrent();
  const controller=createPreviewController({fetch,transport,allows,isCurrent:live,onChange:value=>{
    if (!live()) return;
    const loading=value.phase==='loading';
    const checking=value.phase==='checking';
    input.disabled=!value.available || loading;
    filename.textContent=value.filename;
    if (!value.filename) input.value='';
    buttons.preview.disabled=!value.available || !value.filename || loading;
    buttons.next.disabled=!value.available || loading || value.page?.next_offset==null;
    buttons.clear.disabled=!value.filename && !loading;
    buttons.retry.hidden=value.phase!=='capability-error';
    buttons.retry.disabled=value.phase!=='capability-error';
    root.setAttribute('aria-busy',loading || checking?'true':'false');
    status.textContent=value.error || ({checking:'Checking preview availability…',empty:'Choose a TSV file to preview.',selected:'Ready to preview. Nothing has been imported.',loading:'Preparing preview…',ready:'Preview only. Nothing has been imported.'}[value.phase] || 'Preview is unavailable.');
    results.replaceChildren();
    if (!value.page) return;
    const page=value.page;
    const summary=document.createElement('p');
    summary.textContent=`${page.total_rows} rows. ${page.summary.exact_unique_rows} exact matches; ${page.summary.ambiguous_rows} ambiguous; ${page.summary.unmatched_rows} unmatched; ${page.summary.identity_conflict_rows} identity conflicts. ${page.summary.duplicate_target_rows} rows share a target. ${page.summary.rows_with_field_errors} rows have field errors.`;
    results.append(summary);
    const caution=document.createElement('p');
    caution.textContent='Matches are suggestions, not import approval. Counts and dates remain source observations; no listening events or taste changes are created.';
    results.append(caution);
    if (!page.rows.length) return;
    const table=document.createElement('div');
    table.innerHTML=renderTable({id:'foobar-preview',ariaLabel:'Foobar TSV preview',columns:'80px minmax(150px,1fr) minmax(220px,2fr)',columnsConfig:[{key:'row',label:'Row'},{key:'match',label:'Match'},{key:'evidence',label:'Evidence'}],headers:'visible',density:'compact',overflow:'local',mobile:'stack',frame:'outline',rows:page.rows.map(row=>({key:String(row.ordinal),cells:{row:String(row.ordinal),match:escape(label(row.match_status))+(row.duplicate_target?' · shared target':''),evidence:row.fields.map(field=>escape(`${label(field.name)}: ${label(field.state)}`)).join('<br>') || 'No supported evidence fields'}}))});
    results.append(table);
  }});
  const choose=()=>controller.choose(input.files?.[0]);
  const preview=()=>{void controller.preview(0);};
  const next=()=>{const offset=controller.getState().page?.next_offset;if(offset!=null)void controller.preview(offset);};
  const clear=()=>{input.value='';controller.clear();};
  const retry=()=>{void controller.retryCapabilities();};
  input.addEventListener('change',choose);
  buttons.preview.addEventListener('click',preview);
  buttons.next.addEventListener('click',next);
  buttons.clear.addEventListener('click',clear);
  buttons.retry.addEventListener('click',retry);
  void controller.initialize();
  return Object.freeze({dispose(){
    if(disposed)return;disposed=true;controller.dispose();input.value='';
    input.removeEventListener('change',choose);buttons.preview.removeEventListener('click',preview);buttons.next.removeEventListener('click',next);buttons.clear.removeEventListener('click',clear);buttons.retry.removeEventListener('click',retry);
    root.replaceChildren();
  }});
}
