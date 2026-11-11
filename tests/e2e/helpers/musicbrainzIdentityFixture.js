// Seeds MusicBrainz artist identities into the isolated E2E database for the Delivery 1
// scenarios, as the stored outcome of the enrichment would be, and removes them again.
// Manual decisions and a pinned matcher version keep the background enrichment worker
// from replacing these rows during a test.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const PINNED_MATCHER_VERSION = 999;

function literal(value) {
  if (value === null || value === undefined) return 'null';
  return `convert_from(decode('${Buffer.from(String(value)).toString('base64')}','base64'),'UTF8')`;
}

export async function createMusicBrainzIdentityFixture() {
  const connection = resolveIsolatedE2ESetupConnection(process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL);
  const env = { ...process.env, PGCLIENTENCODING: 'UTF8' };
  delete env.PGDATABASE;
  if (connection.password) env.PGPASSWORD = connection.password;
  const exec = promisify(execFile);
  const sql = async (statement) => {
    const commands = resolvePsqlCommands(env, process.platform);
    for (let index = 0; index < commands.length; index += 1) {
      try {
        return (await exec(commands[index], ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
          `--dbname=${connection.databaseTarget}`, '--set=ON_ERROR_STOP=1', '--command', statement],
        { env, windowsHide: true, encoding: 'utf8' })).stdout.trim();
      } catch (error) {
        if (error.code !== 'ENOENT' || index === commands.length - 1) throw error;
      }
    }
    return '';
  };
  const seededArtists = new Set();
  const seededMbids = new Set();

  async function localArtist(name) {
    const row = JSON.parse(await sql(`select jsonb_build_object('artist', a.id, 'library', a.library_id)
      from library.local_artists a where a.name = ${literal(name)}
        and exists (select 1 from library.local_albums al where al.artist_id = a.id) order by a.id limit 1`) || 'null');
    if (!row) throw new Error(`No present fixture artist named ${name}`);
    seededArtists.add(row.artist);
    return row;
  }

  async function upsertMusicBrainzArtist({ mbid, name, disambiguation = null, kind = 'Group', country = null,
    genres = [], discogsArtistId = null }) {
    seededMbids.add(mbid);
    await sql(`begin;
      insert into integration.musicbrainz_artists (mbid, canonical_name, sort_name, disambiguation, artist_kind,
        discogs_artist_id, refreshed_at)
      values ('${mbid}', ${literal(name)}, ${literal(name)}, ${literal(disambiguation)}, ${literal(kind)},
        ${discogsArtistId === null ? 'null' : Number(discogsArtistId)}, now())
      on conflict (mbid) do update set canonical_name = excluded.canonical_name, disambiguation = excluded.disambiguation,
        artist_kind = excluded.artist_kind, discogs_artist_id = excluded.discogs_artist_id;
      delete from integration.musicbrainz_artist_countries where artist_mbid = '${mbid}';
      delete from integration.musicbrainz_artist_tags where artist_mbid = '${mbid}';
      ${country ? `insert into integration.musicbrainz_artist_countries (artist_mbid, country_code, country_name, provenance, observed_at)
        values ('${mbid}', ${literal(country.code)}, ${literal(country.name)}, 'musicbrainz', now());` : ''}
      ${genres.map((genre) => `insert into integration.musicbrainz_artist_tags
        (artist_mbid, tag_name, tag_normalized, vote_count, is_genre, provenance)
        values ('${mbid}', ${literal(genre.name)}, ${literal(genre.name.toLowerCase())},
          ${Number(genre.voteCount)}, ${genre.isGenre === false ? 'false' : 'true'}, 'musicbrainz');`).join('\n')}
      commit;`);
  }

  async function writeMatch(artist, { state, mbid = null, creditName = null, associated = [] }) {
    await sql(`insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, artist_mbid, state,
        decision_source, confidence, evidence_summary, selected_at, matcher_version, credit_name, associated_artist_mbids)
      values (${artist.library}, ${artist.artist}, ${mbid ? `'${mbid}'` : 'null'}, '${state}', 'manual', 1,
        'E2E MusicBrainz identity fixture', now(), ${PINNED_MATCHER_VERSION}, ${literal(creditName)},
        ${associated.length ? `array[${associated.map((value) => `'${value}'`).join(',')}]::uuid[]` : 'null'})
      on conflict (library_id, local_artist_id) do update set artist_mbid = excluded.artist_mbid, state = excluded.state,
        decision_source = excluded.decision_source, matcher_version = excluded.matcher_version,
        credit_name = excluded.credit_name, associated_artist_mbids = excluded.associated_artist_mbids`);
  }

  return {
    /** A matched artist: MusicBrainz name, country, genres and Discogs link. */
    async matchArtist(name, musicbrainz, { creditName = null } = {}) {
      const artist = await localArtist(name);
      await upsertMusicBrainzArtist(musicbrainz);
      await writeMatch(artist, { state: 'matched', mbid: musicbrainz.mbid, creditName });
    },
    /** Albums of one local name held by several MusicBrainz artists, by album title. */
    async splitArtist(name, owners) {
      const artist = await localArtist(name);
      for (const owner of owners) await upsertMusicBrainzArtist(owner);
      await writeMatch(artist, { state: 'per_album' });
      await this.assignAlbums(artist, owners);
    },
    /** A person matched together with the same-named band they belong to. */
    async personWithBand(name, person, band) {
      const artist = await localArtist(name);
      await upsertMusicBrainzArtist(person);
      await upsertMusicBrainzArtist(band);
      await writeMatch(artist, { state: 'matched', mbid: person.mbid, associated: [band.mbid] });
      await this.assignAlbums(artist, [person, band]);
    },
    async assignAlbums(artist, owners) {
      for (const owner of owners) {
        const count = await sql(`with inserted as (insert into library.local_album_artist_identities
            (library_id, album_key, artist_mbid, decision_source, evidence, tag_differs, matcher_version)
          select al.library_id, al.album_key, '${owner.mbid}', 'manual', '{}'::jsonb, false, ${PINNED_MATCHER_VERSION}
          from library.local_albums al where al.artist_id = ${artist.artist}
            and al.title = any(array[${owner.albums.map(literal).join(',')}])
          on conflict (library_id, album_key) do update set artist_mbid = excluded.artist_mbid
          returning 1) select count(*) from inserted`);
        if (Number(count) !== owner.albums.length) throw new Error(`Expected ${owner.albums.length} albums for ${owner.name}, got ${count}`);
      }
    },
    /** An Unconfirmed match: one suggested artist and an active Problematic Files problem. */
    async unconfirmedArtist(name, suggestion) {
      const artist = await localArtist(name);
      await upsertMusicBrainzArtist(suggestion);
      await sql(`begin;
        insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, state, decision_source,
          confidence, evidence_summary, matcher_version)
        values (${artist.library}, ${artist.artist}, 'manual_review', 'automatic', 0,
          'One MusicBrainz artist has this name, but none of your albums confirm it.', ${PINNED_MATCHER_VERSION})
        on conflict (library_id, local_artist_id) do update set state = excluded.state, artist_mbid = null,
          decision_source = 'automatic', matcher_version = excluded.matcher_version, evidence_summary = excluded.evidence_summary;
        delete from library.local_artist_musicbrainz_candidates where local_artist_id = ${artist.artist};
        insert into library.local_artist_musicbrainz_candidates (library_id, local_artist_id, artist_mbid,
          candidate_score, evidence_summary, observed_at)
        values (${artist.library}, ${artist.artist}, '${suggestion.mbid}', 1, '0 of 1 album agree', now());
        insert into library.metadata_enrichment_problems (library_id, local_artist_id, reason_code, lifecycle_state,
          safe_display_context, candidate_count, observed_at, first_observed_at, last_observed_at)
        values (${artist.library}, ${artist.artist}, 'musicbrainz_manual_review_required', 'active',
          ${literal(name)}, 1, now(), now(), now());
        commit;`);
    },
    async restore() {
      const artists = [...seededArtists].join(',');
      const mbids = [...seededMbids].map((value) => `'${value}'`).join(',');
      if (!artists) return;
      await sql(`begin;
        delete from library.local_album_artist_identities i using library.local_albums al
          where al.library_id = i.library_id and al.album_key = i.album_key and al.artist_id in (${artists});
        delete from library.metadata_enrichment_problems where local_artist_id in (${artists});
        delete from library.local_artist_musicbrainz_candidates where local_artist_id in (${artists});
        delete from library.local_artist_musicbrainz_matches where local_artist_id in (${artists});
        ${mbids ? `delete from integration.musicbrainz_artist_tags where artist_mbid in (${mbids});
        delete from integration.musicbrainz_artist_countries where artist_mbid in (${mbids});
        delete from integration.musicbrainz_artists a where a.mbid in (${mbids})
          and not exists (select 1 from library.local_artist_musicbrainz_matches m where m.artist_mbid = a.mbid)
          and not exists (select 1 from library.local_artist_musicbrainz_candidates c where c.artist_mbid = a.mbid)
          and not exists (select 1 from library.local_album_artist_identities i where i.artist_mbid = a.mbid);` : ''}
        commit;`);
    },
  };
}
