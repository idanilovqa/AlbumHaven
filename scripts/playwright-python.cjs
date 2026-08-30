const DEFAULT_PLAYWRIGHT_PYTHON = 'python';

function resolvePlaywrightPython(env = process.env) {
  return String(env.PLAYWRIGHT_PYTHON || '').trim() || DEFAULT_PLAYWRIGHT_PYTHON;
}

module.exports = {
  DEFAULT_PLAYWRIGHT_PYTHON,
  resolvePlaywrightPython,
};
