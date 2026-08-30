import { test } from '../support/baseFixtures.js';
import { runSparseTagEditScenario } from '../helpers/sparseTagEditScenario.js';

test('FTC-TAGS-010 keeps an album-only edit sparse and retains its optimistic split', async ({
  freshBrowserSession,
  galleryActions,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
}) => {
  await runSparseTagEditScenario({
    field: 'album',
    freshBrowserSession,
    galleryActions,
    initialEditorFields: ['album', 'title', 'year'],
    initialEditorValues: {
      album: 'Sparse Album Edit Fixture',
      title: 'Sparse Album Track 1',
      year: '2001',
    },
    initialYear: '2000',
    originalAlbum: 'Sparse Album Edit Fixture',
    physicalFrame: 'TALB',
    physicalValue: 'Sparse Album Edit Result',
    retainedPhysicalFrames: { TDRC: ['2001'] },
    resultIdentities: [
      { album: 'Sparse Album Edit Fixture', year: '2000', trackCount: 17 },
      { album: 'Sparse Album Edit Result', year: '2000', trackCount: 1 },
    ],
    selectedFilename: '01 - Sparse Album Track 1.mp3',
    setEditorValue: (actions, value) => actions.setAlbumName(value),
    stepLogger,
    tagEditorActions,
    testArtifacts,
    trackModalActions,
    updatedValue: 'Sparse Album Edit Result',
  });
});

test('FTC-TAGS-011 keeps a track-name-only edit on one retained album card', async ({
  freshBrowserSession,
  galleryActions,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
}) => {
  await runSparseTagEditScenario({
    field: 'title',
    freshBrowserSession,
    galleryActions,
    initialEditorFields: ['title', 'year'],
    initialEditorValues: {
      title: 'Sparse Title Track 1',
      year: '2002',
    },
    initialYear: '2002',
    originalAlbum: 'Sparse Title Edit Fixture',
    physicalFrame: 'TIT2',
    physicalValue: 'Sparse Title Edited',
    resultIdentities: [
      { album: 'Sparse Title Edit Fixture', year: '2002', trackCount: 18 },
    ],
    selectedFilename: '01 - Sparse Title Track 1.mp3',
    setEditorValue: (actions, value) => actions.setTrackName(value),
    stepLogger,
    tagEditorActions,
    testArtifacts,
    trackModalActions,
    updatedValue: 'Sparse Title Edited',
    verifyPendingPresentation: true,
  });
});

test('FTC-TAGS-012 carries Genre through selected Postgres payloads and edits only TCON', async ({
  freshBrowserSession,
  galleryActions,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
}) => {
  await runSparseTagEditScenario({
    field: 'genre',
    freshBrowserSession,
    galleryActions,
    initialEditorFields: ['genre', 'year'],
    initialEditorValues: {
      genre: 'Fixture Progressive',
      year: '2003',
    },
    initialYear: '2003',
    originalAlbum: 'Sparse Genre Edit Fixture',
    physicalFrame: 'TCON',
    physicalValue: 'Fixture Ambient',
    resultIdentities: [
      { album: 'Sparse Genre Edit Fixture', year: '2003', trackCount: 18 },
    ],
    selectedFilename: '01 - Sparse Genre Track 1.mp3',
    setEditorValue: (actions, value) => actions.setGenre(value),
    stepLogger,
    tagEditorActions,
    testArtifacts,
    trackModalActions,
    updatedValue: 'Fixture Ambient',
  });
});

test('FTC-TAGS-013 keeps a year-only edit sparse and retains its optimistic split', async ({
  appBarActions,
  freshBrowserSession,
  galleryActions,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
}) => {
  await runSparseTagEditScenario({
    appBarActions,
    field: 'year',
    freshBrowserSession,
    galleryActions,
    initialEditorFields: ['title', 'year'],
    initialEditorValues: {
      title: 'Sparse Year Track 1',
      year: '2004',
    },
    initialYear: '2004',
    originalAlbum: 'Sparse Year Edit Fixture',
    physicalFrame: 'TDRC',
    physicalValue: '2014',
    resultIdentities: [
      { album: 'Sparse Year Edit Fixture', year: '2004', trackCount: 17 },
      { album: 'Sparse Year Edit Fixture', year: '2014', trackCount: 1 },
    ],
    selectedFilename: '01 - Sparse Year Track 1.mp3',
    setEditorValue: (actions, value) => actions.setYear(value),
    stepLogger,
    tagEditorActions,
    testArtifacts,
    trackModalActions,
    updatedValue: '2014',
    verifyAfterIncrementalScan: true,
  });
});
