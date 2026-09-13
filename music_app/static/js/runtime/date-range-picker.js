/* Shared themed calendar. Consumers own timezone conversion and submission. */
function buildDateRangePicker({ fromDate = '', toDate = '' } = {}) {
  return `<div class="date-range-picker" data-date-range-picker>
    ${[['fromDate', 'From date', fromDate], ['toDate', 'To date', toDate]].map(([name, label, value]) => `<div class="date-range-picker__field"><span>${label}</span><div class="date-range-picker__control"><input type="text" name="${name}" aria-label="${label}" value="${escapeHtml(value)}" readonly required>${window.ButtonComponent.renderActionButton({ icon: 'calendar', ariaLabel: `Choose ${label.toLowerCase()}`, attributes: { 'data-calendar-trigger': name, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } })}</div></div>`).join('')}
  </div>`;
}

function mountDateRangePicker(container) {
  const root = container.querySelector('[data-date-range-picker]');
  let popup, trigger, input, month;
  const close = (restore = false) => {
    if (!popup) return;
    clearTriggerAnchor(popup); popup.remove(); popup = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus();
  };
  const limits = () => ({ min: input.name === 'toDate' ? root.querySelector('[name="fromDate"]').value : '', max: input.name === 'fromDate' ? root.querySelector('[name="toDate"]').value : '' });
  const position = () => {
    if (!popup) return;
    const rect = trigger.getBoundingClientRect(), width = Math.min(292, window.innerWidth - 32);
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
    const height = popup.getBoundingClientRect().height;
    popup.style.top = `${Math.max(16, rect.bottom + height + 20 <= window.innerHeight ? rect.bottom + 4 : rect.top - height - 4)}px`;
    syncTriggerAnchor(popup, trigger);
  };
  const render = (key = input.value) => {
    popup.innerHTML = `<div class="calendar-picker__content ui-scrollbar">${buildCalendarMonth({ year: month.getFullYear(), month: month.getMonth(), selected: input.value, ...limits() })}</div>`;
    position();
    (popup.querySelector(`[data-calendar-date="${key}"]:not(:disabled)`) || popup.querySelector('[data-calendar-date]:not(:disabled)') || popup.querySelector('button')).focus();
  };
  const click = event => {
    const button = event.target.closest('[data-calendar-trigger]');
    if (!button) return;
    if (popup && trigger === button) { close(true); return; }
    close(); trigger = button;
    input = root.querySelector(`[name="${button.dataset.calendarTrigger}"]`);
    month = input.value ? new Date(`${input.value}T12:00:00`) : new Date();
    popup = document.createElement('div'); popup.className = 'calendar-picker ui-scrollbar';
    popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', button.getAttribute('aria-label'));
    container.appendChild(popup); trigger.setAttribute('aria-expanded', 'true');
    popup.addEventListener('click', e => {
      const date = e.target.closest('[data-calendar-date]'), nav = e.target.closest('[data-calendar-month]');
      if (date && !date.disabled) { input.value = date.dataset.calendarDate; input.dispatchEvent(new Event('input', { bubbles: true })); close(true); }
      else if (nav) { month = new Date(month.getFullYear(), month.getMonth() + Number(nav.dataset.calendarMonth), 1); render(); }
    });
    popup.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      const day = e.target.closest('[data-calendar-date]'), offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!day || !offset) return;
      e.preventDefault();
      const next = new Date(`${day.dataset.calendarDate}T12:00:00`); next.setDate(next.getDate() + offset);
      const key = calendarDateKey(next), { min, max } = limits();
      if ((min && key < min) || (max && key > max)) return;
      month = next; render(key);
    });
    render();
  };
  const outside = e => { if (popup && !popup.contains(e.target) && !trigger.contains(e.target)) close(); };
  root.addEventListener('click', click);
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
  return () => {
    close(); root.removeEventListener('click', click); document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
  };
}

function calendarDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildCalendarMonth({ year, month, selected = '', min = '', max = '' }) {
  const first = new Date(year, month, 1), today = calendarDateKey(new Date());
  const days = Array.from({ length: first.getDay() }, () => '<span></span>');
  for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
    const date = new Date(year, month, day), key = calendarDateKey(date);
    days.push(window.ButtonComponent.renderButton({ label: String(day), className: 'calendar-picker__day', ariaLabel: date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), disabled: Boolean((min && key < min) || (max && key > max)), attributes: { 'data-calendar-date': key, 'aria-pressed': String(key === selected), 'aria-current': key === today ? 'date' : null } }));
  }
  return `<div class="calendar-picker__header">${window.ButtonComponent.renderActionButton({ icon: 'previous', ariaLabel: 'Previous month', attributes: { 'data-calendar-month': '-1' } })}<strong aria-live="polite">${escapeHtml(first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</strong>${window.ButtonComponent.renderActionButton({ icon: 'next', ariaLabel: 'Next month', attributes: { 'data-calendar-month': '1' } })}</div><div class="calendar-picker__weekdays">${Array.from({ length: 7 }, (_, day) => `<span>${escapeHtml(new Date(2023, 0, day + 1).toLocaleDateString(undefined, { weekday: 'short' }))}</span>`).join('')}</div><div class="calendar-picker__days">${days.join('')}</div>`;
}
