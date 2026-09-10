with ranked_transactions as (
  select id,
         row_number() over (
           partition by reset_token_id
           order by created_at, id
         ) as exchange_number
  from app.password_reset_transactions
)
delete from app.password_reset_transactions transaction
using ranked_transactions ranked
where transaction.id = ranked.id
  and ranked.exchange_number > 1;

create unique index if not exists password_reset_transactions_reset_token_unique_idx
  on app.password_reset_transactions (reset_token_id);
