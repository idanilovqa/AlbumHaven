create table if not exists app.client_surface_classes (
  surface_key text primary key,
  description text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

insert into app.client_surface_classes (surface_key, description)
values
  ('cloud_web', 'Hosted metadata-first web surface.'),
  ('private_web', 'Private self-hosted web surface.'),
  ('desktop', 'Desktop client surface.'),
  ('mobile', 'Mobile client surface.'),
  ('tv', 'TV client surface.'),
  ('node', 'Private library node surface.')
on conflict (surface_key) do nothing;

create table if not exists app.deployment_mode_rules (
  id bigint generated always as identity primary key,
  deployment_mode text not null,
  rule_key text not null,
  client_surface_class text not null references app.client_surface_classes(surface_key) on delete restrict,
  capability_key text not null,
  effect text not null default 'reserved',
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists deployment_mode_rules_mode_rule_surface_capability_idx
  on app.deployment_mode_rules (
    deployment_mode,
    rule_key,
    client_surface_class,
    capability_key
  );

create index if not exists deployment_mode_rules_surface_capability_idx
  on app.deployment_mode_rules (client_surface_class, capability_key);

create table if not exists app.request_origins (
  id bigint generated always as identity primary key,
  account_id bigint references app.accounts(id) on delete set null,
  client_surface_class text not null references app.client_surface_classes(surface_key) on delete restrict,
  origin_type text not null,
  origin_key text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists request_origins_account_id_idx
  on app.request_origins (account_id);

create index if not exists request_origins_surface_last_seen_idx
  on app.request_origins (client_surface_class, last_seen_at);

create unique index if not exists request_origins_surface_type_key_idx
  on app.request_origins (client_surface_class, origin_type, origin_key);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'deployment_mode_rules_effect_check'
      and conrelid = 'app.deployment_mode_rules'::regclass
  ) then
    alter table app.deployment_mode_rules
      add constraint deployment_mode_rules_effect_check
      check (effect in ('reserved', 'allow', 'deny'));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table app.client_surface_classes, app.deployment_mode_rules, app.request_origins to album_haven_readonly';
    execute 'grant select on sequence app.deployment_mode_rules_id_seq, app.request_origins_id_seq to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'revoke insert, update, delete on table app.client_surface_classes, app.deployment_mode_rules from album_haven_app';
    execute 'revoke usage, select on sequence app.deployment_mode_rules_id_seq from album_haven_app';
    execute 'grant select on table app.client_surface_classes, app.deployment_mode_rules to album_haven_app';
    execute 'grant select, insert, update on table app.request_origins to album_haven_app';
    execute 'grant usage, select on sequence app.request_origins_id_seq to album_haven_app';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table app.client_surface_classes, app.deployment_mode_rules, app.request_origins to album_haven_migrator';
    execute 'grant usage, select on sequence app.deployment_mode_rules_id_seq, app.request_origins_id_seq to album_haven_migrator';
  end if;
end $$;
