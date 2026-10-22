// Shared fixed-geometry completed-album display. Callers own authoritative counts.
export function mountAlbumProgress(host, {summary = null, label = 'Completed albums'} = {}) {
  let disposed = false;
  const slot = host.ownerDocument.createElement('span'); slot.className = 'album-progress';
  const track = host.ownerDocument.createElement('span'); track.className = 'album-progress__track';
  const fill = host.ownerDocument.createElement('span'); fill.className = 'album-progress__fill';
  track.append(fill); slot.append(track); host.append(slot);
  function update({summary = null, label = 'Completed albums'} = {}) {
    if (disposed) return;
    const valid = summary && Number.isSafeInteger(summary.total) && summary.total > 0
      && Number.isSafeInteger(summary.completed) && summary.completed >= 0 && summary.completed <= summary.total;
    slot.hidden = !valid;
    if (!valid) {
      for (const name of ['role', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'title']) track.removeAttribute(name);
      fill.style.width = '0%'; return;
    }
    const text = `${summary.completed} of ${summary.total} albums completed`;
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label);
    track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(summary.total));
    track.setAttribute('aria-valuenow', String(summary.completed)); track.setAttribute('aria-valuetext', text);
    track.setAttribute('title', text); fill.style.width = `${100 * summary.completed / summary.total}%`;
  }
  update({summary, label});
  return {update, dispose() {if (disposed) return; disposed = true; slot.remove();}};
}
