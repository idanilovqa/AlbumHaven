const FINAL_RESULT_MARKER = '[album-haven-playwright-result]';
const {
  FINAL_RESULT_NONCE_ENV,
  consumeFinalResultNonce,
} = require('./playwright-final-result-control.cjs');

class PlaywrightFinalResultReporter {
  constructor(options = {}) {
    this.total = 0;
    this.outcomes = new Map();
    this.errorCount = 0;
    this.stdout = options.stdout || process.stdout;
    this.nonce = String(options.nonce || consumeFinalResultNonce());
    this.pendingWrites = new Set();
    this.writeError = null;
  }

  onBegin(_config, suite) {
    this.total = suite.allTests().length;
  }

  onTestEnd(test, result) {
    const retries = Number.isInteger(test.retries) ? test.retries : 0;
    const retry = Number.isInteger(result.retry) ? result.retry : 0;
    const canRetry = (
      (result.status === 'failed' || result.status === 'timedOut' || result.status === 'interrupted')
      && retry < retries
    );
    if (canRetry) {
      this.outcomes.delete(test.id);
      return;
    }
    this.outcomes.set(test.id, {
      status: result.status,
      expectedStatus: test.expectedStatus || 'passed',
    });
    if (this.outcomes.size === this.total) {
      void this.emitResult(this.resolveObservedStatus(), 'tests-complete');
    }
  }

  onError() {
    this.errorCount += 1;
    void this.emitResult('failed', 'run-error');
  }

  async onEnd(result) {
    await this.emitResult(this.resolveFinalStatus(result.status), 'run-final');
    this.throwWriteError();
  }

  async onExit() {
    await Promise.all([...this.pendingWrites]);
    this.throwWriteError();
  }

  resolveObservedStatus() {
    const terminalOutcomes = [...this.outcomes.values()];
    const hasFailure = terminalOutcomes.some(({ status, expectedStatus }) => (
      status !== 'skipped' && status !== expectedStatus
    ));
    return hasFailure || this.errorCount > 0 || this.hasOnlySkippedOutcomes()
      ? 'failed'
      : 'passed';
  }

  resolveFinalStatus(status) {
    return status === 'passed' && (this.errorCount > 0 || this.hasOnlySkippedOutcomes())
      ? 'failed'
      : status;
  }

  hasOnlySkippedOutcomes() {
    return this.total > 0
      && this.outcomes.size === this.total
      && [...this.outcomes.values()].every(({ status }) => status === 'skipped');
  }

  emitResult(status, phase) {
    const terminalOutcomes = [...this.outcomes.values()];
    const failed = terminalOutcomes.filter(({ status, expectedStatus }) => (
      status !== 'skipped' && status !== expectedStatus
    )).length;
    const skipped = terminalOutcomes.filter(({ status }) => status === 'skipped').length;
    const payload = {
      version: 1,
      phase,
      nonce: this.nonce,
      status,
      total: this.total,
      completed: this.outcomes.size,
      failed,
      skipped,
      errors: this.errorCount,
    };
    const line = `\n${FINAL_RESULT_MARKER} ${JSON.stringify(payload)}\n`;
    let resolveWrite;
    const completion = new Promise((resolve) => {
      resolveWrite = resolve;
    });
    this.pendingWrites.add(completion);
    let completed = false;
    const completeWrite = (error = null) => {
      if (completed) return;
      completed = true;
      if (error && !this.writeError) {
        this.writeError = error;
      }
      resolveWrite();
    };
    try {
      const supportsWriteCallback = this.stdout === process.stdout
        || Number(this.stdout?.write?.length || 0) >= 2;
      if (supportsWriteCallback) {
        this.stdout.write(line, completeWrite);
      } else {
        this.stdout.write(line);
        completeWrite();
      }
    } catch (error) {
      completeWrite(error);
    }
    void completion.finally(() => {
      this.pendingWrites.delete(completion);
    });
    return completion;
  }

  throwWriteError() {
    if (this.writeError) {
      throw this.writeError;
    }
  }
}

module.exports = PlaywrightFinalResultReporter;
module.exports.FINAL_RESULT_MARKER = FINAL_RESULT_MARKER;
module.exports.FINAL_RESULT_NONCE_ENV = FINAL_RESULT_NONCE_ENV;
