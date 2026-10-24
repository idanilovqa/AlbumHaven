import {mountObservationPreview} from './observation-panel.mjs';
import {createImportController} from './controller.mjs';
import {mountMaintenance} from './maintenance.mjs';
import {MAPPING,ENHANCED_MAPPING} from './contract.mjs';

const ACTION = 'account.self.foobar.write';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = new Set(['checking', 'reviewing', 'saving_personal', 'submitting', 'importing']);
const CONFLICT_PAGE_SIZE = 32;
const REVIEW_LABELS = Object.freeze([
  'Accepted source rows', 'Unmatched local rows', 'Ambiguous local rows',
  'Rows with invalid or unsupported fields', 'Protected rows', 'Unchanged rows',
]);
const FIELDS = Object.freeze({path: 'Path', artist: 'Artist', album_artist: 'Album artist',
  album: 'Album', date: 'Date', discnumber: 'Disc number', tracknumber: 'Track number',
  title: 'Title', rating: 'Rating', rating_stars: 'Rating stars', rating_stars_fixed: 'Fixed rating stars',
  favorite: 'Favourite', play_count: 'Play count', play_count_enhanced: 'Enhanced play count',
  first_played: 'First played', last_played: 'Last played', added: 'Added',
  first_played_enhanced: 'Enhanced first played', last_played_enhanced: 'Enhanced last played',
  added_enhanced: 'Enhanced added', length: 'Length', length_ex: 'Extended length',
  played_times: 'Played times', played_times_js: 'Played times list', played_times_raw: 'Raw played times',
  lastfm_played_times_js: 'Last.fm played times', lastfm_play_count: 'Last.fm play count'});
const PROBLEMS = Object.freeze({
  no_matching_library: 'No library selected. Source evidence can still be imported.',
  explicit_detach: 'Previously detached. No automatic local match will be added.',
  association_unavailable: 'The saved local match is unavailable.',
  duplicate_source_identity: 'Duplicate source identity. No automatic local match will be added.',
  ambiguous_library_identity: 'More than one possible local match.',
  duplicate_local_target: 'Multiple source rows point to the same local target.',
  association_conflict: 'The proposed local match conflicts with an existing association.',
  target_not_eligible: 'The local target is not eligible for matching.',
  no_local_match: 'No exact local match was found.',
  invalid_rating: 'Invalid rating field.',
  invalid_favorite: 'Invalid favourite field.',
  invalid_count: 'Invalid play-count field.',
  unsupported_history_field: 'Unsupported history field.',
  protected_rating: 'The existing rating is protected and will not be replaced.',
  protected_favorite: 'The existing favourite is protected and will not be replaced.',
});
let mountSequence = 0;

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const numberText = value => count(value) === null ? 'Not confirmed' : String(value);

