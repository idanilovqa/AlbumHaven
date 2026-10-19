-- Private immutable URL acquisition evidence, separate from original source.
alter table app.album_top_source_jobs add column url_acquisition jsonb
  check (url_acquisition is null or (jsonb_typeof(url_acquisition)='object'
    and octet_length(url_acquisition::text)<=3145728));
alter table app.album_top_source_jobs add constraint album_top_url_evidence_complete
  check (source->>'kind'<>'url' or status<>'completed' or url_acquisition is not null);
create function app.guard_album_top_url_evidence() returns trigger language plpgsql as $$
begin
  if (old.url_acquisition is not null and new.url_acquisition is distinct from old.url_acquisition)
     or (new.url_acquisition is not null and
         (new.source->>'kind'<>'url' or (old.url_acquisition is null and
          (old.status<>'running' or new.status<>'completed')))) then
    raise exception 'URL acquisition evidence is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger album_top_url_evidence_guard before update on app.album_top_source_jobs
  for each row execute function app.guard_album_top_url_evidence();
revoke all on function app.guard_album_top_url_evidence() from public;
