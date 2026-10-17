# Subtitle Edition Compatibility Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Root coordinates the sole test lane.

**Goal:** Stop track and disc subtitles from becoming album editions while preserving existing edition compatibility.

**Architecture:** Narrow metadata extraction correction only. Keep raw tag aliases, writer/readback mapping and album grouping unchanged; remove the two incorrect fallback keys from edition extraction.

**Tech Stack:** Python, Mutagen, pytest; existing album builder.

## Global Constraints

- No catalog merges, rescans, live tag rewrites, deployment or service changes.
- Preserve version/native VERSION/TIT3 because the app writes editions using EasyID3 version.
- Existing ambiguous TIT3 records require a separate explicit remediation decision.
- No UI change or new permission; no mockup required for this parser correction.
- Mixed album metadata and Empty audio reporting are separate slices.
- No tests or product edits until root grants the sole test lane.

## Delivery unit: subtitle fallback correction

Outcome: newly parsed subtitle-only tracks share the original album identity. Genuine editions remain distinct.
Prerequisites: owner bug-fix authorization; completed metadata intake; exclusive test lane.
Compatibility/rollback: no schema or data migration; revert the extraction line to roll back. Existing cached metadata remains unchanged. Do not bump metadata schema or trigger automatic catalog repair in this slice.
Checkpoint: focused evidence, independent review, owning functional-case registration by root, then normal branch CI/manual/release gates. This worker does not commit or publish.

### Cases

- SE-1: differing subtitle values do not split one album.
- SE-2: differing discsubtitle/TSST values do not split one album.
- SE-3: explicit edition/album edition/albumedition values remain distinct editions.
- SE-4: version/native VERSION/TIT3 remain distinct editions even with a disc subtitle.
- SE-5: raw subtitle and edition tag values remain readable and unchanged.

### Task 1: Regression tests and minimal extraction change

Files: `tests/py/test_metadata.py`; `music_app/services/metadata.py`.
Interface: `read_metadata_for_file(Path)` returns metadata consumed by `build_albums_from_file_cache(dict)`.

- [x] Author parameterized extraction/grouping cases in `test_track_and_disc_subtitles_do_not_split_album_editions` and `test_explicit_and_legacy_editions_still_split_albums`.
- [x] After test-lane grant, run `rtk python -m pytest tests/py/test_metadata.py -k 'subtitles_do_not_split or legacy_editions_still_split' -q`. Subtitle cases failed on nonempty edition; compatibility controls passed.
- [x] Replace only the edition extraction expression with:

```python
edition = first_tag(tags, ["edition", "album edition", "albumedition", "version"]) or first_custom_tag(tags, ["edition", "album edition", "albumedition"])
```

- [x] Run `rtk python -m pytest tests/py/test_metadata.py -q`, covering the focused selection and existing physical write/read/clear tests unchanged.
- [x] Audit the owned test processes; hand the lane back to root.
- [ ] Independent review and root functional-case registration before commit/release handoff.

Status: narrow product correction implemented and focused verification complete; frozen for independent review. FTC-ALBUM-VERSIONS-006 and its index link recorded as planned; existing acceptance contracts and ready/automated counters unchanged. Exact overall task/process timing not measured; no reconstructed timing claims.

Verification evidence: initial restricted runs could not create pytest temporary files and are setup failures, not RED evidence. Authorized temporary-file access produced RED: three subtitle assertion failures and six compatibility passes in 1.47 s. After removing only subtitle/discsubtitle from the fallback list, the complete metadata file passed 53/53 in 3.90 s with exit code 0. The full-file run includes all nine new grouping/compatibility cases. Corrected scoped CIM audit found no matching Python/FFmpeg test processes; test lane returned to root. An earlier read-only audit command had a quoting error and its exact auxiliary session was closed; it did not change application state.
