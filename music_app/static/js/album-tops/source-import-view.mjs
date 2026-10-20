import {mountButton, mountChoice} from '../home-friends/native-controls.mjs';
import {mountCollectionReorder} from '../playlists/reorder.mjs';
import {mountAlbumPicker} from './builder.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {createSourceImportMatchSession} from './source-import-match-session.mjs';

const kinds = [['url', 'URL'], ['pasted_html', 'Pasted HTML'], ['uploaded_html', 'Uploaded HTML'], ['text', 'Plain text']];
const stateLabels = {queued: 'Waiting to process source', running: 'Processing source', completed: 'Source ready for review',
  failed: 'Source processing failed', canceled: 'Import canceled'};
const operationLabels = {submit: 'Submitting source', read: 'Loading import', process: 'Processing source',
  cancel: 'Canceling import', finalize: 'Saving Album Top'};
function node(parent, tag = 'div', className = '', text) {
  const value = parent.ownerDocument.createElement(tag); value.className = className;
  if (text !== undefined) value.textContent = text; parent.append(value); return value;
}
const reviewIntent = value => JSON.stringify([value.rows, value.orderConfirmed]);

export function mountSourceImportView(host, runtime, {controller, topController, providers, isCurrent, onClose, onOpenTop}) {
  const inactive = Object.freeze({update() {}, dispose() {}, async beforeDismiss() {return false;}});
  function mayMount() {
    if (!isCurrent() || controller.getSnapshot().status === 'retired') return false;
    // Admission reads can synchronously retire either captured owner.
    return isCurrent() && controller.getSnapshot().status !== 'retired' && isCurrent();
  }
  if (!mayMount()) return inactive;
  const input = {...(controller.getSubmittedSource() ?? {title: '', description: '', kind: 'url', filename: null, content: ''})};
  if (!mayMount()) return inactive;
  let disposed = false, rendering = false, queued = false, confirming = false, inputVersion = 0, fileVersion = 0;
  let fileLoading = false, fileError = null, actionError = null, opening = null, match = null, matchGeneration = 0;
  let baselineKey = null, baseline = null, reviewOwner = {}, previous = null;
  let unsubscribe = () => {}, unsubscribeTop = () => {}, choice = null, reorder = null;
  const controls = [], fields = [], rowOwners = new Map();
  const superseded = Symbol('retired source view');
  const root = node(host, 'section', 'album-top-builder'); root.setAttribute('aria-label', 'Import Album Top');
  const intake = node(root, 'div', 'tag-editor-form'), choiceHost = node(intake), fieldHost = node(intake);
  const status = node(root, 'p', 'playlists__note'); status.setAttribute('role', 'status');
  const error = node(root, 'p', 'playlists__note'); error.hidden = true;
  const evidence = node(root, 'section'); evidence.setAttribute('aria-label', 'Source evidence');
  const evidenceTitle = node(evidence, 'h3'), evidenceDescription = node(evidence, 'p'), evidenceKind = node(evidence, 'p'), evidenceContent = node(evidence, 'pre');
  const review = node(root, 'section'); review.setAttribute('aria-label', 'Source review');
  const issues = node(review, 'div'), empty = node(review, 'p', 'playlists__note', 'No candidate rows were extracted. Source review is required.');
  const rows = node(review, 'div', 'playlists__tracks'), announce = node(review, 'span', 'sr-only'); announce.setAttribute('aria-live', 'polite');
  const matchHost = node(root), report = node(root), actions = node(root, 'div', 'playlists__actions');
  function live() {
    if (!disposed && (!isCurrent() || controller.getSnapshot().status === 'retired')) dispose();
    return !disposed;
  }
  const busy = value => ['loading', 'uncertain'].includes(value.status);
  function intakeEditable(value = controller.getSnapshot()) {
    return !value.job && !value.result && controller.canSubmit();
  }
  function editable(value = controller.getSnapshot()) {
    return !busy(value) && !value.result && value.job?.status === 'completed' && !value.job.top_ref
      && albumTopActionAllowed(topController.getSnapshot(), 'create');
  }
  function button(parent, label, run) {
    const target = node(parent, 'span');
    const variant = ['Save source', 'Save Album Top', 'Confirm match'].includes(label) ? 'primary' : undefined;
    const owner = mountButton(target, runtime, {label, variant, onClick: () => {if (live()) run();}});
    if (disposed || !isCurrent()) {owner.dispose(); target.remove(); throw superseded;}
    const item = {target, owner, label, run, variant}; controls.push(item); return item;
  }
  function releaseButton(item) {
    if (!item) return;
    const index = controls.indexOf(item); if (index !== -1) controls.splice(index, 1);
    item.owner.dispose(); item.target.remove();
  }
  function setButton(item, shown, disabled) {
    item.target.hidden = !shown;
    item.owner.update({label: item.label, variant: item.variant, disabled: !shown || disabled, onClick: () => {if (live()) item.run();}});
  }
  function field(label, key, tag = 'input') {
    const wrapper = node(fieldHost, 'label'), caption = node(wrapper, 'span', '', label), control = node(wrapper, tag);
    control.setAttribute('aria-label', label); if (tag === 'input') control.type = 'text';
    const change = () => {
      if (!live() || !intakeEditable()) return;
      input[key] = control.value; inputVersion++; actionError = null; update();
    };
    control.addEventListener('input', change); fields.push({control, change, wrapper, caption, key}); return fields.at(-1);
  }
  const title = field('Album Top title', 'title'), description = field('Album Top description', 'description', 'textarea');
  const content = field('Source URL', 'content', 'textarea');
  const fileWrapper = node(fieldHost, 'label'); node(fileWrapper, 'span', '', 'HTML file');
  const upload = node(fileWrapper, 'input'); upload.type = 'file'; upload.accept = '.html,.htm,text/html'; upload.setAttribute('aria-label', 'HTML file');
  const retainedFilename = node(fileWrapper, 'span', 'playlists__note'); retainedFilename.setAttribute('aria-label', 'Retained HTML filename');
  async function changedFile() {
    if (!live() || !intakeEditable() || input.kind !== 'uploaded_html') return;
    const version = ++fileVersion, selected = upload.files?.[0]; inputVersion++;
    input.filename = null; input.content = ''; fileError = null; fileLoading = false;
    const current = () => live() && fileVersion === version && input.kind === 'uploaded_html' && intakeEditable();
    if (!selected) {update(); return;}
    if (typeof selected.size !== 'number' || !Number.isFinite(selected.size) || selected.size <= 0 || selected.size > 512 * 1024) {
      fileError = 'Choose a nonempty HTML file no larger than 512 KiB.'; update(); return;
    }
    fileLoading = true; update();
    try {
      if (!current()) return;
      const text = await selected.text();
      if (!current()) return;
      if (typeof text !== 'string' || !text.length) throw new TypeError('Empty file.');
      input.filename = selected.name; input.content = text;
    } catch {if (current()) fileError = 'This HTML file could not be read.';}
    finally {if (current()) {fileLoading = false; update();}}
  }
  upload.addEventListener('change', changedFile);
  function retireMatch(expected = match) {
    if (match !== expected) return null;
    const version = ++matchGeneration, old = match; match = null;
    if (!old) return version;
    old.unsubscribe?.(); old.picker?.dispose(); old.session.dispose();
    releaseButton(old.confirm); releaseButton(old.close); old.root.remove();
    return version;
  }
  function matchCurrent(item) {
    const value = controller.getSnapshot();
    return live() && match === item && editable(value) && value.job.job_ref === item.jobRef && value.job.revision === item.revision;
  }
  function updateMatch() {
    const item = match; if (!item) return;
    if (!matchCurrent(item)) {retireMatch(item); return;}
    const disabled = !item.session.draft.canEditMembership();
    if (match !== item || !live()) return;
    const value = item.session.draft.getSnapshot();
    item.picker?.update({value, disabled, blocked: disabled});
    if (match !== item || !live() || item.session.draft.getSnapshot() !== value) return;
    if (item.confirm) setButton(item.confirm, true, disabled || value.busy || value.items.length !== 1);
  }
  function beginMatch(ref) {
    if (!live() || !editable() || !controller.getSnapshot().rows.some(row => row.row_ref === ref)) return;
    const version = retireMatch();
    if (!live() || version !== matchGeneration || !editable()
        || !controller.getSnapshot().rows.some(row => row.row_ref === ref)) return;
    const value = controller.getSnapshot(); let item;
    try {
      const session = createSourceImportMatchSession({topController, providers, importController: controller, rowRef: ref});
      const region = node(matchHost, 'section'); region.setAttribute('aria-label', `Match source row ${ref}`);
      item = {session, root: region, jobRef: value.job.job_ref, revision: value.job.revision}; match = item;
      item.picker = mountAlbumPicker(node(region), runtime, {draft: session.draft, providers, value: session.draft.getSnapshot(), disabled: !session.draft.canEditMembership()});
      if (!live() || match !== item) {item.picker.dispose(); session.dispose(); region.remove(); return;}
      item.confirm = button(region, 'Confirm match', () => {
        if (matchCurrent(item) && item.session.confirm()) {retireMatch(item); update();}
      });
      item.close = button(region, 'Close match', () => {if (match === item) {retireMatch(item); update();}});
      item.unsubscribe = session.draft.subscribe(() => {if (match === item) updateMatch();}); updateMatch();
    } catch {if (match === item) retireMatch(item); actionError = 'Album matching is unavailable. Try again.'; update();}
  }
  async function openTop() {
    if (!live() || opening) return;
    const captured = controller.getSnapshot(), top = captured.result?.top_ref ?? captured.job?.top_ref;
    if (!top || busy(captured)) return;
    const token = {captured}; opening = token; actionError = null;
    const current = () => live() && controller.getSnapshot() === captured;
    update();
    try {if (current() && await onOpenTop(top, current) === false && current()) actionError = 'This Album Top could not be opened. Try again.';}
    catch {if (current()) actionError = 'This Album Top could not be opened. Try again.';}
    finally {if (opening === token) opening = null; if (live()) update();}
  }
  let saveSource, retry, process, cancel, confirmOrder, saveTop, open, close;
  try {
  saveSource = button(actions, 'Save source', () => {
    if (!intakeEditable() || !albumTopActionAllowed(topController.getSnapshot(), 'create')
        || fileLoading || input.kind === 'uploaded_html' && (!input.filename || fileError)) return;
    fileVersion++; void controller.submit({...input});
  });
  retry = button(actions, 'Retry', () => {void controller.retry();});
  process = button(actions, 'Retry processing', () => {if (!busy(controller.getSnapshot()) && controller.getSnapshot().job?.status === 'failed') void controller.process();});
  cancel = button(actions, 'Cancel import', () => {void controller.cancel();});
  confirmOrder = button(actions, 'Confirm order', () => {if (editable()) controller.confirmOrder();});
  saveTop = button(actions, 'Save Album Top', () => {if (editable()) void controller.finalize();});
  open = button(actions, 'Open Album Top', () => {void openTop();});
  close = button(actions, 'Close', () => onClose());
  } catch (error) {dispose(); throw error;}
  function dispose() {
    if (disposed) return; disposed = true; fileVersion++; opening = null;
    unsubscribe(); unsubscribeTop(); retireMatch(); reorder?.dispose(); choice?.dispose();
    upload.removeEventListener('change', changedFile);
    fields.forEach(item => item.control.removeEventListener('input', item.change));
    for (const item of controls) item.owner.dispose();
    rowOwners.clear(); root.remove();
  }
  function render() {
    if (!live()) return;
    const check = () => {if (!live() || queued) throw superseded;};
    const value = controller.getSnapshot(), job = value.job, top = value.result?.top_ref ?? job?.top_ref;
    const canIntake = intakeEditable(value), blocked = busy(value), canReview = editable(value);
    if (value !== previous) {
      previous = value;
      if (!canIntake) {fileVersion++; fileLoading = false; fileError = null;}
      if (opening && opening.captured !== value) {opening = null; actionError = null;}
    }
    const key = job ? `${job.job_ref}:${job.revision}` : null;
    if (key !== baselineKey) {baselineKey = key; baseline = reviewIntent(value); reviewOwner = {};}
    intake.hidden = Boolean(job);
    for (const item of [title, description, content]) {if (item.control.value !== input[item.key]) item.control.value = input[item.key]; item.control.disabled = !canIntake;}
    content.wrapper.hidden = input.kind === 'uploaded_html'; fileWrapper.hidden = input.kind !== 'uploaded_html'; upload.disabled = !canIntake;
    retainedFilename.hidden = canIntake || input.kind !== 'uploaded_html' || !input.filename;
    retainedFilename.textContent = retainedFilename.hidden ? '' : input.filename;
    const contentLabel = input.kind === 'url' ? 'Source URL' : 'Source content'; content.caption.textContent = contentLabel; content.control.setAttribute('aria-label', contentLabel);
    choice.update({label: 'Source type', options: kinds, value: input.kind, disabled: !canIntake, onChange: kind => {
      if (!live() || !intakeEditable() || !kinds.some(row => row[0] === kind) || input.kind === kind) return;
      input.kind = kind; input.filename = null; input.content = ''; inputVersion++; fileVersion++; fileLoading = false; fileError = null; actionError = null; update();
    }});
    check();
    status.textContent = value.status === 'uncertain' ? `${operationLabels[value.operation] || 'Action'}: outcome unknown. Retry to recover.`
      : value.status === 'loading' ? operationLabels[value.operation] || 'Loading import'
        : top ? 'Album Top created' : job ? stateLabels[job.status] : fileLoading ? 'Reading HTML file' : 'Choose a source to import.';
    const message = fileError || actionError || (value.status === 'error'
      ? value.operation === 'submit' && !canIntake
        ? 'This submission was rejected. Retry the same source, or close this view and start a new import to change it.'
        : 'This action could not be completed. Check the source or try again.' : null);
    error.hidden = !message; error.textContent = message || ''; if (message) error.setAttribute('role', 'alert'); else error.removeAttribute('role');
    evidence.hidden = !job;
    if (job) {evidenceTitle.textContent = job.title; evidenceDescription.textContent = job.source.description;
      evidenceKind.textContent = [job.kind, job.source.filename].filter(Boolean).join(' · '); evidenceContent.textContent = job.source.content;}
    review.hidden = !job?.review;
    issues.replaceChildren(); for (const issue of job?.review?.issues || []) node(issues, 'p', 'playlists__note', issue);
    empty.hidden = value.rows.length !== 0;
    const evidenceRows = new Map((job?.review?.rows || []).map(row => [row.row_ref, row]));
    const wanted = new Set();
    for (const row of value.rows) {
      const ref = row.row_ref, original = evidenceRows.get(ref); if (!original) continue;
      wanted.add(ref); let item = rowOwners.get(ref);
      if (!item) {
        const region = node(rows, 'div'); region.setAttribute('data-source-row-ref', ref);
        const text = node(region, 'p'), selected = node(region, 'p', 'playlists__note');
        const move = button(region, `Move source row ${ref}`, () => {});
        move.owner.update({label: move.label, attributes: {'data-source-row-drag': ''}, ariaLabel: move.label});
        const matchButton = button(region, `Match album for source row ${ref}`, () => beginMatch(ref));
        const clear = button(region, `Clear match for source row ${ref}`, () => {if (editable()) controller.select(ref, null);});
        item = {region, text, selected, move, matchButton, clear}; rowOwners.set(ref, item);
      }
      check();
      item.text.textContent = `${original.explicit_rank === null ? '' : `Original rank ${original.explicit_rank}: `}${original.raw_text}`;
      item.selected.textContent = row.selection ? 'Album match selected' : 'Unresolved';
      const ambiguous = job.review.ordered_row_refs === null;
      item.move.target.hidden = !ambiguous;
      item.move.owner.update({label: item.move.label, ariaLabel: item.move.label, disabled: !canReview || !ambiguous,
        attributes: {'data-source-row-drag': ''}});
      setButton(item.matchButton, true, !canReview); setButton(item.clear, Boolean(row.selection), !canReview);
      check();
      rows.append(item.region);
    }
    for (const [ref, item] of rowOwners) if (!wanted.has(ref)) {
      for (const control of [item.move, item.matchButton, item.clear]) releaseButton(control); item.region.remove(); rowOwners.delete(ref);
    }
    report.replaceChildren();
    for (const row of value.result?.source_report || []) node(report, 'p', 'playlists__note', `Source row ${row.row_ref}: ${row.outcome}${row.retained_row_ref ? ` (retained row ${row.retained_row_ref})` : ''}`);
    setButton(saveSource, !job, !canIntake || !albumTopActionAllowed(topController.getSnapshot(), 'create')
      || fileLoading || input.kind === 'uploaded_html' && (!input.filename || Boolean(fileError)));
    setButton(retry, ['error', 'uncertain'].includes(value.status)
      && !(value.operation === 'submit' && canIntake), blocked && value.status !== 'uncertain');
    setButton(process, job?.status === 'failed', blocked || Boolean(top));
    setButton(cancel, Boolean(job) && !top, value.status === 'uncertain' || job?.status === 'canceled'
      || value.status === 'loading' && !['read', 'process'].includes(value.operation));
    setButton(confirmOrder, job?.review?.ordered_row_refs === null && !top, !canReview || value.orderConfirmed);
    setButton(saveTop, Boolean(job?.review) && !top, !canReview || !value.orderConfirmed || !value.rows.some(row => row.selection));
    setButton(open, Boolean(top), blocked || Boolean(opening)); setButton(close, true, false);
    updateMatch(); reorder.update();
  }
  function update() {
    if (disposed) return; queued = true; if (rendering) return; rendering = true;
    try {while (queued && !disposed) {queued = false; try {render();} catch (error) {if (error !== superseded) {dispose(); throw error;}}}} finally {rendering = false;}
  }
  async function beforeDismiss() {
    if (!live() || confirming) return false;
    const value = controller.getSnapshot(), version = inputVersion;
    const dirty = !busy(value) && !value.result && !value.job?.top_ref && (value.job ? reviewIntent(value) !== baseline : controller.canSubmit() && inputVersion !== 0);
    if (!dirty) return true;
    if (typeof runtime.confirm !== 'function') return false;
    confirming = true;
    try {return await runtime.confirm('Discard these unsaved Album Top changes?',
      {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true}) === true
      && live() && controller.getSnapshot() === value && inputVersion === version;}
    finally {confirming = false;}
  }
  try {
    choice = mountChoice(choiceHost, runtime, {label: 'Source type', options: kinds, value: input.kind});
    reorder = mountCollectionReorder(rows, {snapshot: () => {
      const value = controller.getSnapshot(), job = value.job;
      return {scopeKey: topController.getSnapshot().scopeKey, jobRef: job?.job_ref, source: reviewOwner, selectedRowKey: null,
        rows: value.rows.map(row => ({...row, row_key: row.row_ref})), itemsComplete: true, canEdit: live() && editable(value),
        canReorder: job?.review?.ordered_row_refs === null, unfiltered: true, defaultOrder: true, busy: busy(value)};
    }, collectionKey: value => value.jobRef, itemKey: row => row.row_ref, rowSelector: '[data-source-row-ref]',
    handleSelector: '[data-source-row-drag]', rowKeyAttribute: 'data-source-row-ref',
    onReorder: refs => live() && editable() && controller.reorder(refs), onAnnounce: text => {if (live()) announce.textContent = text;}});
    unsubscribe = controller.subscribe(update); unsubscribeTop = topController.subscribe(update); update();
  } catch (error) {dispose(); throw error;}
  return Object.freeze({update, beforeDismiss, dispose});
}
