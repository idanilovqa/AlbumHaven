alter table app.user_appearance_preferences
  add column if not exists alert_family text not null default 'ember';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'app.user_appearance_preferences'::regclass
      and conname = 'user_appearance_alert_family_shape'
  ) then
    alter table app.user_appearance_preferences
      add constraint user_appearance_alert_family_shape check (
        alert_family in ('ember', 'signal', 'quiet')
      );
  end if;
end $$;
