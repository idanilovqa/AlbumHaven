import {mountButton} from './native-controls.mjs';
import {createNativeLifetime} from './native-lifetime.mjs';
import {normalizeGoalSearchQuery} from './goals-provider.mjs';

const periodLabels = {week: '1 week', month: '1 month', 'six-months': '6 months', year: 'This year'};
export function mountGoalAdmission(host, runtime, initial) {
  const life = createNativeLifetime(), doc = host.ownerDocument;
  let sequence = 0, active = null, candidates = [], selected = null, evidence = null, busy = '', message = '', searched = false;
  let rendering = false, queuedRender = false;
  let rows = [], renderedCandidates = null, renderedEvidence = null, search, confirm, cancel;
  const valid = () => !life.disposed && initial.isCurrent();
  const make = (parent, tag, text = '') => {const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node;};
  const root = make(host, 'div'); root.className = 'tag-editor-form';
  life.defer(() => root.remove());
  const form = make(root, 'form'); form.className = 'tag-editor-form'; form.setAttribute('aria-label', 'Search albums for Goals');
  const titleLabel = make(form, 'label', 'Album title'), title = make(titleLabel, 'input');
  title.type = 'text'; title.required = true; title.setAttribute('aria-label', 'Album title');
  const artistLabel = make(form, 'label', 'Artist (optional)'), artist = make(artistLabel, 'input');
  artist.type = 'text'; artist.setAttribute('aria-label', 'Artist (optional)');
  make(form, 'p', 'Use up to 100 characters in each field. Search runs only when you choose Search.').className = 'home-friends__muted';
  const searchHost = make(form, 'span'), help = make(root, 'p'); help.className = 'home-friends__muted';
  help.textContent = initial.expected.period === 'year'
    ? 'This year ends on December 31 of the current calendar year. Choose an album, verify its details, then add it.'
    : `${periodLabels[initial.expected.period]} begins with the first Add or Reset. Choose an album, verify its details, then add it.`;
  const status = make(root, 'p'), error = make(root, 'p'), results = make(root, 'div'), preview = make(root, 'div'), expiry = make(root, 'p');
  status.setAttribute('role', 'status'); error.setAttribute('role', 'alert');
  results.setAttribute('aria-label', 'Album search results'); preview.setAttribute('aria-label', 'Verified album preview');
  const actions = make(root, 'div'), cancelHost = make(actions, 'span'), confirmHost = make(actions, 'span');
  function retire() {sequence++; const request = active; active = null; request?.abort();}
  function disposeRows() {for (const row of rows.splice(0)) row.life.dispose(); renderedCandidates = null;}
  life.defer(() => {try {disposeRows();} finally {retire();}});
  const query = () => {try {return normalizeGoalSearchQuery({title: title.value || '', artist: artist.value || ''});} catch {return null;}};
  function render() {
    if (rendering) {queuedRender = true; return;}
    rendering = true;
    try {do {queuedRender = false; renderFrame();} while (queuedRender && valid());}
    finally {rendering = false;}
  }
  function renderFrame() {
    if (!valid()) {dispose(); return;}
    const frame = {sequence, candidates, selected, evidence, busy, message};
    const checkpoint = () => {
      if (valid() && frame.sequence === sequence && frame.candidates === candidates && frame.selected === selected
        && frame.evidence === evidence && frame.busy === busy && frame.message === message) return true;
      queuedRender = valid(); return false;
    };
    search.update({label: 'Search', type: 'submit', disabled: !query()}); if (!checkpoint()) return;
    status.textContent = busy === 'search' ? 'Searching albums…' : busy === 'evidence' ? 'Verifying album…'
      : searched && candidates.length === 0 ? 'No albums found. Refine the title or artist and search again.' : '';
    error.textContent = message;
    if (renderedCandidates !== candidates) {
      disposeRows(); if (!checkpoint()) return;
      for (const candidate of candidates) {
        const rowHost = make(results, 'span');
        const rowLife = createNativeLifetime(), row = {host: rowHost, life: rowLife, owner: null, candidate};
        rowLife.defer(() => rowHost.remove()); rows.push(row);
        row.owner = rowLife.own(mountButton(rowHost, runtime, {label: `${candidate.title} — ${candidate.artist_display}`}));
        if (!checkpoint()) {rowLife.dispose(); return;}
      }
      renderedCandidates = candidates;
    }
    for (const row of rows) {
      row.owner.update({label: `${row.candidate.title} — ${row.candidate.artist_display}`, selected: selected === row.candidate,
        onClick: () => {if (valid() && candidates.includes(row.candidate)) void choose(row.candidate);}});
      if (!checkpoint()) return;
    }
    if (renderedEvidence !== evidence) {
      if (evidence) {
        const album = evidence.album;
        const artwork = runtime.artboxHtml({state: 'missing', label: `${album.title} artwork`}); if (!checkpoint()) return;
        const markup = runtime.galleryCardHtml({identity: evidence.evidence_ref, title: album.title, artist: album.artist_display,
          year: album.first_release_date?.slice(0, 4) || '', interaction: 'none', displayMode: 'cards', artboxHtml: artwork, listeningSummaryHtml: ''});
        if (!checkpoint()) return;
        preview.innerHTML = markup; if (!checkpoint()) return; expiry.textContent = `Preview expires: ${evidence.expires_at}`;
      } else {preview.replaceChildren(); expiry.textContent = '';}
      renderedEvidence = evidence;
    }
    if (!checkpoint()) return;
    confirm.update({label: 'Add', variant: 'primary', disabled: !evidence || renderedEvidence !== evidence || busy !== '' || !initial.provider.isEvidenceCurrent(evidence),
      onClick: () => {if (valid() && evidence && renderedEvidence === evidence && !busy && initial.provider.isEvidenceCurrent(evidence)) initial.onConfirm(evidence, initial.expected);}});
  }
  function begin() {retire(); const controller = new AbortController(), token = sequence; active = controller;
    return {options: {signal: controller.signal, isCurrent: () => valid() && token === sequence}, current: () => valid() && token === sequence};}
  function failed(errorValue, task, label) {
    if (!task.current()) return;
    initial.controller.admissionFailed(errorValue); if (!valid()) return;
    busy = ''; evidence = null; message = errorValue?.code === 'evidence_limit'
      ? 'Too many album previews are active. Try again later.' : `${label} could not be completed. Try again.`;
    render();
  }
  async function submit(event) {
    event.preventDefault(); const terms = query(); if (!valid() || !terms) return;
    const task = begin(); candidates = []; selected = evidence = null; busy = 'search'; searched = false; message = ''; render();
    if (!task.current()) return;
    try {const result = await initial.provider.search(terms, task.options); if (!task.current()) return;
      candidates = result.candidates; busy = ''; searched = true; render();}
    catch (errorValue) {failed(errorValue, task, 'Search');}
  }
  async function choose(candidate) {
    if (!valid() || !candidates.includes(candidate)) return;
    const task = begin(); selected = candidate; evidence = null; busy = 'evidence'; message = ''; render();
    if (!task.current()) return;
    try {const result = await initial.provider.evidence({release_group_id: candidate.release_group_id}, task.options);
      if (!task.current()) return; evidence = result; busy = ''; render();}
    catch (errorValue) {failed(errorValue, task, 'Album verification');}
  }
  function edited() {if (!valid()) return; retire(); candidates = []; selected = evidence = null; busy = ''; searched = false; message = ''; render();}
  function dispose() {if (life.disposed) return; retire(); candidates = []; selected = evidence = null; life.dispose();}
  try {
    search = life.own(mountButton(searchHost, runtime, {label: 'Search', type: 'submit', disabled: true}));
    confirm = life.own(mountButton(confirmHost, runtime, {label: 'Add', variant: 'primary', disabled: true}));
    cancel = life.own(mountButton(cancelHost, runtime, {label: 'Cancel', onClick: () => initial.onClose()}));
    for (const input of [title, artist]) {input.addEventListener('input', edited); life.defer(() => input.removeEventListener('input', edited));}
    form.addEventListener('submit', submit); life.defer(() => form.removeEventListener('submit', submit));
    render();
  } catch (errorValue) {dispose(); throw errorValue;}
  return {dispose};
}
