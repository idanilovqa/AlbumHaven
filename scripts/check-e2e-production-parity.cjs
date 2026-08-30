#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const EXECUTABLE_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SOURCE_EXTENSIONS = new Set([...EXECUTABLE_SCRIPT_EXTENSIONS, '.py']);
const RETAINED_SPEC_PATTERN = new RegExp(
  `\\.spec(?:${Array.from(EXECUTABLE_SCRIPT_EXTENSIONS, (extension) => (
    extension.replace('.', '\\.')
  )).join('|')})$`,
);
const IGNORED_DIRECTORIES = new Set(['.git', '.pytest_cache', '.tmp', 'node_modules', 'playwright-report', 'test-results']);

function normalizedPath(filePath) {
  return String(filePath || '').replaceAll('\\', '/');
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

function matchingCallSource(source, matchIndex) {
  const openIndex = source.indexOf('(', matchIndex);
  if (openIndex === -1) return source.slice(matchIndex);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = '';
      }
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (current === '(') depth += 1;
    if (current === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(matchIndex, index + 1);
    }
  }
  return source.slice(matchIndex);
}

function firstCallArgument(callSource) {
  const openIndex = callSource.indexOf('(');
  const closeIndex = callSource.lastIndexOf(')');
  if (openIndex === -1) return '';
  return callSource.slice(openIndex + 1, closeIndex > openIndex ? closeIndex : undefined).trim();
}

function matchingBlockSource(source, openIndex) {
  if (openIndex === -1) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = '';
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (current === '{') depth += 1;
    if (current === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  return source.slice(openIndex);
}

function matchingStatementSource(source, startIndex) {
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (current === '\n') return source.slice(startIndex, index);
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = '';
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (current === '(') parenthesisDepth += 1;
    else if (current === ')') parenthesisDepth -= 1;
    else if (current === '[') bracketDepth += 1;
    else if (current === ']') bracketDepth -= 1;
    else if (current === ';' && parenthesisDepth === 0 && bracketDepth === 0) {
      return source.slice(startIndex, index + 1);
    } else if (current === '\n' && parenthesisDepth === 0 && bracketDepth === 0) {
      return source.slice(startIndex, index);
    }
  }
  return source.slice(startIndex);
}

