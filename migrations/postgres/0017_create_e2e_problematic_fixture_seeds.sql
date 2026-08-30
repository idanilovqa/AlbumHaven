create table if not exists app.e2e_problematic_file_fixture_seeds (
    id bigserial primary key,
    seed_key text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists e2e_problematic_file_fixture_seeds_seed_key_idx
    on app.e2e_problematic_file_fixture_seeds (seed_key);

insert into app.e2e_problematic_file_fixture_seeds (seed_key, payload)
values (
    'problematic-files-small',
    $${
      "summary": {
        "items": [
          {
            "key": "synthetic signal artist::missing metadata fixture",
            "name": "Missing Metadata Fixture",
            "album_artist": "Synthetic Signal Artist",
            "problem_reasons": ["Missing year", "Missing cover art", "Missing track number"],
            "track_paths": ["X:\\SyntheticMusic\\Synthetic Signal Artist\\Missing Metadata Fixture\\01 - Missing Metadata Signal.mp3"],
            "tracks": [
              {
                "path": "X:\\SyntheticMusic\\Synthetic Signal Artist\\Missing Metadata Fixture\\01 - Missing Metadata Signal.mp3",
                "title": "Missing Metadata Signal"
              }
            ],
            "detail_loaded": false
          },
          {
            "key": "synthetic texture artist::poor art fixture",
            "name": "Poor Art Fixture",
            "album_artist": "Synthetic Texture Artist",
            "problem_reasons": ["Poor art quality"],
            "track_paths": ["X:\\SyntheticMusic\\Synthetic Texture Artist\\Poor Art Fixture\\01 - Texture Signal.mp3"],
            "tracks": [
              {
                "path": "X:\\SyntheticMusic\\Synthetic Texture Artist\\Poor Art Fixture\\01 - Texture Signal.mp3",
                "title": "Texture Signal"
              }
            ],
            "detail_loaded": false
          },
          {
            "key": "synthetic horizon artist::alternate art fixture",
            "name": "Alternate Art Fixture",
            "album_artist": "Synthetic Horizon Artist",
            "problem_reasons": ["Poor art quality"],
            "track_paths": ["X:\\SyntheticMusic\\Synthetic Horizon Artist\\Alternate Art Fixture\\01 - Horizon Signal.mp3"],
            "tracks": [
              {
                "path": "X:\\SyntheticMusic\\Synthetic Horizon Artist\\Alternate Art Fixture\\01 - Horizon Signal.mp3",
                "title": "Horizon Signal"
              }
            ],
            "detail_loaded": false
          }
        ]
      },
      "details": {}
    }$$::jsonb
)
on conflict (seed_key) do update
set payload = excluded.payload,
    updated_at = now();

grant select on table app.e2e_problematic_file_fixture_seeds to album_haven_app;
