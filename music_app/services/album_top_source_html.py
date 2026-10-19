"""Conservative structural evidence only; never executes HTML or resolves albums."""
import re
from html.parser import HTMLParser

_INERT = frozenset(('head', 'script', 'style', 'template', 'noscript'))
_VOID = frozenset(('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                   'link', 'meta', 'param', 'source', 'track', 'wbr'))
_STRUCTURE = frozenset(('ol', 'ul', 'table'))
_PARENTS = {'li': frozenset(('ol', 'ul')),
            'tr': frozenset(('table', 'thead', 'tbody', 'tfoot')),
            'td': frozenset(('tr',)), 'th': frozenset(('tr',)),
            'thead': frozenset(('table',)), 'tbody': frozenset(('table',)),
            'tfoot': frozenset(('table',)), 'caption': frozenset(('table',)),
            'colgroup': frozenset(('table',)), 'col': frozenset(('colgroup',))}
_NUMBER = re.compile(r'[1-9][0-9]{0,3}')
_CELL_RANK = re.compile(r'([1-9][0-9]{0,3})[.)]?')
_TEXT_RANK = re.compile(r'^([1-9][0-9]{0,3})[.)]\s+')


class _Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': '', 'attrs': {}, 'children': [], 'line': 1}
        self.stack = [self.root]
        self.invalid = False
        self.nodes = 0

    def handle_starttag(self, tag, attrs):
        if self.invalid:
            return
        # Balanced markup can still misplace a row/cell. Never flatten such
        # descendants (or orphan tags outside the candidate) into ranked text.
        if (tag in _PARENTS and self.stack[-1]['tag'] not in _PARENTS[tag]
                and not any(node['tag'] in _INERT for node in self.stack)):
            self.invalid = True
            return
        self.nodes += 1
        if self.nodes > 20000 or len(self.stack) >= 64:
            self.invalid = True
            return
        if len(dict(attrs)) != len(attrs):
            self.invalid = True
        node = {'tag': tag, 'attrs': dict(attrs), 'children': [], 'line': self.getpos()[0]}
        self.stack[-1]['children'].append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        if tag not in _VOID:
            self.invalid = True
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.invalid:
            return
        if len(self.stack) == 1 or self.stack[-1]['tag'] != tag:
            self.invalid = True
            return
        self.stack.pop()

    def handle_data(self, data):
        if not self.invalid:
            self.stack[-1]['children'].append(data)


def _text(node, omit=None):
    if type(node) is str:
        return node
    if node is omit or node['tag'] in _INERT:
        return ''
    if node['tag'] == 'br':
        return ' '
    return ''.join(_text(child, omit) for child in node['children'])


def _walk(node):
    if type(node) is str or node['tag'] in _INERT:
        return
    yield node
    for child in node['children']:
        yield from _walk(child)


def _children(node, tags):
    result = []
    for child in node['children']:
        if type(child) is str:
            if child.strip():
                return None
        elif child['tag'] in _INERT:
            continue
        elif child['tag'] not in tags:
            return None
        else:
            result.append(child)
    return result


def _number(value):
    return int(value) if type(value) is str and _NUMBER.fullmatch(value) else None


def _list(node):
    children = _children(node, {'li'})
    attrs = node['attrs']
    if not children or attrs.get('type', '1') != '1':
        return None
    reverse = 'reversed' in attrs
    rank = _number(attrs['start']) if 'start' in attrs else len(children) if reverse else 1
    if rank is None:
        return None
    result = []
    for child in children:
        if any(item is not child and item['tag'] in _STRUCTURE for item in _walk(child)):
            return None
        if 'value' in child['attrs']:
            rank = _number(child['attrs']['value'])
        if rank is None:
            return None
        text = ' '.join(_text(child).split())
        textual = _TEXT_RANK.match(text)
        if not text or textual and int(textual[1]) != rank:
            return None
        result.append({'candidate_line': child['line'], 'raw_text': text, 'explicit_rank': rank})
        rank += -1 if reverse else 1
    return result


def _table(node):
    sections = _children(node, {'thead', 'tbody', 'tr'})
    if not sections or sum(item['tag'] == 'thead' for item in sections) > 1 or sum(item['tag'] == 'tbody' for item in sections) > 1:
        return None
    for header in (item for item in sections if item['tag'] == 'thead'):
        header_rows = _children(header, {'tr'})
        if header_rows is None or any(not _children(row, {'th'}) for row in header_rows):
            return None
    body = [item for item in sections if item['tag'] != 'thead']
    if len(body) == 1 and body[0]['tag'] == 'tbody':
        body = _children(body[0], {'tr'})
    if not body or any(item['tag'] != 'tr' for item in body):
        return None
    if any(item is not node and item['tag'] in _STRUCTURE for item in _walk(node)):
        return None
    if any('rowspan' in item['attrs'] or 'colspan' in item['attrs'] for item in _walk(node)):
        return None
    result = []
    for row in body:
        cells = _children(row, {'td'})
        if not cells or len(cells) < 2:
            return None
        rank_text = ' '.join(_text(cells[0]).split())
        match = _CELL_RANK.fullmatch(rank_text)
        text = ' '.join(' '.join(_text(cell).split()) for cell in cells[1:]).strip()
        if not match or not text:
            return None
        result.append({'candidate_line': row['line'], 'raw_text': text, 'explicit_rank': int(match[1])})
    return result


def structural_rows(content, max_rows):
    """Return complete ranked candidates, or None for explicit manual review.

    Original input stays in the private job. Strict balanced structure deliberately
    does not emulate browser repair, CSS visibility, or choose a page section.
    """
    parser = _Tree()
    try:
        parser.feed(content)
        parser.close()
    except (ValueError, RecursionError):
        return None
    if parser.invalid or len(parser.stack) != 1:
        return None
    candidates = [node for node in _walk(parser.root) if node['tag'] in _STRUCTURE]
    if len(candidates) != 1 or candidates[0]['tag'] == 'ul':
        return None
    candidate = candidates[0]
    if _text(parser.root, candidate).strip():
        return None
    rows = _list(candidate) if candidate['tag'] == 'ol' else _table(candidate)
    if not rows or len(rows) > max_rows or {row['explicit_rank'] for row in rows} != set(range(1, len(rows) + 1)):
        return None
    return rows
