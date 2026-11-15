-- depends on: 0220_create_durable_job_foundation.sql
create index if not exists job_transitions_retention_idx
  on ops.job_transitions (transitioned_at, id);
