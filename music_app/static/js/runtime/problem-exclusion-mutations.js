const problemExclusionRequestChains = new Map();

function getProblemExclusionMutationJournal() {
  const utility = state.utility || (state.utility = {});
  if (!utility.problemExclusionMutations) {
    utility.problemExclusionMutations = {
      nextOperationId: 1,
      revision: 0,
      latestByRowKey: {},
      pendingByOperationId: {},
      acknowledgedCreates: [],
    };
  }
  utility.problemExclusionMutations.revision = Number(
    utility.problemExclusionMutations.revision || 0,
  );
  if (!Array.isArray(utility.problemExclusionMutations.acknowledgedCreates)) {
    utility.problemExclusionMutations.acknowledgedCreates = [];
  }
  return utility.problemExclusionMutations;
}

function readProblemExclusionMutationRevision() {
  return Number(getProblemExclusionMutationJournal().revision || 0);
}

function advanceProblemExclusionMutationRevision() {
  const journal = getProblemExclusionMutationJournal();
  journal.revision = Number(journal.revision || 0) + 1;
  return journal.revision;
}

function cloneProblemExclusionValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function problemExclusionReason(item) {
  return String(item?.problem_reason || item?.reason || '').trim();
}

function projectProblemExclusionFromAlbum(album, selectedItems) {
  const source = cloneProblemExclusionValue(album || {});
  const items = (Array.isArray(selectedItems) ? selectedItems : [])
    .filter((item) => String(item?.row_key || '').trim());
  const albumRows = Array.isArray(source.album_problem_rows)
    ? source.album_problem_rows
    : [];
  const albumReasons = new Set();
  const selectedAlbumKeys = new Set();
  const selectedFileReasons = new Map();

  items.forEach((item) => {
    const rowKey = String(item.row_key || '').trim();
    if (item.scope === 'album') {
      selectedAlbumKeys.add(rowKey);
      const sourceRow = albumRows.find((row) => String(row?.row_key || '') === rowKey);
      const reason = problemExclusionReason(item) || problemExclusionReason(sourceRow);
      if (reason) albumReasons.add(reason);
      return;
    }
    if (item.scope !== 'file') return;
    const path = String(item.path || '').trim();
    const reason = problemExclusionReason(item);
    if (!path || !reason) return;
    const reasons = selectedFileReasons.get(path) || new Set();
    reasons.add(reason);
    selectedFileReasons.set(path, reasons);
  });

  source.album_problem_rows = albumRows.filter((row) => {
    const rowKey = String(row?.row_key || '').trim();
    return !selectedAlbumKeys.has(rowKey) && !albumReasons.has(problemExclusionReason(row));
  });
  source.track_problem_rows = (Array.isArray(source.track_problem_rows)
    ? source.track_problem_rows
    : []).map((row) => {
    const path = String(row?.path || '').trim();
    const fileReasons = selectedFileReasons.get(path) || new Set();
    const shouldRemoveReason = (reason) => (
      albumReasons.has(String(reason || '').trim())
      || fileReasons.has(String(reason || '').trim())
    );
    return {
      ...row,
      reasons: (Array.isArray(row?.reasons) ? row.reasons : [])
        .filter((reason) => !shouldRemoveReason(reason)),
      ignorable_reasons: (Array.isArray(row?.ignorable_reasons) ? row.ignorable_reasons : [])
        .filter((reasonItem) => !shouldRemoveReason(problemExclusionReason(reasonItem))),
    };
  }).filter((row) => row.reasons.length);

  const retainedReasons = new Set([
    ...source.album_problem_rows.map((row) => problemExclusionReason(row)),
    ...source.track_problem_rows.flatMap((row) => row.reasons || []),
  ].map((reason) => String(reason || '').trim()).filter(Boolean));
  const originalReasonOrder = Array.isArray(source.problem_reasons)
    ? source.problem_reasons
    : [];
  source.problem_reasons = [
    ...originalReasonOrder.filter((reason) => retainedReasons.delete(String(reason || '').trim())),
    ...retainedReasons,
  ];
  source.issue_count = source.problem_reasons.length;

  const optimisticRuleItems = items.map((item) => ({
    ...cloneProblemExclusionValue(item),
    pending: true,
  }));
  return {
    updatedAlbum: source.problem_reasons.length ? source : null,
    optimisticRuleItems,
  };
}

