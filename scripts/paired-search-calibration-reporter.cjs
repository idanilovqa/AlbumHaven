const fs = require('node:fs');
const path = require('node:path');

const {
  PAIRED_SEARCH_CASES,
  validatePhaseArtifact,
} = require('./run-paired-search-calibration.cjs');

const RUN_ID_ENV = 'ALBUM_HAVEN_PAIRED_SEARCH_RUN_ID';
const PHASE_ENV = 'ALBUM_HAVEN_PAIRED_SEARCH_PHASE';
const OUTPUT_ENV = 'ALBUM_HAVEN_PAIRED_SEARCH_PHASE_OUTPUT';

function readAttachment(attachment) {
  if (attachment.body) return JSON.parse(Buffer.from(attachment.body).toString('utf8'));
  if (attachment.path) return JSON.parse(fs.readFileSync(attachment.path, 'utf8'));
  throw new Error(`Paired search attachment ${attachment.name} has no body or path.`);
}

function productionRecord(metrics) {
  const scenario = PAIRED_SEARCH_CASES.find((entry) => entry.query === metrics.query);
  return {
    caseId: metrics.caseId,
    query: metrics.query,
    expectedArtist: scenario?.expectedArtist,
    classification: metrics.classification,
    budget: metrics.budget,
    submitToFirstVisibleMs: metrics.timing?.submitToFirstVisible?.valueMs,
  };
}

function syntheticRecord(metrics) {
  return {
    caseId: metrics.caseId,
    query: metrics.query,
    expectedArtist: metrics.expectedArtist,
    submitToFirstVisibleMs: metrics.submitToFirstVisibleMs,
  };
}

class PairedSearchCalibrationReporter {
  constructor() {
    this.runId = String(process.env[RUN_ID_ENV] || '');
    this.source = String(process.env[PHASE_ENV] || '');
    this.outputPath = String(process.env[OUTPUT_ENV] || '');
    this.enabled = Boolean(this.runId || this.source || this.outputPath);
    this.records = [];
    if (this.enabled && !(this.runId && this.source && this.outputPath)) {
      throw new Error('Paired search reporter requires run ID, phase, and phase output together.');
    }
  }

  onTestEnd(_testCase, result) {
    if (!this.enabled || result.status !== 'passed') return;
    const attachmentName = this.source === 'production'
      ? 'production-search-metrics'
      : 'synthetic-paired-search-metrics';
    const attachment = result.attachments.find((entry) => entry.name === attachmentName);
    if (!attachment) return;
    const metrics = readAttachment(attachment);
    this.records.push(this.source === 'production'
      ? productionRecord(metrics)
      : syntheticRecord(metrics));
  }

  onEnd() {
    if (!this.enabled) return;
    const artifact = validatePhaseArtifact({
      schemaVersion: 1,
      runId: this.runId,
      source: this.source,
      cases: this.records,
    }, { runId: this.runId, source: this.source });
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
    const temporaryPath = `${this.outputPath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, this.outputPath);
  }
}

module.exports = PairedSearchCalibrationReporter;
