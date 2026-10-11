const TARGET = 'https://sandbox3.albumhaven.org';
const SCENARIOS = new Set(['initial-navigation', 'search', 'search-populated', 'clear-search', 'artist-selection', 'root-jump', 'album-details']);
function validateEnvironment(env = process.env, baseURL = TARGET) {
  if (env.CI) throw new Error('Sandbox3 benchmark cannot run in CI.');
  if (baseURL !== TARGET) throw new Error('Sandbox3 benchmark requires its exact target.');
  const username = env.ALBUM_HAVEN_SANDBOX3_BENCHMARK_USERNAME;
  const password = env.ALBUM_HAVEN_SANDBOX3_BENCHMARK_PASSWORD;
  if (!username || !password) throw new Error('Explicit Sandbox3 benchmark credentials are required.');
  return { baseURL, username, password };
}
function permittedRequest(rawURL, method, authenticating = false) {
  let url;
  try { url = new URL(rawURL); } catch { return false; }
  if (url.origin !== TARGET || url.username || url.password) return false;
  return method === 'GET' || method === 'HEAD' || (authenticating && method === 'POST' && url.pathname === '/login');
}
async function installReadOnlyGuard(context, authenticating = false) {
  let violations = 0;
  await context.route('**/*', async route => {
    const request = route.request();
    if (permittedRequest(request.url(), request.method(), authenticating)) return route.continue();
    violations += 1;
    await route.abort('blockedbyclient');
  });
  return { finishAuthentication() { authenticating = false; }, assertClean() { if (violations) throw new Error('Benchmark blocked a forbidden request.'); } };
}
function sanitizeTiming(value) {
  if (!SCENARIOS.has(value.scenario) || !Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error('Invalid benchmark timing.');
  return { scenario: value.scenario, durationMs: Math.round(value.durationMs * 10) / 10, passed: value.passed === true, budgetMs: Number.isFinite(value.budgetMs) && value.budgetMs > 0 ? value.budgetMs : null };
}
module.exports = { TARGET, validateEnvironment, permittedRequest, installReadOnlyGuard, sanitizeTiming };