function stripCommentsPreservingLayout(source) {
  const characters = [...source];
  let quote = '';
  let escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    const next = characters[index + 1] || '';
    if (quote) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = '';
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (current === '/' && next === '/') {
      characters[index] = ' ';
      characters[index + 1] = ' ';
      index += 2;
      while (index < characters.length && characters[index] !== '\n') {
        characters[index] = ' ';
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (current === '/' && next === '*') {
      characters[index] = ' ';
      characters[index + 1] = ' ';
      index += 2;
      while (index < characters.length) {
        if (characters[index] === '*' && characters[index + 1] === '/') {
          characters[index] = ' ';
          characters[index + 1] = ' ';
          index += 1;
          break;
        }
        if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
        index += 1;
      }
    }
  }
  return characters.join('');
}

function javascriptMemberAccessMatches(source, methodNames) {
  const methods = new Set(methodNames);
  const matches = [];

  function receiverBefore(index) {
    const prefix = source.slice(0, index).replace(/\?\s*$/, '');
    return /([A-Za-z_$][\w$]*)\s*$/.exec(prefix)?.[1] || '';
  }

  function shouldReport(method, index) {
    const receiver = receiverBefore(index);
    if (/^(?:locator|querySelector|querySelectorAll)$/.test(method)) return true;
    if (method === 'addInitScript') return true;
    if (method === 'route') return !/router$/i.test(receiver);
    if (/^(?:routeFromHAR|routeWebSocket|unroute|unrouteAll)$/.test(method)) return true;
    return /route$/i.test(receiver);
  }

  function closesControlStatementAt(index) {
    let cursor = index - 1;
    while (/\s/.test(source[cursor] || '')) cursor -= 1;
    if (source[cursor] !== ')') return false;
    let depth = 1;
    cursor -= 1;
    while (cursor >= 0 && depth > 0) {
      if (source[cursor] === ')') depth += 1;
      else if (source[cursor] === '(') depth -= 1;
      cursor -= 1;
    }
    if (depth !== 0) return false;
    const prefix = source.slice(0, cursor + 1);
    const keyword = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix)?.[1] || '';
    return /^(?:if|while|for|with)$/.test(keyword) || /\bfor\s+await\s*$/.test(prefix);
  }

  function regexCanStartAt(index) {
    const prefix = source.slice(0, index);
    const significant = /([^\s])\s*$/.exec(prefix)?.[1] || '';
    if (!significant || /[([{=:;,!?&|+*%^~<>-]/.test(significant)) return true;
    if (significant === ')' && closesControlStatementAt(index)) return true;
    const word = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix)?.[1] || '';
    return /^(?:return|case|throw|yield|await|typeof|void|delete|instanceof|in|else|do)$/.test(word);
  }

  function skipQuoted(index, quote) {
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') cursor += 1;
      else if (source[cursor] === quote) return cursor + 1;
    }
    return source.length;
  }

  function skipRegex(index) {
    let inCharacterClass = false;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const current = source[cursor];
      if (current === '\\') cursor += 1;
      else if (current === '[') inCharacterClass = true;
      else if (current === ']') inCharacterClass = false;
      else if (current === '/' && !inCharacterClass) {
        cursor += 1;
        while (/[A-Za-z]/.test(source[cursor] || '')) cursor += 1;
        return cursor;
      } else if (current === '\n' || current === '\r') return cursor;
    }
    return source.length;
  }

  function scanTemplate(index) {
    let cursor = index;
    while (cursor < source.length) {
      if (source[cursor] === '\\') cursor += 2;
      else if (source[cursor] === '`') return cursor + 1;
      else if (source[cursor] === '$' && source[cursor + 1] === '{') cursor = scanCode(cursor + 2, true);
      else cursor += 1;
    }
    return cursor;
  }

  function inspectMember(index) {
    if (source[index] === '[') {
      let cursor = index + 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      const propertyQuote = source[cursor];
      if (propertyQuote !== '"' && propertyQuote !== "'") return;
      const propertyStart = cursor + 1;
      cursor = skipQuoted(cursor, propertyQuote) - 1;
      const propertyName = source.slice(propertyStart, cursor);
      cursor += 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      if (source[cursor] === ']' && methods.has(propertyName) && shouldReport(propertyName, index)) {
        matches.push({ index, method: propertyName });
      }
      return;
    }
    if (source[index] !== '.') return;
    let cursor = index + 1;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    const identifierMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
    if (!identifierMatch || !methods.has(identifierMatch[0])) return;
    if (shouldReport(identifierMatch[0], index)) matches.push({ index, method: identifierMatch[0] });
  }

  function scanCode(start, stopAtClosingBrace = false) {
    let index = start;
    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1] || '';
      if (stopAtClosingBrace && current === '}') return index + 1;
      if (current === '/' && next === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (current === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (current === '"' || current === "'") {
        index = skipQuoted(index, current);
        continue;
      }
      if (current === '`') {
        index = scanTemplate(index + 1);
        continue;
      }
      if (current === '/' && regexCanStartAt(index)) {
        index = skipRegex(index);
        continue;
      }
      inspectMember(index);
      if (current === '{') {
        index = scanCode(index + 1, true);
        continue;
      }
      index += 1;
    }
    return index;
  }

  scanCode(0);
  return matches;
}

function hasNearbyAnnotation(source, index, annotation) {
  const annotationWindow = source.slice(Math.max(0, index - 280), index);
  return new RegExp(`parity-check:\\s*${annotation}[^\\n]*(?:\\n[^\\n]*){0,2}$`).test(annotationWindow);
}

