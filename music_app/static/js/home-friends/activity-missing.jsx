import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Button} from './components.jsx';

// The server checks the entire sealed source, including unloaded pages. Loaded
// rows and their coarse availability badges never establish missing evidence.
export function ActivityMissingAction({runtime, value, scopeKey, account_ref = null, kind, period,
  selectedRowIds, enabled = true, onError}) {
  const [eligibility, setEligibility] = useState(null), [busy, setBusy] = useState(null);
  const selected = Array.isArray(selectedRowIds) && selectedRowIds.length ? JSON.stringify(selectedRowIds) : null;
  const request = useMemo(() => enabled && value?.status === 'ready' && ['tracks', 'listens'].includes(kind)
    && typeof value.data?.snapshot_ref === 'string' ? {scopeKey,
      origin: {audience: account_ref === null ? 'own' : 'friend', subject_ref: account_ref,
        kind, period, snapshot_ref: value.data.snapshot_ref}, row_refs: selected === null ? null : JSON.parse(selected)} : null,
  [enabled, value, scopeKey, account_ref, kind, period, selected]);
  const latest = useRef(null), alive = useRef(false), click = useRef(null);
  latest.current = {runtime, request, onError};
  const current = () => alive.current && latest.current?.runtime === runtime && latest.current?.request === request;
  useEffect(() => {
    alive.current = true;
    return () => {alive.current = false; click.current?.abort(); click.current = null;};
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    click.current?.abort(); click.current = null; setBusy(null);
    if (request && typeof runtime.readActivityMissingEligibility === 'function') {
      Promise.resolve().then(() => {
        if (!current() || abort.signal.aborted) return null;
        return runtime.readActivityMissingEligibility({...request, signal: abort.signal, isCurrent: current});
      }).then(data => {
        if (current() && !abort.signal.aborted) setEligibility({request, data});
      }).catch(error => {
        if (current() && !abort.signal.aborted) setEligibility({request, tooLarge: error?.status === 413});
      });
    }
    return () => abort.abort();
  }, [runtime, request]);
  if (!request || eligibility?.request !== request) return null;
  if (eligibility.tooLarge) return <span className="home-friends__muted" role="status">Select up to 5,000 activity rows to inspect missing tracks.</span>;
  if (eligibility.data?.can_inspect_missing !== true || typeof runtime.inspectActivityMissing !== 'function') return null;
  const inspect = async () => {
    if (!current() || click.current) return;
    const abort = new AbortController(); click.current = abort; setBusy(request);
    try {
      const opened = await runtime.inspectActivityMissing({...request, signal: abort.signal, isCurrent: current});
      if (opened !== true && current() && !abort.signal.aborted) latest.current.onError?.('This activity source changed. Refresh it before inspecting missing tracks.');
    } catch (error) {
      if (current() && !abort.signal.aborted && error?.name !== 'AbortError') latest.current.onError?.(
        error?.status === 413 ? 'This activity source exceeds the 5,000-row limit. Select fewer rows to inspect.'
          : 'Missing tracks could not be inspected. Refresh the activity and try again.');
    } finally {
      if (click.current === abort) {click.current = null; if (current()) setBusy(null);}
    }
  };
  return <Button runtime={runtime} icon="missing-playlist" disabled={busy === request} onClick={inspect}
    title={selected === null ? 'Inspect missing tracks from the full activity period' : 'Inspect missing tracks from the selected activity rows'}
    attributes={{'data-home-inspect-missing': 'true'}}>Inspect missing tracks</Button>;
}
