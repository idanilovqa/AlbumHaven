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

  // The pinned action exports the flat Review object before rendering or moving inline findings.
  const fields = new Set(['key_issues_to_review', 'security_concerns', 'ticket_compliance_check',
    'estimated_effort_to_review_[1-5]', 'contribution_time_cost_estimate', 'score', 'relevant_tests',
    'insights_from_user_answers', 'todo_sections', 'can_be_split']);
  if (Object.keys(review).some(field => !fields.has(field)) || !Array.isArray(review.key_issues_to_review)) {
    throw new Error('PR Agent produced an unrecognized review schema or omitted its key issues list.');
  }
  if (review.key_issues_to_review.length > 0) {
    throw new Error('PR Agent reported key issues that must be resolved before tests can start.');
  }
  // Security review is optional upstream. When present, require an explicit clear sentinel;
  // false also represents an unquoted YAML No. Blank/null/malformed values are not approval.
  if (Object.hasOwn(review, 'security_concerns')) {
    const security = review.security_concerns;
    const clear = security === false || (typeof security === 'string'
      && ['no', 'none', 'false'].includes(security.trim().toLowerCase()));
    if (!clear) throw new Error('PR Agent reported security concerns or an unclear security verdict.');
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