function evaluateCallbackParameterNames(callSource) {
  const parenthesized = /(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*=>/.exec(callSource);
  if (parenthesized) return [parenthesized[1]];
  const bare = /(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(callSource);
  return bare ? [bare[1]] : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function evaluateMutatesCallbackParameter(callSource) {
  return evaluateCallbackParameterNames(callSource).some((parameterName) => {
    const root = escapeRegExp(parameterName);
    return new RegExp(
      String.raw`\b${root}(?:(?:\?\.)?\.[A-Za-z_$][\w$]*|\[[^\]]+\])*\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|add|set|delete|clear)\s*\(`,
      'i',
    ).test(callSource);
  });
}

function lastMatch(source, pattern) {
  let result = null;
  for (const match of source.matchAll(globalPattern(pattern))) result = match;
  return result;
}

function localCallbackDeclarationSource(source, callbackName, callIndex) {
  const sourceBeforeCall = source.slice(0, callIndex);
  const escapedName = escapeRegExp(callbackName);
  const functionDeclaration = lastMatch(
    sourceBeforeCall,
    new RegExp(`\\b(?:async\\s+)?function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`),
  );
  const variableDeclaration = lastMatch(
    sourceBeforeCall,
    new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=`),
  );
  const declaration = !functionDeclaration
    ? variableDeclaration
    : (!variableDeclaration || functionDeclaration.index > variableDeclaration.index
      ? functionDeclaration
      : variableDeclaration);
  if (!declaration) return '';

  if (declaration === functionDeclaration) {
    const blockStart = source.indexOf('{', declaration.index + declaration[0].length - 1);
    return source.slice(declaration.index, blockStart) + matchingBlockSource(source, blockStart);
  }

  const initializerStart = declaration.index + declaration[0].length;
  const declarationTail = source.slice(initializerStart, callIndex);
  const arrowIndex = declarationTail.indexOf('=>');
  const functionExpression = /^(?:\s*async\s+)?\s*function\b/.exec(declarationTail);
  if (arrowIndex !== -1) {
    const callbackBodyStart = initializerStart + arrowIndex + 2;
    const firstBodyToken = /\S/.exec(source.slice(callbackBodyStart, callIndex));
    if (!firstBodyToken) return source.slice(declaration.index, callIndex);
    const bodyStart = callbackBodyStart + firstBodyToken.index;
    const body = source[bodyStart] === '{'
      ? matchingBlockSource(source, bodyStart)
      : matchingStatementSource(source, bodyStart);
    return `${source.slice(declaration.index, bodyStart)}${body}`;
  }
  if (functionExpression) {
    const blockStart = source.indexOf('{', initializerStart + functionExpression.index);
    if (blockStart !== -1 && blockStart < callIndex) {
      return source.slice(declaration.index, blockStart) + matchingBlockSource(source, blockStart);
    }
  }
  return source.slice(declaration.index, callIndex);
}

function pollingCallbackSource(source, callSource, callIndex) {
  const openIndex = callSource.indexOf('(');
  if (openIndex === -1) return callSource;
  const firstArgument = callSource.slice(openIndex + 1).match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/);
  if (!firstArgument) return callSource;
  const declarationSource = localCallbackDeclarationSource(source, firstArgument[1], callIndex);
  return declarationSource ? `${callSource}\n${declarationSource}` : callSource;
}

const EVALUATE_BEHAVIOR_PATTERN = new RegExp([
  String.raw`\.dispatchEvent\s*\(`,
  String.raw`\bnew\s+(?:Event|MouseEvent|KeyboardEvent|InputEvent|PointerEvent|CustomEvent)\s*\(`,
  String.raw`\.(?:click|dblclick|focus|blur|fill|type|press|check|uncheck|selectOption|setInputFiles|hover|tap)\s*\(`,
  String.raw`\.(?:setAttribute|removeAttribute|toggleAttribute|append|appendChild|prepend|before|after|remove|replaceWith|replaceChildren|insertAdjacent(?:HTML|Element|Text)|scrollTo|scrollBy|scrollIntoView)\s*\(`,
  String.raw`\.classList\.(?:add|remove|toggle|replace)\s*\(`,
  String.raw`\b(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)\s*\(`,
  String.raw`\bhistory\.(?:pushState|replaceState|go|back|forward)\s*\(`,
  String.raw`\blocation\.(?:assign|replace|reload)\s*\(`,
  String.raw`\bfetch\s*\(`,
  String.raw`\b(?:window|document|state)\s*(?:\+\+|--|=(?!=))`,
  String.raw`\b(?:window|document|state)(?:(?:\?\.)?\.[A-Za-z_$][\w$]*|\[[^\]]+\])*\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|add|set|delete|clear)\s*\(`,
  String.raw`\.(?:value|checked|selected|hidden|disabled|textContent|innerHTML|outerHTML|scrollTop|scrollLeft|className)\s*(?:\+\+|--|=(?!=))`,
  String.raw`\b[A-Za-z_$][\w$]*(?:(?:\?\.)?\.[A-Za-z_$][\w$]*|\[[^\]]+\])+\s*(?:\+\+|--|=|\+=|-=|\*=|\/=|%=|&&=|\|\|=|\?\?=|&=|\|=|\^=|<<=|>>=|>>>=)(?!=|>)`,
  String.raw`\.(?:setProperty|removeProperty|play|pause|load|submit|requestSubmit|showModal|close)\s*\(`,
].join('|'), 'i');

function scanSource({ filePath, source }) {
  const relativePath = normalizedPath(filePath);
  const text = String(source || '');
  const violations = [];
  const add = (ruleId, match, message) => {
    if (violations.some((violation) => violation.ruleId === ruleId && violation.line === lineNumber(text, match.index))) {
      return;
    }
    violations.push({
      ruleId,
      filePath: relativePath,
      line: lineNumber(text, match.index),
      message,
    });
  };
  const find = (ruleId, pattern, message) => {
    const match = pattern.exec(text);
    if (match) add(ruleId, match, message);
  };
  const findAll = (ruleId, pattern, message) => {
    for (const match of text.matchAll(globalPattern(pattern))) add(ruleId, match, message);
  };

  const productionFile = relativePath === 'app.py'
    || relativePath === 'config.py'
    || relativePath.startsWith('music_app/');
  if (productionFile) {
    find(
      'production-test-seam',
      /PLAYWRIGHT_[A-Z0-9_]+|(?:ALBUM_HAVEN_)?E2E_[A-Z0-9_]+|app\.e2e_[a-z0-9_]*|["']\/__e2e(?:\/|["'])|\bE2E\b\s*:|\bTESTING\s*=\s*(?:os\.)?(?:getenv|environ)|(?:(?:[A-Za-z_][A-Za-z0-9_.]*\.)?config|settings)\.get\s*\(\s*["']TESTING["']|(?:tests[\\/]e2e[\\/]fixtures|[A-Z0-9_]*FIXTURE_(?:PATH|FILE)|load_fixture_payload\s*\()/i,
      'Production code must not observe or branch on E2E/test-only seams.',
    );
  }

  if (relativePath.startsWith('tests/e2e/support/')) {
    const factoryCall = /(?:^|[=;]\s*)create_asgi_app\s*\(\s*\)/m.exec(text);
    if (factoryCall) {
      const scanOffset = factoryCall.index;
      const augmentation = /\.include_router\s*\(|\.add_middleware\s*\(|@app\.(?:get|post|put|patch|delete)\s*\(\s*["']\/__e2e|@app\.middleware\s*\(|app\.state\.[A-Za-z_][A-Za-z0-9_]*\s*=|hydrate_library_state_for_config\s*\(|start_runtime_workers\s*\(|state_service\.init_state\s*\(|start_background_refresh_for_state\s*\(|(?:install|start|attach|register)_[A-Za-z0-9_]*(?:control|sampler|hook|worker)[A-Za-z0-9_]*\s*\(/i.exec(text.slice(scanOffset));
      if (augmentation) {
        augmentation.index += scanOffset;
        add(
          'production-app-augmentation',
          augmentation,
          'E2E support must start the production app without augmenting or internally hydrating it.',
        );
      }
    }
  }

  if (relativePath.startsWith('tests/e2e/')) {
    const commentFreeText = stripCommentsPreservingLayout(text);
    const selectorOwnershipSurface = (
      relativePath.startsWith('tests/e2e/actions/')
      || relativePath.startsWith('tests/e2e/helpers/')
      || RETAINED_SPEC_PATTERN.test(relativePath)
    ) && !relativePath.startsWith('tests/e2e/poms/')
      && !relativePath.startsWith('tests/e2e/components/');

    if (selectorOwnershipSurface) {
      for (const match of javascriptMemberAccessMatches(text, ['locator'])) {
        const argument = firstCallArgument(matchingCallSource(text, match.index));
        if (/^(?:['"`]|String\.raw\b)/.test(argument)) {
          add(
            'selector-ownership',
            match,
            'Retained specs, actions, and helpers must consume locators owned by POMs or components.',
          );
        }
      }
      for (const match of javascriptMemberAccessMatches(text, ['querySelector', 'querySelectorAll'])) {
        const argument = firstCallArgument(matchingCallSource(text, match.index));
        const pomOwnedReference = /^[A-Za-z_$][\w$]*(?:(?:\?\.)?\.[A-Za-z_$][\w$]*)*$/.test(argument);
        if (!pomOwnedReference) {
          add(
            'selector-ownership',
            match,
            'Browser polling selectors must be supplied by an owning POM or component, not built in specs, actions, or helpers.',
          );
        }
      }
    }
    for (const match of javascriptMemberAccessMatches(
      text,
      ['route', 'routeFromHAR', 'routeWebSocket', 'unroute', 'unrouteAll', 'fulfill', 'abort', 'continue'],
    )) {
      add(
        'request-interception',
        match,
        'E2E must observe the production request path without Playwright routing or request interception.',
      );
    }

    for (const match of javascriptMemberAccessMatches(text, ['addInitScript'])) {
      add(
        'browser-init-script',
        match,
        'E2E must not inject browser startup scripts that can change the application runtime before production code runs.',
      );
    }

    for (const match of text.matchAll(/\.(?:evaluate|evaluateAll|\$eval|\$\$eval)\s*\(/g)) {
      const callSource = matchingCallSource(text, match.index);
      if (EVALUATE_BEHAVIOR_PATTERN.test(callSource) || evaluateMutatesCallbackParameter(callSource)) {
        add(
          'behavior-driving-evaluate',
          match,
          'Browser evaluate must remain read-only; annotations cannot permit mutation or interaction.',
        );
      } else if (!hasNearbyAnnotation(text, match.index, 'allow-read-only-measurement-evaluate')) {
        add('behavior-driving-evaluate', match, 'Browser evaluate requires a read-only measurement annotation.');
      }
    }

    for (const match of text.matchAll(/\.(?:waitForFunction|waitForPageCondition)\s*\(/g)) {
      const callSource = matchingCallSource(text, match.index);
      const callbackSource = pollingCallbackSource(text, callSource, match.index);
      if (EVALUATE_BEHAVIOR_PATTERN.test(callbackSource) || evaluateMutatesCallbackParameter(callbackSource)) {
        add(
          'behavior-driving-poll',
          match,
          'Browser polling callbacks must remain read-only and must not mutate or interact with the application.',
        );
      }
    }

    findAll(
      'synthetic-browser-event',
      /\.dispatchEvent\s*\(|\bnew\s+(?:Event|MouseEvent|KeyboardEvent|InputEvent|PointerEvent|CustomEvent)\s*\(/,
      'E2E must use the same user interaction path as the app instead of dispatching synthetic browser events.',
    );
    findAll(
      'forced-browser-action',
      /\.(?:click|dblclick|tap|check|uncheck|hover)\s*\(\s*\{[\s\S]{0,320}?\bforce\s*:\s*true|\bforce\s*(?::|=)\s*true\b/,
      'Forced browser actions bypass production actionability and are not permitted.',
    );
    const behaviorFallbackPattern = /\b(?:allow|accept|permit|tolerate|ignore|skip|succeedOn)[A-Za-z0-9_]*(?:Fallback|Empty|Missing|Failure|Error|Timeout|Pending|Unavailable|Unready)[A-Za-z0-9_]*\s*(?::|=)\s*true\b|\b[A-Za-z0-9_]*(?:FallbackSuccess|SuccessFallback)\s*(?::|=)\s*true\b|catch\s*\([^)]*\)\s*\{[^}]*\b(?:fallback|empty|default)[A-Za-z0-9_]*/is;
    for (const match of text.matchAll(globalPattern(behaviorFallbackPattern))) {
      const cleanupContext = text.slice(Math.max(0, match.index - 180), match.index + match[0].length);
      const cleanupOnlyIgnoreErrors = /shutil\.rmtree\s*\([^)]*\bignore_errors\s*=\s*True\b/is.test(cleanupContext);
      if (!cleanupOnlyIgnoreErrors) {
        add(
          'behavior-fallback',
          match,
          'Required product behavior must not succeed through a fallback path.',
        );
      }
    }
    find(
      'image-success-fallback',
      /naturalWidth\s*(?:===|==|<=)\s*0|naturalHeight\s*(?:===|==|<=)\s*0/,
      'A zero-sized image must not count as successful loading.',
    );
    for (const match of text.matchAll(/\btest(?:\.describe)?\.(?:skip|fixme)\s*\(/g)) {
      const callSource = matchingCallSource(text, match.index);
      const guardSource = text.slice(Math.max(0, match.index - 180), match.index);
      const directCiGuard = /if\s*\(\s*(?:process\.env\.CI|CI)\b[^)]*\)\s*\{?\s*$/.test(guardSource);
      if (/process\.env\.CI|\bCI\b/.test(callSource) || directCiGuard) {
        add('core-ci-skip', match, 'Retained core E2E coverage must not skip or fixme directly in CI.');
      }
    }
    find(
      'swallowed-required-request',
      /(?:request\.(?:get|post|put|patch|delete)|fetch)\s*\([^;\n]*\.catch\s*\([^;\n]*(?:null|undefined|false|\{\})/,
      'Required product requests must fail visibly instead of being swallowed.',
    );
    find(
      'conditional-populated-success',
      /if\s*\([^)]*(?:items|rows|results)[^)]*\.length[^)]*\)\s*\{[\s\S]{0,500}?\}\s*else\s*\{[\s\S]{0,500}?(?:empty|no[A-Z_]|not\.toHaveCount)/i,
      'Populated-state coverage must not accept an empty-state alternative.',
    );
    const swallowedFailurePattern = /\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*(?:null|undefined|false|true|["']{2}|\{\s*\})\s*\)|\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*\{\s*(?:return\s+(?:null|undefined|false|true|["']{2})\s*;?)?\s*\}\s*\)|catch(?:\s*\([^)]*\))?\s*\{\s*(?:return\s+(?:null|undefined|false|true|["']{2})\s*;?|continue\s*;?|break\s*;?)?\s*\}/is;
    for (const match of commentFreeText.matchAll(globalPattern(swallowedFailurePattern))) {
      add(
        'swallowed-browser-failure',
        match,
        'Browser failures and timeouts must remain visible instead of being swallowed.',
      );
    }
    const swallowedTimeoutPattern = /catch(?:\s*\([^)]*\))?\s*\{[\s\S]{0,360}?\b(?:TimeoutError|timeout|timed out)\b[\s\S]{0,240}?\b(?:return\s+(?:null|undefined|false|true|["']{2})|continue|break)\b/is;
    for (const match of commentFreeText.matchAll(globalPattern(swallowedTimeoutPattern))) {
      add(
        'swallowed-browser-failure',
        match,
        'Timeout failures must remain visible instead of being converted into success or absence.',
      );
    }
    for (const match of text.matchAll(/\bif\s*\(/g)) {
      const conditionSource = matchingCallSource(text, match.index);
      const responseLikeCondition = /\b(?:response|payload|result)\b/i.test(conditionSource)
        || /(?:\.|\?\.)\s*(?:ok|success|successful)\b/i.test(conditionSource);
      if (!responseLikeCondition) continue;
      const conditionEndIndex = match.index + conditionSource.length;
      const bodyPrefix = /^\s*/.exec(text.slice(conditionEndIndex));
      const bodyStartIndex = conditionEndIndex + bodyPrefix[0].length;
      const bodySource = text[bodyStartIndex] === '{'
        ? matchingBlockSource(text, bodyStartIndex)
        : matchingStatementSource(text, bodyStartIndex);
      if (/\b(?:expect\s*\(|assert(?:\.|\s*\())/.test(bodySource)) {
        add(
          'conditional-response-assertion',
          match,
          'Assertions must not become optional based on a response or payload condition.',
        );
      }
    }
  }

  return { filePath: relativePath, violations };
}

function scanRepo(root) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const violations = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const filePath = normalizedPath(path.relative(resolvedRoot, absolutePath));
        violations.push(...scanSource({ filePath, source: fs.readFileSync(absolutePath, 'utf8') }).violations);
      }
    }
  };
  visit(resolvedRoot);
  return { root: resolvedRoot, ok: violations.length === 0, violations };
}

function report(result) {
  if (result.ok) return 'Production parity check passed: no violations found.';
  const lines = [`Production parity check failed with ${result.violations.length} violation(s):`];
  for (const violation of result.violations) {
    lines.push(`- ${violation.filePath}:${violation.line} [${violation.ruleId}] ${violation.message}`);
  }
  return lines.join('\n');
}

function cliRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1) return process.cwd();
  if (!argv[rootIndex + 1]) throw new Error('--root requires a directory path.');
  return argv[rootIndex + 1];
}

if (require.main === module) {
  try {
    const result = scanRepo(cliRoot(process.argv.slice(2)));
    console.log(report(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Production parity check failed: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { scanRepo, scanSource, report };
