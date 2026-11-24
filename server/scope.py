"""Declared package scope (version 1): runtime workspace, local files, entries, implicit loads.

Pattern syntax: docs/modelo-e-leitura.md, section "Declaração de escopo". Patterns are matched by this module
only, never by fnmatch. A declaration never resolves or hides a reference by itself: the scanner counts every
absorption.
"""
from __future__ import annotations

import re

try:
    from .texts import say
except ImportError:
    from texts import say

KINDS = ('runtimeWorkspace', 'localFiles', 'entries', 'implicitLoads')
ABSORBING = frozenset(KINDS[:2])
STARTING = frozenset(KINDS[2:])
MAX_PATTERNS = 200
MAX_PATTERN_LENGTH = 300


def _pattern(value, kind):
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_PATTERN_LENGTH:
        raise ValueError(say('{kind}: each pattern must be a text of 1 to {max} characters.', kind=kind, max=MAX_PATTERN_LENGTH))
    if '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(say('{kind}: a pattern with a backslash or a control character is not accepted.', kind=kind))
    if any('\ud800' <= c <= '\udfff' for c in value):
        raise ValueError(say('{kind}: a pattern with a character that is not valid UTF-8 (a JSON escape such as \\udcff) is not accepted.', kind=kind))
    if value.startswith('/'):
        raise ValueError(say('{kind}: the pattern {pattern} must be relative to the root, without a leading /.', kind=kind, pattern=value))
    segments = (value[:-1] if value.endswith('/') else value).split('/')
    if any(segment in {'', '.', '..'} for segment in segments):
        raise ValueError(say('{kind}: the pattern {pattern} has an empty, "." or ".." segment.', kind=kind, pattern=value))
    return value


def validate_scope(value):
    """Validate a version-1 declaration, rejecting unknown fields and wrong types."""
    if not isinstance(value, dict):
        raise ValueError(say('The scope declaration must be a JSON object.'))
    unknown = sorted(str(key) for key in value if key not in {'version', *KINDS})
    if unknown:
        # Embedded declarations come from inspected files: echo a bounded sample only.
        sample = ', '.join(repr(key[:60]) if len(key) <= 60 else repr(key[:60]) + '…' for key in unknown[:5])
        if len(unknown) > 5:
            raise ValueError(say('Unknown field in the scope declaration: {sample} (and {more} more).', sample=sample, more=len(unknown) - 5))
        raise ValueError(say('Unknown field in the scope declaration: {sample}.', sample=sample))
    if type(value.get('version')) is not int or value['version'] != 1:
        raise ValueError(say('Incompatible scope version; use version: 1.'))
    result, total = {'version': 1}, 0
    for kind in KINDS:
        patterns = value.get(kind, [])
        if not isinstance(patterns, list):
            raise ValueError(say('{kind} must be a list of patterns.', kind=kind))
        total += len(patterns)
        if total > MAX_PATTERNS:
            raise ValueError(say('The scope declaration takes at most {max} patterns in all.', max=MAX_PATTERNS))
        result[kind] = [_pattern(pattern, kind) for pattern in patterns]
        if len(set(result[kind])) != len(result[kind]):
            raise ValueError(say('{kind}: repeated pattern.', kind=kind))
    return result


def _literal(chunk):
    return ''.join('[^/]' if c == '?' else re.escape(c) for c in chunk)


def _leftmost(unit, chunk):
    """Consume units up to the leftmost place where `chunk` matches, then `chunk`.

    A unit is consumed only where `chunk` does not start, so there is exactly one
    way to match and backtracking never multiplies. For globs the leftmost place
    is exact: a later occurrence never leaves more room for what follows.
    """
    return f'(?:(?!{chunk}){unit})*{chunk}'


def _segment(segment):
    """One segment glob, never crossing '/'. A naive translation of `*a*a*a*c`
    backtracks exponentially on a long segment of `a`; this one is linear."""
    chunks = segment.split('*')
    if len(chunks) == 1:
        return _literal(segment)
    result = _literal(chunks[0])
    for chunk in chunks[1:-1]:
        if chunk[:1] not in {'', '?'}:
            # Same leftmost match, cheaper: only the chunk's first character needs a lookahead.
            first, rest = re.escape(chunk[0]), _literal(chunk[1:])
            result += f'(?:[^/{first}]|{first}(?!{rest}))*' if rest else f'[^/{first}]*'
            result += first + rest
        elif chunk:
            result += _leftmost('[^/]', _literal(chunk))
    return result + '[^/]*' + _literal(chunks[-1])


def pattern_regex(pattern):
    """Regex source matched against '/' + relative path; deterministic, no fnmatch.

    Every repetition except the last commits to its leftmost match, at segment
    level too (the groups of segments between `**`), so the cost stays linear in
    the path and polynomial of low degree in the pattern.
    """
    directory = pattern.endswith('/')
    segments = []
    for segment in (pattern[:-1] if directory else pattern).split('/'):
        # `**/**` matches exactly what `**` matches.
        if not (segment == '**' and segments and segments[-1] == '**'):
            segments.append(segment)
    if directory and segments[-1] == '**':
        directory = False  # `dir/**/` is `dir/**`: everything below dir.
    groups = [[]]
    for segment in segments:
        if segment == '**':
            groups.append([])
        else:
            groups[-1].append(segment)

    def sequence(chunk):
        return ''.join('/' + _segment(segment) for segment in chunk)

    result = sequence(groups[0])
    if len(groups) > 1:
        for chunk in groups[1:-1]:
            # (?![^/]) pins the chunk's last glob to the end of its path segment, so the
            # lookahead in _leftmost never mistakes a segment prefix for a match.
            result += _leftmost('/[^/]+', sequence(chunk) + '(?![^/])')
        # A final `**` matches one or more segments, so `dir/**` never matches dir itself.
        result += '(?:/[^/]+)*' + sequence(groups[-1]) if groups[-1] else '(?:/[^/]+)+'
    if directory:
        # The directory itself (a reference written as `dir/` or `dir`) and everything below.
        result += '(?:/[^/]+)*'
    return result


def matches(pattern, relative):
    return re.fullmatch(pattern_regex(pattern), '/' + relative) is not None


class Declaration:
    """Ordered patterns of one declaration with first-match counters.

    Each group is one alternation, so matching a path costs one regex call even
    with 200 patterns; Python alternation keeps the declared order (first wins).
    """

    def __init__(self, scope, root=None):
        self.patterns = [{'kind': kind, 'pattern': pattern, 'references': 0, 'files': 0, **({'root': root} if root else {})}
                         for kind in KINDS for pattern in scope[kind]]
        self.absorbing = self._group(ABSORBING)
        self.starting = self._group(STARTING)

    def _group(self, kinds):
        indexes = [index for index, item in enumerate(self.patterns) if item['kind'] in kinds]
        if not indexes:
            return None
        return re.compile('|'.join(f'(?P<p{index}>{pattern_regex(self.patterns[index]["pattern"])})' for index in indexes))

    def first(self, group, relatives):
        """Index of the earliest declared pattern matching any candidate path, or None."""
        found = None
        for relative in relatives:
            match = group.fullmatch('/' + relative) if group is not None and relative else None
            if match:
                index = int(match.lastgroup[1:])
                found = index if found is None else min(found, index)
        return found
