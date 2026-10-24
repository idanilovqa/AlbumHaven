const ready = value => ['ready', 'empty'].includes(value?.status);
const matches = (left, right) => left && right && left.account_ref === right.account_ref
  && left.kind === right.kind && left.period === right.period;

// A changed React query renders before its data-loading effect. Do not expose
// the previous query's rows or pagination controls beneath the new heading.
export function activityForQuery(snapshot, query) {
  return ready(snapshot.activity) && !matches(snapshot.activityNavigation?.query, query)
    ? {status: 'loading', data: null} : snapshot.activity;
}

// Shared by own and selected-friend history. The model owns all data requests;
// this boundary prevents stale controls and late scroll effects across UI routes.
export async function navigateActivityHistory({controller, snapshot, query, method, target,
  isCurrent, onIntent, onPageCommitted}) {
  const navigation = snapshot.activityNavigation;
  const current = () => isCurrent() && controller.getSnapshot() === snapshot
    && matches(navigation?.query, query);
  if (!['loadActivityPage', 'loadMoreActivity', 'retryActivityNavigation'].includes(method)
    || typeof controller[method] !== 'function' || !current()) return false;
  onIntent?.();
  if (!current()) return false;
  const page = method === 'loadActivityPage' ? target : method === 'retryActivityNavigation' ? navigation.requestedPage : null;
  const result = await controller[method](target), next = controller.getSnapshot();
  if (page !== null && ready(result) && isCurrent() && next.scopeKey === snapshot.scopeKey
    && next.activityNavigation.query === navigation.query && next.activityNavigation.status === 'idle'
    && next.activityNavigation.page === page) onPageCommitted?.();
  return result;
}
