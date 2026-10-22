import {mountSharedHeader} from '../home-friends/shared-header.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';
import {mountAlbumPicker} from '../album-tops/builder.mjs';

export function mountPlaylistAlbumTopPreview(host, runtime, initial) {
  let props = initial, disposed = false, picker = null, renderedPreview = null, opening = false, openError = '', root = null, unsubscribe = () => {};
  const doc = host.ownerDocument, owners = [];
  try {
  const make = (parent, tag = 'div', className = '', text) => {const node = doc.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text; parent.append(node); return node;};
  root = make(host, 'section', 'album-top-builder'); root.setAttribute('aria-label', 'Unsaved Album Top preview');
  const headerHost = make(root), content = make(root), notice = make(content, 'p', 'playlists__note'); notice.setAttribute('role', 'status');
  const errors = make(content); errors.setAttribute('role', 'alert');
  const pickerHost = make(content), report = make(content, 'details'), summary = make(report, 'summary'), reportRows = make(report, 'ol');
  const header = mountSharedHeader(headerHost, runtime, {id: `playlist-top-preview-${props.token}`, ariaLabel: 'Unsaved Album Top'}); owners.push(header);
  const fields = make(header.slots.identity, 'div', 'album-top-builder__identity tag-editor-form');
  const inputs = [['title', 'Name', 100], ['description', 'Subtitle', 1000]].map(([key, label, max]) => {
    const wrapper = make(fields, 'label'); make(wrapper, 'span', 'sr-only', label);
    const input = make(wrapper, 'input'); input.setAttribute('aria-label', `Album Top ${label.toLowerCase()}`); input.maxLength = max;
    const change = () => {if (!disposed) props.controller.edit({[key]: input.value});}; input.addEventListener('input', change);
    return {key, input, change};
  });
  const save = mountButton(make(header.slots.actions), runtime, {label: 'Save', variant: 'primary'}); owners.push(save);
  const close = mountButton(make(header.slots.finalAction), runtime, {label: 'Cancel', icon: 'close'}); owners.push(close);
  const retry = mountButton(make(content), runtime, {label: 'Retry preview'}); owners.push(retry);
  let pickerValue = null;
  const pickerDraft = {getSnapshot: () => pickerValue, reorder: () => false};
  async function openAlbum(row) {
    if (disposed || opening || !props.controller.isCurrent() || props.controller.getSnapshot().save.status !== 'idle') return;
    opening = true; openError = ''; render();
    try {await props.onOpenAlbum(row.album_ref);}
    catch (error) {if (!disposed && props.controller.isCurrent() && error.name !== 'AbortError') openError = error.message;}
    finally {if (!disposed) {opening = false; render();}}
  }
  async function savePreview() {
    if (disposed || opening || !props.controller.isCurrent()) return;
    const receipt = await props.controller.save();
    if (disposed || !receipt || !props.controller.isCurrent()) return;
    opening = true; render();
    try {if (await props.onSaved(receipt) === false && !disposed) {openError = 'Saved. Open the saved Top to continue.'; render();}}
    catch (error) {if (!disposed && props.controller.isCurrent()) {openError = error.message; render();}}
    finally {if (!disposed) {opening = false; render();}}
  }
  function render() {
    if (disposed) return;
    const value = props.controller.getSnapshot(), preview = value.preview, busy = opening || value.save.status === 'loading';
    root.setAttribute('aria-busy', String(busy || value.status === 'loading'));
    inputs.forEach(({key, input}) => {if (input.value !== value[key]) input.value = value[key]; input.disabled = busy || value.status !== 'ready' || !['idle', 'error'].includes(value.save.status);});
    save.update({label: value.save.status === 'ready' ? 'Open saved Top' : value.save.status === 'uncertain' ? 'Retry Save' : 'Save', variant: 'primary',
      disabled: busy || value.status !== 'ready' || !preview?.albums.length || !value.title.trim() || value.title.trim().length > 100 || value.description.length > 1000,
      onClick: savePreview});
    close.update({label: 'Cancel', icon: 'close', disabled: busy || !props.controller.canLeave(), onClick: () => props.onClose()});
    retry.element.hidden = value.status !== 'error'; retry.update({label: 'Retry preview', disabled: busy, onClick: () => props.controller.load()});
    notice.textContent = value.save.status === 'ready' ? 'Saved Album Top.' : value.save.status === 'uncertain'
      ? 'The Save result could not be verified. Retry the same Save before leaving.' : value.status === 'loading' ? 'Preparing Album Top preview…'
        : preview ? `${preview.albums.length} albums. This Top is unsaved. Source Playlist and queue are unchanged.` : 'Preparing an unsaved Album Top.';
    errors.textContent = openError || value.save.error || value.error || '';
    report.hidden = !preview;
    if (preview && renderedPreview !== preview) {
      renderedPreview = preview; summary.textContent = `Source conversion report (${preview.report.length} tracks)`; reportRows.replaceChildren();
      const labels = {included: 'Included', duplicate: 'Duplicate album, included once', unresolved: 'Unresolved album', unsupported: 'Unsupported source', unavailable: 'Unavailable source'};
      for (const row of preview.report) make(reportRows, 'li', '', `Track ${row.position}: ${labels[row.reason]}`);
    }
    if (preview) {
      pickerValue = {scopeKey: value.scopeKey, topRef: null, tab: 'selected', query: '', items: preview.albums,
        search: {status: 'idle', items: [], next_cursor: null}, busy};
      const options = {draft: pickerDraft, value: pickerValue, disabled: busy || value.save.status !== 'idle', readOnly: true, onOpenAlbum: openAlbum};
      if (picker) picker.update(options); else picker = mountAlbumPicker(pickerHost, runtime, options);
    }
    header.refresh();
  }
  unsubscribe = props.controller.subscribe(render);
  render();
  function dispose() {if (disposed) return; disposed = true; unsubscribe(); picker?.dispose();
    for (const {input, change} of inputs) input.removeEventListener('input', change);
    for (const owner of owners.reverse()) owner.dispose(); root.remove();}
  return {update(next) {props = next; render();}, dispose};
  } catch (error) {
    disposed = true; unsubscribe(); picker?.dispose();
    for (const owner of owners.reverse()) {try {owner.dispose();} catch {}}
    root?.remove(); throw error;
  }
}
