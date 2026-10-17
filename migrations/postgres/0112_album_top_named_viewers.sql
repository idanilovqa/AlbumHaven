-- Named viewers receive artifact access only; capability and media policy stay unchanged.
alter table app.album_list_access_grants drop constraint album_list_access_grants_role_check;
alter table app.album_list_access_grants add constraint album_list_access_grants_role_check
  check(role in ('viewer','editor'));

alter table app.album_list_operations drop constraint album_list_operations_action_check;
alter table app.album_list_operations add constraint album_list_operations_action_check check(action in (
  'create','save','add','remove','reorder','delete','visibility','grant_editor','grant_viewer','revoke_editor',
  'request_edit','decide_edit_request','copy','set_manual_completion','enable_external','revoke_external'));

do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant update(role) on app.album_list_access_grants to album_haven_app;
  end if;
end $$;

-- Turning off library-wide sharing must preserve current named viewers' requests.
-- Deletion, revoked grants, disabled accounts and lost capabilities still retire intent.
create or replace function app.retire_album_top_edit_requests() returns trigger
language plpgsql set search_path=pg_catalog,app as $$
begin
  if TG_TABLE_NAME='accounts' then
    update app.album_list_edit_requests set status='revoked',resolved_at=now()
      where requester_account_id=NEW.id and status='pending';
    return NEW;
  elsif TG_TABLE_NAME='album_lists' then
    update app.album_list_edit_requests set status='revoked',resolved_at=now()
      where top_ref=NEW.ref and status='pending'
        and (NEW.deleted_at is not null or not exists(
          select 1 from app.album_list_access_grants g
          where g.top_ref=NEW.ref and g.library_id=NEW.library_id
            and g.account_id=requester_account_id and g.role='viewer'));
    return NEW;
  elsif TG_TABLE_NAME='album_list_access_grants' then
    update app.album_list_edit_requests set status='revoked',resolved_at=now()
      where top_ref=OLD.top_ref and requester_account_id=OLD.account_id and status='pending';
    return OLD;
  end if;
  update app.album_list_edit_requests set status='revoked',resolved_at=now()
    where requester_account_id=OLD.account_id and status='pending'
      and OLD.id=any(browse_grant_ids);
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
