import {mountButton, mountChoice} from '../home-friends/native-controls.mjs';
import {albumTopImageGrid, albumTopImageRowSteps} from './image-export-layout.mjs';

// Feature content only. The native dialog, buttons, choices and trigger-surface
// registry retain their existing focus, dismissal and presentation ownership.
export function mountAlbumTopImageControls(host, runtime, {count, options, onChange, onDownload, onRetry, onCancel}) {
  const doc = host.ownerDocument, root = doc.createElement('div');
  root.className = 'album-top-image';
  const settingsHost = doc.createElement('div'), preview = doc.createElement('div'), status = doc.createElement('p'), actions = doc.createElement('div');
  settingsHost.className = 'album-top-image__settings'; preview.className = 'album-top-image__preview';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); actions.className = 'playlists__actions';
  root.append(settingsHost, preview, status, actions); host.replaceChildren(root);
  let settings = options, dead = false, popup = null;
  const cleanups = [], owners = [], fields = new Map();
  const listen = (node, event, callback, capture = false) => {node.addEventListener(event, callback, capture); cleanups.push(() => node.removeEventListener(event, callback, capture));};
  const change = patch => {if (!dead) onChange(patch);};
  const button = (parent, props) => {const slot = doc.createElement('span'); parent.append(slot); const owner = mountButton(slot, runtime, props); owners.push(owner); return owner;};
  function range(key, label, min, max) {
    const wrapper = doc.createElement('label'), text = doc.createElement('span'), input = doc.createElement('input'), output = doc.createElement('output');
    text.textContent = label; input.type = 'range'; input.setAttribute('min', String(min)); input.setAttribute('max', String(max)); input.setAttribute('step', '1'); input.setAttribute('aria-label', label);
    wrapper.append(text, input, output); settingsHost.append(wrapper); fields.set(key, {input, output});
    listen(input, 'input', () => {
      const value = Number(input.value); if (!Number.isSafeInteger(value)) return;
      if (key === 'height') change({columns: albumTopImageGrid(count, {rowIndex: value}).columns});
      else change({[key]: value});
    });
  }
  range('columns', 'Width', 1, 10); range('height', 'Height', 0, Math.max(0, albumTopImageRowSteps(count).length - 1)); range('frameWidth', 'Frame thickness', 1, 12);
  for (const [key, label] of [['showTitle','Title'],['showInfo','Info'],['showArtist','Artist'],['showAlbum','Album'],['showYear','Year'],['showNumber','Numbers'],['showOwnRating','Own rating'],['roundedCorners','Rounded corners']]) {
    const wrapper = doc.createElement('label'), input = doc.createElement('input'), text = doc.createElement('span');
    input.type = 'checkbox'; input.setAttribute('aria-label', label); text.textContent = label; wrapper.append(input, text); settingsHost.append(wrapper); fields.set(key, {input});
    listen(input, 'change', () => change({[key]: input.checked}));
  }
  const placementHost = doc.createElement('div'); settingsHost.append(placementHost);
  const placementProps = () => ({label: 'Number placement', value: settings.numberPlacement, options: [['on','On artwork'],['below','Below artwork']], onChange: value => change({numberPlacement: value})});
  const placement = mountChoice(placementHost, runtime, placementProps()); owners.push(placement);
  function closeColor(restore = true) {
    const old = popup; popup = null; if (!old) return;
    old.release?.(); for (const release of old.cleanups) release(); old.surface.remove();
    old.anchor.setAttribute('aria-expanded', 'false');
    if (restore && !dead && old.anchor.isConnected) old.anchor.focus({preventScroll: true});
  }
  function openColor(key, label, anchor) {
    if (popup?.anchor === anchor) {closeColor(); return;}
    closeColor(false);
    const surface = doc.createElement('div'), hex = doc.createElement('input'), spectrum = doc.createElement('input');
    surface.className = 'album-top-image__color-popup'; surface.setAttribute('role', 'group'); surface.setAttribute('aria-label', label);
    hex.type = 'text'; hex.setAttribute('aria-label', `${label} hex`); hex.value = settings[key];
    spectrum.type = 'color'; spectrum.setAttribute('aria-label', `${label} spectrum`); spectrum.value = settings[key];
    surface.append(hex, spectrum); root.append(surface);
    const record = {surface, anchor, cleanups: [], release: null}; popup = record;
    const bind = (node, event, fn, capture = false) => {node.addEventListener(event, fn, capture); record.cleanups.push(() => node.removeEventListener(event, fn, capture));};
    const current = () => popup === record && !dead && runtime.imageColorSurfaceCurrent?.(surface, anchor) === true;
    const update = event => {if (!current()) return; const value = event.target.value; if (/^#[0-9a-f]{6}$/i.test(value)) {hex.value = spectrum.value = value.toLowerCase(); change({[key]: value.toLowerCase()});}};
    bind(hex, 'input', update); bind(hex, 'change', update); bind(spectrum, 'input', update); bind(spectrum, 'change', update);
    bind(surface, 'keydown', event => {if (event.key === 'Escape' && current()) {event.preventDefault(); event.stopPropagation(); closeColor();}});
    bind(doc, 'pointerdown', event => {if (current() && !surface.contains(event.target) && !anchor.contains(event.target)) closeColor(false);});
    anchor.setAttribute('aria-expanded', 'true');
    try {
      record.release = runtime.bindImageColorSurface(surface, anchor, () => {if (popup === record) closeColor(false);});
      if (typeof record.release !== 'function') throw new Error('Unavailable color control');
      const box = anchor.getBoundingClientRect(), parent = root.getBoundingClientRect();
      surface.style.left = `${Math.max(0, box.left - parent.left)}px`; surface.style.top = `${Math.max(0, box.bottom - parent.top)}px`;
      hex.focus({preventScroll: true});
    } catch {closeColor(false); status.textContent = 'Color controls are unavailable. Try again.';}
  }
  for (const [key, label] of [['backgroundColor','Background color'],['textColor','Text color'],['frameColor','Frame color']]) {
    let owner; owner = button(settingsHost, {label, attributes: {'aria-haspopup':'true','aria-expanded':'false'}, onClick: event => openColor(key, label, event.target.closest('button'))});
  }
  const download = button(actions, {label:'Download',disabled:true,onClick:onDownload});
  const retry = button(actions, {label:'Try again',onClick:onRetry}); retry.element.hidden = true;
  button(actions, {label:'Cancel',onClick:onCancel});
  function update(next, presentation = {}) {
    if (dead) return; settings = next;
    const grid = count ? albumTopImageGrid(count, {columns: settings.columns}) : {columns:1,rows:0,rowIndex:0};
    for (const [key, record] of fields) {
      if (key === 'height') {record.input.value = String(grid.rowIndex); record.input.setAttribute('aria-valuetext', `${grid.rows} rows`); record.output.textContent = String(grid.rows);}
      else if (key === 'columns') {record.input.value = String(settings.columns); record.output.textContent = String(grid.columns);}
      else if (key === 'frameWidth') {record.input.value = String(settings.frameWidth); record.output.textContent = `${settings.frameWidth}px`;}
      else record.input.checked = settings[key];
      if (!count && (key === 'height' || key === 'columns')) record.input.disabled = true;
    }
    placement.update(placementProps());
    download.update({label:'Download',disabled:presentation.canDownload !== true,onClick:onDownload});
    retry.element.hidden = presentation.error !== true;
    status.textContent = [presentation.message || '', presentation.previous ? 'Previous preview' : ''].filter(Boolean).join(' · ');
  }
  update(settings);
  return {preview, update, dispose() {if (dead) return; dead = true; closeColor(false); for (const release of cleanups) release(); for (const owner of owners) owner.dispose(); root.remove();}};
}
