drop index if exists ops.cover_lookup_tasks_task_key_idx;

create unique index if not exists cover_lookup_tasks_task_key_idx
  on ops.cover_lookup_tasks (
    library_id,
    (metadata->>'source_family'),
    task_key
  )
  where library_id is not null
    and metadata ? 'source_family';
