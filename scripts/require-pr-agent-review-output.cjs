'use strict';

function parseReviewOutput(rawOutput) {
  if (typeof rawOutput !== 'string' || rawOutput.trim() === '') {
    throw new Error('PR Agent completed without producing its documented review output.');
  }

  let review;
  try {
    review = JSON.parse(rawOutput);
  } catch {
    throw new Error('PR Agent produced invalid review JSON.');
  }

  if (review === null || Array.isArray(review) || typeof review !== 'object') {
    throw new Error('PR Agent review output must be a JSON object.');
  }
  if (Object.keys(review).length === 0) {
    throw new Error('PR Agent produced an empty review result.');
  }

  return review;
}

function main() {
  try {
    parseReviewOutput(process.env.PR_AGENT_REVIEW_OUTPUT);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseReviewOutput };
