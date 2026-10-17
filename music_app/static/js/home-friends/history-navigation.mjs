import {mountButton, mountChoice} from './native-controls.mjs';
let sequence = 0;
export function mountHistoryNavigation(host, runtime, initial) {
  let props, pending, failure, focus, disposed = false, draftPage, draftQuery;
  const errorId = `home-history-error-${++sequence}`;
  const node = (parent, tag, className, text) => {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; parent.append(element); return element;};
  host.classList.add('home-history-navigation'); host.setAttribute('aria-label', 'Listening history pages');
  const summary = node(host, 'p', 'home-history-navigation__summary'); for (const [key, value] of [['role','status'],['aria-live','polite'],['aria-atomic','true'],['tabindex','-1']]) summary.setAttribute(key, value);
  const controls = node(host, 'div', 'home-history-navigation__controls'), previousHost = node(controls, 'span'), choiceHost = node(controls, 'span', 'home-history-navigation__choice'), nextHost = node(controls, 'span'), moreHost = node(controls, 'span');
  const form = node(controls, 'form', 'tag-editor-form home-history-navigation__jump'); form.noValidate = true; form.setAttribute('aria-label', 'Jump to history page');
  const label = node(form, 'label', '', 'Go to page'), input = node(label, 'input'); input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]*';
  const goHost = node(form, 'span'), errorHost = node(host, 'div'), statusHost = node(host, 'div', 'home-history-navigation__status'), statusMessage = node(statusHost, 'div'), retryHost = node(statusHost, 'span'); errorHost.id = errorId;
  const previous = mountButton(previousHost, runtime, {label: 'Previous history page'}), next = mountButton(nextHost, runtime, {label: 'Next history page'}), more = mountButton(moreHost, runtime, {label: 'Load more history'}), go = mountButton(goHost, runtime, {label: 'Go', type: 'submit'}), retry = mountButton(retryHost, runtime, {label: 'Retry history loading'}), choice = mountChoice(choiceHost, runtime, {label: 'History page', options: []});
  const visible = () => ['ready', 'empty'].includes(props.value?.status) && ['numbered', 'progressive'].includes(props.navigation?.mode);
  const busy = () => props.navigation?.status === 'loading' || Boolean(pending && pending.queryKey === props.queryKey);
  function clearError() {errorHost.replaceChildren(); input.setAttribute('aria-invalid', 'false'); input.removeAttribute('aria-describedby');}
  function restoreFocus() {
    if (busy() || !focus) return; const saved = focus; focus = null;
    if (!visible() || saved.queryKey !== props.queryKey || !host.isConnected) return;
    const active = host.ownerDocument.activeElement; if (active && active !== host.ownerDocument.body && active.isConnected) return;
    const target = host.contains(saved.control) && !saved.control.disabled ? saved.control : summary;
    if (target && !target.closest('[hidden],[inert]')) target.focus({preventScroll: true});
  }
  function run(callback, control) {
    if (disposed || typeof callback !== 'function' || busy() || pending || !host.isConnected || !visible()) return;
    const queryKey = props.queryKey, navigation = props.navigation, active = host.ownerDocument.activeElement, source = host.contains(active) ? active : control;
    focus = source ? {queryKey, control: source} : null; const token = {queryKey}; pending = token; failure = null; render();
    const release = () => {if (pending !== token || disposed) return; pending = null; render(); restoreFocus();};
    const reject = () => {if (pending === token && visible() && props.queryKey === queryKey && props.navigation === navigation) failure = {queryKey, navigation}; release();};
    try {Promise.resolve(callback()).then(release, reject);} catch {reject();}
  }
  function selectPage(target, control) {const navigation = props.navigation; if (navigation?.mode !== 'numbered' || typeof props.onPage !== 'function' || !Number.isSafeInteger(target) || target < 1 || target > navigation.totalPages || target === navigation.page) return; run(() => props.onPage(target), control);}
  function submit(event) {
    event.preventDefault(); if (busy() || !visible() || props.navigation.mode !== 'numbered') return;
    const text = input.value.trim(), target = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(target) || target < 1 || target > props.navigation.totalPages) {errorHost.innerHTML = runtime.alertHtml({severity: 'error', role: 'alert', message: `Enter a whole page number from 1 to ${props.navigation.totalPages}.`}); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', errorId); return;}
    clearError(); selectPage(target, input);
  }
  form.addEventListener('submit', submit); input.addEventListener('input', clearError);
  function render() {
    if (disposed) return;
    host.hidden = !visible();
    if (host.hidden) {
      // Unreadable resources retire the local operation even if query identity
      // is unchanged. Late completion must not affect a recovered owner.
      pending = failure = focus = null;
      draftPage = draftQuery = undefined;
      summary.textContent = ''; input.value = ''; input.removeAttribute('value');
      input.disabled = true; clearError(); statusMessage.replaceChildren();
      form.hidden = statusHost.hidden = retryHost.hidden = true;
      host.setAttribute('aria-busy', 'false');
      previous.update({label: 'Previous history page', icon: 'previous', disabled: true});
      next.update({label: 'Next history page', icon: 'next', disabled: true});
      more.update({label: 'Load more history', disabled: true});
      go.update({label: 'Go', type: 'submit', disabled: true});
      retry.update({label: 'Retry history loading', disabled: true});
      // Updating the real Choice owner clears its selected text/title/ARIA
      // label and closes any externally mounted popup without restoring focus.
      choice.update({label: 'History page', showLabel: false, value: '', options: [], disabled: true});
      return;
    }
    const navigation = props.navigation, numbered = navigation.mode === 'numbered', page = navigation.page, working = busy(); host.setAttribute('aria-busy', String(working));
    summary.textContent = numbered ? `Page ${page} of ${navigation.totalPages} · ${navigation.loadedCount ? `Items ${(page - 1) * navigation.pageSize + 1}–${(page - 1) * navigation.pageSize + navigation.loadedCount} of ${navigation.totalRows}` : '0 items'} · ${navigation.pageSize} per page` : `${navigation.loadedCount} items shown · ${navigation.hasMore ? 'More history available' : 'End of available history'}`;
    previousHost.hidden = choiceHost.hidden = nextHost.hidden = !numbered; moreHost.hidden = numbered; form.hidden = !numbered || navigation.totalPages <= 1;
    previous.update({label: 'Previous history page', icon: 'previous', disabled: working || page <= 1 || typeof props.onPage !== 'function', onClick: () => selectPage(props.navigation.page - 1)});
    next.update({label: 'Next history page', icon: 'next', disabled: working || page >= navigation.totalPages || typeof props.onPage !== 'function', onClick: () => selectPage(props.navigation.page + 1)});
    const pageNumbers = numbered ? [...new Set([1, navigation.totalPages, ...[-2,-1,0,1,2].map(offset => page + offset)])].filter(number => number >= 1 && number <= navigation.totalPages).sort((a,b) => a-b) : [];
    choice.update({label: 'History page', showLabel: false, value: String(page), disabled: working || navigation.totalPages <= 1 || typeof props.onPage !== 'function', options: pageNumbers.map(number => [String(number), `Page ${number} of ${navigation.totalPages} · ${navigation.pageSize} per page`]), onChange: value => selectPage(Number(value), choiceHost.querySelector('button'))});
    more.update({label: 'Load more history', disabled: working || !navigation.hasMore || typeof props.onLoadMore !== 'function', onClick: () => {if (props.navigation.hasMore) run(props.onLoadMore);}});
    input.disabled = working || typeof props.onPage !== 'function'; go.update({label: 'Go', type: 'submit', disabled: input.disabled});
    if (draftPage !== page || draftQuery !== props.queryKey) {draftPage = page; draftQuery = props.queryKey; input.value = String(page ?? ''); clearError();}
    const message = working ? numbered ? navigation.requestedPage ? `Loading page ${navigation.requestedPage}…` : 'Loading history page…' : 'Loading more history…' : navigation.status === 'error' ? numbered ? `Page ${navigation.requestedPage} could not be loaded. Your current page is still shown.` : 'More history could not be loaded. Your listening history is still shown.' : failure && failure.queryKey === props.queryKey && failure.navigation === navigation ? 'History navigation could not be started. Try choosing again.' : '';
    statusHost.hidden = !message; statusMessage.innerHTML = message ? runtime.alertHtml({severity: working ? 'info' : 'error', role: working ? 'status' : 'alert', message}) : ''; retryHost.hidden = navigation.status !== 'error';
    retry.update({label: 'Retry history loading', disabled: working || typeof props.onRetry !== 'function', onClick: () => run(props.onRetry)}); restoreFocus();
  }
  function update(nextProps) {if (disposed) return; if (props?.queryKey !== nextProps.queryKey) {pending = null; failure = null; focus = null;} props = nextProps; render();}
  update(initial); return {element: host, update, dispose() {if (!disposed) {disposed = true; pending = focus = null; form.removeEventListener('submit', submit); input.removeEventListener('input', clearError); for (const owner of [previous,next,more,go,retry,choice]) owner.dispose(); host.replaceChildren();}}};
}
