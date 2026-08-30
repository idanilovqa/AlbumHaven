with bootstrap_context as (
  select app.bootstrap_owners.account_id
  from app.bootstrap_owners
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  limit 1
),
updated_account as (
  update app.accounts
     set display_name = 'nominem',
         metadata = app.accounts.metadata || jsonb_build_object(
           'source', 'phase_6_bootstrap_owner_nominem_migration',
           'display_name', 'nominem'
         )
  from bootstrap_context
  where app.accounts.id = bootstrap_context.account_id
  returning app.accounts.id
)
update app.bootstrap_owners
   set metadata = app.bootstrap_owners.metadata || jsonb_build_object(
     'source', 'phase_6_bootstrap_owner_nominem_migration',
     'display_name', 'nominem'
   )
from bootstrap_context
where app.bootstrap_owners.account_id = bootstrap_context.account_id
  and app.bootstrap_owners.owner_key = 'local-bootstrap-owner';
