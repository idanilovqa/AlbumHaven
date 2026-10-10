import React, {useId, useLayoutEffect, useRef, useState} from 'react';
import {Button, NativeHtml} from './components.jsx';
import {NativeChoice} from './native-choice.jsx';

// The controller owns page/cursor validation and committed rows. This component
// only presents its descriptor; it never reads browser history or invents pages.
export function HistoryNavigation({runtime, value, navigation, queryKey, onPage, onLoadMore, onRetry}) {
  const root = useRef(null), summary = useRef(null), pending = useRef(null), focus = useRef(null), latest = useRef(null);
  const [request, setRequest] = useState(null), [draft, setDraft] = useState(null), [failure, setFailure] = useState(null);
  const errorId = useId();
  const visible = ['ready', 'empty'].includes(value?.status) && ['numbered', 'progressive'].includes(navigation?.mode);
  const numbered = navigation?.mode === 'numbered', page = navigation?.page;
  const busy = navigation?.status === 'loading' || Boolean(request && request.queryKey === queryKey);
  const currentDraft = draft && draft.queryKey === queryKey && draft.page === page ? draft : {queryKey, page, text: String(page ?? ''), error: ''};
  latest.current = {queryKey, navigation, visible};

  useLayoutEffect(() => {
    setRequest(null); setFailure(null);
    return () => {pending.current = null; focus.current = null;};
  }, [queryKey]);
  useLayoutEffect(() => {setDraft(null);}, [queryKey, page]);
  useLayoutEffect(() => {
    const restore = focus.current;
    if (busy || !restore) return;
    focus.current = null;
    if (!visible || restore.queryKey !== queryKey || !root.current?.isConnected) return;
    const document = root.current.ownerDocument, active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target = root.current.contains(restore.control) && !restore.control.disabled ? restore.control : summary.current;
    if (target && !target.closest('[hidden], [inert]')) target.focus({preventScroll: true});
  }, [busy, visible, queryKey]);

  if (!visible) return null;

  function run(callback, control) {
    if (typeof callback !== 'function' || busy || pending.current || !root.current?.isConnected || !latest.current.visible
      || latest.current.queryKey !== queryKey || latest.current.navigation !== navigation) return;
    const active = root.current?.ownerDocument.activeElement;
    const source = root.current?.contains(active) ? active : control;
    focus.current = source ? {queryKey, control: source} : null;
    const token = {queryKey}; pending.current = token; setRequest(token); setFailure(null);
    const release = () => {
      if (pending.current !== token) return;
      pending.current = null; setRequest(null);
    };
    const reject = () => {
      if (pending.current === token && latest.current.visible && latest.current.queryKey === queryKey
        && latest.current.navigation === navigation) setFailure({queryKey, navigation});
      release();
    };
    // Controller failures arrive in the descriptor. An embedding callback may
    // also throw/reject; report that locally without leaving a locked control.
    try {Promise.resolve(callback()).then(release, reject);}
    catch {reject();}
  }
  function selectPage(target, control) {
    if (!numbered || typeof onPage !== 'function' || !Number.isSafeInteger(target) || target < 1 || target > navigation.totalPages || target === page) return;
    run(() => onPage(target), control);
  }
  function jump(event) {
    event.preventDefault();
    if (busy || !latest.current.visible || latest.current.queryKey !== queryKey || latest.current.navigation !== navigation) return;
    const text = currentDraft.text.trim(), target = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(target) || target < 1 || target > navigation.totalPages) {
      setDraft({...currentDraft, error: `Enter a whole page number from 1 to ${navigation.totalPages}.`}); return;
    }
    setDraft({...currentDraft, error: ''}); selectPage(target);
  }

  const pageNumbers = numbered ? [...new Set([1, navigation.totalPages,
    ...[-2, -1, 0, 1, 2].map(offset => page + offset)])].filter(number => number >= 1 && number <= navigation.totalPages).sort((a, b) => a - b) : [];
  const summaryText = numbered
    ? `Page ${page} of ${navigation.totalPages} · ${navigation.loadedCount
      ? `Items ${(page - 1) * navigation.pageSize + 1}–${(page - 1) * navigation.pageSize + navigation.loadedCount} of ${navigation.totalRows}`
      : '0 items'} · ${navigation.pageSize} per page`
    : `${navigation.loadedCount} items shown · ${navigation.hasMore ? 'More history available' : 'End of available history'}`;
  const statusMessage = busy ? numbered ? navigation.requestedPage ? `Loading page ${navigation.requestedPage}…` : 'Loading history page…' : 'Loading more history…'
    : navigation.status === 'error' ? numbered ? `Page ${navigation.requestedPage} could not be loaded. Your current page is still shown.`
      : 'More history could not be loaded. Your listening history is still shown.'
    : failure && failure.queryKey === queryKey && failure.navigation === navigation
      ? 'History navigation could not be started. Try choosing again.' : '';

  return <nav ref={root} className="home-history-navigation" aria-label="Listening history pages" aria-busy={busy}>
    <p ref={summary} className="home-history-navigation__summary" role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>{summaryText}</p>
    {numbered ? <div className="home-history-navigation__controls">
      <Button runtime={runtime} icon="previous" disabled={busy || page <= 1 || typeof onPage !== 'function'} onClick={() => selectPage(page - 1)}>Previous history page</Button>
      <NativeChoice runtime={runtime} className="home-history-navigation__choice" label="History page" showLabel={false}
        value={String(page)} disabled={busy || navigation.totalPages <= 1 || typeof onPage !== 'function'}
        options={pageNumbers.map(number => [String(number), `Page ${number} of ${navigation.totalPages} · ${navigation.pageSize} per page`])}
        onChange={next => selectPage(Number(next), root.current?.querySelector('.home-history-navigation__choice button'))}/>
      <Button runtime={runtime} icon="next" disabled={busy || page >= navigation.totalPages || typeof onPage !== 'function'} onClick={() => selectPage(page + 1)}>Next history page</Button>
      {navigation.totalPages > 1 && <form className="tag-editor-form home-history-navigation__jump" aria-label="Jump to history page" onSubmit={jump} noValidate>
        <label>Go to page<input type="text" inputMode="numeric" pattern="[0-9]*" value={currentDraft.text}
          disabled={busy || typeof onPage !== 'function'} aria-invalid={Boolean(currentDraft.error)} aria-describedby={currentDraft.error ? errorId : undefined}
          onChange={event => {if (!busy && latest.current.queryKey === queryKey && latest.current.navigation === navigation) setDraft({queryKey, page, text: event.target.value, error: ''});}}/></label>
        <Button runtime={runtime} type="submit" disabled={busy || typeof onPage !== 'function'}>Go</Button>
      </form>}
    </div> : <div className="home-history-navigation__controls">
      <Button runtime={runtime} disabled={busy || !navigation.hasMore || typeof onLoadMore !== 'function'} onClick={() => {if (navigation.hasMore) run(onLoadMore);}}>Load more history</Button>
    </div>}
    {currentDraft.error && numbered && <div id={errorId}><NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: currentDraft.error})}/></div>}
    {statusMessage && <div className="home-history-navigation__status">
      <NativeHtml html={runtime.alertHtml({severity: busy ? 'info' : 'error', role: busy ? 'status' : 'alert', message: statusMessage})}/>
      {navigation.status === 'error' && <Button runtime={runtime} disabled={busy || typeof onRetry !== 'function'} onClick={() => run(onRetry)}>Retry history loading</Button>}
    </div>}
  </nav>;
}
