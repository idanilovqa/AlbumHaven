'use strict';
const P = require('./foobar-account-personal-conflicts-fixture.cjs');
const {F} = P;
const item = (index, patch = {}) => ({cursor: 32 + index, row: Math.floor((32 + index) / 32), code: 'protected_rating', field: 'rating', source_artist: 'Diagnostic artist', source_title: 'Diagnostic song ' + index, source_album: 'Diagnostic album', ...patch});
// Forty instances on two source rows deliberately differ from distinct-track totals.
const page = (problem = false, conflict = false, patch = {}) => P.page(conflict, {
  problem_items: Array.from({length: problem ? 8 : 32}, (_, n) => item(n + (problem ? 32 : 0))),
  problem_count: 40, problem_after: problem ? 63 : 0, problem_next: problem ? null : 63, problem_remaining: problem ? 0 : 8, ...patch});
const validate = (C, value) => C.validateReview(F.review({review: value}), F.STAMP, 'status', F.SOURCE, F.JOBREF).review;
const header = call => JSON.parse(call.init.headers['X-AlbumHaven-Foobar-Command']);
module.exports = {P, F, item, page, validate, header};