// Only trusted, fixed component markup is parsed. Source-derived strings,
// review values and identifiers are assigned through DOM text/value properties.
export function mountFoobarImport(target, {
  fetch, contextRoot, allows, isCurrent, renderButton, renderTable,
}) {
  const document = target?.ownerDocument;
  const window = document?.defaultView;
  if (!document || !window || !contextRoot || contextRoot.ownerDocument !== document
      || typeof fetch !== 'function' || typeof allows !== 'function'
      || typeof isCurrent !== 'function' || typeof renderButton !== 'function'
      || typeof renderTable !== 'function') throw new TypeError('Foobar controls are unavailable.');

  const marker = contextRoot.dataset.accountFoobarContext;
  const scope = contextRoot.dataset.accountFoobarScope;
  const matchingMarker = contextRoot.dataset.accountFoobarMatchingLibraryId || '';
  const id = `foobar-import-${++mountSequence}`;
  const releases = [];
  const pending = new Set();
  const buttons = {};
  let disposed = false, controller = null, latest = null, maintenance = null, observationPanel = null;
  let renderedReview = null, confirmedReview = null, wantedFocus = null;
  let confirmedPersonalReview = null, invalidatedReview = null;
  const selectedConflicts = new Map();
  const conflictControls = [];
  const conflictReleases = [];
  const discoveryReleases = [];
  const discoveryControls = [];
  let renderedDiscovery = null;
  let reselectedForJob = false;
  let localError = '', observer = null, lifetimeTimer = null;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const section = element('section', 'library-settings-section foobar-import');
  section.setAttribute('aria-labelledby', `${id}-title`);
  const title = element('h3', '', 'Import a Foobar2000 export');
  title.id = `${id}-title`;
  section.append(title,
    element('p', '', 'Choose a supported Text Tools TSV or finalized Enhanced SQLite artifact, review the proposed changes, then confirm. Choosing a file or running a dry run does not import it.'),
    element('p', 'foobar-import__hint', 'The selected file is sent to this server for review and sent again when you confirm. The raw upload is temporary. Keep the original file if you may need to resume.'));

  const on = (node, event, listener) => {
    node.addEventListener(event, listener);
    releases.push(() => node.removeEventListener(event, listener));
  };
  const group = (legendText, parent = section) => {
    const fieldset = element('fieldset', 'foobar-import__group');
    fieldset.append(element('legend', '', legendText));
    parent.append(fieldset);
    return fieldset;
  };
  const field = (text, node, parent, suffix, hint) => {
    const label = element('label', 'lastfm-inline-field foobar-import__field');
    node.id = `${id}-${suffix}`;
    label.htmlFor = node.id;
    label.append(element('span', '', text), node);
    parent.append(label);
    if (hint) {
      const description = element('p', 'foobar-import__hint', hint);
      description.id = `${node.id}-hint`;
      node.setAttribute('aria-describedby', description.id);
      parent.append(description);
    }
    return node;
  };
  const input = type => {
    const node = element('input', type === 'checkbox' ? '' : 'utility-search-input');
    node.type = type;
    if (type === 'text') {node.autocomplete = 'off'; node.spellcheck = false;}
    return node;
  };
  const action = (key, label, parent, primary = false) => {
    const holder = element('div');
    holder.innerHTML = renderButton({label, type: 'button', variant: primary ? 'primary' : 'secondary',
      attributes: {'data-foobar-import-action': key}});
    const button = holder.firstElementChild;
    if (!button || button.tagName !== 'BUTTON' || holder.children.length !== 1)
      throw new TypeError('Shared Button owner unavailable.');
    button.type = 'button';
    parent.append(button);
    buttons[key] = button;
    return button;
  };
  const setDisabled = (node, disabled) => {
    node.disabled = Boolean(disabled);
    node.setAttribute('aria-disabled', String(node.disabled));
  };
  const setText = (node, text) => {if (node.textContent !== text) node.textContent = text;};
  const visible = (node, show) => {node.hidden = !show;};

  const discoveryGroup = group('Find my earlier imports');
  discoveryGroup.append(element('p', 'foobar-import__hint', 'This list is advisory. Open an import to read its genuine server status before deciding what to do. No changes are applied by browsing. Clear a selected file first; an unresolved submitted import must remain selected.'));
  const discoveryFilter = element('select', 'utility-search-input');
  for (const [value, label] of [['unfinished', 'Unfinished imports'], ['recent', 'All recent imports']]) {
    const option = element('option', '', label); option.value = value; discoveryFilter.append(option);
  }
  field('Show', discoveryFilter, discoveryGroup, 'discovery-filter');
  const discoveryStatus = element('p');
  discoveryStatus.setAttribute('role', 'status');
  discoveryStatus.setAttribute('aria-live', 'polite');
  const discoveryError = element('p', 'foobar-import__error');
  discoveryError.setAttribute('role', 'alert');
  const discoveryItems = element('ul');
  const discoveryActions = element('div', 'settings-integration-actions foobar-import__actions');
  action('refreshJobs', 'Refresh imports', discoveryActions);
  action('firstJobs', 'First page', discoveryActions);
  action('nextJobs', 'Next page', discoveryActions);
  discoveryGroup.append(discoveryStatus, discoveryError, discoveryItems, discoveryActions);

  const sourceGroup = group('1. Choose the account source');
  sourceGroup.append(element('p', 'foobar-import__hint', 'After a successful idle import-list read, your default Foobar source is selected automatically. If discovery is unavailable or busy, use the explicit default-source button or recover an existing import. Use an existing source UUID only when you intend to continue that account source.'));
  const sourceStatus = element('p');
  sourceGroup.append(sourceStatus);
  const advancedSource = element('details', 'foobar-import__details');
  advancedSource.append(element('summary', '', 'Advanced source references'));
  sourceGroup.append(advancedSource);
  const selectedSource = field('Selected account source UUID', input('text'), advancedSource, 'selected-source');
  selectedSource.readOnly = true;
  const sourceChoice = field('Existing source UUID', input('text'), advancedSource, 'source-choice');
  sourceChoice.maxLength = 36;
  sourceChoice.setAttribute('placeholder', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
  const sourceActions = element('div', 'settings-integration-actions foobar-import__actions');
  sourceGroup.append(sourceActions);
  action('defaultSource', 'Use my default source', sourceActions);
  action('selectSource', 'Use this source UUID', advancedSource);

  const fileGroup = group('2. Choose the original file');
  const mapping = element('select', 'utility-search-input');
  const mappingOption = element('option', '', 'Foobar Text Tools snapshot v1 (UTF-8 TSV)');
  mappingOption.value=MAPPING;
  const enhancedOption=element('option','','Enhanced Playcount finalized SQLite');
  enhancedOption.value=ENHANCED_MAPPING;
  mapping.append(mappingOption,enhancedOption);
  field('Supported export format', mapping, fileGroup, 'mapping',
    'TSV uses the named Text Tools columns and required path. SQLite must be a finalized, self-contained artifact, not a live database copy or a file dependent on a WAL. The server validates it; selecting the format is not proof of completeness.');
  const file = field('Original file: TSV up to 64 MiB; SQLite up to 512 MiB', input('file'), fileGroup, 'file');
  file.accept = '.tsv,text/tab-separated-values';
  const filename = element('p', 'foobar-import__filename');
  filename.id = `${id}-filename`;
  file.setAttribute('aria-describedby', filename.id);
  fileGroup.append(filename);
  const matching = input('checkbox');
  const matchingLabel = element('label', 'foobar-import__check');
  matching.id = `${id}-matching`;
  matchingLabel.htmlFor = matching.id;
  matchingLabel.append(matching, element('span', '', 'Try matching to my currently selected library'));
  const matchingHint = element('p', 'foobar-import__hint');
  matchingHint.id = `${id}-matching-hint`;
  matching.setAttribute('aria-describedby', matchingHint.id);
  fileGroup.append(matchingLabel, matchingHint,
    element('p', 'foobar-import__hint', 'Without library matching, the import saves account-owned source evidence only. It does not change local library ratings or favourites. Play counts and dates remain source observations, not generated listening events.'));
  const fileActions = element('div', 'settings-integration-actions foobar-import__actions');
  fileGroup.append(fileActions);
  action('preview', 'Run dry-run review', fileActions, true);
  action('cancelReview', 'Cancel dry run', fileActions);
  action('clear', 'Clear selected file', fileActions);

  const status = element('p', 'foobar-import__status');
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const error = element('p', 'foobar-import__error');
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-atomic', 'true');
  error.hidden = true;
  section.append(status, error);

  const reviewSection = element('section', 'foobar-import__review');
  reviewSection.hidden = true;
  reviewSection.setAttribute('aria-labelledby', `${id}-review-title`);
  const reviewTitle = element('h4', '', '3. Review the proposed import');
  reviewTitle.id = `${id}-review-title`;
  reviewTitle.tabIndex = -1;
  const reviewBody = element('div');
  reviewSection.append(reviewTitle, reviewBody);
  const problemPageHint = element('p', 'foobar-import__hint', 'At most 32 problem instances are shown per page; one source track may have several problems. Every problem is reachable without fixing earlier ones. Next problems sends the same original file for a fresh whole-file review, which may take as long as the first review. First problems starts a new review at the first problem and conflict pages. Changing pages clears all personal selections and both confirmations; it saves nothing and does not change matching.');
  problemPageHint.id = `${id}-problem-page-hint`;
  const problemPageActions = element('div', 'settings-integration-actions foobar-import__actions');
  action('firstProblems', 'First problems', problemPageActions);
  action('nextProblems', 'Next problems', problemPageActions);
  buttons.firstProblems.setAttribute('aria-describedby', problemPageHint.id);
  buttons.nextProblems.setAttribute('aria-describedby', problemPageHint.id);
  reviewSection.append(problemPageHint, problemPageActions);

  const personalSection = element('section', 'foobar-import__personal');
  personalSection.hidden = true;
  personalSection.setAttribute('aria-labelledby', `${id}-personal-title`);
  const personalTitle = element('h4', '', 'Personal taste changes, separate from import');
  personalTitle.id = `${id}-personal-title`;
  personalTitle.tabIndex = -1;
  const personalExplanation = element('p', 'foobar-import__caution', 'These are changes to your own native ratings and favourites, not import overrides. Select individual fields below, then confirm separately to save them immediately. Saving personal changes does not import source rows or advance import progress.');
  personalExplanation.id = `${id}-personal-explanation`;
  const conflictSummary = element('p');
  const conflictBody = element('div');
  const conflictPageHint = element('p', 'foobar-import__hint', 'At most 32 exact fields are shown per page. Each page sends the same original file again and runs a fresh whole-file review, which may take as long as the first review. The source and import identity stay the same. First conflicts starts at the first conflict and problem pages. Changing pages clears all selections and confirmations; it does not save changes.');
  conflictPageHint.id = `${id}-conflict-page-hint`;
  const conflictPageActions = element('div', 'settings-integration-actions foobar-import__actions');
  action('firstConflicts', 'First conflicts', conflictPageActions);
  action('nextConflicts', 'Next conflicts', conflictPageActions);
  buttons.firstConflicts.setAttribute('aria-describedby', conflictPageHint.id);
  buttons.nextConflicts.setAttribute('aria-describedby', conflictPageHint.id);
  const personalSelection = element('p');
  personalSelection.setAttribute('role', 'status');
  personalSelection.setAttribute('aria-live', 'polite');
  personalSelection.setAttribute('aria-atomic', 'true');
  const personalConfirmation = input('checkbox');
  personalConfirmation.id = `${id}-personal-confirmation`;
  const personalConfirmationLabel = element('label', 'foobar-import__check');
  personalConfirmationLabel.htmlFor = personalConfirmation.id;
  personalConfirmationLabel.append(personalConfirmation,
    element('span', '', 'I want to save only the selected fields as immediate changes to my own native ratings and favourites, separately from this import.'));
  const personalConfirmHint = element('p', 'foobar-import__hint', 'This never clears a rating, removes a favourite, or overrides an ambiguous local match. The server checks each exact field again. After any save attempt, including a lost response, selections are cleared and a new import review is required. Nothing is automatically imported or retried.');
  personalConfirmHint.id = `${id}-personal-confirm-hint`;
  personalConfirmation.setAttribute('aria-describedby', `${personalExplanation.id} ${personalConfirmHint.id}`);
  const personalActions = element('div', 'settings-integration-actions foobar-import__actions');
  action('savePersonal', 'Save selected personal changes', personalActions);
  personalSection.append(personalTitle, personalExplanation, conflictSummary, conflictBody,
    conflictPageHint, conflictPageActions, personalSelection, personalConfirmationLabel,
    personalConfirmHint, personalActions);
  reviewSection.append(personalSection);

  const observationHost = element('div');
  reviewSection.append(observationHost);
  const confirmGroup = group('Explicit import confirmation', reviewSection);
  const confirmation = input('checkbox');
  confirmation.id = `${id}-confirmation`;
  const confirmationLabel = element('label', 'foobar-import__check');
  confirmationLabel.htmlFor = confirmation.id;
  confirmationLabel.append(confirmation, element('span', '', 'I have reviewed these proposed changes and want to import them into my account.'));
  const confirmHint = element('p', 'foobar-import__hint', 'Confirmation applies only to this review and original file. Personal-field selections are not included in the import. The server rechecks the proposal before applying batches. A changed source, file, library, or protected value may require a new review.');
  confirmHint.id = `${id}-confirm-hint`;
  confirmation.setAttribute('aria-describedby', confirmHint.id);
  confirmGroup.append(confirmationLabel, confirmHint);
  const confirmActions = element('div', 'settings-integration-actions foobar-import__actions');
  confirmGroup.append(confirmActions);
  action('confirm', 'Confirm import', confirmActions, true);
  section.append(reviewSection);

  const jobSection = element('section', 'foobar-import__job');
  jobSection.hidden = true;
  jobSection.setAttribute('aria-labelledby', `${id}-job-title`);
  const jobTitle = element('h4', '', 'Import progress and recovery');
  jobTitle.id = `${id}-job-title`;
  jobTitle.tabIndex = -1;
  const progressText = element('p');
  progressText.setAttribute('role', 'status');
  progressText.setAttribute('aria-live', 'polite');
  progressText.setAttribute('aria-atomic', 'true');
  const progress = element('progress', 'foobar-import__progress');
  progress.setAttribute('aria-label', 'Server-confirmed source rows');
  const progressDetail = element('p', 'foobar-import__hint');
  const confirmedChanges = element('p');
  const uncertainty = element('p', 'foobar-import__caution');
  const resumeHint = element('p', 'foobar-import__hint', 'To resume, reselect the exact original file above, then review the remaining work and confirm again. An edited file or a fresh re-export is not the original file. Temporary SQLite uploads are not retained for restart recovery.');
  const countFamilySummary = element('p', 'foobar-import__hint');
  jobSection.append(jobTitle, countFamilySummary, progressText, progress, progressDetail, confirmedChanges, uncertainty, resumeHint);
  const jobActions = element('div', 'settings-integration-actions foobar-import__actions');
  jobSection.append(jobActions);
  action('status', 'Check server status', jobActions);
  action('cancel', 'Request stop', jobActions);
  action('resume', 'Review remaining work / reconcile', jobActions, true);
  jobSection.append(element('p', 'foobar-import__hint', 'Requesting a stop does not undo confirmed work. A batch already in flight may still settle; check the server status before deciding what remains.'));
  const references = element('details', 'foobar-import__details');
  references.append(element('summary', '', 'Recovery references for this import'),
    element('p', 'foobar-import__hint', 'Keep these references and the exact original file if you need to recover this import after closing or reloading this page. They are not saved in browser storage.'));
  const sourceRef = field('Account source UUID', input('text'), references, 'source-reference');
  const jobRef = field('Import job UUID', input('text'), references, 'job-reference');
  sourceRef.readOnly = true;
  jobRef.readOnly = true;
  jobSection.append(references);
  section.append(jobSection);

  const recovery = element('details', 'foobar-import__details');
  recovery.append(element('summary', '', 'Advanced: recover using exact references'),
    element('p', 'foobar-import__hint', 'Use the exact source and job UUIDs from that import. Recovery reads its server checkpoint; it does not create a replacement import or apply changes.'));
  const recoverSource = field('Earlier account source UUID', input('text'), recovery, 'recover-source');
  const recoverJob = field('Earlier import job UUID', input('text'), recovery, 'recover-job');
  recoverSource.maxLength = 36;
  recoverJob.maxLength = 36;
  const recoveryActions = element('div', 'settings-integration-actions foobar-import__actions');
  recovery.append(recoveryActions);
  action('recover', 'Read this import’s status', recoveryActions);
  section.append(recovery);

  function isLive() {
    if (disposed) return false;
    try {
      // The native Settings modal is a document sibling of the signed shell,
      // not its descendant. The caller binds the exact host and shell owners.
      return target.isConnected && contextRoot.isConnected
        && target.ownerDocument === contextRoot.ownerDocument
        && target.contains(section) && /^[a-f0-9]{64}$/.test(marker || '')
        && scope === 'account-foobar-v1'
        && contextRoot.dataset.accountFoobarContext === marker
        && contextRoot.dataset.accountFoobarScope === scope
        && (contextRoot.dataset.accountFoobarMatchingLibraryId || '') === matchingMarker
        && allows(ACTION) === true && isCurrent() === true;
    } catch {return false;}
  }

  function retire(showMessage = true) {
    if (disposed) return;
    const owned = target.contains(section);
    disposed = true;
    observer?.disconnect();
    maintenance?.dispose(); maintenance=null;
    observationPanel?.dispose(); observationPanel=null;
    if (lifetimeTimer !== null) window.clearInterval(lifetimeTimer);
    for (const release of releases.splice(0).reverse()) release();
    try {controller?.dispose();} catch { /* Retire the DOM even if an owner cannot finish cleanup. */ }
    pending.clear();
    latest = null; renderedReview = null; confirmedReview = null; wantedFocus = null;
    invalidatedReview = null;
    clearPersonalSelections();
    for (const release of conflictReleases.splice(0).reverse()) release();
    conflictControls.length = 0;
    for (const release of discoveryReleases.splice(0).reverse()) release();
    for (const {key} of discoveryControls) delete buttons[key];
    discoveryControls.length = 0;
    renderedDiscovery = null;
    reselectedForJob = false;
    file.value = ''; sourceChoice.value = ''; selectedSource.value = ''; recoverSource.value = ''; recoverJob.value = '';
    sourceRef.value = ''; jobRef.value = '';
    filename.textContent = '';
    reviewBody.replaceChildren();
    conflictBody.replaceChildren();
    section.remove();
    if (showMessage && owned && target.isConnected) {
      const message = element('p', '', 'Foobar import controls were closed because the account context changed. Reload this page to reopen them and check any import already submitted.');
      message.setAttribute('role', 'status');
      target.append(message);
    }
  }

  function guard() {
    if (isLive()) return true;
    retire();
    return false;
  }

  // Shared CompactDataTable remains the table owner. Its cells start empty;
  // untrusted values never enter its HTML-string API, even after escaping.
  function safeTable(titleText, columns, rows, suffix) {
    const wrapper = element('div', 'foobar-import__table');
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', titleText);
    wrapper.tabIndex = 0;
    wrapper.innerHTML = renderTable({id: `${id}-${suffix}`, ariaLabel: titleText,
      columns: columns.map(column => column.width).join(' '),
      columnsConfig: columns.map(({key, label}) => ({key, label})),
      headers: 'visible', density: 'compact', overflow: 'local', mobile: 'stack', frame: 'outline',
      rows: rows.map((unused, index) => ({key: String(index), cells: Object.fromEntries(columns.map(column => [column.key, '']))})),
    });
    const table = wrapper.querySelector('[role="table"]');
    const rowNodes = wrapper.querySelectorAll('.compact-data-table-body > [role="row"]');
    if (!table || rowNodes.length !== rows.length) throw new TypeError('Shared Table owner unavailable.');
    rowNodes.forEach((rowNode, index) => {
      columns.forEach(column => {
        const cell = rowNode.querySelector(`[data-cdt-column="${column.key}"]`);
        if (!cell) throw new TypeError('Shared Table cell unavailable.');
        cell.textContent = rows[index][column.key];
      });
    });
    return wrapper;
  }

  function changesText(values, prefix) {
    if (!Array.isArray(values) || values.length !== 7 || values.some(value => count(value) === null)) return '';
    return `${prefix}: ${values[1] + values[3]} source-evidence rows, ${values[4]} ratings, ${values[5]} favourites and ${values[6]} new local associations. These counts can overlap.`;
  }

  function clearPersonalSelections() {
    selectedConflicts.clear();
    confirmedPersonalReview = null;
    personalConfirmation.checked = false;
    for (const {checkbox} of conflictControls) checkbox.checked = false;
  }

  function conflictEligible(conflict) {
    if (!conflict || count(conflict.row) === null || conflict.row < 1
        || conflict.eligible !== true || conflict.reason !== null) return false;
    if (conflict.field === 'rating') return conflict.consequence === 'replace_personal_rating'
      && Number.isInteger(conflict.proposed) && conflict.proposed >= 1 && conflict.proposed <= 5
      && (conflict.existing === null || Number.isInteger(conflict.existing)
        && conflict.existing >= 1 && conflict.existing <= 5)
      && conflict.proposed !== conflict.existing;
    return conflict.field === 'favorite' && conflict.consequence === 'set_personal_favorite'
      && conflict.existing === 'off' && conflict.proposed === 'loved';
  }

  function personalValue(fieldName, value) {
    if (fieldName === 'rating') return value === null ? 'Not set'
      : Number.isInteger(value) && value >= 1 && value <= 5 ? `${value} of 5` : 'Not available';
    if (fieldName === 'favorite') return value === 'off' ? 'Off'
      : value === 'loved' ? 'Loved' : value === 'obsessed' ? 'Obsessed' : 'Not available';
    return 'Not available';
  }

  function personalConsequence(conflict, eligible) {
    if (!eligible) return conflict.reason === 'provenance_requires_review'
      ? 'Unavailable: this field’s ownership history requires review. It cannot be changed here.'
      : 'Unavailable: this is not a safe personal rating or Off-to-Loved change. No change can be selected.';
    return conflict.field === 'rating'
      ? `Save your rating as ${conflict.proposed} of 5 immediately, separately from import.`
      : 'Set your favourite from Off to Loved immediately, separately from import.';
  }

  function sourceSong(conflict) {
    const title=conflict.source_title||'Untitled source track';
    const artist=conflict.source_artist||'Unknown source artist';
    const album=conflict.source_album?` (${conflict.source_album})`:'';
    return `${artist} / ${title}${album} · row ${numberText(conflict.row)}`;
  }

  function renderConflicts(review) {
    clearPersonalSelections();
    for (const release of conflictReleases.splice(0).reverse()) release();
    conflictControls.length = 0;
    conflictBody.replaceChildren();
    const conflicts = Array.isArray(review?.conflicts) ? review.conflicts.slice(0, CONFLICT_PAGE_SIZE) : [];
    setText(conflictSummary, `${numberText(review?.conflict_count)} personal-field conflicts in total. ${conflicts.length} shown on this page. ${numberText(review?.conflict_remaining)} conflicts remain after this page.`);
    if (!conflicts.length) {
      conflictBody.append(element('p', '', 'There are no personal-field conflicts on this page.'));
      return;
    }
    const keys = conflicts.map(conflict => `${conflict.row}:${conflict.field}`);
    const eligible = conflicts.map((conflict, index) => conflictEligible(conflict)
      && keys.indexOf(keys[index]) === keys.lastIndexOf(keys[index]));
    const table = safeTable('Personal-field conflicts, separate from import', [
      {key: 'select', label: 'Select field', width: 'minmax(110px, .8fr)'},
      {key: 'row', label: 'Song from source (labels may be shortened)', width: 'minmax(220px, 1.5fr)'},
      {key: 'field', label: 'Field', width: 'minmax(100px, .7fr)'},
      {key: 'existing', label: 'Your current value', width: 'minmax(110px, .8fr)'},
      {key: 'proposed', label: 'Incoming proposal', width: 'minmax(110px, .8fr)'},
      {key: 'consequence', label: 'Consequence or reason unavailable', width: 'minmax(240px, 2fr)'},
    ], conflicts.map((conflict, index) => ({select: '', row: sourceSong(conflict),
      field: conflict.field === 'rating' ? 'Rating' : conflict.field === 'favorite' ? 'Favourite' : 'Unavailable',
      existing: personalValue(conflict.field, conflict.existing),
      proposed: personalValue(conflict.field, conflict.proposed),
      consequence: personalConsequence(conflict, eligible[index]),
    })), 'personal-conflicts');
    const rows = table.querySelectorAll('.compact-data-table-body > [role="row"]');
    rows.forEach((row, index) => {
      const conflict = conflicts[index], key = keys[index];
      const checkbox = input('checkbox');
      checkbox.id = `${id}-personal-field-${index}`;
      checkbox.checked = false;
      const label = element('label', 'foobar-import__check foobar-import__conflict-check');
      label.htmlFor = checkbox.id;
      label.append(checkbox, element('span', '', `Change ${conflict.field === 'rating' ? 'rating' : 'favourite'} for ${sourceSong(conflict)}`));
      const consequence = row.querySelector('[data-cdt-column="consequence"]');
      consequence.id = `${id}-personal-consequence-${index}`;
      checkbox.setAttribute('aria-describedby', consequence.id);
      row.querySelector('[data-cdt-column="select"]').append(label);
      const change = () => {
        if (!guard()) return;
        if (latest?.review !== review || latest.phase !== 'review_ready'
            || invalidatedReview === review || !eligible[index] || pending.size) {
          checkbox.checked = selectedConflicts.has(key);
          return;
        }
        confirmedPersonalReview = null;
        personalConfirmation.checked = false;
        confirmedReview = null;
        confirmation.checked = false;
        if (checkbox.checked && selectedConflicts.size < CONFLICT_PAGE_SIZE)
          selectedConflicts.set(key, {row: conflict.row, field: conflict.field});
        else {selectedConflicts.delete(key); checkbox.checked = false;}
        render(latest);
      };
      checkbox.addEventListener('change', change);
      conflictReleases.push(() => checkbox.removeEventListener('change', change));
      conflictControls.push({checkbox, eligible: eligible[index]});
    });
    conflictBody.append(table);
  }

  function renderReview(review) {
    reviewBody.replaceChildren();
    renderConflicts(review);
    if (!review) return;
    const start = count(review.start_offset), checked = count(review.checked_rows);
    const range = start !== null && checked !== null
      ? `Dry run checked ${checked} source rows, starting after ${start} already-confirmed rows.`
      : 'Dry-run results for the selected source range.';
    reviewBody.append(element('p', '', range),
      element('p', 'foobar-import__hint', 'Accepted means source rows admitted by the dry run, not rows imported or successfully matched. These categories overlap and must not be added together.'));
    const counters = Array.isArray(review.review_counts) ? review.review_counts : [];
    const enhanced=review.command.mapping_name===ENHANCED_MAPPING;
    const labels=enhanced?['Accepted source records','Records with a permitted library association','Ambiguous aliases or conflicting associations',
      'Incoming records with unavailable, invalid or unsupported payloads','Native taste changes not attempted','Unchanged source records']:REVIEW_LABELS;
    reviewBody.append(safeTable('Dry-run review counts', [
      {key: 'category', label: 'Review category', width: 'minmax(180px, 2fr)'},
      {key: 'count', label: 'Source rows', width: 'minmax(100px, 1fr)'},
    ], labels.map((label, index) => ({category: label, count: numberText(counters[index])})), 'review-counts'));
    const changes = changesText(review.proposed_counts, 'Proposed updates');
    if (changes) reviewBody.append(element('p', '', changes));
    if(enhanced){
      reviewBody.append(element('p','foobar-import__caution','This import saves timestamp-vector evidence, not lifetime play counts, sessions, duration or full-album proof. Repeated vector positions remain separate evidence; cached Last.fm entries are not local Foobar listens.'),
        element('p','foobar-import__hint','Invalid or unavailable incoming payloads are retained as source evidence and do not erase previously usable values. Empty valid vectors are genuine corrections. This summary does not provide per-record diagnostic pages.'),
        element('p','foobar-import__hint','Selected-library matching uses exact imported aliases and preserves existing explicit decisions. Ambiguous records remain separate source evidence. No native rating/favourite change or playback grant is proposed. Later authority, capacity or state changes can stop a batch; earlier confirmed batches remain saved.'));
      return;
    }
    reviewBody.append(element('p', 'foobar-import__caution', 'Protected local values are not replaced by the import. Eligible personal-field conflicts can be changed individually in the separate personal taste section below; there is no blanket override of import protection.'),
      element('p', 'foobar-import__hint', 'This is a dry run, not a reservation or a promise that every batch will finish. No import has been applied by this review.'));
    reviewBody.append(element('p','foobar-import__hint',
      `Selected displayed count: ${latest?.countFamily==='enhanced'?'Enhanced TSV':'Standard TSV'}. Both families are retained separately, never added; unavailable selected values do not fall back. Inspect both original and effective observations below.`));
    if(review.observations){
      reviewBody.append(element('p','foobar-import__hint','Observation inspection is shown below. Problem and personal-conflict pages are not shown in this mode; return to their review before choosing any personal changes.'));
      return;
    }
    const problems = Array.isArray(review.problem_items) ? review.problem_items.slice(0, 32) : [];
    reviewBody.append(element('h5', '', 'Problems needing attention'),
      element('p', '', `${numberText(review.problem_count)} problem instances in total. ${problems.length} shown on this page. ${numberText(review.problem_remaining)} problem instances remain after this page. These are not distinct-track counts.`));
    if (problems.length) {
      reviewBody.append(safeTable('Foobar dry-run row problems', [
        {key: 'row', label: 'Song from source (labels may be shortened)', width: 'minmax(220px, 1.5fr)'},
        {key: 'field', label: 'Field', width: 'minmax(110px, .8fr)'},
        {key: 'problem', label: 'Review finding', width: 'minmax(220px, 2fr)'},
      ], problems.map(problem => ({row: sourceSong(problem),
        field: Object.hasOwn(FIELDS, problem.field) ? FIELDS[problem.field] : 'General',
        problem: Object.hasOwn(PROBLEMS, problem.code) ? PROBLEMS[problem.code] : 'A review issue needs attention.',
      })), 'review-problems'));
    } else reviewBody.append(element('p', '', 'No problems are shown on this page.'));
  }

  function completionKnown(state) {
    const job = state.job;
    visible(countFamilySummary, state.mapping === MAPPING);
    setText(countFamilySummary, `This page displays ${state.countFamily === 'enhanced' ? 'Enhanced TSV' : 'Standard TSV'} counts. Both evidence families remain retained separately and are never added. This display choice is local to this page, not a persisted job preference or a change to confirmed import counters.`);
    return Boolean(job && job.snapshot_kind === 'durable'
      && job.phase === 'completed' && job.disposition === 'completed'
      && job.uncertain === false && count(job.command?.total_rows) !== null
      && job.confirmed_rows === job.command.total_rows && job.remaining_rows === 0);
  }

  function statusText(state) {
    if (state.phase === 'saving_personal')
      return 'Saving only your selected personal fields. This is separate from import; no source rows are being imported by this action…';
    if (state.phase === 'completed') return completionKnown(state)
      ? 'The server has confirmed the complete import.'
      : 'Completion is not yet confirmed. Check the server status.';
    if (state.job?.uncertain === true) return 'The last attempt has an uncertain outcome. Only the server-confirmed prefix below is known; do not start a duplicate import.';
    if (state.job?.cancel_pending === true) return 'A stop has been requested. Waiting for the server to confirm where the import stopped.';
    if (state.job?.phase === 'completed' && !completionKnown(state))
      return 'The last snapshot reports completion, but durable completion is not confirmed. Check this same import’s server status.';
    const messages = {
      checking: 'Checking your account source…',
      idle: 'Choose a supported TSV file to begin.',
      selected: 'The file is selected. Run a dry-run review before confirming an import.',
      reviewing: 'Reviewing the selected source range. No changes are applied by the dry run…',
      review_ready: 'The dry-run review is ready. No changes from this review have been applied.',
      submitting: 'Submitting the confirmed import. Acceptance is not proof that a batch has been saved…',
      importing: 'The import is running. Progress below shows only work confirmed by the server.',
      paused: 'The import is paused or stopped. Check its confirmed progress before reviewing remaining work.',
      error: 'The request could not be completed. Check the message below before continuing.',
      retired: 'This import screen is no longer current.',
    };
    return messages[state.phase] || 'Foobar import status is unavailable.';
  }

  function render(state) {
    if (!guard()) return;
    if (state.phase === 'submitting' && latest?.phase !== 'submitting') reselectedForJob = false;
    latest = state;
    maintenance?.update(state);
    observationPanel?.update(state);
    if (state.phase === 'retired') {retire(); return;}
    const busy = BUSY.has(state.phase) || state.discoveryLoading === true;
    const hasJob = state.submitted === true && Boolean(state.jobRef);
    const complete = completionKnown(state);
    const uncertain = state.job?.uncertain === true;
    const originalLibrary = state.job?.command?.original_matching_library_id;
    const originalScopeAvailable = originalLibrary == null || String(originalLibrary) === matchingMarker;
    const locked = busy || hasJob;
    const discoveryAllowed = state.canDiscover === true && pending.size === 0;
    discoveryFilter.value = state.discoveryUnfinished === false ? 'recent' : 'unfinished';
    setDisabled(discoveryFilter, !discoveryAllowed);
    setDisabled(buttons.refreshJobs, !discoveryAllowed);
    setDisabled(buttons.firstJobs, !discoveryAllowed || !state.discoveryCursor);
    setDisabled(buttons.nextJobs, !discoveryAllowed || Boolean(state.discoveryError)
      || !state.discovery?.next_cursor || state.discovery.unfinished !== state.discoveryUnfinished);
    discoveryGroup.setAttribute('aria-busy', String(state.discoveryLoading === true));
    const listed = state.discovery;
    setText(discoveryStatus, state.discoveryLoading ? 'Reading your account imports…'
      : listed?.busy ? 'Incomplete busy snapshot: a worker is busy. This is not the complete saved-import list. Refresh later, or open an available import to check its status.'
      : listed ? `${listed.items.length} ${listed.unfinished ? 'unfinished' : 'recent'} imports on this page. This is a changing server snapshot, not permission to resume.`
      : 'The import list is not available yet. Refresh to read it.');
    setText(discoveryError, state.discoveryError || '');
    visible(discoveryError, Boolean(state.discoveryError));
    if (listed !== renderedDiscovery) {
      for (const release of discoveryReleases.splice(0).reverse()) release();
      for (const {key} of discoveryControls) delete buttons[key];
      discoveryControls.length = 0;
      discoveryItems.replaceChildren();
      renderedDiscovery = listed;
      const dateText = value => value === null ? 'Not available in busy snapshot'
        : new Date(value.slice(0, 23) + 'Z').toLocaleString();
      for (const [index, item] of (listed?.items || []).entries()) {
      const row = element('li');
      const stateLabel = item.confirmed_rows === item.total_rows
        ? 'All rows listed as confirmed; check current status.'
        : item.cancel_requested === true ? 'Incomplete; stop was requested. Check current status.'
        : listed.busy ? 'Current worker snapshot; outcome may still be settling.'
        : 'Incomplete saved import; this does not mean it is running.';
      row.append(element('p', '', `Created: ${dateText(item.created_at)}. Updated: ${dateText(item.updated_at)}.`),
        element('p', '', `Confirmed progress: ${item.confirmed_rows === null ? 'Not available yet' : `${item.confirmed_rows} of ${item.total_rows} rows`}. Stop requested: ${item.cancel_requested === null ? 'Not available yet' : item.cancel_requested ? 'Yes' : 'No'}.`),
        element('p', '', stateLabel));
      const key = `openJob${index}`;
      row.children[0].id = `${id}-job-list-${index}-date`;
      row.children[1].id = `${id}-job-list-${index}-progress`;
      const open = action(key, 'Open import status', row);
      open.setAttribute('aria-describedby', `${row.children[0].id} ${row.children[1].id}`);
      const click = () => {
        if (!guard() || pending.size > 0 || latest?.canDiscover !== true) return;
        const ownedFocus = document.activeElement === open;
        wantedFocus = ownedFocus ? 'job' : null;
        void run('recover', () => {
          const outcome = controller.selectDiscoveredJob(item.job_ref, item.source_ref);
          // Recover publishes the exact identity synchronously, before its
          // status await. A browser may blur a disabled button during run's
          // pre-render; preserve only this immediate activation focus intent.
          const current = controller.getState();
          if (ownedFocus && guard() && current.submitted === true
              && current.jobRef === item.job_ref && current.source?.source_ref === item.source_ref
              && !jobSection.hidden) jobTitle.focus();
          return outcome;
        });
      };
      open.addEventListener('click', click);
      discoveryReleases.push(() => open.removeEventListener('click', click));
      discoveryControls.push({key, open});
      discoveryItems.append(row);
      }
    }
    for (const {open} of discoveryControls)
      setDisabled(open, !discoveryAllowed || Boolean(state.discoveryError));
    const choosing = pending.has('source') || pending.has('recover');
    const operationPending = pending.has('preview') || pending.has('resume') || pending.has('confirm')
      || pending.has('personal') || pending.has('conflicts') || pending.has('problems')
      || pending.has('observations') || pending.has('review');
    // Leave live regions outside busy containers so confirmed progress is
    // announced while a long import is still running.
    sourceGroup.setAttribute('aria-busy', String(state.phase === 'checking' || choosing));
    fileGroup.setAttribute('aria-busy', String(state.phase === 'reviewing'));
    setText(sourceStatus, state.source
      ? 'An account-owned Foobar source is selected.'
      : 'No account source is selected. Choose the default source or enter an existing source UUID.');
    selectedSource.value = UUID.test(state.source?.source_ref || '') ? state.source.source_ref : '';
    visible(selectedSource.parentElement, Boolean(selectedSource.value));
    setDisabled(sourceChoice, locked || choosing);
    setDisabled(buttons.defaultSource, locked || choosing);
    setDisabled(buttons.selectSource, locked || choosing);
    setDisabled(file, !state.source || busy || choosing || complete);
    mapping.value=state.mapping||MAPPING;
    setDisabled(mapping,locked||choosing);
    const enhanced=state.mapping===ENHANCED_MAPPING;
    file.accept=enhanced?'.sqlite,.sqlite3,.db,application/vnd.sqlite3':'.tsv,text/tab-separated-values';
    setText(filename, state.filename ? `Selected file: ${state.filename}` : 'No file selected.');
    matching.checked = hasJob && state.job ? originalLibrary !== null : state.matching === true;
    setDisabled(matching, !state.matchingAvailable || locked || choosing);
    setText(matchingHint, hasJob && !originalScopeAvailable
      ? 'This import keeps its original library scope. Select that library and reopen this page before reviewing remaining work. You can still check its account-owned status here.'
      : hasJob ? 'This import keeps its original library choice. Recovery cannot change it.'
      : enhanced && state.matchingAvailable
      ? 'Optional exact-alias association with the current library. Existing explicit choices are preserved; ambiguous records stay unmatched. This never changes native ratings/favourites or grants playback.'
      : state.matchingAvailable
      ? 'Optional. Only your server-verified current library can be used; no other library can be entered here.'
      : 'No eligible current library is available. You can still import source evidence without library matching.');
    setDisabled(buttons.preview, !state.source || !state.filename || locked || choosing || operationPending);
    visible(buttons.cancelReview, state.phase === 'reviewing');
    setDisabled(buttons.cancelReview, state.phase !== 'reviewing' || pending.has('cancel'));
    setDisabled(buttons.clear, !state.filename && !complete || busy || hasJob && !complete || choosing);
    const clearLabel = buttons.clear.querySelector('.ui-button__content') || buttons.clear;
    setText(clearLabel, complete ? 'Start another import' : 'Clear selected file');
    setText(status, `${statusText(state)}${state.notice ? ` ${state.notice}` : ''}`);
    const errorText = localError || state.error || '';
    setText(error, errorText);
    visible(error, Boolean(errorText));

    if (state.review !== renderedReview) {
      renderedReview = state.review;
      confirmedReview = null;
      confirmation.checked = false;
      if (state.review && state.review !== invalidatedReview) invalidatedReview = null;
      renderReview(state.review);
    }
    const currentReview = Boolean(state.review) && state.review !== invalidatedReview;
    const canConfirm = state.phase === 'review_ready' && currentReview && !operationPending && pending.size === 0;
    visible(reviewSection, currentReview);
    setDisabled(confirmation, !canConfirm);
    setDisabled(buttons.confirm, !canConfirm || confirmedReview !== state.review || !confirmation.checked);
    const confirmLabel = buttons.confirm.querySelector('.ui-button__content') || buttons.confirm;
    setText(confirmLabel, state.review?.resume ? 'Confirm remaining import' : 'Confirm import');
    visible(personalSection, currentReview && !state.review.observations && (count(state.review.conflict_count) > 0
      || count(state.review.conflict_after) > 0));
    visible(problemPageHint,currentReview&&!state.review.observations&&state.mapping!==ENHANCED_MAPPING);
    visible(problemPageActions,currentReview&&!state.review.observations&&state.mapping!==ENHANCED_MAPPING);
    personalSection.setAttribute('aria-busy', String(state.phase === 'saving_personal'));
    const canChangePersonal = canConfirm && pending.size === 0;
    for (const {checkbox, eligible} of conflictControls) setDisabled(checkbox, !canChangePersonal || !eligible);
    setText(personalSelection, `${selectedConflicts.size} of up to ${CONFLICT_PAGE_SIZE} fields selected on this page. Selections apply only to the separate personal save, not to the import.`);
    setDisabled(personalConfirmation, !canChangePersonal || selectedConflicts.size === 0);
    setDisabled(buttons.savePersonal, !canChangePersonal || selectedConflicts.size === 0
      || confirmedPersonalReview !== state.review || !personalConfirmation.checked);
    setDisabled(buttons.firstConflicts, !canChangePersonal || count(state.review?.conflict_after) === null
      || state.review.conflict_after === 0);
    setDisabled(buttons.nextConflicts, !canChangePersonal || count(state.review?.conflict_next) === null
      || count(state.review?.conflict_remaining) === null || state.review.conflict_remaining === 0);
    setDisabled(buttons.firstProblems, !canConfirm || count(state.review?.problem_after) === null
      || state.review.problem_after === 0);
    setDisabled(buttons.nextProblems, !canConfirm || count(state.review?.problem_next) === null
      || count(state.review?.problem_remaining) === null || state.review.problem_remaining === 0);

    visible(jobSection, hasJob);
    const job = state.job;
    visible(countFamilySummary, state.mapping === MAPPING);
    setText(countFamilySummary, `This page displays ${state.countFamily === 'enhanced' ? 'Enhanced TSV' : 'Standard TSV'} counts. Both evidence families remain retained separately and are never added. This display choice is local to this page, not a persisted job preference or a change to confirmed import counters.`);
    const confirmed = count(job?.confirmed_rows), total = count(job?.command?.total_rows);
    const remaining = count(job?.remaining_rows);
    if (confirmed !== null && total !== null && remaining !== null) {
      setText(progressText, `Server-confirmed prefix: ${confirmed} of ${total} source rows. ${remaining} rows are not yet confirmed.`);
      progress.max = Math.max(1, total);
      progress.value = confirmed;
      progress.hidden = false;
    } else {
      setText(progressText, 'No confirmed row count is available yet. A submitted request is not proof that rows were imported.');
      progress.hidden = true;
      progress.removeAttribute('value');
    }
    setText(progressDetail, job?.snapshot_kind === 'durable'
      ? 'This is the durable server checkpoint, not a prediction of pending work.'
      : 'This is the last confirmed snapshot. Later work may still be running or awaiting reconciliation.');
    const confirmedText = changesText(job?.confirmed_counts, 'Confirmed updates');
    setText(confirmedChanges, confirmedText);
    visible(confirmedChanges, Boolean(confirmedText));
    const pendingOutcome = uncertain || ['claimed', 'ready'].includes(job?.pending_attempt?.state);
    setText(uncertainty, uncertain
      ? 'Outcome uncertain: the request may have reached the server. Check this same import’s status; do not create another import to guess or retry.'
      : pendingOutcome ? 'A batch is pending. The confirmed prefix does not yet describe that batch’s outcome.' : '');
    visible(uncertainty, pendingOutcome);
    visible(resumeHint, !complete);
    setDisabled(buttons.status, !hasJob || pending.has('status') || pending.has('cancel') || choosing
      || state.phase === 'reviewing' || state.phase === 'submitting' || state.phase === 'saving_personal'
      || pending.has('personal') || pending.has('conflicts') || pending.has('problems'));
    visible(buttons.cancel, !['reviewing', 'review_ready'].includes(state.phase));
    setDisabled(buttons.cancel, !hasJob || complete || pending.has('cancel') || choosing
      || state.phase === 'saving_personal' || pending.has('personal') || pending.has('conflicts') || pending.has('problems')
      || job?.cancel_pending === true || job?.cancel_requested === true);
    setDisabled(buttons.resume, !hasJob || !state.filename || busy || operationPending || choosing
      || !reselectedForJob || !originalScopeAvailable || job?.cancel_pending === true
      || complete || !['paused', 'error', 'selected'].includes(state.phase));
    sourceRef.value = UUID.test(state.source?.source_ref || '') ? state.source.source_ref : '';
    jobRef.value = UUID.test(state.jobRef || '') ? state.jobRef : '';
    setDisabled(recoverSource, locked || choosing);
    setDisabled(recoverJob, locked || choosing);
    setDisabled(buttons.recover, locked || choosing);
    if (wantedFocus === 'review' && state.phase === 'review_ready' && !operationPending) {
      wantedFocus = null;
      if (section.contains(document.activeElement)) reviewTitle.focus();
    } else if (wantedFocus === 'personal' && state.phase === 'review_ready' && !operationPending) {
      wantedFocus = null;
      if (section.contains(document.activeElement)) (personalSection.hidden ? reviewTitle : personalTitle).focus();
    } else if (wantedFocus === 'job' && hasJob && !jobSection.hidden) {
      wantedFocus = null;
      if (section.contains(document.activeElement)) jobTitle.focus();
    }
  }

  async function run(key, work) {
    if (!guard() || pending.has(key)) return;
    pending.add(key);
    localError = '';
    if (latest) render(latest);
    try {await work();}
    catch {
      if (guard()) localError = key === 'personal'
        ? 'The personal save outcome could not be confirmed. Your selected fields may already have changed. Run a fresh review to inspect the current values; do not repeat this save from the old review.'
        : 'The request could not be confirmed. Check the server status for any import already submitted before trying to continue.';
    } finally {
      pending.delete(key);
      if (key === 'personal') clearPersonalSelections();
      if (guard()) render(controller.getState());
    }
  }

  function validUUID(node, message) {
    if (UUID.test(node.value.trim())) {node.removeAttribute('aria-invalid'); return true;}
    node.setAttribute('aria-invalid', 'true');
    localError = message;
    if (latest) render(latest);
    node.focus();
    return false;
  }

  on(buttons.defaultSource, 'click', () => {void run('source', () => controller.selectSource(null));});
  on(discoveryFilter, 'change', () => {
    const unfinished = discoveryFilter.value === 'unfinished';
    void run('discovery', () => controller.discoverJobs(unfinished, null));
  });
  on(buttons.refreshJobs, 'click', () => {void run('discovery', () => controller.discoverJobs(latest?.discoveryUnfinished !== false, null));});
  on(buttons.firstJobs, 'click', () => {void run('discovery', () => controller.discoverJobs(latest?.discoveryUnfinished !== false, null));});
  on(buttons.nextJobs, 'click', () => {void run('discovery', () => controller.nextJobPage());});
  on(buttons.selectSource, 'click', () => {
    if (guard() && validUUID(sourceChoice, 'Enter the complete existing source UUID.')) {
      const selected = sourceChoice.value.trim().toLowerCase();
      void run('source', () => controller.selectSource(selected));
    }
  });
  on(file, 'change', () => {
    if (!guard()) return;
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    confirmedReview = null;
    confirmation.checked = false;
    reselectedForJob = latest?.submitted === true;
    void run('choose', () => controller.choose(chosen));
  });
  on(mapping,'change',()=>{
    const selected=mapping.value;
    file.value='';
    confirmedReview=null;
    confirmation.checked=false;
    void run('mapping',()=>controller.setMapping(selected));
  });
  on(matching, 'change', () => {
    // run() renders the previous state while admitting the action. Capture
    // the user's new value before that render restores controlled inputs.
    const selected = matching.checked;
    void run('matching', () => controller.setMatching(selected));
  });
  on(buttons.preview, 'click', () => {
    wantedFocus = 'review';
    void run('preview', () => controller.preview());
  });
  on(personalConfirmation, 'change', () => {
    if (!guard()) return;
    const canConfirm = latest?.phase === 'review_ready' && Boolean(latest.review)
      && latest.review !== invalidatedReview && selectedConflicts.size > 0 && pending.size === 0;
    confirmedPersonalReview = canConfirm && personalConfirmation.checked ? latest.review : null;
    if (!canConfirm) personalConfirmation.checked = false;
    render(latest);
  });
  on(buttons.savePersonal, 'click', () => {
    if (!guard() || latest?.phase !== 'review_ready' || !latest.review
        || latest.review === invalidatedReview || pending.size > 0
        || !personalConfirmation.checked || confirmedPersonalReview !== latest.review
        || selectedConflicts.size === 0 || selectedConflicts.size > CONFLICT_PAGE_SIZE) return;
    const choices = [...selectedConflicts.values()].map(({row, field}) => ({row, field}));
    // Burn both confirmations before dispatch. A lost response must never leave
    // a usable old review or repeatable selection behind.
    invalidatedReview = latest.review;
    confirmedReview = null;
    confirmation.checked = false;
    clearPersonalSelections();
    wantedFocus = null;
    void run('personal', () => controller.savePersonalChanges(choices));
  });
  function conflictPage(first) {
    if (!guard() || latest?.phase !== 'review_ready' || !latest.review
        || latest.review === invalidatedReview || pending.size > 0) return;
    if (first ? count(latest.review.conflict_after) === null || latest.review.conflict_after === 0
      : count(latest.review.conflict_next) === null || count(latest.review.conflict_remaining) === null
        || latest.review.conflict_remaining === 0) return;
    clearPersonalSelections();
    confirmedReview = null;
    confirmation.checked = false;
    wantedFocus = 'personal';
    void run('conflicts', () => first ? controller.firstConflictPage() : controller.nextConflictPage());
  }
  on(buttons.firstConflicts, 'click', () => conflictPage(true));
  on(buttons.nextConflicts, 'click', () => conflictPage(false));
  function problemPage(first) {
    if (!guard() || latest?.phase !== 'review_ready' || !latest.review
        || latest.review === invalidatedReview || pending.size > 0) return;
    if (first ? count(latest.review.problem_after) === null || latest.review.problem_after === 0
      : count(latest.review.problem_next) === null || count(latest.review.problem_remaining) === null
        || latest.review.problem_remaining === 0) return;
    clearPersonalSelections();
    confirmedReview = null;
    confirmation.checked = false;
    wantedFocus = 'review';
    void run('problems', () => first ? controller.firstProblemPage() : controller.nextProblemPage());
  }
  on(buttons.firstProblems, 'click', () => problemPage(true));
  on(buttons.nextProblems, 'click', () => problemPage(false));
  on(confirmation, 'change', () => {
    if (!guard()) return;
    confirmedReview = confirmation.checked && latest?.phase === 'review_ready' ? latest.review : null;
    render(latest);
  });
  on(buttons.confirm, 'click', () => {
    if (!guard() || !confirmation.checked || confirmedReview !== latest?.review
        || latest?.phase !== 'review_ready' || latest.review === invalidatedReview || pending.size > 0) return;
    confirmedReview = null;
    confirmation.checked = false;
    wantedFocus = 'job';
    void run('confirm', () => controller.confirm());
  });
  on(buttons.status, 'click', () => {void run('status', () => controller.refreshStatus());});
  on(buttons.cancelReview, 'click', () => {void run('cancel', () => controller.cancel());});
  on(buttons.cancel, 'click', () => {void run('cancel', () => controller.cancel());});
  on(buttons.resume, 'click', () => {
    wantedFocus = 'review';
    void run('resume', () => controller.resume());
  });
  on(buttons.clear, 'click', () => {
    void run('clear', () => {
      controller.clear();
      reselectedForJob = false;
      file.value = '';
      if (!file.disabled) file.focus();
    });
  });
  on(buttons.recover, 'click', () => {
    if (!guard() || !validUUID(recoverSource, 'Enter the complete earlier source UUID.')
        || !validUUID(recoverJob, 'Enter the complete earlier import job UUID.')) return;
    const source = recoverSource.value.trim().toLowerCase();
    const job = recoverJob.value.trim().toLowerCase();
    wantedFocus = 'job';
    void run('recover', () => controller.recoverJob(job, source));
  });
  for (const [node, button] of [[sourceChoice, buttons.selectSource], [recoverSource, buttons.recover], [recoverJob, buttons.recover]]) {
    on(node, 'keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!button.disabled && guard()) button.click();
    });
  }
  on(window, 'pagehide', () => retire());
  for (const name of ['album-haven:policy-invalidated', 'album-haven:session-changed'])
    on(document, name, () => retire());

  function runObservationReview(key, work) {
    if (!guard() || pending.size !== 0 || latest?.phase !== 'review_ready'
        || latest.mapping !== MAPPING || !latest.review) return;
    // The initiating controls will become hidden during the new review.
    // Transfer only currently owned focus, synchronously before that render.
    // The existing result handler still refuses to steal external focus.
    const ownedFocus = observationHost.contains(document.activeElement);
    wantedFocus = ownedFocus ? 'review' : null;
    if (ownedFocus) status.focus();
    void run(key, work);
  }

  target.replaceChildren(section);
  maintenance=mountMaintenance(section,{fetch,contextRoot,allows,isCurrent:isLive});
  observationPanel=mountObservationPreview(observationHost,{id,isCurrent:isLive,renderTable:safeTable,
    onInspect:(after,raw)=>{runObservationReview('observations',()=>controller.inspectObservations(after,raw));},
    onFamily:value=>{if(guard())controller.setCountFamily(value);},
    onReturn:()=>{runObservationReview('review',()=>controller.preview());}});
  if (!guard()) throw new TypeError('Foobar account context is unavailable.');
  try {
    controller = createImportController({fetch, contextRoot, allows, isCurrent: isLive, onChange: render});
    observer = new window.MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' && record.target === contextRoot
          && record.attributeName?.startsWith('data-account-foobar-')
        || record.type === 'childList' && [...record.removedNodes].some(node =>
          node === contextRoot || node === target || node.contains?.(contextRoot) || node.contains?.(target)))) {
        retire();
      } else guard();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-account-foobar-context', 'data-account-foobar-scope',
        'data-account-foobar-allowed', 'data-account-foobar-matching-library-id']});
    // Policy owners may invalidate without a DOM event. Every action/response
    // is fenced immediately; this read-only check also retires idle controls.
    lifetimeTimer = window.setInterval(guard, 1000);
    render(controller.getState());
    void run('initialize', () => controller.initialize());
  } catch (error) {
    retire(false);
    throw error;
  }
  return Object.freeze({dispose() {retire(false);}});
}
