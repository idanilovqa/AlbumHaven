// Seeds each Delivery 1 composite case after checkpoint restore and before its app starts.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  async function localArtist(name) {
    const row = JSON.parse(await sql(`select jsonb_build_object('artist', a.id, 'library', a.library_id)
      from library.local_artists a where a.name = ${literal(name)}
        and exists (select 1 from library.local_albums al where al.artist_id = a.id) order by a.id limit 1`) || 'null');
    if (!row) throw new Error(`No present fixture artist named ${name}`);
    return row;
  }

  async function upsertMusicBrainzArtist({ mbid, name, sortName = name, nativeName = null, aliases = [],
    disambiguation = null, kind = 'Group', country = null, genres = [], discogsArtistId = null }) {
    await sql(`begin;
      insert into integration.musicbrainz_artists (mbid, canonical_name, sort_name, preferred_native_name, disambiguation, artist_kind,
        discogs_artist_id, refreshed_at)
      values ('${mbid}', ${literal(name)}, ${literal(sortName)}, ${literal(nativeName)}, ${literal(disambiguation)}, ${literal(kind)},
        ${discogsArtistId === null ? 'null' : Number(discogsArtistId)}, now())
      on conflict (mbid) do update set canonical_name = excluded.canonical_name, sort_name = excluded.sort_name,
        preferred_native_name = excluded.preferred_native_name, disambiguation = excluded.disambiguation, artist_kind = excluded.artist_kind,
        discogs_artist_id = excluded.discogs_artist_id;
      delete from integration.musicbrainz_artist_aliases where artist_mbid = '${mbid}';
      delete from integration.musicbrainz_artist_countries where artist_mbid = '${mbid}';
      delete from integration.musicbrainz_artist_tags where artist_mbid = '${mbid}';
      ${aliases.map((alias) => `insert into integration.musicbrainz_artist_aliases
        (artist_mbid, alias_name, alias_normalized, sort_name, locale, alias_kind, is_primary_for_locale, provenance, observed_at)
        values ('${mbid}', ${literal(alias.name)}, ${literal(alias.name.toLowerCase())}, ${literal(alias.sortName || alias.name)},
          ${literal(alias.locale || null)}, ${literal(alias.kind || null)}, ${alias.primary ? 'true' : 'false'}, 'musicbrainz', now());`).join('\n')}
      ${country ? `insert into integration.musicbrainz_artist_countries (artist_mbid, country_code, country_name, provenance, observed_at)
        values ('${mbid}', ${literal(country.code)}, ${literal(country.name)}, 'musicbrainz', now());` : ''}
      ${genres.map((genre) => `insert into integration.musicbrainz_artist_tags
        (artist_mbid, tag_name, tag_normalized, vote_count, is_genre, provenance)
        values ('${mbid}', ${literal(genre.name)}, ${literal(genre.name.toLowerCase())},
          ${Number(genre.voteCount)}, ${genre.isGenre === false ? 'false' : 'true'}, 'musicbrainz');`).join('\n')}
      commit;`);
  }

  async function writeMatch(artist, {
    state, mbid = null, creditName = null, associated = [], decisionSource = 'manual', matcherVersion = PINNED_MATCHER_VERSION,
  }) {
    await sql(`insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, artist_mbid, state,
        decision_source, confidence, evidence_summary, selected_at, matcher_version, credit_name, associated_artist_mbids)
      values (${artist.library}, ${artist.artist}, ${mbid ? `'${mbid}'` : 'null'}, '${state}', '${decisionSource}', 1,
        'E2E MusicBrainz identity fixture', now(), ${matcherVersion}, ${literal(creditName)},
        ${associated.length ? `array[${associated.map((value) => `'${value}'`).join(',')}]::uuid[]` : 'null'})
      on conflict (library_id, local_artist_id) do update set artist_mbid = excluded.artist_mbid, state = excluded.state,
        decision_source = excluded.decision_source, matcher_version = excluded.matcher_version,
        credit_name = excluded.credit_name, associated_artist_mbids = excluded.associated_artist_mbids`);
  }

  async function writeProblem(artist, reasonCode, candidateCount) {
    await sql(`insert into library.metadata_enrichment_problems (library_id, local_artist_id, reason_code, lifecycle_state,
        safe_display_context, candidate_count, observed_at, first_observed_at, last_observed_at)
      values (${artist.library}, ${artist.artist}, '${reasonCode}', 'active',
        (select name from library.local_artists where id = ${artist.artist}), ${Number(candidateCount)}, now(), now(), now())`);
  }

  async function writeCandidates(artist, candidates) {
    await sql(`delete from library.local_artist_musicbrainz_candidates where local_artist_id = ${artist.artist};
      ${candidates.map((candidate) => `insert into library.local_artist_musicbrainz_candidates
        (library_id, local_artist_id, artist_mbid, candidate_score, evidence_summary, observed_at)
        values (${artist.library}, ${artist.artist}, '${candidate.mbid}', 1,
          ${literal(candidate.evidence || '1 of 1 album agree')}, now());`).join('\n')}`);
  }

  async function renameArtistAlbum(sourceArtist, artistName, albumName) {
    const artist = await localArtist(sourceArtist);
    const album = JSON.parse(await sql(`select jsonb_build_object('key', album_key, 'title', title)
      from library.local_albums where artist_id = ${artist.artist} order by id limit 1`) || 'null');
    if (!album) throw new Error(`No fixture album for ${sourceArtist}`);
    await sql(`begin;
      update library.local_artists set name = ${literal(artistName)} where id = ${artist.artist};
      update library.local_albums set title = ${literal(albumName)}, metadata = metadata
        || jsonb_build_object('album_artist', ${literal(artistName)})
        where library_id = ${artist.library} and album_key = ${literal(album.key)};
      commit;`);
    return artist;
  }

  async function queueJob(artist, { state = 'queued', reason, priority = 0, attemptCount = 0, nextAttempt = 'now()' }) {
    return sql(`insert into ops.metadata_enrichment_jobs (library_id, local_artist_id, target_kind, job_kind, reason,
        state, priority, attempt_count, next_attempt_at, provider_classification, provider_observed_at, created_at, updated_at)
      values (${artist.library}, ${artist.artist}, 'artist', 'musicbrainz_artist_enrichment', ${literal(reason)},
        '${state}', ${Number(priority)}, ${attemptCount}, ${nextAttempt}, ${state === 'exhausted' ? "'provider_unavailable'" : 'null'},
        ${state === 'exhausted' ? 'now()' : 'null'}, now(), now()) returning id`);
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
    async notFoundArtist(name) {
      const artist = await localArtist(name);
      await writeMatch(artist, { state: 'not_found' });
      await writeProblem(artist, 'musicbrainz_artist_not_found', 0);
    },
    async readStoredArtist(mbid) {
      return JSON.parse(await sql(`select jsonb_build_object(
          'canonicalName', artist.canonical_name,
          'sortName', artist.sort_name,
          'nativeName', artist.preferred_native_name,
          'aliases', coalesce((select jsonb_agg(alias.alias_name order by alias.alias_name)
            from integration.musicbrainz_artist_aliases alias where alias.artist_mbid = artist.mbid), '[]'::jsonb))
        from integration.musicbrainz_artists artist where artist.mbid = '${mbid}'`) || 'null');
    },
    async multipleArtist(name, candidates) {
      const artist = await localArtist(name);
      for (const candidate of candidates) await upsertMusicBrainzArtist(candidate);
      await writeMatch(artist, { state: 'ambiguous' });
      await writeCandidates(artist, candidates);
      await writeProblem(artist, 'musicbrainz_artist_ambiguous', candidates.length);
    },
    async conflictArtist(name, current, suggestion) {
      const artist = await localArtist(name);
      await upsertMusicBrainzArtist(current);
      await upsertMusicBrainzArtist(suggestion);
      await writeMatch(artist, { state: 'conflict', mbid: current.mbid });
      await writeCandidates(artist, [suggestion]);
      await writeProblem(artist, 'musicbrainz_artist_metadata_conflict', 1);
    },
    async hydrationArtist(sourceArtist, name, album, musicbrainz) {
      const artist = await renameArtistAlbum(sourceArtist, name, album);
      await sql(`update library.local_artists set mbid = '${musicbrainz.mbid}' where id = ${artist.artist}`);
      await upsertMusicBrainzArtist({ mbid: musicbrainz.mbid, name });
      await writeMatch(artist, {
        state: 'matched', mbid: musicbrainz.mbid, decisionSource: 'automatic', matcherVersion: 1,
      });
      await queueJob(artist, { reason: 'stale_refresh', priority: 100 });
    },
    async renamedMatchedArtist(sourceArtist, name, album, musicbrainz, options = {}) {
      const artist = await renameArtistAlbum(sourceArtist, name, album);
      await this.matchArtist(name, musicbrainz, options);
      await this.assignAlbums(artist, [{ ...musicbrainz, albums: [album], tagDiffers: musicbrainz.name !== name }]);
    },
    async providerUnavailableArtist(sourceArtist, name, album, musicbrainz) {
      const artist = await renameArtistAlbum(sourceArtist, name, album);
      await upsertMusicBrainzArtist(musicbrainz);
      await writeMatch(artist, {
        state: 'matched', mbid: musicbrainz.mbid, decisionSource: 'automatic', matcherVersion: PINNED_MATCHER_VERSION,
      });
      await sql(`update library.local_artist_musicbrainz_matches set last_verified_at = now()
        where library_id = ${artist.library} and local_artist_id = ${artist.artist}`);
      const jobId = await queueJob(artist, {
        state: 'exhausted', reason: 'automatic_retry', attemptCount: 8, nextAttempt: "now() + interval '1 minute'",
      });
      await sql(`insert into library.metadata_enrichment_problems (library_id, local_artist_id, reason_code,
          lifecycle_state, safe_display_context, candidate_count, related_job_id, observed_at, first_observed_at, last_observed_at)
        values (${artist.library}, ${artist.artist}, 'musicbrainz_provider_retry_exhausted', 'active', ${literal(name)}, 0,
          ${Number(jobId)}, now(), now(), now())`);
    },
    async ratingMismatch(sourceArtist, artistName, albumName, appRating, fileRating) {
      const artist = await renameArtistAlbum(sourceArtist, artistName, albumName);
      const album = JSON.parse(await sql(`select jsonb_build_object('library', library_id, 'key', album_key)
        from library.local_albums where artist_id = ${artist.artist} order by id limit 1`) || 'null');
      const accountId = await sql(`select owner_account_id from library.libraries
        where id = ${album.library}`);
      await sql(`begin;
        update library.local_albums set cover_path = 'fixture-cover.jpg', metadata = metadata
          || jsonb_build_object('local_cover_width', 1200, 'local_cover_height', 1200, 'tag_album_rating', ${Number(fileRating)})
          where library_id = ${album.library} and album_key = ${literal(album.key)};
        insert into app.album_ratings (account_id, library_id, album_key, rating, provenance)
          values (${Number(accountId)}, ${album.library}, ${literal(album.key)}, ${Number(appRating)}, 'user')
          on conflict (account_id, library_id, album_key) do update set rating = excluded.rating, provenance = excluded.provenance;
        commit;`);
    },
    async assignAlbums(artist, owners) {
      for (const owner of owners) {
        const count = await sql(`with inserted as (insert into library.local_album_artist_identities
            (library_id, album_key, artist_mbid, decision_source, evidence, tag_differs, matcher_version)
          select al.library_id, al.album_key, '${owner.mbid}', 'manual', '{}'::jsonb,
            ${owner.tagDiffers ? 'true' : 'false'}, ${PINNED_MATCHER_VERSION}
          from library.local_albums al where al.artist_id = ${artist.artist}
            and al.title = any(array[${owner.albums.map(literal).join(',')}])
          on conflict (library_id, album_key) do update set artist_mbid = excluded.artist_mbid,
            tag_differs = excluded.tag_differs
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
        commit;`);
      await writeProblem(artist, 'musicbrainz_manual_review_required', 1);
    },
  };
}

