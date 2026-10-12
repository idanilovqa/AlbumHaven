import React, {useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button, NativeHtml} from '../home-friends/components.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {DEFAULT_PLAYLIST_FILTERS, PLAYLIST_LENGTH_PRESETS, groupPlaylists, normalizePlaylistFilters,
  playlistFiltersActive, playlistLengthValue} from './filters.mjs';

const allowed = item => Object.prototype.hasOwnProperty.call(item?.allowed_actions || {}, 'can_open') && item.allowed_actions.can_open === true;
const names = {autoplaylists: 'Autoplaylists', manual: 'Manual', unclassified: 'Other playlists'};
const empty = {autoplaylists: 'No autoplaylists were supplied.', manual: 'No manual playlists were supplied.'};
export function playlistDisclosureState(closed, key) {
  if (key === 'ArrowLeft') return true;
  if (key === 'ArrowRight') return false;
  return closed;
}
function GroupHeading({runtime, id, group, closed, onChange}) {
  const root = useRef(null), label = names[group];
  // NavigationTree owns disclosure button presentation. Add semantic disclosure
  // attributes to its generated button; no page-specific button implementation.
  const html = runtime.navigationItemHtml({key: `playlist-group:${group}`, action: true, variant: 'panel',
    label, icon: '›', className: 'playlists__group-toggle', attributes: {'data-playlist-group-toggle': group}})
    .replace('<button ', `<button id="${runtime.escapeHtml(id)}" aria-expanded="${String(!closed)}" aria-controls="${runtime.escapeHtml(`${id}-items`)}" `);
  const initial = useRef(html);
  useLayoutEffect(() => {
    const button = root.current.querySelector('button');
    button.setAttribute('aria-expanded', String(!closed));
    button.setAttribute('aria-label', `${closed ? 'Expand' : 'Collapse'} ${label}`);
    button.title = `${closed ? 'Expand' : 'Collapse'} ${label}`;
  }, [closed, label]);
  return <h3 className="playlists__group-heading"><span ref={root} dangerouslySetInnerHTML={{__html: initial.current}}
    onClick={event => {if (event.target.closest('[data-playlist-group-toggle]')) onChange(!closed);}}
    onKeyDown={event => {
      if (!event.target.closest('[data-playlist-group-toggle]') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); onChange(playlistDisclosureState(closed, event.key));
    }}/></h3>;
}
export function PlaylistGroupedDirectory({runtime, items = [], selectedPlaylistId = null, onSelect, disabled = false}) {
  const prefix = `playlist-directory-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const groups = useMemo(() => groupPlaylists(items), [items]);
  const [collapsed, setCollapsed] = useState({autoplaylists: false, manual: false, unclassified: false});
  return <nav className="navigation-tree playlists__groups" aria-label="Choose a playlist">
    {['autoplaylists', 'manual', ...(groups.unclassified.length ? ['unclassified'] : [])].map(group => {
      const id = `${prefix}-${group}`;
      return <section key={group} data-playlist-group={group} aria-labelledby={id}>
        <GroupHeading runtime={runtime} id={id} group={group} closed={collapsed[group]}
          onChange={closed => setCollapsed(previous => ({...previous, [group]: closed}))}/>
        <div id={`${id}-items`} hidden={collapsed[group]}>
          {groups[group].map(item => <NativeHtml key={item.playlist_id} html={runtime.navigationItemHtml({
            key: item.playlist_id, label: item.title || 'Untitled playlist', action: true, variant: 'wide',
            selected: selectedPlaylistId === item.playlist_id, disabled: disabled || !allowed(item),
            subtitle: Number.isSafeInteger(item.item_count) && item.item_count >= 0 ? `${item.item_count} tracks` : '',
            attributes: {'data-playlist-group-item': item.playlist_id},
          })} onClick={event => {
            const button = event.target.closest('[data-playlist-group-item]');
            if (button && !button.disabled && !disabled && allowed(item)) onSelect?.(item.playlist_id);
          }}/>) }
          {!groups[group].length && <p className="playlists__note">{empty[group]}</p>}
          {group === 'unclassified' && <p className="playlists__note">Playlist types are unavailable for these entries.</p>}
        </div>
      </section>;
    })}
  </nav>;
}
export function PlaylistFilterControls({runtime, rows = [], filters, onChange, onReset, canReset, disabled = false, children}) {
  const values = normalizePlaylistFilters(filters);
  const resetEnabled = canReset === undefined ? playlistFiltersActive(values) : canReset === true;
  const sourceRows = Array.isArray(rows) ? rows : [];
  const styleOptions = [...new Set(sourceRows.filter(row => row && row.source_readable !== false).flatMap(row => Array.isArray(row.styles) ? row.styles : [])
    .filter(style => typeof style === 'string' && style.trim()))].sort();
  if (values.style && !styleOptions.includes(values.style)) styleOptions.push(values.style);
  const length = playlistLengthValue(values);
  const change = patch => {if (!disabled) onChange?.(patch);};
  return <div className="playlists__filters playlists__rich-filters tag-editor-form" aria-label="Playlist filter choices">
    {children}
    <NativeChoice runtime={runtime} label="Love" value={values.love} disabled={disabled} options={[
      ['all', 'Any love'], ['loved', 'Only loved'], ['obsessed', 'Only obsessed'],
    ]} onChange={love => change({love})}/>
    <NativeChoice runtime={runtime} label="Style" value={values.style} disabled={disabled} options={[
      ['', 'Any style'], ...styleOptions.map(style => [style, style]),
    ]} onChange={style => change({style})}/>
    <NativeChoice runtime={runtime} label="Length" value={length} disabled={disabled} options={[
      ['all', 'Any length'], ['short', 'Under 3 min'], ['medium', '3–5 min'], ['long', 'Over 5 min'], ['epic', 'Over 8 min'],
      ...(length === 'custom' ? [['custom', 'Custom range']] : []),
    ]} onChange={value => {const preset = PLAYLIST_LENGTH_PRESETS[value]; if (preset) change(preset);}}/>
    <NativeChoice runtime={runtime} label="Added" controlLabelPrefix="Added" value={values.addedWithinDays === null ? 'all' : String(values.addedWithinDays)} disabled={disabled} options={[
      ['all', 'Any time'], ['1', 'Last day'], ['7', 'Last week'], ['30', 'Last month'], ['90', 'Last 3 months'],
    ]} onChange={value => change({addedWithinDays: value === 'all' ? null : Number(value)})}/>
    <NativeChoice runtime={runtime} label="Listening" controlLabelPrefix="Listening" value={values.frequency} disabled={disabled} options={[
      ['all', 'Any frequency'], ['frequent', 'A lot (20+)'], ['mid', 'Mid (10–19)'], ['barely', 'Barely (<10)'], ['forgotten', 'Forgotten (6+ months)'],
    ]} onChange={frequency => change({frequency, ...(frequency === 'all' ? {frequencyMode: 'only'} : {})})}/>
    {values.frequency !== 'all' && <NativeChoice runtime={runtime} label="Match" value={values.frequencyMode} disabled={disabled}
      options={ [['only', 'Show these'], ['exclude', 'Filter these out']] } onChange={frequencyMode => change({frequencyMode})}/>}
    <Button runtime={runtime} icon="undo" disabled={disabled || !resetEnabled} onClick={() => {
      if (!disabled && resetEnabled) {if (onReset) onReset(); else change(DEFAULT_PLAYLIST_FILTERS);}
    }}>Reset filters</Button>
    <p className="playlists__note">{values.includeUnknown ? 'Unknown filter values remain visible.' : 'Unknown filter values are excluded when that filter is active.'} Filters change this view only.</p>
  </div>;
}
