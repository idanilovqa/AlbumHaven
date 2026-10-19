"""Bounded offline source evidence. Text is never executable or canonical identity."""
import hashlib
import json
import re
from html.parser import HTMLParser

from music_app.services.owned_album_tops import (
    AlbumTopError, MAX_TOP_COMMAND_BYTES, MAX_TOP_ITEMS, _text, top_uuid,
)

_RANK = re.compile(r"^\s*([1-9][0-9]{0,3})[.)]\s+(.+)$")


def source_command(payload):
    if type(payload) is not dict or set(payload) != {
            'request_key', 'title', 'description', 'kind', 'filename', 'content'}:
        raise AlbumTopError('invalid_command')
    result = dict(payload)
    result['request_key'] = top_uuid(payload['request_key'])
    result['title'] = _text(payload['title'], 100, title=True)
    result['description'] = _text(payload['description'], 1000)
    if payload['kind'] not in ('text', 'pasted_html', 'uploaded_html', 'url'):
        raise AlbumTopError('invalid_command')
    result['content'] = _text(payload['content'], MAX_TOP_COMMAND_BYTES)
    if not result['content'].strip():
        raise AlbumTopError('invalid_command')
    if payload['kind'] == 'url':
        from music_app.services.public_document_worker import normalize_url, DocumentError
        try:
            normalize_url(result['content'])
        except DocumentError:
            raise AlbumTopError('invalid_source_url') from None
    filename = payload['filename']
    if payload['kind'] == 'uploaded_html':
        filename = _text(filename, 255)
        if not filename.strip():
            raise AlbumTopError('invalid_command')
        if filename in ('.', '..') or any(c in filename for c in '/\\:'):
            raise AlbumTopError('invalid_command')
        if any(ord(c) < 32 or ord(c) == 127 for c in filename):
            raise AlbumTopError('invalid_command')
    elif filename is not None:
        raise AlbumTopError('invalid_command')
    result['filename'] = filename
    encoded = json.dumps(result, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(encoded) > MAX_TOP_COMMAND_BYTES:
        raise AlbumTopError('command_too_large', 413)
    return result, hashlib.sha256(encoded).hexdigest()


class _VisibleEvidence(HTMLParser):
    # These are candidate boundaries, not an assertion about list membership.
    boundaries = frozenset(('p', 'li', 'div', 'br', 'tr', 'h1', 'h2', 'h3',
                            'h4', 'h5', 'h6', 'section', 'article', 'ul', 'ol'))
    inert = frozenset(('script', 'style', 'template', 'noscript'))

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = []

    def handle_starttag(self, tag, attrs):
        if tag in self.inert:
            self.hidden.append(tag)
        if not self.hidden and tag in self.boundaries:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
            return
        if tag in self.boundaries:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def parse_source(command):
    """No network, catalog reads, metadata guessing or creation side effects.

    All original bytes remain in the job. Extracted HTML is always reviewed since
    heading/list selection is not yet an approved automatic extraction contract.
    """
    content = command['content']
    html = command['kind'] != 'text'
    if html:
        parser = _VisibleEvidence()
        parser.feed(content)
        parser.close()
        content = ''.join(parser.parts)
    lines = [(index, line) for index, line in enumerate(content.splitlines(), 1)
             if line.strip()]
    if len(lines) > MAX_TOP_ITEMS:
        return {'parser_version': 1, 'state': 'review_required', 'rows': [],
                'issues': ['too_many_candidate_rows'], 'ordered_row_refs': None}
    rows = []
    for position, (line_number, line) in enumerate(lines, 1):
        match = _RANK.fullmatch(line)
        rows.append({'row_ref': str(position), 'candidate_line': line_number,
                     'raw_text': line, 'explicit_rank': int(match[1]) if match else None,
                     'catalog_ref': None, 'match_state': 'unresolved'})
    ranks = [row['explicit_rank'] for row in rows]
    unambiguous = bool(rows) and not html and set(ranks) == set(range(1, len(rows) + 1))
    issues = [] if unambiguous else ['html_structure_requires_review' if html
                                     else 'order_requires_review']
    if not rows:
        issues.append('no_candidate_rows')
    return {'parser_version': 1, 'state': 'review_required', 'rows': rows,
            'issues': issues, 'ordered_row_refs': [row['row_ref'] for row in
                sorted(rows, key=lambda row: row['explicit_rank'])] if unambiguous else None}
