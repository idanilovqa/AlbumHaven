alter table app.generated_preview_inventory
  add column if not exists current_path text;

update app.generated_preview_inventory
set current_path = album_preview_path
where current_path is null;

alter table app.generated_preview_inventory
  alter column current_path set not null;
