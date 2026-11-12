-- Keep notification position independent of search retries and older writers.
create or replace function ops.preserve_cover_notification_order()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  notification_order_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    notification_order_at := coalesce(
      nullif(old.metadata ->> 'notification_order_at', '')::timestamptz,
      old.completed_at,
      old.requested_at
    );
  else
    notification_order_at := coalesce(
      nullif(new.metadata ->> 'notification_order_at', '')::timestamptz,
      new.requested_at
    );
  end if;

  new.metadata := new.metadata || jsonb_build_object(
    'notification_order_at', notification_order_at
  );
  return new;
end;
$$;

revoke all on function ops.preserve_cover_notification_order() from public;

drop trigger if exists cover_lookup_notification_order on ops.cover_lookup_tasks;
create trigger cover_lookup_notification_order
before insert or update on ops.cover_lookup_tasks
for each row execute function ops.preserve_cover_notification_order();
