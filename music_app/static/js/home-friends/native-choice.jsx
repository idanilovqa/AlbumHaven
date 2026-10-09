import React, {useLayoutEffect, useRef} from 'react';

const chevron = '<svg class="ui-choice__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';

// React owns the stable trigger and current values. The canonical Choice owner
// retains the menu, anchored surface, keyboard behavior and focus return.
export function NativeChoice({runtime, label, value, options = [], onChange, disabled = false, showLabel = true,
  className = '', buttonClassName = '', matchTriggerWidth = true, menuWidth, controlLabelPrefix = ''}) {
  const root = useRef(null), owner = useRef(null), latest = useRef(null);
  const choices = options.map(option => Array.isArray(option)
    ? {value: String(option[0]), label: String(option[1]), disabled: option[2] === true}
    : {value: String(option.value), label: String(option.label), disabled: option.disabled === true});
  const selected = String(value ?? ''), selectedLabel = choices.find(option => option.value === selected)?.label || '';
  const unavailable = disabled || typeof runtime.openChoice !== 'function' || !choices.some(option => !option.disabled);
  latest.current = {choices, selected, label, onChange, unavailable, matchTriggerWidth, menuWidth};
  const visibleLabel = controlLabelPrefix && selectedLabel ? `${controlLabelPrefix}: ${selectedLabel}` : selectedLabel;
  const html = runtime.buttonHtml({label: visibleLabel, size: 'small', disabled: unavailable,
    className: ['ui-choice__trigger', buttonClassName].filter(Boolean).join(' '),
    ariaLabel: selectedLabel ? `${label}: ${selectedLabel}` : label, title: selectedLabel ? `${label}: ${selectedLabel}` : label,
    attributes: {'aria-haspopup': 'menu', 'aria-expanded': 'false'},
  }).replace('</button>', `${chevron}</button>`);
  const initial = useRef(html), choicesKey = JSON.stringify(choices);
  useLayoutEffect(() => {
    const host = root.current;
    const open = initialFocus => {
      const current = latest.current, trigger = host.firstElementChild;
      if (current.unavailable || !trigger || trigger.disabled) return;
      owner.current = runtime.openChoice(trigger, {formats: current.choices, selected: current.selected, label: current.label,
        matchTriggerWidth: current.matchTriggerWidth, menuWidth: current.menuWidth, density: 'compact', initialFocus, updateTriggerLabel: false,
        onSelect: next => {
          const active = latest.current;
          if (!active.unavailable && active.choices.some(option => option.value === next && !option.disabled)) active.onChange?.(next);
        },
      });
    };
    const click = event => {
      if (!event.target.closest('button')) return;
      event.preventDefault(); open('selected');
    };
    const keydown = event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !event.target.closest('button') || latest.current.unavailable) return;
      event.preventDefault(); event.stopPropagation();
      if (!owner.current?.isOpen) open(event.key === 'ArrowUp' ? 'last' : 'selected');
    };
    host.addEventListener('click', click); host.addEventListener('keydown', keydown);
    return () => {
      host.removeEventListener('click', click); host.removeEventListener('keydown', keydown);
      owner.current?.close(); owner.current = null;
    };
  }, [runtime]);
  useLayoutEffect(() => {
    owner.current?.close({restoreFocus: !unavailable}); owner.current = null;
    const current = root.current.firstElementChild;
    const holder = root.current.ownerDocument.createElement('span'); holder.innerHTML = html;
    const next = holder.firstElementChild;
    // Keep the focused native button in place across value/permission updates.
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
  }, [html, choicesKey, selected, runtime, matchTriggerWidth, menuWidth]);
  return <span className={['ui-choice', className].filter(Boolean).join(' ')}>
    {showLabel && <span className="ui-choice__label">{label}</span>}
    <span ref={root} className="ui-choice__control" dangerouslySetInnerHTML={{__html: initial.current}}/>
  </span>;
}