function collectProblemIgnoreItems(rule) {
  const combined = [
    ...(Array.isArray(rule?.items) ? rule.items : []),
    ...(Array.isArray(rule?.album_items)
      ? rule.album_items.map((item) => ({ ...item, scope: item.scope || 'album' }))
      : []),
    ...(Array.isArray(rule?.file_items)
      ? rule.file_items.map((item) => ({ ...item, scope: item.scope || 'file' }))
      : []),
  ];
  const byKey = new Map();
  combined.forEach((item) => {
    const rowKey = String(item?.row_key || '').trim();
    if (rowKey) byKey.set(rowKey, item);
  });
  return Array.from(byKey.values());
}

function replaceProblemIgnoreRule(rules, items) {
  const sourceRules = Array.isArray(rules) ? rules : [];
  const existingIndex = sourceRules.findIndex((rule) => rule?.key === 'problem-ignores');
  const existing = existingIndex >= 0 ? sourceRules[existingIndex] : null;
  const normalizedItems = Array.from(new Map(
    (Array.isArray(items) ? items : [])
      .map((item) => [String(item?.row_key || '').trim(), item])
      .filter(([rowKey]) => rowKey),
  ).values());
  const nextRule = {
    ...(existing || {
      key: 'problem-ignores',
      title: 'Problem exclusions',
      description: 'Album or file problems excluded from Problematic Files.',
    }),
    count: normalizedItems.length,
    items: normalizedItems,
    album_items: normalizedItems.filter((item) => item.scope === 'album'),
    file_items: normalizedItems.filter((item) => item.scope === 'file'),
  };
  if (existingIndex < 0) return [...sourceRules, nextRule];
  return sourceRules.map((rule, index) => (index === existingIndex ? nextRule : rule));
}

function beginProblemExclusionMutation({ kind, items, snapshot }) {
  const journal = getProblemExclusionMutationJournal();
  const id = Number(journal.nextOperationId || 1);
  journal.nextOperationId = id + 1;
  const operation = {
    id,
    kind: kind === 'revert' ? 'revert' : 'create',
    items: (Array.isArray(items) ? items : []).map((item) => cloneProblemExclusionValue(item)),
    snapshot: cloneProblemExclusionValue(snapshot || {}),
  };
  operation.items.forEach((item) => {
    const rowKey = String(item?.row_key || '').trim();
    if (rowKey) journal.latestByRowKey[rowKey] = id;
  });
  journal.pendingByOperationId[id] = operation;
  advanceProblemExclusionMutationRevision();
  return operation;
}

function isLatestProblemExclusionMutation(operation) {
  if (!operation) return false;
  const journal = getProblemExclusionMutationJournal();
  return operation.items.every((item) => (
    Number(journal.latestByRowKey[String(item?.row_key || '')]) === Number(operation.id)
  ));
}

function removeProblemExclusionOperation(operation) {
  const journal = getProblemExclusionMutationJournal();
  delete journal.pendingByOperationId[operation.id];
  operation.items.forEach((item) => {
    const rowKey = String(item?.row_key || '').trim();
    if (Number(journal.latestByRowKey[rowKey]) === Number(operation.id)) {
      delete journal.latestByRowKey[rowKey];
    }
  });
}

