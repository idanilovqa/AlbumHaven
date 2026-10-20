import {mountButton, mountChoice, mountNumericInput} from '../home-friends/native-controls.mjs';

const owners = new WeakMap();
const fields = [['minYear', 'Year from', 9999], ['maxYear', 'Year to', 9999],
  ['minRating', 'Rating from', 10], ['maxRating', 'Rating to', 10]];
const types = [['studio', 'Studio'], ['ep', 'EP'], ['live', 'Live'], ['demo', 'Demo'],
  ['compilation', 'Compilation'], ['single', 'Single']];
const numeric = filters => Object.fromEntries(fields.map(([key]) => [key, filters[key]]));
const signature = value => JSON.stringify(numeric(value));
let serial = 0;

export function mountScopedCreationFilterControls(host, runtime, options) {
  const {draft, isCurrent, onValidityChange} = options || {};
  if (!host?.ownerDocument || typeof isCurrent !== 'function'
    || onValidityChange !== undefined && typeof onValidityChange !== 'function'
    || !['getSnapshot', 'subscribe', 'setArtistFilters', 'resetArtistFilters'].every(key => typeof draft?.[key] === 'function')
    || !draft.getSnapshot()?.artistScope || !draft.getSnapshot()?.artistFilters
    || !['buttonHtml', 'openChoice', 'alertHtml'].every(key => typeof runtime?.[key] === 'function')) {
    throw new TypeError('Scoped creation filters require their current draft and native owners.');
  }
  const document = host.ownerDocument, root = document.createElement('div'), id = `artist-filters-${++serial}`;
  root.className = 'collection-filter-fields';
  const controls = [], inputs = new Map(), raw = {}, bad = {};
  let disposed = false, unsubscribe = null, rendering = false, pending = false, menu = null, menuEpoch = 0;
  let observed = null, ownExpected = null, validity = true, initialized = false;
  let release, include, reset, errorHost;
  const owned = () => !disposed && owners.get(host) === owner;
  const current = () => owned() && isCurrent() === true && owned();
  const editable = snapshot => current() && draft.getSnapshot() === snapshot && owned()
    && !snapshot.busy && !snapshot.denied && !snapshot.stale;
  const make = (tag = 'div') => {const node = document.createElement(tag); root.append(node); return node;};
  function hydrate(filters) {
    for (const [key] of fields) {raw[key] = filters[key] === null ? '' : String(filters[key]); bad[key] = false;}
  }
  function proposed() {
    const values = {};
    for (const [key, , maximum] of fields) {
      const text = raw[key];
      if (bad[key] || typeof text !== 'string' || text.trim() !== text || text !== '' && !/^[0-9]+$/.test(text)) return null;
      const value = text === '' ? null : Number(text);
      if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) return null;
      values[key] = value;
    }
    if (values.minYear !== null && values.maxYear !== null && values.minYear > values.maxYear
      || values.minRating !== null && values.maxRating !== null && values.minRating > values.maxRating) return null;
    return values;
  }
  function closeMenu() {menuEpoch++; const previous = menu; menu = null; previous?.close({restoreFocus: false});}
  function applyPatch(patch) {
    const snapshot = draft.getSnapshot();
    if (!editable(snapshot)) return false;
    const accepted = draft.setArtistFilters(patch) === true;
    if (owned()) update();
    return accepted;
  }
  function editNumber(key, value) {
    const snapshot = draft.getSnapshot();
    if (!editable(snapshot)) return;
    raw[key] = value; bad[key] = inputs.get(key)?.element.validity?.badInput === true;
    const proposal = proposed();
    if (proposal) {
      const expected = signature(proposal); ownExpected = expected;
      try {draft.setArtistFilters(proposal);} finally {if (ownExpected === expected) ownExpected = null;}
    }
    if (owned()) update();
  }
  function openRelease() {
    const snapshot = draft.getSnapshot();
    if (!editable(snapshot)) return;
    closeMenu();
    if (!editable(snapshot)) return;
    const epoch = menuEpoch, selected = snapshot.artistFilters.releaseTypes;
    const allowed = () => owned() && epoch === menuEpoch && editable(draft.getSnapshot());
    let next;
    next = runtime.openChoice(release.element.querySelector('button'), {
      label: 'Release types', selected: '', updateTriggerLabel: false, density: 'compact',
      formats: [{value: 'all', label: 'All types', kind: 'action'}, ...types.map(([value, label]) => ({
        value, label, kind: 'checkbox', checked: selected === null || selected.includes(value),
      }))],
      onSelect(value) {
        if (!allowed()) return false;
        if (value === 'all') return applyPatch({releaseTypes: null});
        if (!types.some(([key]) => key === value)) return false;
        const chosen = new Set(selected === null ? types.map(([key]) => key) : selected);
        if (chosen.has(value)) chosen.delete(value); else chosen.add(value);
        return applyPatch({releaseTypes: types.map(([key]) => key).filter(key => chosen.has(key))});
      }, onClose() {if (menu === next) menu = null;},
    });
    if (!allowed()) next?.close({restoreFocus: false}); else menu = next;
  }
  function resetFilters() {
    if (!editable(draft.getSnapshot())) return;
    if (draft.resetArtistFilters() !== true || !current()) return;
    const snapshot = draft.getSnapshot();
    hydrate(snapshot.artistFilters); observed = signature(snapshot.artistFilters); ownExpected = null;
    update();
  }
  function paint() {
    if (!owned()) return;
    const snapshot = draft.getSnapshot(), filters = snapshot.artistFilters;
    if (!owned()) return;
    const nextSignature = signature(filters);
    if (observed !== nextSignature) {
      if (nextSignature !== ownExpected) {hydrate(filters); ownExpected = null;}
      observed = nextSignature;
    }
    const enabled = editable(snapshot);
    if (!owned()) return;
    if (draft.getSnapshot() !== snapshot) {pending = true; return;}
    closeMenu();
    if (!owned()) return;
    for (const [key, label, maximum] of fields) {
      inputs.get(key).update({id: `${id}-${key}`, label, value: raw[key], min: 1, max: maximum,
        step: 1, disabled: !enabled, onChange: value => editNumber(key, value)});
      if (!owned()) return;
    }
    release.update({label: 'Release types', disabled: !enabled, onClick: openRelease});
    if (!owned()) return;
    include.update({label: 'Include rated albums', value: filters.includeRated ? 'yes' : 'no',
      options: [['yes', 'Yes'], ['no', 'No']], disabled: !enabled,
      onChange: value => {if (['yes', 'no'].includes(value)) applyPatch({includeRated: value === 'yes'});}});
    if (!owned()) return;
    const validNumbers = proposed() !== null;
    const dirty = !validNumbers || filters.releaseTypes !== null || !filters.includeRated
      || fields.some(([key]) => filters[key] !== null);
    reset.element.hidden = !dirty;
    reset.update({label: 'Reset', disabled: !enabled, onClick: resetFilters});
    if (!owned()) return;
    const html = validNumbers ? '' : runtime.alertHtml({severity: 'error', role: 'alert',
      message: 'Enter whole-number year and rating limits in range, with each minimum no greater than its maximum.'});
    if (!owned()) return;
    errorHost.innerHTML = html;
    const nextValidity = enabled && validNumbers;
    if (initialized && validity !== nextValidity) {validity = nextValidity; onValidityChange?.(validity);}
    else validity = nextValidity;
    initialized = true;
  }
  function update() {
    if (!owned()) return;
    pending = true;
    if (rendering) return;
    rendering = true;
    try {while (pending && owned()) {pending = false; paint();}}
    finally {rendering = false;}
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (owners.get(host) === owner) owners.delete(host);
    unsubscribe?.(); unsubscribe = null;
    try {closeMenu();} finally {
      for (const control of controls) {try {control.dispose();} catch { /* Retire every owned field. */ }}
      root.remove();
    }
  }
  const owner = Object.freeze({update, isValid() {
    if (!current()) return false;
    const snapshot = draft.getSnapshot();
    return editable(snapshot) && proposed() !== null && owned();
  }, dispose});
  function add(control) {controls.push(control); if (!owned()) control.dispose(); return control;}
  try {
    const initial = draft.getSnapshot(); hydrate(initial.artistFilters); observed = signature(initial.artistFilters);
    const previous = owners.get(host); owners.set(host, owner); previous?.dispose();
    if (!owned()) {dispose(); return owner;}
    host.append(root);
    for (const [key, label, maximum] of fields) {
      const labelNode = make('label'); labelNode.textContent = label; labelNode.setAttribute('for', `${id}-${key}`);
      const fieldHost = document.createElement('span'); labelNode.append(fieldHost);
      const field = add(mountNumericInput(fieldHost, {id: `${id}-${key}`, label, value: raw[key], min: 1, max: maximum,
        step: 1, disabled: true, onChange: value => editNumber(key, value)}));
      inputs.set(key, field); if (!owned()) {dispose(); return owner;}
    }
    release = add(mountButton(make(), runtime, {label: 'Release types', disabled: true, onClick: openRelease}));
    if (!owned()) {dispose(); return owner;}
    include = add(mountChoice(make(), runtime, {label: 'Include rated albums', value: 'yes',
      options: [['yes', 'Yes'], ['no', 'No']], disabled: true}));
    if (!owned()) {dispose(); return owner;}
    reset = add(mountButton(make(), runtime, {label: 'Reset', disabled: true, onClick: resetFilters}));
    if (!owned()) {dispose(); return owner;}
    errorHost = make(); unsubscribe = draft.subscribe(update);
    if (!owned()) {unsubscribe?.(); unsubscribe = null; return owner;}
    update(); return owner;
  } catch (error) {dispose(); throw error;}
}
