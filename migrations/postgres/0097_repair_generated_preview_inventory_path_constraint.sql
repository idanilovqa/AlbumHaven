alter table app.generated_preview_inventory
  drop constraint if exists generated_preview_inventory_relative_path_check;

alter table app.generated_preview_inventory
  add constraint generated_preview_inventory_relative_path_check check (
    managed_relative_path ~ '^v1/cover_variants/[0-9a-f]{2}/[0-9a-f]+\.[a-z0-9]+$'
  ) not valid;

alter table app.generated_preview_inventory
  validate constraint generated_preview_inventory_relative_path_check;