const CASES = {
  'FTC-MBID-001': async (fixture) => {
    await fixture.matchArtist('Functional Balance Artist 03', {
      mbid: '0e2e0001-0000-4000-8000-000000000002', name: 'Signal Guest Collective',
    }, { creditName: 'Functional Balance Artist 03' });
    await fixture.matchArtist('Compilation Signal Lead', {
      mbid: '0e2e0001-0000-4000-8000-000000000001', name: 'Compilation Signal Lead',
      country: { code: 'FI', name: 'Finland' },
      genres: [
        { name: 'progressive rock', voteCount: 12 }, { name: 'art rock', voteCount: 8 },
        { name: 'doom metal', voteCount: 4 }, { name: 'folk rock', voteCount: 2 },
        { name: 'melancholy', voteCount: 100, isGenre: false },
      ],
      discogsArtistId: 424242,
    });
    await fixture.matchArtist('ДДТ', {
      mbid: '0e2e0001-0000-4000-8000-000000000011', name: 'ДДТ', sortName: 'DDT', nativeName: 'ДДТ',
      aliases: [{ name: 'DDT', locale: 'en' }],
    });
    await fixture.matchArtist('Ария', {
      mbid: '0e2e0001-0000-4000-8000-000000000012', name: 'Ария', sortName: 'Aria', nativeName: 'Ария',
      aliases: [{ name: 'Aria', locale: 'en' }],
    });
    await fixture.hydrationArtist('Compilation Signal Guest', 'Compilation Signal Guest', 'Compilation Guest Solo', {
      mbid: '0e2e0001-0000-4000-8000-000000000013',
    });
    await fixture.renamedMatchedArtist('Solo Voice', 'Zero Vote Artist', 'Zero Vote Album', {
      mbid: '0e2e0001-0000-4000-8000-000000000016', name: 'Zero Vote Artist',
      country: { code: 'FI', name: 'Finland' }, genres: [
        { name: 'dark wave', voteCount: 0 }, { name: 'ambient', voteCount: 0 },
      ], discogsArtistId: 424242,
    });
    await fixture.renamedMatchedArtist('Onségen Ensemble', 'Shamaani Duo', 'Hunka lunka', {
      mbid: 'd6b3e0a2-7c1d-4f7c-90bc-73c8bd2ac431', name: 'Korpiklaani',
      country: { code: 'FI', name: 'Finland' }, genres: [{ name: 'folk metal', voteCount: 10 }],
    }, { creditName: 'Shamaani Duo' });
  },
  'FTC-MBID-002': async (fixture) => {
    await fixture.splitArtist('Compilation Signal Lead', [
      { mbid: '0e2e0001-0000-4000-8000-000000000003', name: 'Compilation Signal Lead', disambiguation: 'UK band', albums: ['Compilation Lead Solo', 'Functional Fixture Album 249'] },
      { mbid: '0e2e0001-0000-4000-8000-000000000004', name: 'Compilation Signal Lead', disambiguation: 'Swedish band', albums: ['Functional Fixture Album 250'] },
    ]);
    await fixture.personWithBand('Control Signal Lead',
      { mbid: '0e2e0001-0000-4000-8000-000000000005', name: 'Control Signal Lead', kind: 'Person', albums: ['Control Lead Solo'] },
      { mbid: '0e2e0001-0000-4000-8000-000000000006', name: 'Control Signal Lead', disambiguation: 'the band', albums: ['Functional Fixture Album 266'] });
  },
  'FTC-MBID-003': async (fixture) => {
    await fixture.unconfirmedArtist('Album Rating Contract', {
      mbid: '0e2e0001-0000-4000-8000-000000000007', name: 'Album Rating Contract',
      country: { code: 'FI', name: 'Finland' }, disambiguation: 'Finnish band',
    });
    await fixture.notFoundArtist('Functional Balance Artist 03');
    await fixture.multipleArtist('Compilation Signal Guest', [
      { mbid: '0e2e0001-0000-4000-8000-000000000009', name: 'Compilation Signal Guest North', country: { code: 'CA', name: 'Canada' }, disambiguation: 'Canadian studio project' },
      { mbid: '0e2e0001-0000-4000-8000-000000000010', name: 'Compilation Signal Guest South', country: { code: 'FI', name: 'Finland' }, disambiguation: 'Finnish live act' },
    ]);
    await fixture.conflictArtist('Compilation Signal Lead',
      { mbid: '0e2e0001-0000-4000-8000-000000000003', name: 'Compilation Signal Lead', country: { code: 'GB', name: 'United Kingdom' }, disambiguation: 'UK group' },
      { mbid: '0e2e0001-0000-4000-8000-000000000004', name: 'Compilation Signal Lead', country: { code: 'SE', name: 'Sweden' }, disambiguation: 'Swedish group' });
    await fixture.conflictArtist('Control Signal Partner',
      { mbid: '0e2e0001-0000-4000-8000-000000000017', name: 'Control Signal Partner', country: { code: 'CA', name: 'Canada' } },
      { mbid: '0e2e0001-0000-4000-8000-000000000018', name: 'Control Signal Partner', country: { code: 'FI', name: 'Finland' } });
    await fixture.providerUnavailableArtist('Flaming Row', 'Provider Outage Artist', 'Provider Outage Album', {
      mbid: '0e2e0001-0000-4000-8000-000000000014', name: 'Provider Outage Artist',
      country: { code: 'US', name: 'United States' }, genres: [{ name: 'rock', voteCount: 4 }],
    });
    await fixture.ratingMismatch('東京事変', 'Arcade Fire', 'Reflektor', 6, 7);
    await fixture.ratingMismatch('Борис', 'Orphaned Land', 'Mabool: the Story of the Three Sons of Seven', 10, 5);
  },
};

export async function seedMusicBrainzIdentityFixture(caseName) {
  const entry = Object.entries(CASES).find(([prefix]) => caseName.startsWith(prefix));
  if (!entry) throw new Error(`Unsupported MusicBrainz fixture case: ${caseName}`);
  await entry[1](await createMusicBrainzIdentityFixture());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const caseName = process.argv.find((argument) => argument.startsWith('--case='))?.slice('--case='.length) || '';
  await seedMusicBrainzIdentityFixture(caseName);
}
