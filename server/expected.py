"""Observations marked as expected: stable keys, scope suggestions and the stored marks.

A mark is personal state of the app (``workspace.json``, per opened root), never
written into an inspected root and never part of the reading: the scanner, the
audit and every CLI command still report each observation. The interface only
moves a marked observation out of what it counts as active.

The key of an observation follows the identity rule of ``aae audit``
(``audit._identity``, reused as is): code, path relative to the most specific
opened root, destination as written (or the scope pattern) and the ordinal by
line among equal keys of that root. Line, message and absolute paths never
enter, so inserting lines above a reference or restarting keeps the mark;
changing the written destination, moving the source file or changing the code
gives another key. Removing the first of two identical references makes the
second inherit the ordinal, and so the mark.
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import unicodedata
from datetime import datetime

try:
    from . import audit
    from .scanner import MAX_BYTES, InvalidInput, below, open_regular_file
    from .scope import KINDS, _pattern, validate_scope
    from .texts import number, plural, say
except ImportError:
    import audit
    from scanner import MAX_BYTES, InvalidInput, below, open_regular_file
    from scope import KINDS, _pattern, validate_scope
    from texts import number, plural, say

KEY = re.compile(r'[0-9a-f]{16}')
MAX_REASON = 500
MAX_PER_ROOT = 5000
LIMIT_TEXT = number(MAX_PER_ROOT)
# Bidirectional embeddings and isolates turn a reason around on screen; control characters hide in it.
BIDI = frozenset(range(0x202A, 0x202F)) | frozenset(range(0x2066, 0x206A)) | {0x200E, 0x200F, 0x061C}
MAX_TEXT = 4096
MAX_CODE = 100
MAX_TIME = 64
# Observations whose destination is missing: a runtimeWorkspace pattern absorbs them.
ABSORBABLE = {'broken', 'unresolved-name'}


def _light(item, path, extra):
    """The fields audit._identity reads, for one observation of a single root."""
    return {'code': item['code'], '_root': None, 'path': path, 'line': item.get('line'), **extra}


def annotate(model):
    """(issues, signals, facts) for the interface; the model itself is never mutated.

    `issues` and `signals` are copies of the model lists with `key` (and, for issues, a
    `suggestion` when there is one); `facts` is {root: {key: {code, path, target}}} of this
    reading, what a new mark stores and what tells a mark without observation (orphan).
    Never mutated because the readings of `delta` copy issue fields into their
    findings, and a new field there would change the delta.
    """
    frame = audit._Frame(model['roots'])
    nodes = {node['id']: node for node in model['nodes']}
    manifests = {}

    def manifest(root):
        if root not in manifests:
            manifests[root] = manifest_state(root)
        return manifests[root]
    by_line = {}
    for edge in model['edges']:
        if edge['kind'] != 'scope':
            by_line.setdefault((edge['origin'], edge['line']), []).append(edge)
    per_root = {}
    for kind in ('issues', 'signals'):
        for index, item in enumerate(model[kind]):
            root, path = frame.locate(item.get('node'))
            if root is None:
                continue  # Outside every opened root (or no file): no project to keep a mark in.
            if kind == 'issues':
                extra = {field: item[field] for field in ('target', 'pattern') if item.get(field) is not None}
            else:
                target = _signal_target(item, frame, root)
                extra = {'target': target} if target is not None else {}
            per_root.setdefault(root, []).append((kind, index, _light(item, path, extra)))
    keys, facts = {'issues': {}, 'signals': {}}, {}
    for root, members in per_root.items():
        # One standalone audit per root: the root never enters the key, the mark is stored under it.
        audit._identity([light for _, _, light in members], False)
        found = facts.setdefault(frame.roots[root], {})
        for kind, index, light in members:
            keys[kind][index] = light['id']
            # What a mark keeps to describe itself once orphan; bounded like a restored mark.
            target = light.get('target', light.get('pattern'))
            found[light['id']] = {'code': light['code'], 'path': _bounded(light['path']), 'target': _bounded(target)}
    issues = []
    for index, issue in enumerate(model['issues']):
        if index not in keys['issues']:
            issues.append(issue)
            continue
        hint = suggestion(issue, frame, nodes, by_line, manifest)
        issues.append({**issue, 'key': keys['issues'][index], **({'suggestion': hint} if hint else {})})
    signals = [{**signal, 'key': keys['signals'][index]} if index in keys['signals'] else signal
               for index, signal in enumerate(model['signals'])]
    return issues, signals, facts


def _signal_target(signal, frame, root):
    """Destination of a repeated reference, relative to its own project; None for other signals.

    The scanner gives it in `to`, the destination as the model holds it (never read out of the
    message). Always relative to the project that owns the source (with `..` when outside it), never
    absolute and never relative to another opened root: opening or closing a neighbour must
    not change the key.
    """
    if signal['code'] != 'repeated-reference' or not isinstance(signal.get('to'), str):
        return None
    return posixpath.relpath(signal['to'], frame.roots[root])


def suggestion(issue, frame, nodes, by_line, manifest):
    """Where and how a declared scope would settle this observation: {places: [...]}, or None.

    One place per opened root that contains the source, the project that owns it first, then
    each enclosing root (its own agent-architecture.json applies to the file too, and it is the
    one read when that root is opened alone). A place is {root, basis, pattern, kinds, manifest}:
    `kinds` lists the declarations that fit, `manifest` what the root's agent-architecture.json
    holds now. A place may carry no pattern, only the reason: `wildcard` (a literal part has *
    or ?, which a v1 pattern cannot escape, so it would also settle other files) or `generic`
    (an unreachable file that is neither an agent nor a skill: v1 cannot say "not for the
    agent"). Never for `ambiguous`, which a declaration never absorbs, nor for the other codes.
    Every pattern passes scope.py.
    """
    code = issue['code']
    node = issue.get('node')
    if code not in ABSORBABLE and code != 'unreachable' or frame.locate(node)[0] is None:
        return None
    places = []
    for index in frame.order:  # most specific first
        if frame.inside(node, index) is None:
            continue
        root = frame.roots[index]
        hint = _hint(code, issue, root, nodes, by_line)
        if hint is None:
            continue  # This root does not contain the destination.
        places.append({'root': root, **hint, 'manifest': manifest(root)})
        if hint['pattern'] is None and len(places) == 1:
            break  # The owner cannot declare it (wildcard or generic): no enclosing root can do better.
        # An enclosing root may still be blocked by a wildcard in the name of a nested root; it is
        # listed without a pattern so the interface can say why that alternative is missing.
    return {'places': places} if places else None


def _literal(text):
    return '*' not in text and '?' not in text


def _hint(code, issue, project, nodes, by_line):
    """{basis, pattern, kinds} of one project, or None when nothing applies there."""
    if code in ABSORBABLE:
        edge = next((edge for edge in by_line.get((issue['node'], issue.get('line')), ())
                     if edge['raw'] == issue.get('target')), None)
        destination = below(edge['target'], project) if edge else None
        if not destination:
            return None  # Outside this project: none of its patterns can absorb it.
        folder = posixpath.dirname(destination)
        if str(issue.get('target', '')).endswith('/'):
            basis, literal, pattern = 'directory', destination, destination + '/'
        elif not folder:
            basis, literal, pattern = 'root-file', destination, destination
        elif (nodes.get(f'{project}/{folder}') or {}).get('kind') == 'directory':
            basis, literal, pattern = 'existing-folder', destination, destination
        else:
            basis, literal, pattern = 'folder', folder, folder + '/'
        kinds = ['runtimeWorkspace', 'localFiles']
    else:
        relative = below(issue['node'], project)
        if not relative:
            return None
        folder, name = posixpath.split(relative)
        container = posixpath.dirname(folder)
        if name == 'SKILL.md' and folder and posixpath.basename(container) == 'skills':
            basis, literal, pattern, kinds = 'skills', container, f'{container}/*/SKILL.md', ['implicitLoads']
        elif name.endswith('.md') and (folder == '.claude/agents' or folder.endswith('/.claude/agents')):
            basis, literal, pattern, kinds = 'agents', folder, f'{folder}/*.md', ['entries']
        else:
            return {'basis': 'generic', 'pattern': None, 'kinds': []}
    if not _literal(literal):
        return {'basis': 'wildcard', 'pattern': None, 'kinds': []}
    try:
        for kind in kinds:
            _pattern(pattern, kind)
    except ValueError:
        return None
    return {'basis': basis, 'pattern': pattern, 'kinds': kinds}


def manifest_state(root):
    """What agent-architecture.json at `root` holds now, to word where a pattern goes.

    {state: absent | unreadable | broken | no-scope | invalid-scope | empty-scope | scope,
    lists: [kinds present in scope]}. Read only, bounded like the reader, never followed
    through a link; the content is data, only parsed.
    """
    try:
        with open_regular_file(os.path.join(root, 'agent-architecture.json')) as stream:
            data = stream.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return {'state': 'absent', 'lists': []}
    except (OSError, ValueError):
        return {'state': 'unreadable', 'lists': []}
    try:
        if len(data) > MAX_BYTES:
            raise ValueError
        manifest = json.loads(data.decode('utf-8'))
    except (ValueError, RecursionError):
        return {'state': 'broken', 'lists': []}
    if not isinstance(manifest, dict):
        return {'state': 'broken', 'lists': []}
    if 'scope' not in manifest:
        return {'state': 'no-scope', 'lists': []}
    try:
        validate_scope(manifest['scope'])
    except ValueError:
        return {'state': 'invalid-scope', 'lists': []}
    lists = [kind for kind in KINDS if kind in manifest['scope']]
    return {'state': 'scope' if lists else 'empty-scope', 'lists': lists}


def _bounded(value):
    return value[:MAX_TEXT] if isinstance(value, str) else None


def _text(value, limit):
    return value if isinstance(value, str) and len(value) <= limit else None


def _normal(text):
    """CR LF, a lone CR and a pasted tab are ordinary text: a line break and a space."""
    return text.replace('\r\n', '\n').replace('\r', '\n').replace('\t', ' ').strip()


def _hidden(text):
    """Whether a reason carries a control character (other than a line break) or a bidi mark."""
    return any(ord(char) in BIDI or char != '\n' and unicodedata.category(char) == 'Cc' for char in text)


def _mark(key, entry):
    """A stored mark normalized to its known fields, or None when anything is off."""
    if not isinstance(key, str) or not KEY.fullmatch(key) or not isinstance(entry, dict):
        return None
    reason = _normal(entry['reason']) if isinstance(entry.get('reason'), str) else None
    code, reason, at = _text(entry.get('code'), MAX_CODE), _text(reason, MAX_REASON), _text(entry.get('at'), MAX_TIME)
    path, target = entry.get('path'), entry.get('target')
    if not code or reason is None or _hidden(reason) or not at:
        return None
    if path is not None and _text(path, MAX_TEXT) is None or target is not None and _text(target, MAX_TEXT) is None:
        return None
    return {'code': code, 'path': path, 'target': target, 'reason': reason, 'at': at}


def _moment(mark):
    """Sort key of a mark by its time (an unreadable time counts as the oldest)."""
    try:
        return datetime.fromisoformat(mark['at']).timestamp()
    except (ValueError, OverflowError, OSError):
        return float('-inf')


def restore(value):
    """(marks, report) of a saved state; never fatal, the valid marks are kept.

    `report` counts what was left out or changed: `invalid` (roots or marks with wrong
    types or values), `over` (valid marks above the ceiling of a root: the most recent by
    `at` stay, ties by key) and `normalized` (roots written in a non-canonical form, such
    as a trailing slash, merged into the canonical one, so the next save rewrites them).
    """
    report = {'invalid': 0, 'over': 0, 'normalized': 0}
    if value is None:
        return {}, report
    if not isinstance(value, dict):
        report['invalid'] = 1
        return {}, report
    marks = {}
    for root, entries in value.items():
        if not isinstance(root, str) or not root or '\x00' in root or not os.path.isabs(root) or not isinstance(entries, dict):
            report['invalid'] += len(entries) if isinstance(entries, dict) else 1
            continue
        canonical = os.path.normpath(root)
        if canonical != root:
            report['normalized'] += 1
        kept = marks.setdefault(canonical, {})
        for key, entry in entries.items():
            mark = _mark(key, entry)
            if mark is None:
                report['invalid'] += 1
            elif key not in kept or _moment(mark) > _moment(kept[key]):
                kept[key] = mark
    for root, kept in list(marks.items()):
        if len(kept) > MAX_PER_ROOT:
            ordered = sorted(kept.items(), key=lambda pair: (-_moment(pair[1]), pair[0]))
            report['over'] += len(kept) - MAX_PER_ROOT
            marks[root] = dict(ordered[:MAX_PER_ROOT])
        elif not kept:
            del marks[root]
    return marks, report


def restore_messages(report):
    """Warnings for `restoreErrors` about what restore() left out or rewrote."""
    messages = []
    if report['invalid']:
        messages.append(plural(report['invalid'], 'An invalid mark of an expected observation in the saved state was ignored.',
                               '{count} invalid marks of expected observations in the saved state were ignored.'))
    if report['over']:
        messages.append(plural(report['over'], 'A mark of an expected observation above the ceiling of {limit} per project was left out; the most recent ones stayed.',
                               '{count} marks of expected observations above the ceiling of {limit} per project were left out; the most recent ones stayed.',
                               limit=LIMIT_TEXT))
    if report['normalized']:
        messages.append(plural(report['normalized'], 'The path of a project with marks was in a non-canonical form (with a trailing slash, for example) and was normalized.',
                               'The paths of {count} projects with marks were in a non-canonical form (with a trailing slash, for example) and were normalized.'))
    return messages


def limit_message(orphans):
    """Refusal at the ceiling: orphan marks count too and can be removed."""
    return say('Limit of {limit} marks in this project reached. Marks without a matching observation count too '
               '({orphans} now) and can be removed in the Audit; remove marks before creating others.', limit=LIMIT_TEXT, orphans=orphans)


def validate(root, key, expected, reason, open_roots):
    """Checks of a mark request; returns (expected, reason to store).

    `None` in an optional field (`expected`, `reason`) means absent: marking, without reason.
    The reason is stripped first and then measured in code points, as the interface counts.
    """
    if not isinstance(root, str) or root not in open_roots:
        raise InvalidInput(say('The project is not open: open the folder before marking observations.'))
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise InvalidInput(say('Malformed observation key.'))
    if expected is None:
        expected = True
    if not isinstance(expected, bool):
        raise InvalidInput(say('The expected option must be a boolean.'))
    if reason is None:
        reason = ''
    if not isinstance(reason, str):
        raise InvalidInput(say('The reason must be a text of up to {max} characters.', max=MAX_REASON))
    reason = _normal(reason)
    if len(reason) > MAX_REASON:
        raise InvalidInput(say('The reason must be a text of up to {max} characters.', max=MAX_REASON))
    if _hidden(reason):
        raise InvalidInput(say('The reason cannot have control characters or text direction marks; only line breaks are accepted.'))
    return expected, reason