function mergePendingProblemExclusionRules(rules) {
  const journal = getProblemExclusionMutationJournal();
  const existingRule = (Array.isArray(rules) ? rules : [])
    .find((rule) => rule?.key === 'problem-ignores');
  const byKey = new Map(
    collectProblemIgnoreItems(existingRule).map((item) => [String(item.row_key || ''), item]),
  );
  Object.values(journal.pendingByOperationId || {})
    .sort((left, right) => Number(left.id) - Number(right.id))
    .forEach((operation) => {
      operation.items.forEach((item) => {
        const rowKey = String(item?.row_key || '').trim();
        if (!rowKey || Number(journal.latestByRowKey[rowKey]) !== Number(operation.id)) return;
        if (operation.kind === 'revert') {
          byKey.delete(rowKey);
        } else {
          byKey.set(rowKey, { ...item, pending: true });
        }
      });
    });
  return replaceProblemIgnoreRule(rules, Array.from(byKey.values()));
}

function settleProblemExclusionMutation(operation, appliedItems = []) {
  if (!operation) return false;
  const latest = isLatestProblemExclusionMutation(operation);
  if (latest && operation.kind === 'create') {
    const operationKeys = new Set(operation.items.map((item) => String(item?.row_key || '')));
    const currentRule = (state.utility.rules || []).find((rule) => rule?.key === 'problem-ignores');
    const retained = collectProblemIgnoreItems(currentRule)
      .filter((item) => !operationKeys.has(String(item?.row_key || '')));
    const authoritative = (Array.isArray(appliedItems) ? appliedItems : [])
      .map((item) => ({ ...item, pending: false }));
    state.utility.rules = replaceProblemIgnoreRule(state.utility.rules, [
      ...retained,
      ...authoritative,
    ]);
    const albumKey = String(operation?.snapshot?.album?.key || '').trim();
    if (albumKey) {
      const journal = getProblemExclusionMutationJournal();
      journal.acknowledgedCreates.push({
        id: Number(operation.id),
        albumKey,
        items: authoritative.map((item) => cloneProblemExclusionValue(item)),
      });
      journal.acknowledgedCreates = journal.acknowledgedCreates.slice(-64);
    }
  }
  removeProblemExclusionOperation(operation);
  state.utility.rules = mergePendingProblemExclusionRules(state.utility.rules);
  advanceProblemExclusionMutationRevision();
  return latest;
}

function restoreProblematicAlbumSnapshot(operation) {
  const album = operation?.snapshot?.album;
  if (!album) return;
  const albumKey = String(album.key || '');
  const items = Array.isArray(state.utility.problematicFiles)
    ? state.utility.problematicFiles.slice()
    : [];
  const currentIndex = items.findIndex((item) => String(item?.key || '') === albumKey);
  if (currentIndex >= 0) items.splice(currentIndex, 1);
  const insertionIndex = Math.min(
    Math.max(Number(operation.snapshot.albumIndex || 0), 0),
    items.length,
  );
  items.splice(insertionIndex, 0, cloneProblemExclusionValue(album));

  let projectedAlbum = items[insertionIndex];
  const journal = getProblemExclusionMutationJournal();
  const acknowledgedSuccessors = (journal.acknowledgedCreates || [])
    .filter((candidate) => (
      Number(candidate.id) > Number(operation.id)
      && String(candidate.albumKey || '') === albumKey
    ));
  const pendingSuccessors = Object.values(journal.pendingByOperationId || {})
    .filter((candidate) => (
      candidate.id !== operation.id
      && candidate.kind === 'create'
      && String(candidate?.snapshot?.album?.key || '') === albumKey
    ));
  [...acknowledgedSuccessors, ...pendingSuccessors]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .forEach((candidate) => {
      if (!projectedAlbum) return;
      projectedAlbum = projectProblemExclusionFromAlbum(
        projectedAlbum,
        candidate.items,
      ).updatedAlbum;
    });
  if (projectedAlbum) items[insertionIndex] = projectedAlbum;
  else items.splice(insertionIndex, 1);
  state.utility.problematicFiles = items;
  state.utility.selectedProblematicKey = projectedAlbum
    ? String(operation.snapshot.selectedProblematicKey || '')
    : '';
}

