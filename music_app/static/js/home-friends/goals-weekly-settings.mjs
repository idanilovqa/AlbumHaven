import {mountWeeklyGoalsSheet} from './goals-weekly-sheet.mjs';
import {mountButton, mountChoice} from './native-controls.mjs';
import {WEEKLY_FILTERS, normalizeWeeklySettings, changeWeeklyCount, newWeeklyFilter} from './goals-weekly-settings-model.mjs';

// Mounted by the shared native modal owner: it owns dismissal, focus, and the mobile sheet.
export function mountWeeklyGoalsSettings(host, runtime, options) {
  const doc = host.ownerDocument, owners = [], rowOwners = [], requests = new Set(), previewRequests = new Set();
  let disposed = false, retired = false, draft, revision, directory, previewEpoch = 0, saving = false, addMenu, lastSave, sheet;
  const valid = () => !disposed && !retired && options.isCurrent() === true;
  const make = (parent, tag, text = '', className = '') => {
    const node = doc.createElement(tag); node.textContent = text; node.className = className; parent.append(node); return node;
  };
  const root = make(host, 'div', '', 'weekly-goals-settings');
  const shell = host.closest('.confirm-modal-dialog'); shell?.classList.add('weekly-goals-settings-dialog');
  const notice = make(root, 'p', 'Loading settings…'); notice.setAttribute('role', 'status');
  const layout = make(root, 'div', '', 'weekly-goals-settings__layout'); layout.hidden = true;
  const form = make(layout, 'form', '', 'weekly-goals-settings__form tag-editor-form'); form.setAttribute('aria-label', 'Weekly Goals settings');
  const controls = make(form, 'fieldset'); controls.className = 'weekly-goals-settings__controls';
  const section = title => {const node = make(controls, 'section', '', 'weekly-goals-settings__section'); make(node, 'h4', title); return node;};
  const counts = section('Albums per week');
  const fields = {};
  function number(parent, label, value, min, max, change) {
    const line = make(parent, 'label', '', 'weekly-goals-settings__field'); make(line, 'span', label);
    const input = make(line, 'input'); input.type = 'number'; input.min = String(min); input.max = String(max);
    input.step = '1'; input.value = String(value); input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {if (valid() && !saving) change(Number(input.value), input);});
    return input;
  }
  fields.manual_count = number(counts, 'Your picks', 5, 0, 7, (value, input) => count('manual_count', value, input));
  fields.suggestion_count = number(counts, 'Suggestions', 1, 0, 7, (value, input) => count('suggestion_count', value, input));
  const total = make(counts, 'p', '', 'home-friends__muted');
  const limits = section('Your pick limits');
  make(limits, 'p', 'Each limit is a maximum, not a required number.', 'home-friends__muted');
  const rows = make(limits, 'div'), addHost = make(limits, 'span');
  const suggestions = section('Suggestions'), sources = make(suggestions, 'div', '', 'weekly-goals-settings__sources');
  sources.setAttribute('role', 'group'); sources.setAttribute('aria-label', 'Pick from');
  const sourceButtons = [];
  for (const [source, label] of [['tops', 'Album Tops'], ['playthroughs', 'Playthroughs'], ['library', 'My library']]) {
    const button = make(sources, 'button', '', 'ui-filter-pill'); button.type = 'button';
    make(button, 'span', label, 'ui-filter-pill__label'); sourceButtons.push([source, button]);
    button.addEventListener('click', () => {
      if (!valid() || saving || !draft) return;
      draft = {...draft, sources: draft.sources.includes(source) ? draft.sources.filter(value => value !== source) : [...draft.sources, source]}; changed();
    });
  }
  const selectionHost = make(suggestions, 'span');
  const switches = [];
  function toggle(key, label) {
    const holder = make(suggestions, 'span');
    const render = () => {
      const temp = doc.createElement('span');
      temp.innerHTML = runtime.switchHtml({label, checked: draft?.[key] === true, disabled: saving || !draft});
      const next = temp.firstElementChild, current = holder.firstElementChild;
      if (!current) holder.append(next);
      else {
        for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of [...next.attributes]) current.setAttribute(attr.name, attr.value);
      }
    };
    holder.addEventListener('click', event => {
      if (valid() && !saving && draft && event.target.closest('button') === holder.firstElementChild) {
        draft = {...draft, [key]: !draft[key]}; changed();
      }
    });
    switches.push(render); render();
  }
  toggle('prefer_preferences', 'Prefer my chosen genres and years');
  toggle('discover', 'Explore outside my usual genres');
  toggle('prefer_nearly_finished', 'Prioritize nearly finished Tops');
  const families = make(suggestions, 'details'); make(families, 'summary', 'Preferred Playthroughs');
  const familyRows = make(families, 'div', '', 'weekly-goals-settings__sources');
  const preview = make(layout, 'aside', '', 'weekly-goals-settings__preview'); preview.setAttribute('aria-label', 'Example week');
  make(preview, 'h4', 'Example week');
  const previewStatus = make(preview, 'p', '', 'home-friends__muted'); previewStatus.setAttribute('role', 'status');
  const covers = make(preview, 'div', '', 'weekly-goals-settings__covers'), titles = make(preview, 'ol', '', 'weekly-goals-settings__titles');
  const summary = make(preview, 'div', '', 'weekly-goals-settings__summary');
  const footer = make(root, 'div', '', 'weekly-goals-settings__footer');
  const error = make(footer, 'p'); error.setAttribute('role', 'alert');
  const retryHost = make(footer, 'span'), cancelHost = make(footer, 'span'), saveHost = make(footer, 'span'), drawHost = make(footer, 'span');
  const retry = mountButton(retryHost, runtime, {label: 'Retry', onClick: () => void load()}); owners.push(retry); retryHost.hidden = true;
  owners.push(mountButton(cancelHost, runtime, {label: 'Cancel', onClick: () => options.onClose()}));
  const save = mountButton(saveHost, runtime, {label: 'Save', variant: 'primary', disabled: true, onClick: () => void submit()}); owners.push(save);
  const draw = mountButton(drawHost, runtime, {label: 'Add suggestions', disabled: true, onClick: confirmDraw}); owners.push(draw);
  drawHost.hidden = typeof options.onDraw !== 'function';
  const selection = mountChoice(selectionHost, runtime, {label: 'Choose by', value: 'random',
    options: [['popular', 'Popular'], ['random', 'Random'], ['position', 'Position in Top']], onChange: value => editSelection(value)}); owners.push(selection);
  const add = mountButton(addHost, runtime, {label: 'Add filter', disabled: true, onClick: () => openFilterMenu()}); owners.push(add);
  const retire = () => {
    if (disposed || retired) return;
    retired = true; previewEpoch++;
    for (const controller of requests) controller.abort();
    sheet?.dispose(); root.replaceChildren(); options.onClose({restoreFocus: false});
  };
  const stop = options.provider.subscribe?.(retire), stopSource = options.subscribeSources?.(retire);
  form.addEventListener('submit', event => {event.preventDefault(); void submit();});

  function editSelection(value) {if (valid() && !saving && draft) {draft = {...draft, selection: value}; changed();}}
  function count(key, value, input) {
    draft = changeWeeklyCount(draft, key, value); input.value = String(draft[key]); renderFilters(); changed();
  }
  function openFilterMenu() {
    if (!valid() || saving || !draft) return;
    addMenu?.close({restoreFocus: false});
    addMenu = runtime.openChoice(addHost.firstElementChild, {label: 'Add filter', updateTriggerLabel: false,
      formats: WEEKLY_FILTERS.map(([value, label]) => ({value, label, disabled: !newWeeklyFilter(draft, value, directory.genres)})),
      onSelect: kind => {
        if (!valid() || saving) return;
        const row = newWeeklyFilter(draft, kind, directory.genres);
        if (row) {draft = {...draft, filters: [...draft.filters, row]}; renderFilters(); changed();}
      }});
  }
  function renderFilters() {
    rowOwners.splice(0).forEach(owner => owner.dispose()); rows.replaceChildren();
    draft.filters.forEach((row, index) => {
      const line = make(rows, 'div', '', 'weekly-goals-settings__filter');
      const label = WEEKLY_FILTERS.find(([kind]) => kind === row.kind)[1];
      const patch = values => {if (valid() && !saving) {draft = {...draft, filters: draft.filters.map((item, slot) => slot === index ? {...item, ...values} : item)}; changed();}};
      if (row.kind === 'genre') {
        const choiceHost = make(line, 'span'); rowOwners.push(mountChoice(choiceHost, runtime, {label: 'Genre', value: row.value,
          options: [...new Set([row.value, ...directory.genres])].map(value => [value, value]), onChange: value => patch({value})}));
      } else number(line, label, row.value, 1, 9999, (value, input) => {
        if (!Number.isInteger(value) || value < 1 || value > 9999 || row.kind === 'decade' && value % 10) {input.value = String(draft.filters[index].value); return;}
        patch({value});
      });
      number(line, 'At most', row.maximum, 0, draft.manual_count, (maximum, input) => {
        if (!Number.isInteger(maximum) || maximum < 0 || maximum > draft.manual_count) {input.value = String(draft.filters[index].maximum); return;}
        patch({maximum});
      });
      const removeHost = make(line, 'span'); rowOwners.push(mountButton(removeHost, runtime, {label: `Remove ${label} limit`, icon: 'close',
        onClick: () => {if (valid() && !saving) {draft = {...draft, filters: draft.filters.filter((_, slot) => slot !== index)}; renderFilters(); changed();}}}));
    });
  }
  function renderControls() {
    if (!valid() || !draft) return;
    controls.disabled = saving;
    for (const key of ['manual_count', 'suggestion_count']) {
      fields[key].value = String(draft[key]); fields[key].max = String(7 - draft[key === 'manual_count' ? 'suggestion_count' : 'manual_count']);
    }
    total.textContent = `${draft.manual_count + draft.suggestion_count} of 7 albums`;
    for (const [source, button] of sourceButtons) button.setAttribute('aria-pressed', String(draft.sources.includes(source)));
    switches.forEach(render => render());
    selection.update({label: 'Choose by', value: draft.selection, disabled: saving,
      options: [['popular', 'Popular'], ['random', 'Random'], ['position', 'Position in Top']], onChange: editSelection});
    add.update({label: 'Add filter', disabled: saving || draft.filters.length >= 30, onClick: openFilterMenu});
    let good = true; try {normalizeWeeklySettings(draft);} catch {good = false;}
    error.textContent = good ? '' : !draft.sources.length && draft.suggestion_count ? 'Choose at least one source for suggestions.' : 'Check your limits. Each filter must be unique and within your pick count.';
    const dirty = good && JSON.stringify(normalizeWeeklySettings(draft)) !== JSON.stringify(normalizeWeeklySettings(directory.settings));
    draw.update({label: 'Add suggestions', disabled: saving || !good || dirty || draft.suggestion_count === 0,
      title: dirty ? 'Save your settings before adding suggestions' : 'Add this week’s suggestions to Goals', onClick: confirmDraw});
    save.update({label: saving ? 'Saving…' : 'Save', variant: 'primary', disabled: saving || !good, onClick: () => void submit()});
  }
  function confirmDraw() {
    if (!valid() || saving || !draft || !directory || typeof options.onDraw !== 'function') return;
    let values; try {values = normalizeWeeklySettings(draft);} catch {return;}
    if (!values.suggestion_count || JSON.stringify(values) !== JSON.stringify(normalizeWeeklySettings(directory.settings))) return;
    options.onDraw(revision);
  }
  function changed() {renderControls(); void refreshPreview();}
  async function request(action, isPreview = false) {
    const controller = new AbortController(); requests.add(controller); if (isPreview) previewRequests.add(controller);
    try {return await action({signal: controller.signal, isCurrent: valid});}
    finally {requests.delete(controller); previewRequests.delete(controller);}
  }
  async function load() {
    if (!valid()) return;
    retryHost.hidden = true; notice.hidden = false; notice.textContent = 'Loading settings…';
    try {
      const result = await request(extra => options.provider.readWeeklySettings(extra));
      if (!valid()) return;
      directory = result; draft = normalizeWeeklySettings(result.settings); revision = result.settings_revision;
      familyRows.replaceChildren();
      for (const family of result.playthroughs) {
        const button = make(familyRows, 'button', '', 'ui-filter-pill'); button.type = 'button';
        make(button, 'span', family.title, 'ui-filter-pill__label');
        button.setAttribute('aria-pressed', String(draft.preferred_playthrough_refs.includes(family.top_ref)));
        button.addEventListener('click', () => {if (valid() && !saving) {
          const selected = draft.preferred_playthrough_refs.includes(family.top_ref);
          if (!selected && draft.preferred_playthrough_refs.length >= 100) return;
          const refs = draft.preferred_playthrough_refs.filter(ref => ref !== family.top_ref);
          draft = {...draft, preferred_playthrough_refs: selected ? refs : [...refs, family.top_ref]};
          button.setAttribute('aria-pressed', String(!selected)); changed();
        }});
      }
      if (!result.playthroughs.length) make(familyRows, 'p', 'No active Playthroughs.', 'home-friends__muted');
      notice.hidden = true; layout.hidden = false; renderFilters(); changed();
    } catch (failure) {if (valid() && failure.name !== 'AbortError') {notice.textContent = failure.code === 'weekly_settings_schema_unavailable' ? 'Weekly Goals settings need a server update before they can be used.' : 'Settings could not be loaded.'; retryHost.hidden = false;}}
  }
  async function refreshPreview() {
    const epoch = ++previewEpoch;
    for (const controller of previewRequests) controller.abort(); previewRequests.clear();
    covers.replaceChildren(); titles.replaceChildren(); summary.replaceChildren();
    let settings; try {settings = normalizeWeeklySettings(draft);} catch {previewStatus.textContent = ''; return;}
    previewStatus.textContent = 'Updating example…';
    try {
      const value = await request(extra => options.provider.previewWeeklySettings({settings}, {...extra, isCurrent: () => valid() && epoch === previewEpoch}), true);
      if (!valid() || epoch !== previewEpoch) return;
      previewStatus.textContent = value.albums.length ? '' : 'No eligible albums in your selected sources.';
      for (const album of value.albums) {
        const name = `${album.release_year ?? '—'} – ${album.artist_display} – ${album.title}`;
        const card = make(covers, 'div', '', 'weekly-goals-settings__cover'); card.tabIndex = 0;
        card.setAttribute('aria-label', `${name}${album.suggested ? ' · Suggestion' : ''}`);
        if (album.suggested) card.classList.add('weekly-goals-settings__cover--suggested');
        if (album.cover_url) {const img = make(card, 'img'); img.src = album.cover_url; img.alt = ''; img.loading = 'lazy';}
        else make(card, 'span', album.title);
        make(titles, 'li', name);
      }
      for (const text of value.summary) make(summary, 'p', text);
      const missing = [];
      if (value.evidence_gaps?.includes('broad_genres') && draft.filters.some(row => row.kind === 'genre')) missing.push('genre matching');
      if (value.evidence_gaps?.includes('listening_taste') && draft.discover) missing.push('outside-your-taste discovery');
      if (value.evidence_gaps?.includes('album_popularity') && draft.selection === 'popular') missing.push('popularity ranking');
      if (missing.length) make(summary, 'p', `Not available in this preview: ${missing.join(', ')}.`, 'home-friends__muted');
    } catch (failure) {if (valid() && epoch === previewEpoch && failure.name !== 'AbortError') previewStatus.textContent = 'Example could not be loaded.';}
  }
  async function submit() {
    if (!valid() || saving || !draft) return;
    let settings; try {settings = normalizeWeeklySettings(draft);} catch {renderControls(); return;}
    const signature = JSON.stringify({settings_revision: revision, settings});
    if (lastSave?.signature !== signature) lastSave = {signature, command: {request_key: doc.defaultView.crypto.randomUUID(), settings_revision: revision, settings}};
    saving = true; renderControls();
    try {
      await request(extra => options.provider.saveWeeklySettings(lastSave.command, extra));
      if (valid()) options.onClose();
    } catch (failure) {if (valid() && failure.name !== 'AbortError') {saving = false; renderControls(); error.textContent = failure.code === 'weekly_settings_schema_unavailable' ? 'This server needs the Weekly Goals settings update before settings can be saved.' : 'Settings could not be saved. Retry to check the same request.';}}
  }
  sheet = mountWeeklyGoalsSheet(host, runtime, {isCurrent: valid, onClose: options.onClose});
  void load();
  return {dispose() {
    if (disposed) return; disposed = true; previewEpoch++; stop?.(); stopSource?.(); addMenu?.close({restoreFocus: false});
    for (const controller of requests) controller.abort(); requests.clear();
    sheet?.dispose(); rowOwners.splice(0).forEach(owner => owner.dispose()); owners.reverse().forEach(owner => owner.dispose());
    shell?.classList.remove('weekly-goals-settings-dialog'); root.remove(); draft = null; directory = null; lastSave = null;
  }};
}
