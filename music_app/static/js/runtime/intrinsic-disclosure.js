/* Intrinsic disclosure owns only visibility, toggle semantics and its listeners.
   Consumers retain the member DOM, semantic state and independent header actions. */
let intrinsicDisclosurePanelSequence = 0;
function createIntrinsicDisclosure({members = [], collapsed = {}, enabled = true, onToggle} = {}) {
  let disposed = false, active = Boolean(enabled), records = new Map(), generation = 0;
  const current = operation => operation === generation;
  let choices = new Map(Object.entries(collapsed || {}).map(([key, value]) => [key, Boolean(value)]));

  function own(record, element, name, value) {
    let attributes = record.attributes.get(element);
    if (!attributes) {attributes = new Map(); record.attributes.set(element, attributes);}
    const current = element.getAttribute(name);
    let attribute = attributes.get(name);
    if (!attribute) {
      attribute = {original: current, written: current};
      attributes.set(name, attribute);
    } else if (current !== attribute.written) {
      // A consumer changed this attribute since our last write. Preserve that
      // new baseline too, rather than overwriting it during eventual release.
      attribute.original = current;
    }
    if (current !== value) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
    attribute.written = value;
  }

  function release(record, operation) {
    if (!current(operation)) return false;
    if (record.listening) record.toggle.removeEventListener('click', record.click);
    record.listening = false;
    const visibility = record.attributes.get(record.panel);
    const willConceal = ['hidden', 'inert'].some(name => {
      const attribute = visibility?.get(name);
      return attribute && attribute.original !== null && record.panel.getAttribute(name) === attribute.written;
    });
    if (willConceal && record.panel.contains(record.panel.ownerDocument.activeElement)) {
      record.toggle.focus({preventScroll: true});
      // Focus listeners may renew this exact record or install a replacement.
      // Never restore/clear leases or remove handlers owned by that successor.
      if (!current(operation)) return false;
    }
    for (const [element, attributes] of record.attributes) {
      for (const [name, attribute] of attributes) {
        if (element.getAttribute(name) !== attribute.written) continue;
        if (attribute.original === null) element.removeAttribute(name);
        else element.setAttribute(name, attribute.original);
      }
    }
    record.attributes.clear();
    return true;
  }

  function panelId(record) {
    if (record.panel.id) return record.panel.id;
    const document = record.panel.ownerDocument;
    if (!record.generatedId || document.getElementById(record.generatedId)) {
      do {record.generatedId = `intrinsic-disclosure-panel-${++intrinsicDisclosurePanelSequence}`;}
      while (document.getElementById(record.generatedId));
    }
    own(record, record.panel, 'id', record.generatedId);
    return record.generatedId;
  }

  function apply(operation) {
    if (!current(operation) || !active || disposed) return false;
    // Choose the outermost collapsing member first, regardless of input order.
    // Its own toggle stays outside the panel that is about to conceal focus.
    const focusTargets = new Map();
    for (const record of records.values()) {
      const document = record.panel.ownerDocument;
      if (!choices.get(record.key) || !record.panel.contains(document.activeElement)) continue;
      const previous = focusTargets.get(document);
      if (!previous || record.panel.contains(previous.panel)) focusTargets.set(document, record);
    }
    for (const record of focusTargets.values()) {
      record.toggle.focus({preventScroll: true});
      if (!current(operation) || !active || disposed) return false;
    }
    for (const record of records.values()) {
      const closed = Boolean(choices.get(record.key));
      own(record, record.toggle, 'aria-controls', panelId(record));
      own(record, record.toggle, 'aria-expanded', String(!closed));
      own(record, record.panel, 'hidden', closed ? '' : null);
      own(record, record.panel, 'inert', closed ? '' : null);
      if (!record.listening) {
        record.toggle.addEventListener('click', record.click);
        record.listening = true;
      }
    }
    return true;
  }

  function reconcile(nextMembers, operation) {
    const next = new Map(), panels = new Set(), toggles = new Set();
    for (const member of nextMembers || []) {
      if (!member || typeof member.key !== 'string' || !member.key || !member.panel || !member.toggle) continue;
      if (next.has(member.key) || panels.has(member.panel) || toggles.has(member.toggle)) continue;
      panels.add(member.panel); toggles.add(member.toggle);
      let record = records.get(member.key);
      if (record && (record.panel !== member.panel || record.toggle !== member.toggle)) {
        if (!release(record, operation)) return false;
        record = null;
      }
      if (!record) {
        record = {key: member.key, panel: member.panel, toggle: member.toggle, header: member.header,
          attributes: new Map(), listening: false, generatedId: null};
        record.click = event => {
          if (disposed || !active || records.get(record.key) !== record || event.defaultPrevented
              || record.toggle.disabled || record.toggle.getAttribute('aria-disabled') === 'true'
              || record.toggle.closest('[hidden],[inert]')) return;
          const operation = ++generation, closed = !choices.get(record.key);
          choices.set(record.key, closed);
          if (!apply(operation) || !current(operation) || !active || disposed || records.get(record.key) !== record) return;
          onToggle?.(record.key, closed);
        };
      }
      record.header = member.header;
      next.set(member.key, record);
    }
    for (const [key, record] of records) {
      if (!next.has(key) && !release(record, operation)) return false;
    }
    // A release may synchronously focus and reenter update. Its successor's
    // membership is already authoritative; an older reconcile cannot publish.
    if (!current(operation)) return false;
    records = next;
    return true;
  }

  function update(next = {}) {
    if (disposed) return;
    const operation = ++generation;
    if (Object.prototype.hasOwnProperty.call(next, 'collapsed')) {
      choices = new Map(Object.entries(next.collapsed || {}).map(([key, value]) => [key, Boolean(value)]));
    }
    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) active = Boolean(next.enabled);
    if (Object.prototype.hasOwnProperty.call(next, 'members') && !reconcile(next.members, operation)) return;
    if (active) apply(operation);
    else for (const record of records.values()) if (!release(record, operation)) return;
  }

  const initialOperation = ++generation;
  reconcile(members, initialOperation);
  if (active) apply(initialOperation);
  return {update, dispose() {
    if (disposed) return;
    disposed = true;
    const operation = ++generation;
    for (const record of records.values()) release(record, operation);
    records.clear(); choices.clear();
  }};
}
