const path = require('node:path');

class FunctionalListReporter {
  onBegin(_config, suite) {
    for (const test of suite.allTests()) {
      process.stdout.write(`ALBUM_HAVEN_FUNCTIONAL_CASE=${JSON.stringify({
        project: test.parent.project()?.name || '',
        test: path.relative(process.cwd(), test.location.file).replaceAll('\\', '/'),
        case: test.title,
        areas: test.tags
          .filter((tag) => tag.startsWith('@area:'))
          .map((tag) => tag.slice('@area:'.length)),
      })}\n`);
    }
  }
}

module.exports = FunctionalListReporter;
