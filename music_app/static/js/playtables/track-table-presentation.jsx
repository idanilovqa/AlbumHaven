import React, {useLayoutEffect, useRef, useState} from 'react';
import {Button} from '../home-friends/components.jsx';
import {bindTrackTablePresentation} from './track-table-presentation.mjs';

const EMPTY_CHOICES = Object.freeze({});

/** Choices last only for this mounted resource. Source revisions retire gestures,
 * but never become preference IDs or trigger another data read. */
export function useTrackTablePresentation(hostRef, {runtime, resourceKey, enabled = true, ...options}) {
  const ownerRef = useRef(null), latest = useRef(null);
  const [selection, setSelection] = useState(null);
  const choices = selection?.resourceKey === resourceKey ? selection.choices : EMPTY_CHOICES;
  latest.current = {resourceKey, enabled, ...options};
  const settings = {...options, choices, openChoice: runtime.openChoice,
    isCurrent: () => latest.current.enabled && latest.current.resourceKey === resourceKey && latest.current.isCurrent?.() !== false,
    onChoicesChange: next => {
      if (latest.current.enabled && latest.current.resourceKey === resourceKey) setSelection({resourceKey, choices: next});
    }};
  useLayoutEffect(() => {
    if (!enabled || !hostRef.current) return undefined;
    const owner = bindTrackTablePresentation(hostRef.current, settings); ownerRef.current = owner;
    return () => {owner.dispose(); if (ownerRef.current === owner) ownerRef.current = null;};
  }, [hostRef, runtime, resourceKey, enabled]);
  useLayoutEffect(() => {ownerRef.current?.update(settings);});
  return {ownerRef, available: enabled && typeof runtime.openChoice === 'function'};
}

export function TrackTableColumnsAction({runtime, ownerRef, available = true}) {
  const hasAction = typeof runtime.actionHtml === 'function';
  return <span className="compact-data-table__columns-action"><Button runtime={runtime} icon={hasAction ? 'more' : undefined} disabled={!available || !hasAction}
    attributes={{'data-track-table-columns': '', 'aria-haspopup': 'menu', 'aria-expanded': 'false'}}
    onClick={event => ownerRef.current?.openColumns(event.target.closest('button'))}>Track columns</Button></span>;
}