function rollbackProblemExclusionMutation(operation) {
  if (!operation) return false;
  if (!isLatestProblemExclusionMutation(operation)) {
    removeProblemExclusionOperation(operation);
    return false;
  }
  const operationKeys = new Set(operation.items.map((item) => String(item?.row_key || '')));
  const currentRule = (state.utility.rules || []).find((rule) => rule?.key === 'problem-ignores');
  const retained = collectProblemIgnoreItems(currentRule)
    .filter((item) => !operationKeys.has(String(item?.row_key || '')));
  const priorRuleItems = Array.isArray(operation.snapshot?.ruleItems)
    ? operation.snapshot.ruleItems
    : [];
  state.utility.rules = replaceProblemIgnoreRule(state.utility.rules, [
    ...retained,
    ...priorRuleItems,
  ]);
  if (operation.kind === 'create') restoreProblematicAlbumSnapshot(operation);
  if (operation.kind === 'revert'
      && Object.prototype.hasOwnProperty.call(operation.snapshot || {}, 'loaded')) {
    state.utility.loaded = operation.snapshot.loaded;
  }
  removeProblemExclusionOperation(operation);
  state.utility.rules = mergePendingProblemExclusionRules(state.utility.rules);
  advanceProblemExclusionMutationRevision();
  return true;
}

function buildProblemExclusionItemFromAlbum(album, rowKey) {
  const key = String(rowKey || '').trim();
  const albumRow = (Array.isArray(album?.album_problem_rows) ? album.album_problem_rows : [])
    .find((row) => String(row?.row_key || '') === key);
  if (albumRow) {
    const durableAlbumKey = String(albumRow.album_key || '').trim();
    return {
      ...albumRow,
      row_key: key,
      scope: 'album',
      album_key: durableAlbumKey || String(album?.key || ''),
      artist: String(album?.album_artist || album?.raw_album_artist || ''),
      album: String(album?.name || album?.raw_name || ''),
      year: String(album?.year || ''),
      problem_reason: problemExclusionReason(albumRow),
    };
  }
  for (const row of (Array.isArray(album?.track_problem_rows) ? album.track_problem_rows : [])) {
    const reasonItem = (Array.isArray(row?.ignorable_reasons) ? row.ignorable_reasons : [])
      .find((item) => String(item?.row_key || '') === key);
    if (!reasonItem) continue;
    return {
      ...reasonItem,
      row_key: key,
      scope: 'file',
      path: String(row.path || ''),
      filename: String(row.filename || (typeof getFilenameFromPath === 'function'
        ? getFilenameFromPath(row.path)
        : '')),
      artist: String(album?.album_artist || album?.raw_album_artist || ''),
      album: String(album?.name || album?.raw_name || ''),
      year: String(album?.year || ''),
      problem_reason: problemExclusionReason(reasonItem),
    };
  }
  return null;
}

function applyOptimisticProblemExclusionCard(album, updatedAlbum) {
  const albumKey = String(album?.key || '');
  const current = Array.isArray(state.utility.problematicFiles)
    ? state.utility.problematicFiles
    : [];
  const index = current.findIndex((item) => String(item?.key || '') === albumKey);
  if (index < 0) return;
  state.utility.problematicFiles = updatedAlbum
    ? current.map((item, itemIndex) => (itemIndex === index ? updatedAlbum : item))
    : current.filter((_item, itemIndex) => itemIndex !== index);
  if (!updatedAlbum && String(state.utility.selectedProblematicKey || '') === albumKey) {
    state.utility.selectedProblematicKey = '';
  }
  state.utility.problemExclusionSelections = {};
  state.utility.pendingRepairAction = '';
  state.utility.loaded = true;
}

