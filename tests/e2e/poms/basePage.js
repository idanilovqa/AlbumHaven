const PRODUCTION_BOOTSTRAP_ASSIGNMENT_PATTERN = (
  /(?:^|[;\r\n])\s*window\.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__\s*=\s*/u
);

function readBootstrapJsonAssignment(source, start) {
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (character === ';') {
      return JSON.parse(source.slice(start, index));
    }
  }
  throw new SyntaxError('Expected a terminated JSON assignment.');
}

export function parseProductionBootstrapPayloadScriptSources(scriptSources = []) {
  for (let index = scriptSources.length - 1; index >= 0; index -= 1) {
    const source = String(scriptSources[index] || '');
    const match = source.match(PRODUCTION_BOOTSTRAP_ASSIGNMENT_PATTERN);
    if (!match) continue;
    try {
      return readBootstrapJsonAssignment(source, match.index + match[0].length);
    } catch (error) {
      throw new Error(
        `Production bootstrap payload script contained invalid JSON: ${error.message}`,
        { cause: error },
      );
    }
  }
  throw new Error('Expected the production bootstrap payload script on the current document.');
}

export class BasePage {
  constructor(page, testInfo = null) {
    this.page = page;
    this.testInfo = testInfo;
  }

  async goto(pathname = '/', options = {}) {
    await this.page.goto(pathname, {
      waitUntil: options.waitUntil || 'domcontentloaded',
    });
  }

  async click(locator, options = {}) {
    await locator.click(options);
  }

  async waitForVisible(locator, options = {}) {
    await locator.waitFor({
      state: 'visible',
      timeout: options.timeout,
    });
  }

  async waitForHidden(locator, options = {}) {
    await locator.waitFor({
      state: 'hidden',
      timeout: options.timeout,
    });
  }

  async waitForPageCondition(callback, options = {}, arg = null) {
    await this.page.waitForFunction(callback, arg, options);
  }

  async readProductionBootstrapPayload() {
    const scriptSources = await this.page.locator('script').allTextContents();
    return parseProductionBootstrapPayloadScriptSources(scriptSources);
  }
}
