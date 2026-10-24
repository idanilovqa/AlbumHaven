import React, {useLayoutEffect, useRef, useState} from 'react';
import {createFoobarHistoryOwner} from '../foobar-history/owner.mjs';
import {mountFoobarHistoryPanel} from '../foobar-history/panel.mjs';
import {createFoobarHistoryNativeActions} from '../foobar-history/native-actions.mjs';

export function canShowFoobarHistory(shell, root) {
  return shell?.authenticated === true && root?.isConnected === true
    && root.dataset.accountFoobarHistoryAllowed === 'true'
    && root.dataset.accountFoobarScope === 'account-foobar-v1'
    && /^[a-f0-9]{64}$/.test(root.dataset.accountFoobarContext || '');
}

// React owns only this empty host and adjacent status. The existing independent
// panel owns every descendant in the host; React never reconciles that subtree.
export function FoobarHistory({runtime, shell, scopeKey}) {
  const host = useRef(null), latest = useRef(null), [failed, setFailed] = useState(false);
  latest.current = {runtime, shell, scopeKey};
  const root = typeof document === 'undefined' ? null : document.getElementById('app-shell');
  const marker = root?.dataset.accountFoobarContext, readable = canShowFoobarHistory(shell, root);
  useLayoutEffect(() => {
    let active = true, owner = null, panel = null;
    const node = host.current, window = node?.ownerDocument.defaultView;
    const fetch = window?.fetch, entryKey = shell.entryKey ?? 'initial';
    const current = () => {
      const value = latest.current, live = runtime.snapshot();
      return active && root !== null && node?.isConnected === true && value.runtime === runtime
        && value.scopeKey === scopeKey && (value.shell.entryKey ?? 'initial') === entryKey
        && value.shell.section !== 'friends' && live.visible === true && live.scopeKey === scopeKey
        && (live.entryKey ?? 'initial') === entryKey && window?.fetch === fetch
        && node.ownerDocument.getElementById('app-shell') === root
        && root.dataset.accountFoobarContext === marker && canShowFoobarHistory(value.shell, root);
    };
    const dispose = () => {active = false; try {panel?.dispose();} finally {owner?.dispose();}};
    setFailed(false);
    if (!node || !canShowFoobarHistory(shell, root) || typeof fetch !== 'function') return dispose;
    try {
      owner = createFoobarHistoryOwner({fetch: (...args) => fetch.apply(window, args), contextRoot: root,
        allows: action => action === 'account.self.foobar.read' && current(), isCurrent: current});
      panel = mountFoobarHistoryPanel(node, runtime, {owner, isCurrent: current,
        createNativeActions: options => {
          return createHomeFoobarNativeActions(window, current, options);
        }});
    } catch {dispose(); setFailed(true);}
    return dispose;
  }, [runtime, scopeKey, shell.entryKey, shell.authenticated, shell.section, root, marker, readable]);
  if (!canShowFoobarHistory(shell, root) || shell.section === 'friends') return null;
  return <><div ref={host} className="home-friends__scroll gallery-scrollbar" data-home-foobar-history="true"/>
    {failed && <p role="status">Foobar history is unavailable. No import or playback was attempted.</p>}</>;
}

// Publicly exported for source composition tests, not placed on the window.
// Private targets remain solely inside the accepted native adapter/dispatcher.
export function createHomeFoobarNativeActions(window, current, options) {
  const tracks = typeof TrackActionsRuntime === 'undefined' ? null : TrackActionsRuntime;
  const transport = window.AlbumHavenPrivateUITransport;
  if (!tracks || !transport) return null;
  return createFoobarHistoryNativeActions({...options, tracks, transport,
    isCurrent: () => current() && options.isCurrent()
      && window.AlbumHavenPrivateUITransport === transport && TrackActionsRuntime === tracks});
}
