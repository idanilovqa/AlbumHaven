import {mountIntrinsicDisclosure} from '../home-friends/native-controls.mjs';

const hostOwners = new WeakMap();

// A native composition of existing sections. Album DOM stays exclusively with
// the transferred VirtualArtistGrid, including while disclosures are closed.
export function mountArtistPage({host, runtime}) {
  let session = null, disposed = false, updating = false, queued = false;
  const doc = host.ownerDocument, hostOwner = {};
  hostOwners.set(host, hostOwner);
  const ownsHost = () => hostOwners.get(host) === hostOwner;
  function retire() {
    const previous = session;
    if (!previous) return;
    session = null;
    previous.binding?.release();
    for (const owner of Object.values(previous.sections)) owner.dispose();
    previous.root.remove();
    if (!session && ownsHost()) {host.hidden = true; host.inert = true;}
  }
  function create(snapshot) {
    const root = doc.createElement('div');
    root.className = 'artist-page__sections';
    const owned = {id: snapshot.sessionId, root, sections: {}, choices: new Map(), binding: null, infoKey: '', familyKey: '', releaseIds: new Map()};
    session = owned;
    for (const [key, label] of [['info', 'Info'], ['discography', 'Discography'], ['family', 'Family']]) {
      const element = doc.createElement('section'); root.append(element);
      owned.sections[key] = mountIntrinsicDisclosure(element, runtime, {id: `artist-page-${owned.id}-${key}`, memberKey: key, label,
        collapsed: false, onToggle(member, value) {
          if (session !== owned || !ownsHost() || disposed) return;
          owned.choices.set(member, value);
          if (member === 'discography') owned.binding?.update({collapsed: value});
        }});
    }
    host.querySelector('[data-artist-page-unavailable]')?.remove();
    host.append(root); host.hidden = false;
    owned.binding = runtime.attach({host, sections: owned.sections,
      mountReleaseDisclosure(element, props) {
        if (session !== owned || !ownsHost() || disposed) return null;
        if (!owned.releaseIds.has(props.memberKey)) owned.releaseIds.set(props.memberKey, owned.releaseIds.size + 1);
        return mountIntrinsicDisclosure(element, runtime, {...props,
          id: `artist-page-${owned.id}-release-${owned.releaseIds.get(props.memberKey)}`});
      }});
    if (session !== owned || !ownsHost() || disposed) {owned.binding?.release(); return null;}
    return owned;
  }
  function patchFamily(owned, snapshot) {
    const panel = owned.sections.family.slots.panel;
    const html = runtime.artistFamilyHtml({title: 'Artist Family', currentArtist: snapshot.artistRef, members: snapshot.familyMembers});
    if (owned.familyKey === html) return;
    const focused = panel.contains(doc.activeElement) ? doc.activeElement.closest?.('[data-artist-page-family]')?.getAttribute('data-artist-page-family') : null;
    const scratch = doc.createElement('div'); scratch.innerHTML = html;
    const previous = new Map([...panel.querySelectorAll('[data-artist-page-family]')].map(row => [row.getAttribute('data-artist-page-family'), row]));
    for (const next of scratch.querySelectorAll('[data-artist-page-family]')) {
      const old = previous.get(next.getAttribute('data-artist-page-family'));
      if (old?.isEqualNode(next)) next.replaceWith(old);
    }
    if (session !== owned || !ownsHost() || disposed) return;
    panel.replaceChildren(...scratch.childNodes); owned.familyKey = html;
    if (focused && snapshot.actionable && session === owned && ownsHost() && !disposed) {
      const target = [...panel.querySelectorAll('[data-artist-page-family]')].find(row => row.getAttribute('data-artist-page-family') === focused);
      (target || owned.sections.family.element.querySelector('button[aria-controls]'))?.focus({preventScroll: true});
    }
  }
  function update() {
    if (disposed || !ownsHost()) return;
    if (updating) {queued = true; return;}
    updating = true;
    try {
      do {
        queued = false;
        let snapshot = runtime.snapshot();
        if (disposed || !ownsHost()) break;
        if (!snapshot.sessionId || !snapshot.retained) {
          retire();
          if (ownsHost()) {host.querySelector('[data-artist-page-unavailable]')?.remove(); host.hidden = true; host.inert = true;}
          continue;
        }
        if (snapshot.status === 'unavailable') {
          retire();
          if (!ownsHost() || disposed) break;
          if (!host.querySelector('[data-artist-page-unavailable]')) {
            const status = doc.createElement('p'); status.setAttribute('role', 'status');
            status.setAttribute('data-artist-page-unavailable', ''); status.textContent = 'Artist view is unavailable.';
            host.replaceChildren(status);
          }
          host.hidden = false; host.inert = false; continue;
        }
        if (session && session.id !== snapshot.sessionId) retire();
        const created = !session, owned = session || create(snapshot);
        if (!owned || session !== owned || disposed || !ownsHost()) continue;
        if (!owned.binding) {
          // A failed transfer leaves the ordinary Gallery mounted at its dock.
          const status = doc.createElement('p'); status.setAttribute('role', 'status');
          status.setAttribute('data-artist-page-unavailable', ''); status.textContent = 'Artist view is unavailable.';
          retire(); if (!ownsHost() || disposed) break; host.replaceChildren(status); host.hidden = false; host.inert = false;
          continue;
        }
        // Attachment changes mounted/actionable state synchronously. Do not
        // apply the pre-attachment inert snapshot over a newly live grid.
        snapshot = runtime.snapshot();
        if (disposed || !ownsHost() || session !== owned || snapshot.sessionId !== owned.id) continue;
        host.hidden = false; host.inert = !snapshot.actionable;
        const info = runtime.artistInfoHtml(snapshot.info);
        if (owned.infoKey !== info) {owned.sections.info.slots.panel.innerHTML = info; owned.infoKey = info;}
        patchFamily(owned, snapshot);
        for (const [key, label, count] of [['info', 'Info', null],
          ['discography', 'Discography', snapshot.discography.totals.albumCount], ['family', 'Family', snapshot.familyMembers.length]]) {
          owned.sections[key].update({id: `artist-page-${owned.id}-${key}`, memberKey: key, label, count,
            collapsed: owned.choices.get(key) === true, onToggle(member, value) {
              if (session !== owned || !ownsHost() || disposed) return;
              owned.choices.set(member, value);
              if (member === 'discography') owned.binding.update({collapsed: value});
            }});
        }
        if (created && session === owned) runtime.requestRender();
      } while (queued && !disposed && ownsHost());
    } finally {updating = false;}
  }
  const click = event => {
    const row = event.target.closest?.('[data-artist-page-family]');
    if (disposed || !ownsHost() || !row || !host.contains(row)) return;
    event.preventDefault();
    void Promise.resolve(runtime.navigateFamily(row.getAttribute('data-artist-page-family'))).catch(() => {});
  };
  host.addEventListener('click', click);
  const unsubscribe = runtime.subscribe(update);
  update();
  return {update, dispose() {
    if (disposed) return;
    disposed = true; unsubscribe(); host.removeEventListener('click', click); retire();
    if (ownsHost()) hostOwners.delete(host);
  }};
}
