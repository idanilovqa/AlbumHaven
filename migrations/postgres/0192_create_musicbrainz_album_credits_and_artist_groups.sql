-- depends on: 0190_create_musicbrainz_release_identity.sql
-- MusicBrainz Delivery 2, S2: per-album release credits and same-name artist groups.
-- Views only (additive): nothing is copied, so they always agree with the stored decisions,
-- and nothing here writes media tags or changes the artist tree, gallery or search yet.

-- Each artist a local album's certainly matched release credits, in MusicBrainz's order
-- ("Alan Menken" " & " "Howard Ashman"; a composer before the performer), with the credited
-- name and the join phrase after it. "Various Artists" appears only when MusicBrainz credits it.
create or replace view library.local_album_musicbrainz_credits as
select decisions.library_id, decisions.album_key, decisions.release_mbid,
       credit.position::integer as position,
       (credit.part ->> 'artist_mbid')::uuid as artist_mbid,
       credit.part ->> 'name' as credited_name,
       credit.part ->> 'artist_name' as artist_name,
       coalesce(credit.part ->> 'join_phrase', '') as join_phrase
from library.local_album_musicbrainz_releases decisions
join integration.musicbrainz_releases releases on releases.mbid = decisions.release_mbid
cross join lateral jsonb_array_elements(releases.artist_credit) with ordinality as credit(part, position)
where decisions.state = 'release';

comment on view library.local_album_musicbrainz_credits is
  'The artist credit of each local album''s certainly matched MusicBrainz release, in credit order; display data only.';

-- The artist group each local album belongs to. A local name that MusicBrainz splits per
-- album (Amarok; a person and the same-named band) gives each proven MusicBrainz artist its
-- own group, labelled "Name (Country)", else "Name (disambiguation)", else both, else the
-- MBID's first characters, whichever tells the groups apart. Undecided albums of a split
-- name, and every album of any other artist, stay in the plain name's group.
create or replace view library.local_album_artist_groups as
with split_artists as (
  select distinct albums.library_id, albums.artist_id, identities.artist_mbid
  from library.local_album_artist_identities identities
  join library.local_albums albums
    on albums.library_id = identities.library_id and albums.album_key = identities.album_key
  join library.local_artist_musicbrainz_matches matches
    on matches.library_id = albums.library_id and matches.local_artist_id = albums.artist_id
   and matches.state = 'per_album'
), described as (
  select split_artists.*, nullif(btrim(remote.disambiguation), '') as disambiguation, country.name as country
  from split_artists
  join integration.musicbrainz_artists remote on remote.mbid = split_artists.artist_mbid
  left join lateral (
    select coalesce(countries.country_name, countries.country_code) as name
    from integration.musicbrainz_artist_countries countries
    where countries.artist_mbid = split_artists.artist_mbid
    order by countries.country_code
    limit 1
  ) country on true
), qualified as (
  select described.library_id, described.artist_id, described.artist_mbid,
         case
           when country is not null
                and count(*) over (partition by library_id, artist_id, country) = 1 then country
           when disambiguation is not null
                and count(*) over (partition by library_id, artist_id, disambiguation) = 1 then disambiguation
           when country is not null and disambiguation is not null
                and count(*) over (partition by library_id, artist_id, country, disambiguation) = 1
             then country || ', ' || disambiguation
           else left(artist_mbid::text, 8)
         end as qualifier
  from described
)
select albums.library_id, albums.album_key, albums.id as local_album_id, albums.artist_id as local_artist_id,
       coalesce(identities.artist_mbid,
                case when matches.state = 'matched' then matches.artist_mbid end) as artist_mbid,
       case when qualified.artist_mbid is null then 'artist:' || albums.artist_id
            else 'musicbrainz:' || qualified.artist_mbid end as group_key,
       case when qualified.artist_mbid is null then artists.name
            else artists.name || ' (' || qualified.qualifier || ')' end as group_label
from library.local_albums albums
join library.local_artists artists on artists.library_id = albums.library_id and artists.id = albums.artist_id
left join library.local_artist_musicbrainz_matches matches
  on matches.library_id = albums.library_id and matches.local_artist_id = albums.artist_id
left join library.local_album_artist_identities identities
  on identities.library_id = albums.library_id and identities.album_key = albums.album_key
left join qualified
  on qualified.library_id = albums.library_id and qualified.artist_id = albums.artist_id
 and qualified.artist_mbid = identities.artist_mbid;

comment on view library.local_album_artist_groups is
  'The artist group (key and label) each local album belongs to: one per proven MusicBrainz artist of a split name.';

revoke all on table library.local_album_musicbrainz_credits, library.local_album_artist_groups from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_musicbrainz_credits, library.local_album_artist_groups
      to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select on table library.local_album_musicbrainz_credits, library.local_album_artist_groups
      to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select on table library.local_album_musicbrainz_credits, library.local_album_artist_groups
      to album_haven_migrator;
  end if;
end $$;
