/* Recommendations own only metadata delivery. Playback/profile authority stays
   with the existing resource owners. Every request is session/context guarded. */
const RecommendationRuntime = (() => {
  let active = null, currentAlbumOwner = null, summaryOwner = null;
  const presentation = () => window.AlbumHavenRecommendationPresentation;
  const available = (kind, ref, source) => Boolean(presentation()?.recommendationResource(kind, ref, source)
    && window.AlbumHavenPrivateUITransport && typeof showAppFormDialog === 'function');
  async function open({kind, resource_ref, source, manual = false, anchor = null, isCurrent = () => true} = {}) {
    if (active || !available(kind, resource_ref, source) || typeof activeAppFormDialog !== 'undefined' && activeAppFormDialog) return false;
    const resource = presentation().recommendationResource(kind, resource_ref, source);
    const transport = window.AlbumHavenPrivateUITransport, abort = new AbortController();
    let expected;
    try {expected = transport.context();} catch {return false;}
    const sourceView = state.view, sourceUrl = window.location.href;
    const owner = {abort, body: null, sending: false, close: null}; active = owner;
    const current = () => active === owner && !abort.signal.aborted && state.view === sourceView
      && window.location.href === sourceUrl && transport.context() === expected && isCurrent() === true;
    const safeCurrent = () => {try {return current();} catch {return false;}};
    let unsubscribe = null, content = null, controls = null, input = null, selected = null, cursor = null, loading = false;
    const names = new Map(), options = {signal: abort.signal, expected, isCurrent: safeCurrent};
    const retireNavigation = () => {if (!safeCurrent()) {abort.abort(); owner.close?.(null,{force:true,restoreFocus:false});}};
    owner.reconcile = retireNavigation;
    const cleanup = () => {abort.abort(); unsubscribe?.(); unsubscribe = null; window.removeEventListener?.('popstate',retireNavigation); if (active === owner) active = null;};
    const changed = () => {
      if (!safeCurrent()) return;
      controls?.setSubmitEnabled(!loading && (owner.body !== null || manual && Boolean(input?.value.trim()) || selected !== null));
    };
    const choose = person => {
      if (!safeCurrent() || owner.body) return;
      selected = person.account_ref;
      if (input) input.value = '';
      const status = content.querySelector('[data-recommendation-selected]');
      status.textContent = `Selected: ${person.display_name}`;
      changed();
    };
    async function loadFriends() {
      if (!safeCurrent() || loading || owner.body) return;
      loading = true; changed();
      const status = content.querySelector('[data-recommendation-load-status]');
      const more = content.querySelector('[data-recommendation-more]');
      more.disabled = true; status.textContent = 'Loading friends…';
      try {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const result = await transport.request('/recommendations/friends' + query, options);
        if (!safeCurrent()) return;
        if (!Array.isArray(result.friends) || result.next_cursor !== null && typeof result.next_cursor !== 'string') throw new Error('Invalid friends response.');
        for (const person of presentation().normalizeRecommenders(result.friends)) {
          if (!person.account_ref || names.has(person.account_ref)) continue;
          names.set(person.account_ref, person);
          const holder = document.createElement('span');
          holder.innerHTML = ButtonComponent.renderButton({label: person.display_name, size: 'small'});
          const button = holder.firstElementChild;
          button.addEventListener('click', () => choose(person));
          content.querySelector('[data-recommendation-friends]').appendChild(button);
        }
        cursor = result.next_cursor;
        status.textContent = names.size ? '' : manual ? 'You can enter any person’s name.' : 'No eligible friends yet.';
        more.hidden = !cursor; more.textContent = 'More friends';
      } catch (error) {
        if (safeCurrent() && error.name !== 'AbortError') {status.textContent = 'Friends could not be loaded.'; more.hidden = false; more.textContent = 'Retry';}
      } finally {loading = false; if (safeCurrent()) {more.disabled = false; changed();}}
    }
    const parent = anchor?.closest?.('#track-modal, #non-album-modal, [data-resource-selection-content="album"]');
    const parentSurface = parent?.id ? `#${parent.id}` : parent ? '[data-resource-selection-content="album"]' : undefined;
    try {
      const result = await showAppFormDialog({title: manual ? 'Add to Recommended By' : `Recommend ${kind}`,
        parentSurface, submitLabel: manual ? 'Add' : 'Recommend', submitEnabled: false,
        contentHtml: `<div class="tag-editor-form"><p>${manual ? 'Who recommended this? Enter a name or choose an app user.' : 'Choose a friend.'}</p>${manual ? '<label>Name<input data-recommender-name maxlength="100" autocomplete="off"></label>' : ''}<p data-recommendation-selected role="status"></p><div class="playlists__actions" data-recommendation-friends></div><p data-recommendation-load-status role="status"></p>${ButtonComponent.renderButton({label:'More friends',size:'small',attributes:{'data-recommendation-more':'1'}})}</div>`,
        beforeDismiss: () => !owner.sending,
        onMount(host, next) {
          content = host; controls = next; owner.close = next.close;
          window.addEventListener?.('popstate',retireNavigation);
          input = host.querySelector('[data-recommender-name]');
          input?.addEventListener('input', () => {if (!owner.body) {selected = null; host.querySelector('[data-recommendation-selected]').textContent = ''; changed();}});
          host.querySelector('[data-recommendation-more]').addEventListener('click', loadFriends);
          unsubscribe = transport.subscribe(() => {if (!safeCurrent()) {abort.abort(); next.close(null, {force:true,restoreFocus:false});}});
          void loadFriends();
        },
        async onSubmit() {
          if (!safeCurrent()) throw new Error('The source changed. Close and reopen Recommend.');
          if (!owner.body) {
            if (manual && !selected && !presentation().manualRecommenderName(input?.value)) throw new Error('Enter a name of at most 100 characters without control characters.');
            if (!manual && !selected) throw new Error('Choose a friend first.');
            owner.body = {request_key: crypto.randomUUID(), ...resource,
              ...(manual ? {recommender: selected ? {account_ref:selected} : {name:presentation().manualRecommenderName(input.value)}} : {recipient_account_ref:selected})};
          }
          owner.sending = true;
          for (const field of content.querySelectorAll('input,button')) field.disabled = true;
          try {
            await transport.request(manual ? '/recommendations/manual' : '/recommendations', {...options, method:'POST', body:owner.body});
            if (!safeCurrent()) return null;
            window.dispatchEvent(new CustomEvent('albumhaven:recommendations-changed'));
            showToast(manual ? 'Added to Recommended By.' : 'Recommendation sent.', 'info', 3000);
            return true;
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new Error('Could not confirm the recommendation. Retry sends the same request; close to cancel.');
          } finally {owner.sending = false;}
        },
        onClose: cleanup,
      });
      return result === true;
    } finally {cleanup();}
  }
  async function albumDetails(album, host, {force = false} = {}) {
    if (!host || !presentation()) return;
    const transport = window.AlbumHavenPrivateUITransport;
    let ref, expected;
    try {ref = getAlbumPlaybackQueueRef(album); expected = transport.context();} catch {return;}
    const previous = currentAlbumOwner;
    if (!force && previous?.host === host && previous?.album === album && previous.expected === expected && previous.node.isConnected) return;
    previous?.retire();
    if (!presentation().recommendationResource('album', ref)) return;
    const node = document.createElement('p'), abort = new AbortController();
    node.className = 'album-subtitle'; node.setAttribute('data-album-recommendations', '');
    node.hidden = true; host.appendChild(node);
    const owner = {album,expected,node,abort,host}; currentAlbumOwner=owner;
    owner.retire=()=>{abort.abort();owner.unsubscribe?.();node.remove();if(currentAlbumOwner===owner)currentAlbumOwner=null;};
    const current = () => currentAlbumOwner === owner && !abort.signal.aborted && node.isConnected
      && node.parentElement === host && !document.getElementById('track-modal')?.hidden
      && getCurrentTrackModalAlbum() === album && transport.context() === expected;
    let unsubscribe;
    try {
      unsubscribe = transport.subscribe(() => {try {if (transport.context() !== expected) owner.retire();} catch {owner.retire();}});
      owner.unsubscribe = unsubscribe;
      const payload = await transport.request(`/recommendations/album/${ref.split(':')[2]}`, {expected,signal:abort.signal,isCurrent:current});
      if (!current()) {owner.retire();return;}
      const html = presentation().recommenderListHtml(payload.recommenders, escapeHtml);
      if (html) {node.innerHTML = `Recommended by: ${html}`; node.hidden = false;}
    } catch {
      owner.retire();
      // Optional attribution must never disturb album playback/details.
    }
  }
  window.addEventListener?.('albumhaven:recommendations-changed', () => {
    const host = document.getElementById('track-modal-cover');
    const album = typeof getCurrentTrackModalAlbum === 'function' ? getCurrentTrackModalAlbum() : null;
    if (album && host && !document.getElementById('track-modal')?.hidden) void albumDetails(album,host,{force:true});
  });
  async function summary(row, isCurrent = () => true) {
    if (!isCurrent() || active || typeof activeAppFormDialog !== 'undefined' && activeAppFormDialog) return false;
    const transport = window.AlbumHavenPrivateUITransport;
    let expected; try {expected=transport.context();} catch {return false;}
    let unsubscribe;
    const record={isCurrent,close:null};summaryOwner=record;
    const reconcile=()=>{let valid=false;try {valid=isCurrent() && transport.context()===expected;}catch{}if(!valid)record.close?.(null,{force:true,restoreFocus:false});};
    try {return await showAppFormDialog({title:row.title || 'Recommended album',mode:'reading',
      contentHtml:`<div class="album-artbox album-card--unavailable"><p>Album unavailable in this library</p></div><p>${escapeHtml(row.artist || '')}</p><p>${escapeHtml(row.year || '')}</p><p>Recommended by: ${presentation().recommenderListHtml(row.recommended_by,escapeHtml) || '—'}</p><p>This is album information only. Tracks and playback are unavailable.</p>`,
      onMount(host,controls){record.close=controls.close;record.reconcile=reconcile;unsubscribe=transport.subscribe(reconcile);window.addEventListener?.('popstate',reconcile);},
      onClose(){unsubscribe?.();},
    });} finally {unsubscribe?.();window.removeEventListener?.('popstate',reconcile);if(summaryOwner===record)summaryOwner=null;}
  }
  function reconcile(){active?.reconcile?.();summaryOwner?.reconcile?.();}
  return Object.freeze({open, available, albumDetails, summary, reconcile});
})();
window.AlbumHavenRecommendations = RecommendationRuntime;
