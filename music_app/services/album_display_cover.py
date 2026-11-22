"""The one album cover that display readers show.

Tracks have no artwork: each shows its album's, and artwork belongs to the folder-album. An album without a
stored cover shows the image of the folder-album that holds most of it. This is for reading only: readers that
feed a write keep the stored `cover_path`, so a displayed image is never saved as a choice.
"""
from __future__ import annotations

from music_app.services.album_local_membership import physical_album_folder_sql

_IMAGE = "(files.metadata #>> '{scan_cache,file_entry,cover_path}')"


def album_display_cover_sql(album: str) -> str:
    """The display cover of the album row ``album``; the folder is read only for a coverless album."""
    track_folder = physical_album_folder_sql("files.private_path")
    image_folder = physical_album_folder_sql(_IMAGE)
    # A cleared cover has no revision, so it never comes back from the folder.
    return f"""case
      when nullif(btrim({album}.cover_path), '') is not null then {album}.cover_path
      when nullif(btrim({album}.metadata ->> 'remote_cover_url'), '') is null
       and nullif(btrim({album}.metadata ->> 'cover_revision'), '') is not null
      then (
        with album_files as materialized (
          select tracks.id, coalesce(tracks.disc_number, 1) as disc,
            coalesce(tracks.track_number, 2147483647) as number,
            nullif({_IMAGE}, '') as image,
            {track_folder} as track_folder,
            case when nullif({_IMAGE}, '') is not null then {image_folder} end as image_folder,
            case when library.local_path_style(roots.root_path) = 'windows'
              then replace(library.local_path_key(roots.root_path), chr(92), '/')
              else library.local_path_key(roots.root_path) end as root_folder
          from library.local_tracks tracks
          join library.local_track_files files on files.track_id = tracks.id and files.scan_cache_stale is false
          join library.library_roots roots on roots.id = files.library_root_id and roots.is_active is true
          where tracks.album_id = {album}.id and tracks.library_id = {album}.library_id
          offset 0
        ), images as materialized (
          select image, image_folder, min(array[disc, number, id]) as first
          from album_files
          where image is not null
            and (image_folder = track_folder
              or (image_folder = regexp_replace(track_folder, '/[^/]*$', '') and image_folder <> root_folder))
          group by image, image_folder
        )
        select images.image
        from images
        cross join lateral (
          select count(*) as covered from album_files
          where album_files.track_folder = images.image_folder
             or regexp_replace(album_files.track_folder, '/[^/]*$', '') = images.image_folder
        ) coverage
        -- The folder-album holding most of the album, so a moved-in file can't lend its old image.
        where coverage.covered * 2 >= (select count(*) from album_files)
        order by coverage.covered desc, images.first
        limit 1
      ) end"""
