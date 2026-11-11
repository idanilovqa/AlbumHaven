-- Re-check automatic MusicBrainz artist matches accepted only from a stored local
-- artist MBID. That MBID comes from Last.fm's name lookup, not from file tags, but
-- Delivery 1 first treated it as embedded evidence and skipped the album check
-- (for example Aina, matched to a different band of the same name).
--
-- Only automatic rows with that exact evidence are removed. Manual choices and
-- matches confirmed by album-agreeing search evidence are never touched. Once the
-- row is gone, the startup backfill and the owner's MusicBrainz sync queue the
-- artist again, and the corrected matcher accepts an MBID only when the albums
-- agree; otherwise the artist appears in Problematic Files with its reason.
delete from library.local_artist_musicbrainz_matches matches
where matches.decision_source = 'automatic'
  and matches.state = 'matched'
  and matches.evidence_summary = 'MusicBrainz embedded evidence agreed.';
