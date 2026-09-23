function getTagEditorReorderInsertionBefore(rows, draggedPath, clientY) {
  const dragged = String(draggedPath || '');
  const pointerY = Number(clientY);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.path || '') !== dragged)
    .find((row) => pointerY < Number(row?.top || 0) + (Number(row?.height || 0) / 2))
    ?.path || null;
}

function reorderTagEditorTracksByPath(tracks, draggedPath, beforePath = null) {
  const current = Array.isArray(tracks) ? tracks : [];
  const dragged = String(draggedPath || '');
  const sourceIndex = current.findIndex((track) => String(track?.path || '') === dragged);
  if (sourceIndex < 0) return current.slice();
  const next = current.slice();
  const [moved] = next.splice(sourceIndex, 1);
  const target = String(beforePath || '');
  const targetIndex = target
    ? next.findIndex((track) => String(track?.path || '') === target)
    : next.length;
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, moved);
  return next;
}
