-- Explicit selected-period rollover keeps Reset and all earlier receipts intact.
alter table app.listening_goal_operations drop constraint listening_goal_operations_action_check;
alter table app.listening_goal_operations add constraint listening_goal_operations_action_check
  check (action in ('add','reset','completion','remove','bonus_settings','bonus_draw','transition'));