function scheduleProblemExclusionRequest(operation, request) {
  const keys = operation.items.map((item) => String(item?.row_key || '')).filter(Boolean);
  const predecessors = Array.from(new Set(
    keys.map((key) => problemExclusionRequestChains.get(key)).filter(Boolean),
  ));
  const completion = predecessors.length
    ? Promise.allSettled(predecessors).then(request)
    : request();
  keys.forEach((key) => problemExclusionRequestChains.set(key, completion));
  completion.finally(() => {
    keys.forEach((key) => {
      if (problemExclusionRequestChains.get(key) === completion) {
        problemExclusionRequestChains.delete(key);
      }
    });
  });
  return completion;
}

async function queueProblemExclusionCreate({ album, items }) {
  const selectedItems = (Array.isArray(items) ? items : []).filter(Boolean);
  const currentRules = state.utility.rules || [];
  const currentRule = currentRules.find((rule) => rule?.key === 'problem-ignores');
  const selectedKeys = new Set(selectedItems.map((item) => String(item?.row_key || '')));
  const albumIndex = (state.utility.problematicFiles || []).findIndex((item) => (
    String(item?.key || '') === String(album?.key || '')
  ));
  const projection = projectProblemExclusionFromAlbum(album, selectedItems);
  const operation = beginProblemExclusionMutation({
    kind: 'create',
    items: projection.optimisticRuleItems,
    snapshot: {
      album,
      albumIndex,
      selectedProblematicKey: state.utility.selectedProblematicKey,
      ruleItems: collectProblemIgnoreItems(currentRule)
        .filter((item) => selectedKeys.has(String(item?.row_key || ''))),
    },
  });
  applyOptimisticProblemExclusionCard(album, projection.updatedAlbum);
  state.utility.rules = mergePendingProblemExclusionRules(currentRules);
  renderUtilityModalContent();
  closeRepairConfirmModal();
  showToast('Problem exclusion queued.', 'success', 2400);

  return scheduleProblemExclusionRequest(operation, async () => {
    try {
      const requestItems = selectedItems.map((item) => (
        item.scope === 'album'
          ? { row_key: item.row_key, scope: 'album', album_key: item.album_key }
          : { row_key: item.row_key, scope: 'file', path: item.path }
      ));
      const response = await fetch('/utilities/rules/problem-ignores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: requestItems }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Problem exclusion failed');
      settleProblemExclusionMutation(operation, data.applied_items || []);
      renderUtilityModalContent();
    } catch (error) {
      console.error('[AlbumHaven][Utilities] Failed to save problem exclusion.', error);
      await waitForProblematicUtilityRenderFrame();
      rollbackProblemExclusionMutation(operation);
      renderUtilityModalContent();
      showToast('Failed to save problem exclusion', 'error', 3200);
    }
  });
}

async function queueProblemExclusionRevert(item) {
  const ruleItem = cloneProblemExclusionValue(item || {});
  const operation = beginProblemExclusionMutation({
    kind: 'revert',
    items: [ruleItem],
    snapshot: {
      ruleItems: [ruleItem],
      loaded: state.utility.loaded,
    },
  });
  state.utility.rules = mergePendingProblemExclusionRules(state.utility.rules);
  renderUtilityModalContent();
  showToast('Problem exclusion revert queued.', 'success', 2400);

  return scheduleProblemExclusionRequest(operation, async () => {
    await waitForProblematicUtilityRenderFrame();
    try {
      const response = await fetch('/utilities/rules/problem-ignores/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_key: ruleItem.row_key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Problem exclusion revert failed');
      settleProblemExclusionMutation(operation);
      state.utility.problematicSummaryRequestToken = Number(
        state.utility.problematicSummaryRequestToken || 0,
      ) + 1;
      state.utility.loaded = false;
      renderUtilityModalContent();
    } catch (error) {
      console.error('[AlbumHaven][Utilities] Failed to revert problem exclusion.', error);
      await waitForProblematicUtilityRenderFrame();
      rollbackProblemExclusionMutation(operation);
      renderUtilityModalContent();
      showToast('Failed to revert problem exclusion', 'error', 3200);
    }
  });
}
