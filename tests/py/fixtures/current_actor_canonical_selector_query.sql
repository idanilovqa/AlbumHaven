
                select app.accounts.id as account_id,
                       app.accounts.username_display,
                       app.accounts.display_name,
                       app.accounts.is_active,
                       app.accounts.disabled_at,
                       exists (
                         select 1
                         from app.bootstrap_owners
                         where app.bootstrap_owners.account_id = app.accounts.id
                           and app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                       ) as is_bootstrap_owner,
                       (
                         select library.libraries.id
                         from app.bootstrap_owners as runtime_owner
                         join library.libraries
                           on library.libraries.owner_account_id = runtime_owner.account_id
                         where runtime_owner.owner_key = 'local-bootstrap-owner'
                           and library.libraries.library_kind = 'local'
                         order by library.libraries.id
                         limit 1
                       ) as current_library_id,
                       coalesce((
                         select jsonb_agg(
                           jsonb_build_object(
                             'library_id', library.library_memberships.library_id,
                             'membership_role', library.library_memberships.membership_role,
                             'is_primary_owner',
                               library.libraries.owner_account_id = app.accounts.id
                           ) order by library.library_memberships.library_id
                         )
                         from library.library_memberships
                         join library.libraries
                           on library.libraries.id =
                              library.library_memberships.library_id
                         where library.library_memberships.account_id = app.accounts.id
                       ), '[]'::jsonb) as library_relationships,
                       coalesce((
                         select jsonb_agg(
                           jsonb_build_object(
                             'capability_key', app.capabilities.capability_key,
                             'scope_kind', app.capabilities.scope_kind,
                             'scope_id', app.capabilities.scope_id
                           ) order by app.capabilities.capability_key,
                                      app.capabilities.scope_kind,
                                      app.capabilities.scope_id nulls first
                         )
                         from app.capabilities
                         where app.capabilities.account_id = app.accounts.id
                           and app.capabilities.revoked_at is null
                       ), '[]'::jsonb) as capability_grants
                from app.accounts
                where app.accounts.id = %s
                