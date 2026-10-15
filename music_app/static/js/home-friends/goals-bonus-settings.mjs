import {mountButton, mountChoice} from './native-controls.mjs';
import {createNativeLifetime} from './native-lifetime.mjs';
import {normalizeBonusValues} from './goals-provider.mjs';

const INCLUDE = 'Include random album from Album Tops';
const NO_SOURCES = 'Album Top sources are unavailable without your library. Saved settings and the captured bonus are kept.';
const FIELDS = ['enabled', 'source_mode', 'selected_top_refs', 'preferred_top_refs', 'album_mode', 'unfinished_policy'];
const valuesOf = settings => normalizeBonusValues(Object.fromEntries(FIELDS.map(key => [key, settings[key]])));
const modes = [['all_active', 'All active Tops'], ['selected', 'Selected Tops']];
const orders = [['next', 'Next unfinished in Top order'], ['random', 'Random unfinished album']];
const policies = [['carry', 'Carry into next period'], ['larger_period', 'Keep in existing larger periods']];

// This control always reflects persisted state. Activation only proposes a dialog.
// Gallery must never discover it through data-gallery-source.
export function mountGoalBonusSwitch(host, runtime, initial) {
  let disposed = false, props, revision = 0;
  const update = next => {
    if (disposed) return;
    const operation = ++revision;
    props = next;
    const holder = host.ownerDocument.createElement('span');
    const html = runtime.switchHtml({id: next.id || 'home-goals-bonus-switch', label: INCLUDE,
      checked: next.enabled === true, disabled: next.disabled === true});
    if (disposed || revision !== operation) return;
    holder.innerHTML = html;
    const rendered = holder.firstElementChild;
    if (!rendered || rendered.tagName !== 'BUTTON' || rendered.getAttribute('role') !== 'switch'
      || rendered.hasAttribute('data-gallery-source')) throw new TypeError('Goals requires the canonical native switch.');
    const current = host.firstElementChild;
    if (!current) host.append(rendered);
    else {
      if (current.tagName !== 'BUTTON') throw new TypeError('Goals switch host must be dedicated.');
      for (const attr of [...current.attributes]) if (!rendered.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      for (const attr of [...rendered.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      if (current.innerHTML !== rendered.innerHTML) current.innerHTML = rendered.innerHTML;
    }
  };
  const click = event => {
    const button = host.firstElementChild;
    if (!disposed && event.target.closest?.('button') === button && !button.disabled
      && button.getAttribute('aria-disabled') !== 'true') props.onClick?.(event);
  };
  const dispose = () => {if (disposed) return; disposed = true; revision++; host.removeEventListener('click', click); host.replaceChildren(); props = null;};
  try {update(initial); host.addEventListener('click', click);} catch (error) {dispose(); throw error;}
  return {element: host, update(next) {try {update(next);} catch (error) {dispose(); throw error;}}, dispose};
}

// Parent mounts this child through openNativeDialog and owns all durable writes.
// expected is one immutable {data, settings, bonus, period} controller identity.
export function mountGoalBonusSettings(host, runtime, initial) {
  const life = createNativeLifetime(), doc = host.ownerDocument, expected = initial.expected;
  const saved = valuesOf(expected.settings);
  let draft = {...saved, selected_top_refs: [...saved.selected_top_refs], preferred_top_refs: [...saved.preferred_top_refs],
    enabled: typeof initial.proposedEnabled === 'boolean' ? initial.proposedEnabled : saved.enabled};
  let source = {sourceProvider: initial.sourceProvider, sourceScope: initial.sourceScope, sourceCurrent: initial.sourceCurrent};
  let sourceRetired = false, sequence = 0, active = null, directory = [], sourceStatus = 'idle', sourceMessage = '';
  let rows = [], submitted = false, closed = false, message = '', rendering = false, queuedRender = false, formRevision = 0;
  let sourceChoice, albumChoice, policyChoice, cancel, save, draw, retry;
  const make = (parent, tag, text = '') => {const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node;};
  const root = make(host, 'div'); root.className = 'tag-editor-form';
  life.defer(() => root.remove());
  const form = make(root, 'form'); form.className = 'tag-editor-form'; form.setAttribute('aria-label', 'Bonus album settings');
  const enabledLabel = make(form, 'label'); enabledLabel.className = 'selection-accent-toggle';
  const enabled = make(enabledLabel, 'input'); enabled.type = 'checkbox'; enabled.setAttribute('aria-label', INCLUDE); make(enabledLabel, 'span', INCLUDE);
  make(form, 'p', 'Disabling selection keeps the captured album and history.').className = 'home-friends__muted';
  const sourceChoiceHost = make(form, 'span'), sourceHelp = make(form, 'p'), sourceRows = make(form, 'div');
  sourceHelp.setAttribute('role', 'status'); sourceRows.setAttribute('aria-label', 'Album Top source choices');
  const retained = make(form, 'p'), retryHost = make(form, 'span'); retained.className = 'home-friends__muted';
  make(form, 'p', 'Preferred Tops are three times as likely to be chosen; then an album is chosen within that Top.').className = 'home-friends__muted';
  make(form, 'p', 'Choose up to 100 selected Tops and up to 100 preferred Tops. All active Tops stays a dynamic source rule.').className = 'home-friends__muted';
  const albumChoiceHost = make(form, 'span'), policyChoiceHost = make(form, 'span');
  make(form, 'p', 'At the end of the year, unfinished albums carry into the next year.').className = 'home-friends__muted';
  const error = make(form, 'p'); error.setAttribute('role', 'alert');
  const bonusHelp = make(form, 'p'); bonusHelp.className = 'home-friends__muted';
  const actions = make(form, 'div'), cancelHost = make(actions, 'span'), saveHost = make(actions, 'span'), drawHost = make(actions, 'span');

  function snapshotMatches(snapshot) {
    return snapshot?.status === 'ready' && snapshot.mutation === 'idle' && snapshot.bonusStatus === 'ready'
      && snapshot.data === expected.data && snapshot.settings === expected.settings && snapshot.bonus === expected.bonus
      && snapshot.period === expected.period && snapshot.data?.allowed_actions.can_add === true;
  }
  function current() {
    if (life.disposed || closed || !snapshotMatches(initial.controller.getSnapshot())) return false;
    try {if (initial.isCurrent() !== true) return false;} catch {return false;}
    return !life.disposed && !closed && snapshotMatches(initial.controller.getSnapshot());
  }
  function sourceCurrent() {
    if (sourceRetired || !source.sourceProvider || typeof source.sourceProvider.list !== 'function'
      || typeof source.sourceScope !== 'string' || !source.sourceScope) return false;
    const captured = source;
    try {if (captured.sourceCurrent?.() !== true) return false;} catch {return false;}
    return current() && !sourceRetired && source === captured;
  }
  function abortSources() {sequence++; const request = active; active = null; request?.abort();}
  function disposeRows() {for (const row of rows.splice(0)) row.life.dispose();}
  function clearSources(text, retire = false) {
    abortSources(); if (retire) sourceRetired = true;
    directory = []; disposeRows(); sourceStatus = 'unavailable'; sourceMessage = text;
    draft = {...draft, source_mode: saved.source_mode, selected_top_refs: [...saved.selected_top_refs], preferred_top_refs: [...saved.preferred_top_refs]};
    formRevision++;
  }
  function dispose() {
    if (life.disposed) return;
    closed = true; abortSources(); directory = []; source = {}; draft = null;
    life.dispose();
  }
  function close(stale = false) {
    if (closed || life.disposed) return;
    dispose(); initial.onClose?.(stale ? {restoreFocus: false, reason: 'stale'} : undefined);
  }
  function ensureCurrent() {if (current()) return true; close(true); return false;}
  function sourceReady() {
    if (!sourceCurrent()) {if (!sourceRetired) clearSources(NO_SOURCES, true); return false;}
    return sourceStatus === 'ready';
  }
  function values() {
    return normalizeBonusValues({...draft, selected_top_refs: draft.source_mode === 'all_active' ? [] : draft.selected_top_refs});
  }
  function dirty() {return JSON.stringify(values()) !== JSON.stringify(saved);}
  function editableSources() {return ensureCurrent() && !submitted && sourceReady();}
  function edit(key, value) {
    if (!ensureCurrent() || submitted) return;
    draft = {...draft, [key]: value}; message = ''; formRevision++; render();
  }
  function changeMode(value) {
    if (!editableSources() || !modes.some(row => row[0] === value)) {render(); return;}
    const selected = value === 'selected' ? [...new Set([...draft.selected_top_refs, ...draft.preferred_top_refs])] : draft.selected_top_refs;
    if (selected.length > 100) {message = 'Choose at most 100 selected Tops.'; render(); return;}
    draft = {...draft, source_mode: value, selected_top_refs: selected}; message = ''; formRevision++; render();
  }
  function toggle(row, kind, checked) {
    if (!editableSources() || !rows.includes(row) || kind === 'selected' && draft.source_mode !== 'selected') {render(); return;}
    const key = kind === 'selected' ? 'selected_top_refs' : 'preferred_top_refs', existing = draft[key].includes(row.ref);
    if (checked === existing) return;
    if (checked && (!row.available || draft[key].length >= 100
      || kind === 'preferred' && draft.source_mode === 'selected' && !draft.selected_top_refs.includes(row.ref))) {render(); return;}
    const next = checked ? [...draft[key], row.ref] : draft[key].filter(ref => ref !== row.ref);
    draft = {...draft, [key]: next};
    if (kind === 'selected' && !checked && draft.source_mode === 'selected') draft.preferred_top_refs = draft.preferred_top_refs.filter(ref => ref !== row.ref);
    message = ''; formRevision++; render();
  }
  function buildRows() {
    disposeRows();
    const entries = directory.filter(row => row.allowed_actions?.can_read === true && row.top_viewer_overlay?.activity?.active === true);
    const shown = new Set(entries.map(row => row.top_ref));
    const unavailable = [...new Set([...saved.selected_top_refs, ...saved.preferred_top_refs])].filter(ref => !shown.has(ref));
    for (const entry of [...entries.map(row => ({ref: row.top_ref, title: row.title, available: true})),
      ...unavailable.map((ref, index) => ({ref, title: `Unavailable saved Top ${index + 1}`, available: false}))]) {
      if (!current() || !sourceCurrent()) return;
      const rowLife = createNativeLifetime(), node = make(sourceRows, 'div'), row = {...entry, life: rowLife};
      rowLife.defer(() => node.remove()); rows.push(row);
      make(node, 'span', entry.title);
      for (const kind of ['selected', 'preferred']) {
        const label = make(node, 'label'); label.className = 'selection-accent-toggle';
        const input = make(label, 'input'); input.type = 'checkbox';
        input.setAttribute('aria-label', `${kind === 'selected' ? 'Include' : 'Prefer'} ${entry.title}`);
        make(label, 'span', kind === 'selected' ? 'Selected' : 'Preferred');
        const changed = () => toggle(row, kind, input.checked === true);
        input.addEventListener('change', changed); rowLife.defer(() => input.removeEventListener('change', changed));
        row[kind] = input; row[`${kind}Label`] = label;
      }
    }
  }
  function render() {
    if (rendering) {queuedRender = true; return;}
    rendering = true;
    try {do {queuedRender = false; renderFrame();} while (queuedRender && current());}
    finally {rendering = false;}
  }
  function renderFrame() {
    if (!ensureCurrent()) return;
    const sourcesReady = sourceReady();
    if (!ensureCurrent()) return;
    const revision = formRevision;
    const checkpoint = () => {
      if (!ensureCurrent()) return false;
      if (sourceStatus === 'ready' && !sourceCurrent()) {clearSources(NO_SOURCES, true); queuedRender = true; return false;}
      if (formRevision !== revision) {queuedRender = true; return false;}
      return true;
    };
    enabled.checked = draft.enabled; enabled.disabled = submitted;
    sourceChoice.update({label: 'Sources', options: modes, value: draft.source_mode, disabled: submitted || !sourcesReady, onChange: changeMode}); if (!checkpoint()) return;
    sourceHelp.textContent = sourceStatus === 'loading' ? 'Loading Album Top sources…' : sourceStatus === 'ready'
      ? 'Only currently active, readable Tops are offered. Availability is checked again when adding a bonus album.' : sourceMessage || NO_SOURCES;
    sourceRows.hidden = !sourcesReady;
    const unavailableCount = sourceStatus === 'ready' ? rows.filter(row => !row.available).length
      : new Set([...draft.selected_top_refs, ...draft.preferred_top_refs]).size;
    retained.textContent = unavailableCount ? `${unavailableCount} unavailable saved ${unavailableCount === 1 ? 'Top is' : 'Tops are'} retained. Saved choices are not removed by a failed or incomplete directory.` : '';
    for (const row of rows) {
      const selected = draft.selected_top_refs.includes(row.ref), preferred = draft.preferred_top_refs.includes(row.ref);
      row.selectedLabel.hidden = draft.source_mode !== 'selected'; row.selected.checked = selected; row.preferred.checked = preferred;
      row.selected.disabled = submitted || !sourcesReady || !selected && (!row.available || draft.selected_top_refs.length >= 100);
      row.preferred.disabled = submitted || !sourcesReady || !preferred && (!row.available || draft.preferred_top_refs.length >= 100
        || draft.source_mode === 'selected' && !selected);
    }
    retryHost.hidden = sourceRetired || sourceStatus !== 'unavailable';
    retry.update({label: 'Retry sources', disabled: submitted || sourceRetired, onClick: () => {if (ensureCurrent() && !submitted) void loadSources();}}); if (!checkpoint()) return;
    albumChoice.update({label: 'Album choice', options: orders, value: draft.album_mode, disabled: submitted,
      onChange: value => {if (orders.some(row => row[0] === value)) edit('album_mode', value);}}); if (!checkpoint()) return;
    policyChoice.update({label: 'Unfinished bonus', options: policies, value: draft.unfinished_policy, disabled: submitted,
      onChange: value => {if (policies.some(row => row[0] === value)) edit('unfinished_policy', value);}}); if (!checkpoint()) return;
    error.textContent = message;
    bonusHelp.textContent = expected.bonus.bonus !== null ? expected.bonus.bonus.present
      ? 'This week already has a captured bonus album.' : 'This week’s captured bonus was removed. It cannot be drawn again in this cycle.'
      : !saved.enabled ? 'Save enabled settings first, then reopen settings to add a bonus album.'
        : dirty() ? 'Save changes first, then reopen settings to add a bonus album.'
          : 'Add weekly bonus album is a separate action using saved settings. Saving settings never draws an album.';
    save.update({label: 'Save', variant: 'primary', disabled: submitted, onClick: saveChanges}); if (!checkpoint()) return;
    draw.update({label: 'Add weekly bonus album', disabled: submitted || !sourcesReady || !saved.enabled || expected.bonus.bonus !== null || dirty(), onClick: addBonus});
  }
  function commit(callback, payload) {
    if (!ensureCurrent() || submitted) return;
    submitted = true; formRevision++; render();
    if (!ensureCurrent()) return;
    // No retries and no rearming on a callback failure: the controller owns
    // receipt recovery and whether the action may safely be submitted again.
    const failed = () => {if (current()) {message = 'The action could not be confirmed. Close settings and check Goals before trying again.'; render();}};
    try {const result = callback?.(...payload); Promise.resolve(result).catch(failed);} catch {failed();}
  }
  function saveChanges() {
    if (!ensureCurrent() || submitted) return;
    sourceReady(); if (!ensureCurrent()) return;
    try {values();} catch {message = 'These settings could not be saved. Check the source choices.'; render(); return;}
    commit(() => {
      sourceReady(); if (!current()) return;
      // Rendering may retire source authority; never persist the earlier source draft.
      return initial.onSave?.(values(), expected);
    }, []);
  }
  function addBonus() {
    if (!ensureCurrent() || submitted || !sourceReady() || !saved.enabled || expected.bonus.bonus !== null || dirty()) {render(); return;}
    // Check again after the canonical render boundary and before delegation.
    commit((captured) => {if (sourceCurrent() && current()) return initial.onDraw?.(captured);}, [expected]);
  }
  async function loadSources() {
    if (!ensureCurrent() || submitted) return;
    if (!sourceCurrent()) {clearSources(NO_SOURCES, true); render(); return;}
    abortSources(); const request = new AbortController(), token = sequence, captured = source; active = request;
    sourceStatus = 'loading'; sourceMessage = ''; directory = []; disposeRows(); formRevision++; render();
    const valid = () => !request.signal.aborted && token === sequence && source === captured && current() && sourceCurrent();
    if (!valid()) return;
    try {
      const result = await captured.sourceProvider.list({scopeKey: captured.sourceScope, signal: request.signal});
      if (!valid()) {if (current() && !sourceCurrent()) {clearSources(NO_SOURCES, true); render();} return;}
      active = null; directory = result.tops; sourceStatus = 'ready'; formRevision++; buildRows(); render();
    } catch {
      if (!valid()) {if (current() && !sourceCurrent()) {clearSources(NO_SOURCES, true); render();} return;}
      clearSources('Album Top sources could not be loaded. Saved source choices are kept.'); render();
    }
  }
  function updateSource(next = {}) {
    if (!ensureCurrent()) return;
    if (sourceRetired) return;
    if (next.sourceProvider !== source.sourceProvider || next.sourceScope !== source.sourceScope) clearSources(NO_SOURCES, true);
    else {source.sourceCurrent = next.sourceCurrent ?? source.sourceCurrent; if (!sourceCurrent()) clearSources(NO_SOURCES, true);}
    render();
  }
  try {
    sourceChoice = life.own(mountChoice(sourceChoiceHost, runtime, {label: 'Sources', options: modes, value: draft.source_mode, disabled: true}));
    albumChoice = life.own(mountChoice(albumChoiceHost, runtime, {label: 'Album choice', options: orders, value: draft.album_mode, disabled: true}));
    policyChoice = life.own(mountChoice(policyChoiceHost, runtime, {label: 'Unfinished bonus', options: policies, value: draft.unfinished_policy, disabled: true}));
    cancel = life.own(mountButton(cancelHost, runtime, {label: 'Cancel', onClick: () => close()}));
    save = life.own(mountButton(saveHost, runtime, {label: 'Save', variant: 'primary', disabled: true}));
    draw = life.own(mountButton(drawHost, runtime, {label: 'Add weekly bonus album', disabled: true}));
    retry = life.own(mountButton(retryHost, runtime, {label: 'Retry sources', disabled: true}));
    const changed = () => edit('enabled', enabled.checked === true), submit = event => event.preventDefault();
    enabled.addEventListener('change', changed); life.defer(() => enabled.removeEventListener('change', changed));
    form.addEventListener('submit', submit); life.defer(() => form.removeEventListener('submit', submit));
    life.defer(disposeRows);
    life.defer(initial.controller.subscribe(() => {if (!current()) close(true);}));
    render(); if (current()) void loadSources();
  } catch (errorValue) {dispose(); throw errorValue;}
  return {element: root, updateSource, dispose};
}
