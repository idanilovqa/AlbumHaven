import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {usePlaytableSelection} from './selection.jsx';

export const editorRowSelectable = row => row?.source_readable === true
  && Object.hasOwn(row.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read === true
  && Object.hasOwn(row.allowed_actions || {}, 'can_select') && row.allowed_actions.can_select === true;

// Editor highlights have no writer or media authority. Their public occurrence
// keys are deliberately never resolved into native Playlist track references.
export function useEditorPlaytableSelection(hostRef, {controller, state, rows, tableKey, disabled, onInspect}) {
  const latest = useRef(null), [unavailableNotice, setUnavailableNotice] = useState(false);
  latest.current = {controller, state, rows, disabled};
  const source = state.sourceResource.data;
  const sourceAdapter = useMemo(() => {
    const instance = {};
    return {
      snapshot() {
        const live = controller.getSnapshot(), view = latest.current;
        if (view.controller !== controller || view.disabled || live.scopeKey !== state.scopeKey
          || live.draftToken !== state.draftToken || live.sourceResource.status !== 'ready'
          || live.sourceResource.data !== source || live.mutation.status === 'loading' || live.mutation.request_key != null) return null;
        return {scopeKey: live.scopeKey, instance,
          rows: view.rows.map(row => ({rowKey: row.row_key, readable: row.source_readable === true,
            selectable: editorRowSelectable(row)}))};
      },
      subscribe: listener => controller.subscribe(listener),
    };
  }, [controller, state.scopeKey, state.draftToken, source]);
  useLayoutEffect(() => {setUnavailableNotice(false);}, [sourceAdapter]);
  const selection = usePlaytableSelection(hostRef, {sourceAdapter, tableKey,
    isViewCurrent: () => latest.current.controller === controller && !latest.current.disabled
      && latest.current.state === controller.getSnapshot(),
    onInspect,
    onPlaylistAction: (_packet, lifetime) => {
      // A context gesture still uses the shared selected-set behavior, but the
      // editor cannot open another form or manufacture an Add writer mapping.
      if (lifetime.isCurrent()) setUnavailableNotice(true);
      lifetime.dispose();
    },
  });
  return {...selection, unavailableNotice};
}
