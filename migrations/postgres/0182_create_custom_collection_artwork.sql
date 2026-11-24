create table if not exists library.custom_collection_artwork (
    library_id bigint not null references library.libraries(id) on delete cascade,
    collection_name text not null,
    updated_by_account_id bigint references app.accounts(id) on delete set null,
    image_bytes bytea not null,
    content_type text not null default 'image/jpeg',
    content_sha256 text not null,
    width integer not null,
    height integer not null,
    filename text not null,
    revision bigint not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (library_id, collection_name),
    constraint custom_collection_artwork_name_check check (
        collection_name = btrim(collection_name)
        and char_length(collection_name) between 1 and 255
    ),
    constraint custom_collection_artwork_type_check check (content_type = 'image/jpeg'),
    constraint custom_collection_artwork_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
    constraint custom_collection_artwork_dimensions_check check (width > 0 and height > 0),
    constraint custom_collection_artwork_bytes_check check (
        octet_length(image_bytes) between 1 and 16777216
    ),
    constraint custom_collection_artwork_revision_check check (revision > 0)
);

create index if not exists exception_overrides_custom_collection_name_idx
on library.exception_overrides (
    library_id,
    ((override_payload ->> 'custom_collection_name'))
)
where override_payload ->> 'exception_type' = 'Custom Collection'
  and nullif(btrim(override_payload ->> 'custom_collection_name'), '') is not null;

revoke all on table library.custom_collection_artwork from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
        grant select, insert, update, delete
        on table library.custom_collection_artwork
        to album_haven_app;
    end if;
end;
$$;
