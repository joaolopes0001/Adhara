"""What changed on disk since a fixed reference reading of each opened root.

The rules are in docs/architecture.md, section "Alterações entre leituras". A
compact reading holds no evidence text and no document content. A saved
reference is untrusted input when loaded: bounded before and after
decompression, validated field by field, bound to the root being opened, never
followed through links.
"""
from __future__ import annotations

from collections import deque
import errno
import gzip
import hashlib
import json
import os
import posixpath
import re
import secrets
import stat
import zlib
from datetime import datetime

try:
    from . import audit as audit_report
    from .scanner import EXCLUDED, MAX_ROOTS, below
    from .texts import is_text, number, of, plural, say, unwire, wire
except ImportError:
    import audit as audit_report
    from scanner import EXCLUDED, MAX_ROOTS, below
    from texts import is_text, number, of, plural, say, unwire, wire

VERSION = 1
LIMIT = 500
STORE = 'references'
FORMAT = 1
KIND = 'aae-reference'
MAX_STORED = 32 * 1024 * 1024  # compressed bytes on disk; above it a reference lives in memory only
MAX_EXPANDED = 128 * 1024 * 1024  # JSON bytes after decompression (decompression-bomb guard)
NOT_FILES = {'directory', 'unresolved'}
# Finding fields that hold document text, left out of a compact reading.
EXCERPTS = {'evidence'}
# Field of a compact finding: the phrase and parameters of its message, so the interface words a saved finding in
# its language. Kept as JSON text (`texts.wire`) so that a finding stays a flat record of scalars, which
# `_validated` and earlier servers accept; the delta lists it as an object (`_spoken`).
PHRASE = 'messagePhrase'
# Field of a compact reading, true: the messages of its findings are sentences of this server (`texts.say`). Without
# it, the delta marks a resolved finding `earlier`, and the interface does not read its message (src/serverText.ts).
PHRASES = 'phrases'
NUL_MARK = '\u2400'  # SYMBOL FOR NULL
ESCAPE_MARK = '\u241b'  # SYMBOL FOR ESCAPE
MARKED = re.compile(f'{ESCAPE_MARK}(.)|{NUL_MARK}', re.DOTALL)
SCOPE_SOURCES = {'flag', 'manifest'}
STATUS_ORDER = ('pass', 'fail', 'inconclusive', 'error')


def _reader():
    """Fingerprint of the code that turns the disk into relations and findings.

    A reference saved by another version of this code compares readings made by
    different rules: relations and findings may differ with no file changed.
    """
    digest = hashlib.sha256()
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ('scanner.py', 'scope.py', 'audit.py', 'delta.py'):
        try:
            with open(os.path.join(here, name), 'rb') as stream:
                content = stream.read()
        except OSError:
            content = b'?'
        digest.update(name.encode() + b'\0' + content + b'\0')
    return digest.hexdigest()[:16]


READER = _reader()
READER_CHANGED = say('The saved baseline was read by another version of the app: relations and observations may show as '
                     'changed with no change in the files, because of the reading rules. The Files section compares the content and '
                     'stays valid. To compare only scans of this version, use “Update baseline”.')
READER_CHANGED_MANY = ('The saved baselines of {count} projects were read by another version of the app: relations and observations '
                       'may show as changed with no change in the files, because of the reading rules. The Files section compares the '
                       'content and stays valid. To compare only scans of this version, use “Update baseline”.')
# Relations and findings of a root are compared only between readings with the same opened roots in the same order:
# the reading is joint, so limits, name resolution and the owner of a nested root depend on them.
CONTEXT_CHANGED = say('Relations and observations not compared: the open projects, or their order, changed since the baseline.')
CONTEXT_UNKNOWN = say('Relations and observations not compared: the baseline does not record which projects were open.')
CONTEXT_WARNINGS = {'changed': ('reference-context-changed', CONTEXT_CHANGED), 'unknown': ('reference-context-unknown', CONTEXT_UNKNOWN)}
# Findings about the analysis of a file itself: compared even when the file was analysed in one reading only.
ANALYSIS_CODES = {'limit', 'unreadable'}


def now():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def _relative(path, root):
    """Path relative to the root ('.' for the root itself); absolute when outside it.

    Outside the root, the two leading slashes POSIX normpath keeps ('//host/x',
    '//') become one, since `_stored_path` refuses them. Both readings go through here.
    """
    if path == root:
        return '.'
    inside = below(path, root)
    if inside is not None:
        return inside
    return '/' + path.lstrip('/') if path.startswith('//') else path


def _absolute(path, root):
    if not isinstance(path, str):
        return None
    if path.startswith('/'):
        return path
    return root if path == '.' else f'{root}/{path}'


def _inside(path, root):
    return isinstance(path, str) and (path == root or below(path, root) is not None)


def _unwalked(relative):
    """Whether the walk of a root skips the folder at `relative` below it: a component is an excluded name."""
    return relative is not None and any(part in EXCLUDED for part in relative.split('/'))


def _part(model, root):
    """What `root` read on its own, as a standalone audit of that root would see it.

    Containment, not the most specific owner: opening or closing a nested root must not change the reading of
    `root` (`_Merge` removes the duplicates). Left out is what only another opened root read: the inside of a
    nested root below a folder the walk of `root` skips, and the `no-entry` finding of a nested root. One opened
    root is audited whole, exactly like the CLI.
    """
    if len(model['roots']) == 1:
        return model
    first = model['roots'][0]['path']
    others = {item['path'] for item in model['roots'] if item['path'] != root}
    unwalked = [path for path in others if _unwalked(below(path, root))]
    mine = (lambda path: _inside(path, root) and not any(_inside(path, other) for other in unwalked)) if unwalked else (
        lambda path: _inside(path, root))
    scope = model.get('scope') or {'source': None, 'patterns': []}
    patterns = [item for item in scope['patterns'] if scope['source'] == 'flag' or item.get('root') == root]
    return {**model, 'roots': [item for item in model['roots'] if item['path'] == root],
            'nodes': [node for node in model['nodes'] if mine(node['id'])],
            'edges': [edge for edge in model['edges'] if mine(edge['origin'])],
            'issues': [issue for issue in model['issues'] if (mine(issue['node']) and not (issue['code'] == 'no-entry' and issue['node'] in others))
                       or (issue.get('node') is None and root == first)],
            'scope': {'source': scope['source'] if patterns or scope['source'] == 'flag' else None, 'patterns': patterns}}


def _evidence_hash(text):
    return hashlib.sha256(str(text).encode('utf-8')).hexdigest()[:16]


def read(model, at):
    """{root: compact reading} for every opened root of a freshly scanned model.

    Sizes of files the scanner did not hash come from lstat now, at reading time.
    """
    statuses = {node['id']: node['status'] for node in model['nodes']}
    context = [item['path'] for item in model['roots']]
    result = {}
    for item in model['roots']:
        root = item['path']
        part = _part(model, root)
        files = {}
        for node in part['nodes']:
            if node['kind'] in NOT_FILES or node['status'] not in {'resolved', 'skipped'}:
                continue
            size = node.get('bytes')
            if type(size) is not int and node['kind'] != 'symlink':
                try:
                    size = os.lstat(node['id']).st_size
                except OSError:
                    size = None
            files[_relative(node['id'], root)] = {'sha256': node.get('sha256'), 'bytes': size if type(size) is int else None}
        # A manifest relationship may name a source outside the root (absolute, like targets). Paths are not marked:
        # no file name holds a NUL. `_raw` keeps a `raw` that is not text (never from the scanner) serializable.
        relations = [{'origin': _relative(edge['origin'], root), 'source': _relative(edge['source'], root),
                      'target': _relative(edge['target'], root), 'kind': _visible(edge['kind']), 'raw': _visible(_raw(edge['raw'])), 'line': edge['line'],
                      'evidenceHash': _evidence_hash(edge['evidence']), 'status': statuses.get(edge['target']), 'edge': edge['id']}
                     for edge in part['edges'] if edge['kind'] != 'scope']
        # `unlisted`: folders listed in part or not at all (the inventory limit, a name not UTF-8), where an absence is
        # not checked. Without one every absence is checked, so `listed` is kept only when `unlisted` is not empty.
        folders = {_relative(node['id'], root): node.get('listing', 'complete') == 'complete' for node in part['nodes']
                   if node['kind'] == 'directory' and node['status'] == 'resolved' and _inside(node['id'], root)}
        unlisted = sorted(path for path, whole in folders.items() if not whole)
        listed = sorted(path for path, whole in folders.items() if whole) if unlisted else []
        report = audit_report.audit(part)
        # compare-audit takes at most MAX_IMPORTED_FINDINGS per side: the reading keeps the first ones, in audit order
        # (most severe first), and counts the others in `omitted`.
        cap = audit_report.MAX_IMPORTED_FINDINGS
        # `path` is not marked: it is compared with the keys of `files`.
        findings = [_compact(finding) for finding in report['findings'][:cap]]
        audit = {'status': report['status'], 'partial': report['metrics']['partial'], 'scopeHash': report['scopeHash'],
                 'scopeSource': audit_report._scope_source(report), 'findings': findings}
        if len(report['findings']) > cap:
            audit['omitted'] = len(report['findings']) - cap
        result[root] = {'version': VERSION, 'root': root, 'name': item['name'], 'at': at, 'reader': READER, 'files': files, 'relations': relations,
                        'unlisted': unlisted, 'listed': listed, 'audit': audit, 'context': list(context), PHRASES: True}
    return result


def _compact(finding):
    """A finding of the audit as a compact reading keeps it: without its excerpt, its texts as plain strings and,
    for a message made with parameters, its phrase."""
    item = {key: value if key == 'path' else _visible(str(value) if is_text(value) else value) for key, value in finding.items() if key not in EXCERPTS}
    message = finding.get('message')
    if is_text(message) and message.params:
        item[PHRASE] = json.dumps(wire(message))
    return item


def _spoken(item):
    """A finding as the delta lists it: the phrase of its message as an object, or none when the saved text is
    not one (a saved reference is untrusted input)."""
    if PHRASE not in item:
        return item
    try:
        phrase = json.loads(item[PHRASE]) if type(item[PHRASE]) is str else None
    except (ValueError, RecursionError):
        phrase = None
    found = unwire(phrase)
    rest = {key: value for key, value in item.items() if key != PHRASE}
    return {**rest, PHRASE: wire(found)} if found is not None else rest


def _visible(value):
    """`value` with no NUL in its text: each one becomes NUL_MARK, and a NUL_MARK or ESCAPE_MARK already there is
    escaped by ESCAPE_MARK, so two different texts never become the same (`_written` undoes it).

    Both readings of a comparison go through here, so a reference written with a NUL keeps matching itself.
    """
    if type(value) is str:
        if '\x00' not in value and NUL_MARK not in value and ESCAPE_MARK not in value:
            return value
        return (value.replace(ESCAPE_MARK, ESCAPE_MARK * 2).replace(NUL_MARK, ESCAPE_MARK + NUL_MARK)
                .replace('\x00', NUL_MARK))
    if type(value) is list:
        return [_visible(item) for item in value]
    if type(value) is dict:
        return {key: _visible(item) for key, item in value.items()}
    return value


def _written(value):
    """The text as written of a value marked by `_visible`, as the model holds it."""
    if type(value) is str:
        if NUL_MARK not in value and ESCAPE_MARK not in value:
            return value
        return MARKED.sub(lambda match: '\x00' if match[1] is None else match[1], value)
    if type(value) is list:
        return [_written(item) for item in value]
    if type(value) is dict:
        return {key: _written(item) for key, item in value.items()}
    return value


def _raw(value):
    return value if type(value) is str else json.dumps(value, ensure_ascii=False)


def _parent(path):
    return path.rpartition('/')[0] or '.'


def _checks_absence(compact):
    """Whether `compact` affirms that a path inside its root is absent: it listed the folder of the path whole.

    The first inventoried folder up from the path decides; a folder not inventoried either does not exist or was
    left out. A reading without `unlisted` counts as completely listed.
    """
    unlisted = set(compact.get('unlisted') or ())
    if not unlisted:
        return lambda path: True
    listed = set(compact.get('listed') or ())
    def checks(path):
        if not isinstance(path, str) or path == '.' or path.startswith('/'):
            return True
        folder = _parent(path)
        while True:
            if folder in listed:
                return True
            if folder in unlisted or folder == '.':
                return False
            folder = _parent(folder)
    return checks


def _files(reference, current):
    root = current['root']
    old, new = reference['files'], current['files']
    def item(relative, extra):
        return {'path': _absolute(relative, root), 'relative': relative, 'root': root, **extra}
    in_old, in_new = _checks_absence(reference), _checks_absence(current)
    only_new, only_old = sorted(set(new) - set(old)), sorted(set(old) - set(new))
    added = [item(path, {'bytes': new[path]['bytes']}) for path in only_new if in_old(path)]
    removed = [item(path, {'bytes': old[path]['bytes']}) for path in only_old if in_new(path)]
    # Neither added nor removed: the reading where the file is missing did not list its folder.
    uncompared = [item(path, {}) for path in only_new if not in_old(path)] + [item(path, {}) for path in only_old if not in_new(path)]
    changed, unverified = [], 0
    for path in sorted(set(old) & set(new)):
        a, b = old[path], new[path]
        if a['sha256'] and b['sha256']:
            basis, differs = 'sha256', a['sha256'] != b['sha256']
        elif a['bytes'] is not None and b['bytes'] is not None:
            basis, differs = 'size', a['bytes'] != b['bytes']
        else:
            unverified += 1
            continue
        if differs:
            changed.append(item(path, {'basis': basis, 'before': a['bytes'], 'after': b['bytes']}))
    return added, removed, changed, unverified, uncompared


def _unseen(compact):
    """Whether an item whose file is `path` is missing from `compact` only because the file was not inventoried."""
    checks = _checks_absence(compact)
    return lambda path: isinstance(path, str) and path not in compact['files'] and not checks(path)


def _half_analysed(reference, current):
    """Whether the file at `path` is in both readings with a known size and was analysed (hashed) in one only.

    The text budget or the size limit leaves a file listed but not analysed: what it writes is then missing from
    that reading, not from the disk.
    """
    old, new = reference['files'], current['files']
    return lambda path: (isinstance(path, str) and path in old and path in new
                         and (old[path]['sha256'] is None) != (new[path]['sha256'] is None)
                         # A symbolic link has neither hash nor size: becoming a file (or one) is a real change.
                         and old[path]['bytes'] is not None and new[path]['bytes'] is not None)


def _relations(reference, current, edges):
    """Relations added/removed, matched by (origin, source, target, kind, written target).

    The line is not part of the identity: inserting lines above moves evidence
    without creating relations. Several occurrences of one key pair first by
    identical evidence (hash), then in line order.
    """
    root = current['root']
    groups = {}
    for side, compact in ((0, reference), (1, current)):
        for item in compact['relations']:
            key = (item['origin'], item['source'], item['target'], item['kind'], item['raw'])
            groups.setdefault(key, ([], []))[side].append(item)
    added, removed = [], []
    for old, new in groups.values():
        old = sorted(old, key=lambda item: item['line'])
        new = sorted(new, key=lambda item: item['line'])
        by_hash, used, unmatched = {}, set(), []
        for index, item in enumerate(new):
            by_hash.setdefault(item['evidenceHash'], deque()).append(index)
        for item in old:
            same = by_hash.get(item['evidenceHash'])
            if same:
                used.add(same.popleft())
            else:
                unmatched.append(item)
        pending = [item for index, item in enumerate(new) if index not in used]
        paired = min(len(unmatched), len(pending))
        removed += unmatched[paired:]
        added += pending[paired:]
    in_old, in_new = _unseen(reference), _unseen(current)
    uncompared = [item for item in removed if in_new(item['origin'])] + [item for item in added if in_old(item['origin'])]
    removed = [item for item in removed if not in_new(item['origin'])]
    added = [item for item in added if not in_old(item['origin'])]
    half = _half_analysed(reference, current)
    unanalysed = [item for item in removed + added if half(item['origin'])]
    removed = [item for item in removed if not half(item['origin'])]
    added = [item for item in added if not half(item['origin'])]
    def located(item, current_side):
        result = {'origin': _absolute(item['origin'], root), 'source': _absolute(item['source'], root),
                  'target': _absolute(item['target'], root), 'raw': _written(item['raw']), 'kind': _written(item['kind']), 'line': item['line'],
                  'targetStatus': item['status']}
        edge = edges.get(item['edge']) if current_side else None
        if edge is not None:
            # Evidence text exists only for the current reading.
            result.update(edge=edge['id'], evidence=edge['evidence'], resolvedBy=edge.get('resolvedBy'),
                          **({'declared': edge['declared']} if edge.get('declared') else {}))
        return result
    return ([located(item, True) for item in added], [located(item, False) for item in removed],
            [located(item, False) for item in uncompared], [located(item, False) for item in unanalysed])


def _report(compact):
    """Minimal audit v2 report rebuilt from a compact reading, accepted by compare_audits."""
    audit = compact['audit']
    return {'version': audit_report.REPORT_VERSION, 'kind': 'audit', 'status': audit['status'],
            'roots': [{'path': compact['root'], 'name': compact['name']}], 'findings': audit['findings'],
            'metrics': {'partial': audit['partial']}, 'scopeHash': audit['scopeHash'], 'suiteHash': None, 'contractHash': None,
            # The declared scope source, so the context note names it as compare-audit does.
            'scope': {'source': audit.get('scopeSource')}}


def _truncated(sides):
    """Note of the comparison of one root when a reading kept only the first findings (`omitted`)."""
    cap = number(audit_report.MAX_IMPORTED_FINDINGS)
    message = (say('More than {cap} observations in the baseline and in the current scan: only the first {cap}, in audit order (most severe first), '
                   'are kept. No observation is reported as new or as resolved; those that would be count as not compared.', cap=cap)
               if len(sides) == 2 else
               say('More than {cap} observations in the baseline: only the first {cap}, in audit order (most severe first), '
                   'are kept. No observation is reported as new; those that would be count as not compared.', cap=cap)
               if sides == ['before'] else
               say('More than {cap} observations in the current scan: only the first {cap}, in audit order (most severe first), '
                   'are kept. No observation is reported as resolved; those that would be count as not compared.', cap=cap))
    return {'code': 'findings-truncated', 'severity': 'incomplete', 'sides': sides, 'message': message}


def _findings(reference, current):
    """compare-audit of the reference and current findings of one root (same ids, same sets).

    A side that kept only the first findings (`omitted`) affirms no absence: with the reference cut, no finding is new;
    with the current reading cut, none is resolved. Those are counted as not compared.
    """
    root = current['root']
    comparison = audit_report.compare_audits(_report(reference), _report(current))
    old_ids = {item['id'] for item in reference['audit']['findings']}
    def located(items, earlier=False):
        # Unmarked, as the model holds it: the panel finds the model observation by this text. `path` was never marked.
        return [{**{key: value if key == 'path' else _written(value) for key, value in item.items()}, 'node': _absolute(item.get('path'), root),
                 **({'earlier': True} if earlier else {})}
                for item in items]
    # Reclassified (same reference, new code: its legacyId is a reference id) counts as persisting.
    persisting = located(item for item in current['audit']['findings'] if item['id'] in old_ids or item.get('legacyId') in old_ids)
    truncated = [side for side, compact in (('before', reference), ('after', current)) if compact['audit'].get('omitted')]
    context = [{**item, 'root': root} for item in comparison['findings'] + ([_truncated(truncated)] if truncated else [])]
    unseen_old, unseen_new = _unseen(reference), _unseen(current)
    in_old = lambda path: 'before' in truncated or unseen_old(path)
    in_new = lambda path: 'after' in truncated or unseen_new(path)
    new = [item for item in comparison['new'] if not in_old(item.get('path'))]
    resolved = [item for item in comparison['resolved'] if not in_new(item.get('path'))]
    uncompared = ([item for item in comparison['new'] if in_old(item.get('path'))]
                  + [item for item in comparison['resolved'] if in_new(item.get('path'))])
    half = _half_analysed(reference, current)
    marked = lambda item: item['code'] not in ANALYSIS_CODES and half(item.get('path'))
    unanalysed = [item for item in new + resolved if marked(item)]
    new = [item for item in new if not marked(item)]
    resolved = [item for item in resolved if not marked(item)]
    return (comparison['status'], {'new': located(new), 'resolved': located(resolved, reference.get(PHRASES) is not True), 'persisting': persisting,
                                   'uncompared': located(uncompared), 'unanalysed': located(unanalysed)}, context)


class _Merge:
    """Concatenate per-root lists; an item already given by an enclosing root is listed once.

    Only items from earlier roots are skipped, so two identical findings of one
    root (same reference twice on a line) both stay, as in compare-audit.
    """

    def __init__(self, key):
        self.key, self.seen, self.items = key, set(), []

    def add(self, items, *context):
        """`context` goes to the key with each item (the root of a finding)."""
        keys = [self.key(item, *context) for item in items]
        self.items += [item for item, key in zip(items, keys) if key not in self.seen]
        self.seen.update(keys)


# Codes whose findings on one line of one file differ only by message: each file left out of a folder (`unreadable`),
# the invalid manifest and scope declaration of one file (`manifest`). Their key keeps the message: two baselines saved
# by versions with other words then list one finding twice, which is better than leaving out a distinct one.
DISTINCT_BY_MESSAGE = {'unreadable', 'manifest'}


def _finding_key(item, root):
    """What makes a finding of `root` the same as one an enclosing root already gave: the fields of the `aae audit`
    id with the file absolute, the line, and what tells apart two findings of one code there. Only fields every
    saved baseline keeps: never the message, whose words depend on the version that saved it, but for
    DISTINCT_BY_MESSAGE."""
    code = item['code']
    key = (code, item['node'], item.get('line'), str(item.get('target')), str(item.get('scenarioId')), str(item.get('pattern')))
    if code == 'limit':
        # On the folder of a root: the inventory limit, or the text budget, the one with counts.
        return (*key, 'bytes' in item)
    if code == 'scope-unused-pattern':
        return (*key, str(item.get('scopeKind')))
    if code == 'manifest-mismatch':
        # One link, a member of two nested manifests, is a finding of each. `manifest` is relative to the root.
        manifest = item.get('manifest')
        return (*key, str(item.get('absent')), posixpath.normpath(posixpath.join(root, manifest)) if type(manifest) is str else str(manifest))
    if code in DISTINCT_BY_MESSAGE:
        return (*key, str(item.get('message')))
    return key


def _context(reference, compact):
    """'same' when the reference was read with the opened roots of `compact`, in the same order; else 'changed', or
    'unknown' for a reference without the field."""
    saved = reference.get('context')
    if saved is None:
        return 'unknown'
    return 'same' if saved == compact.get('context') else 'changed'


def compare(references, current, model):
    """Delta of every opened root against its reference; None without opened roots.

    Files are always compared. Relations and findings of a root are compared only when its reference was read in
    the same context (`_context`); otherwise the root says so (`roots[].context`, a warning from `annotate`).
    """
    if not current:
        return None
    edges = {edge['id']: edge for edge in model['edges']}
    relation_key = lambda item: (item['origin'], item['source'], item['target'], item['kind'], item['raw'], item['line'])
    files = {key: _Merge(lambda item: item['path']) for key in ('added', 'removed', 'changed', 'uncompared')}
    relations = {key: _Merge(relation_key) for key in ('added', 'removed', 'uncompared', 'unanalysed')}
    findings = {key: _Merge(_finding_key) for key in ('new', 'resolved', 'persisting', 'uncompared', 'unanalysed')}
    status, unverified, roots, errors, context = 'pass', 0, [], [], []
    contexts = {root: _context(references[root], compact) for root, compact in current.items()}
    # Outer roots first, so a nested root's items are credited to the enclosing reading.
    for root in sorted(current, key=len):
        compact, reference = current[root], references[root]
        added, removed, changed, missing, uncompared = _files(reference, compact)
        for key, items in (('added', added), ('removed', removed), ('changed', changed), ('uncompared', uncompared)):
            files[key].add(items)
        unverified += missing
        if contexts[root] != 'same':
            # Readings of other conditions: nothing about relations and findings of this root is affirmed.
            status = 'inconclusive' if STATUS_ORDER.index(status) < STATUS_ORDER.index('inconclusive') else status
            continue
        added, removed, uncompared, unanalysed = _relations(reference, compact, edges)
        relations['added'].add(added)
        relations['removed'].add(removed)
        relations['uncompared'].add(uncompared)
        relations['unanalysed'].add(unanalysed)
        try:
            state, lists, notes = _findings(reference, compact)
        except (ValueError, KeyError, TypeError) as exc:
            errors.append(say('{name}: {reason}', name=compact['name'], reason=of(exc)))
            status = 'error'
            continue
        if STATUS_ORDER.index(state) > STATUS_ORDER.index(status):
            status = state
        for key, items in lists.items():
            findings[key].add(items, root)
        context += notes
    for root, compact in current.items():
        reference = references[root]
        # `referenceSaved` and `warnings` are filled by `annotate` once the store answered.
        roots.append({'path': root, 'name': compact['name'], 'referenceAt': reference['at'],
                      'referenceOrigin': reference.get('origin', 'first-reading'), 'referenceSaved': False,
                      'context': contexts[root]})
    order = lambda item: (item['origin'], item['line'], item['target'])
    uncompared = {group: len(merges.pop('uncompared').items) for group, merges in (('files', files), ('relations', relations), ('findings', findings))}
    unanalysed = {group: len(merges.pop('unanalysed').items) for group, merges in (('relations', relations), ('findings', findings))}
    files = {key: merge.items for key, merge in files.items()}
    relations = {key: sorted(merge.items, key=order) for key, merge in relations.items()}
    findings = {key: merge.items for key, merge in findings.items()}
    # Same ordering as compare-audit: most new + resolved first, then code.
    counts = {}
    for key, items in findings.items():
        for item in items:
            counts.setdefault(item['code'], {'new': 0, 'resolved': 0, 'persisting': 0})[key] += 1
    by_code = dict(sorted(counts.items(), key=lambda pair: (-(pair[1]['new'] + pair[1]['resolved']), pair[0])))
    totals = lambda group: {key: len(value) for key, value in group.items()}
    references_at = sorted(references[root]['at'] for root in current)
    return {'version': VERSION,
            'reference': {'at': references_at[0], 'uniform': references_at[0] == references_at[-1]},
            'current': {'at': next(iter(current.values()))['at']},
            'roots': roots, 'warnings': [], 'limit': LIMIT,
            'files': {**{key: value[:LIMIT] for key, value in files.items()}, 'totals': totals(files), 'unverified': unverified,
                      'uncompared': uncompared['files']},
            'relations': {**{key: value[:LIMIT] for key, value in relations.items()}, 'totals': totals(relations),
                          'uncompared': uncompared['relations'], 'unanalysed': unanalysed['relations']},
            'findings': {'status': status, **({'error': errors[0] if len(errors) == 1 else '; '.join(errors)} if errors else {}),
                         'new': [_spoken(item) for item in findings['new'][:LIMIT]], 'resolved': [_spoken(item) for item in findings['resolved'][:LIMIT]],
                         'persisting': len(findings['persisting']), 'totals': {'new': len(findings['new']), 'resolved': len(findings['resolved'])},
                         'uncompared': uncompared['findings'], 'unanalysed': unanalysed['findings'], 'byCode': by_code, 'context': context}}


def annotate(delta, status):
    """Fill `referenceSaved` of each compared root and `warnings` from what the store answered.

    `status` is {root: {'saved': bool | None, 'warnings': [{code, message}]}}, kept by the workspace.
    A root whose relations and findings were not compared gets the warning that says why; the warning about the
    rules of reading, which speaks only of relations and findings, is then left out for that root.
    """
    if delta is None:
        return
    warnings, read_by_another = [], []
    for item in delta['roots']:
        state = status.get(item['path']) or {}
        item['referenceSaved'] = state.get('saved') is True
        compared = item.get('context', 'same') == 'same'
        if not compared:
            code, message = CONTEXT_WARNINGS[item['context']]
            warnings.append({'root': item['path'], 'code': code, 'message': message})
        for warning in state.get('warnings', ()):
            if warning.get('code') != 'reference-reader-changed':
                warnings.append({'root': item['path'], **warning})
            elif compared:
                if not read_by_another:
                    warnings.append(None)  # said once, where the first of these roots is
                read_by_another.append(item['path'])
    if read_by_another:
        count = len(read_by_another)
        warnings[warnings.index(None)] = {'root': read_by_another[0], 'roots': read_by_another, 'code': 'reference-reader-changed',
                                          'message': plural(count, READER_CHANGED, READER_CHANGED_MANY)}
    delta['warnings'] = warnings


# Saved references are untrusted input: every reason below names a cause, never file content.
LINKED_STORE = say('the references folder of the state is not an ordinary directory (a symbolic link or a file)')
LINKED = say('there is a symbolic link in place of the saved file')
NOT_REGULAR = say('the name of the saved file is not an ordinary file')
HARDLINKED = say('the saved file has more than one name (hard link)')
STORED_CAP = say('ceiling of {size} MiB compressed', size=MAX_STORED // 2 ** 20)
EXPANDED_CAP = say('ceiling of {size} MiB uncompressed', size=MAX_EXPANDED // 2 ** 20)
TOO_BIG = say('file above the {cap}', cap=STORED_CAP)
TOO_BIG_EXPANDED = say('content above the {cap}', cap=EXPANDED_CAP)
CORRUPT = say('file corrupted or truncated')
INCOMPATIBLE = say('incompatible format version')
OTHER_ROOT = say('the file belongs to another root')
INVALID = say('fields with invalid types or values')
ERRORS = {errno.EACCES: say('no permission'), errno.EPERM: say('no permission'), errno.ENOSPC: say('disk full'),
          errno.EDQUOT: say('disk quota exceeded'), errno.EROFS: say('read-only file system'),
          errno.ELOOP: say('symbolic link in the path'), errno.ENOTDIR: say('a file is in the place of a folder'),
          errno.EISDIR: say('a folder is in the place of the file'), errno.EIO: say('input/output error')}


def _cause(exc):
    return ERRORS.get(exc.errno) or say('system error {code}', code=errno.errorcode.get(exc.errno, exc.errno))


class Invalid(ValueError):
    """A saved reference that cannot be used; the message is one of the reasons above."""


HEX16 = re.compile(r'[0-9a-f]{16}')
HEX64 = re.compile(r'[0-9a-f]{64}')
# An empty, '.' or '..' segment: a relative path written by `_relative` never has one. `\Z`, not `$`: a name that
# ends in a line break ('\n', '..\n') is a name like any other, not a segment before the end of the string.
UNNORMALIZED = re.compile(r'(?:^|/)\.{0,2}(?:/|\Z)')
AUDIT_STATUSES = {'pass', 'fail', 'inconclusive'}
RELATION_KEYS = ('origin', 'source', 'target', 'kind', 'raw', 'line', 'evidenceHash', 'status', 'edge')


def _text(value):
    return type(value) is str and '\x00' not in value


def _relative_path(value):
    """Relative to the root as `_relative` writes it: '.' or normalized segments."""
    return _text(value) and (value == '.' or (value[:1] != '/' and not UNNORMALIZED.search(value)))


def _stored_path(value):
    """Relative to the root or, outside it, absolute and normalized."""
    if _text(value) and value[:1] == '/':
        return value == '/' or not UNNORMALIZED.search(value[1:])
    return _relative_path(value)


def _size(value):
    return value is None or (type(value) is int and value >= 0)


def _scalar(value):
    return value is None or type(value) in (str, int, bool) or (type(value) is float and value == value and abs(value) != float('inf'))


def _detail(value):
    """Optional fields of a finding: scalars, lists of scalars or flat objects of scalars."""
    if type(value) is list:
        return all(_scalar(item) for item in value)
    if type(value) is dict:
        return all(_scalar(item) for item in value.values())
    return _scalar(value)


def _time(value):
    if not _text(value) or len(value) > 64:
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _check(condition):
    if not condition:
        raise Invalid(INVALID)


def _no_constant(name):
    raise ValueError(f'JSON constant not accepted: {name}')


def _parsed(data):
    """JSON object of a gzip file, never expanding more than MAX_EXPANDED bytes."""
    inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)  # gzip container only
    try:
        text = inflater.decompress(data, MAX_EXPANDED + 1)
    except zlib.error as exc:
        raise Invalid(CORRUPT) from exc
    if len(text) > MAX_EXPANDED or (inflater.unconsumed_tail and not inflater.eof):
        raise Invalid(TOO_BIG_EXPANDED)
    if not inflater.eof or inflater.unused_data:
        raise Invalid(CORRUPT)
    try:
        return json.loads(text.decode('utf-8'), parse_constant=_no_constant)
    except (ValueError, RecursionError) as exc:
        raise Invalid(CORRUPT) from exc


def _validated(document, root):
    """The compact reference of `root` in a loaded document, rebuilt from checked fields only."""
    if type(document) is not dict or document.get('kind') != KIND:
        raise Invalid(CORRUPT)
    if type(document.get('format')) is not int or document['format'] != FORMAT:
        raise Invalid(INCOMPATIBLE)
    if document.get('root') != root:
        raise Invalid(OTHER_ROOT if _text(document.get('root')) else INVALID)
    reference = document.get('reference')
    if type(reference) is not dict:
        raise Invalid(INVALID)
    if type(reference.get('version')) is not int or reference['version'] != VERSION:
        raise Invalid(INCOMPATIBLE)
    if reference.get('root') != root:
        raise Invalid(OTHER_ROOT)
    name, at, files, relations, audit, reader = map(reference.get, ('name', 'at', 'files', 'relations', 'audit', 'reader'))
    # Absent or malformed: unknown, and the reference still loads, since its files compare without it.
    context = reference.get('context')
    if not (type(context) is list and 1 <= len(context) <= MAX_ROOTS and root in context and len(set(map(str, context))) == len(context)
            and all(_text(path) and path[:1] == '/' and _stored_path(path) for path in context)):
        context = None
    # Absent: the listing counts as complete.
    unlisted, listed = reference.get('unlisted', []), reference.get('listed', [])
    for folders in (unlisted, listed):
        _check(type(folders) is list and all(_relative_path(path) for path in folders)
               and all(a < b for a, b in zip(folders, folders[1:])))
    # Both sides of the split together, as `read` writes them: the root inventoried, no folder on both sides.
    _check((not unlisted and not listed) or ('.' in unlisted or '.' in listed) and set(unlisted).isdisjoint(listed))
    _check(_text(name) and _time(at) and type(files) is dict and type(relations) is list and type(audit) is dict
           and (reader is None or (type(reader) is str and HEX16.fullmatch(reader))))
    checked_files = {}
    for path, item in files.items():
        _check(_relative_path(path) and path != '.' and type(item) is dict)
        digest, size = item.get('sha256'), item.get('bytes')
        _check((digest is None or (type(digest) is str and HEX64.fullmatch(digest))) and _size(size))
        checked_files[path] = {'sha256': digest, 'bytes': size}
    checked_relations, inside, located = [], set(), set()  # paths repeat across relations: check each once
    for item in relations:
        _check(type(item) is dict)
        origin, source, target, kind, raw, line, digest, status, edge = map(item.get, RELATION_KEYS)
        # The origin is a scanned file of the root; a manifest relationship may name a source outside it.
        for value, seen, valid in ((origin, inside, _relative_path), (source, located, _stored_path), (target, located, _stored_path)):
            if type(value) is not str or value not in seen:
                _check(valid(value))
                seen.add(value)
        _check(_text(kind) and _text(raw) and type(line) is int and type(digest) is str and HEX16.fullmatch(digest)
               and (status is None or _text(status)) and _text(edge))
        checked_relations.append({'origin': origin, 'source': source, 'target': target, 'kind': kind, 'raw': raw, 'line': line,
                                  'evidenceHash': digest, 'status': status, 'edge': edge})
    status, partial, scope, source, findings = map(audit.get, ('status', 'partial', 'scopeHash', 'scopeSource', 'findings'))
    _check(type(status) is str and status in AUDIT_STATUSES and type(partial) is bool
           and (scope is None or (type(scope) is str and HEX64.fullmatch(scope))) and (source is None or source in SCOPE_SOURCES)
           and type(findings) is list and len(findings) <= audit_report.MAX_IMPORTED_FINDINGS
           # Only a full list leaves findings out: a mark next to fewer would only silence new findings.
           and ('omitted' not in audit or (type(audit['omitted']) is int and audit['omitted'] > 0
                                           and len(findings) == audit_report.MAX_IMPORTED_FINDINGS)))
    ids, checked_findings = set(), []
    for item in findings:
        _check(type(item) is dict)
        identifier, code, severity, message = map(item.get, ('id', 'code', 'severity', 'message'))
        _check(type(identifier) is str and HEX16.fullmatch(identifier) and identifier not in ids
               and _text(code) and 1 <= len(code) <= 80 and type(severity) is str and severity in audit_report.SEVERITY_RANK
               and _text(message) and (item.get('path') is None or _stored_path(item['path']))
               and (item.get('line') is None or type(item['line']) is int) and (item.get('target') is None or _text(item['target']))
               and all(_text(key) and _detail(value) for key, value in item.items()))
        ids.add(identifier)
        checked_findings.append(dict(item))
    checked_audit = {'status': status, 'partial': partial, 'scopeHash': scope, 'scopeSource': source, 'findings': checked_findings}
    if 'omitted' in audit:
        checked_audit['omitted'] = audit['omitted']
    # `reader` None: a reference without the fingerprint; the rules of that reading are unknown.
    return {'version': VERSION, 'root': root, 'name': name, 'at': at, 'reader': reader, 'files': checked_files, 'relations': checked_relations,
            'unlisted': list(unlisted), 'listed': list(listed), 'audit': checked_audit, 'origin': 'persisted',
            'context': None if context is None else list(context), PHRASES: reference.get(PHRASES) is True}


def _through_unwalked(relative, folder=False):
    """Whether a relative path lies below a folder the walk of its root skips; `folder`: the last segment too."""
    if not isinstance(relative, str) or relative.startswith('/'):
        return False
    parts = relative.split('/')
    return any(part in EXCLUDED for part in (parts if folder else parts[:-1]))


def _own(reference):
    """A loaded reference without what its root could not have read on its own.

    The walk of a root never enters a folder with an excluded name. A saved reference may still hold items below one
    (the inside of a nested root opened there); kept, they would show as removed files, relations and resolved findings.
    """
    audit = reference['audit']
    return {**reference, 'files': {path: item for path, item in reference['files'].items() if not _through_unwalked(path)},
            'relations': [item for item in reference['relations'] if not _through_unwalked(item['origin'])],
            'unlisted': [path for path in reference['unlisted'] if not _through_unwalked(path, True)],
            'listed': [path for path in reference['listed'] if not _through_unwalked(path, True)],
            'audit': {**audit, 'findings': [item for item in audit['findings'] if not _through_unwalked(item.get('path'))]}}


class ReferenceStore:
    """References kept under <state>/references, one gzip file per root named by the hash of its path.

    Each access pins the store directory by descriptor and never follows a link,
    so the store reads and writes only its own regular files inside the state
    directory. Files are written to a temporary name and renamed (mode 0600).
    """

    def __init__(self, state_dir):
        self.state_dir = os.fspath(state_dir)
        self.directory = os.path.join(self.state_dir, STORE)

    @staticmethod
    def name(root):
        return hashlib.sha256(os.fsencode(root)).hexdigest() + '.json.gz'

    def _directory(self, create):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        state = os.open(self.state_dir, flags)
        try:
            if create:
                try:
                    os.mkdir(STORE, 0o700, dir_fd=state)
                except FileExistsError:
                    pass
            return os.open(STORE, flags, dir_fd=state)
        finally:
            os.close(state)

    def load(self, root):
        """(reference with origin 'persisted', None); (None, None) when none is saved; or (None, reason)."""
        return self.load_file(root)[:2]

    def load_file(self, root):
        """`load` and the sha256 of the bytes of the saved file (None when none was read): its identity on disk."""
        try:
            directory = self._directory(create=False)
        except FileNotFoundError:
            return None, None, None
        except OSError as exc:
            return None, LINKED_STORE if exc.errno in {errno.ELOOP, errno.ENOTDIR} else say('could not read the references folder ({cause})', cause=_cause(exc)), None
        try:
            # O_NONBLOCK: a FIFO in place of the file must not hang the reading.
            descriptor = os.open(self.name(root), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        except FileNotFoundError:
            return None, None, None
        except OSError as exc:
            return None, LINKED if exc.errno == errno.ELOOP else say('could not read the saved file ({cause})', cause=_cause(exc)), None
        finally:
            os.close(directory)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                return None, NOT_REGULAR, None
            if info.st_nlink != 1:
                return None, HARDLINKED, None
            if info.st_size > MAX_STORED:
                return None, TOO_BIG, None
            chunks, size = [], 0
            while size <= MAX_STORED:
                chunk = os.read(descriptor, min(1 << 20, MAX_STORED + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
        except OSError as exc:
            return None, say('could not read the saved file ({cause})', cause=_cause(exc)), None
        finally:
            os.close(descriptor)
        if size > MAX_STORED:
            return None, TOO_BIG, None
        data = b''.join(chunks)
        digest = hashlib.sha256(data).hexdigest()
        try:
            return _own(_validated(_parsed(data), root)), None, digest
        except Invalid as exc:
            return None, of(exc), digest
        except Exception:  # noqa: BLE001 - a saved file never prevents opening a root
            return None, CORRUPT, digest

    def save(self, root, reference):
        """None once written; else the reason it was not (the reference stays in memory)."""
        stored = {key: reference[key] for key in ('version', 'root', 'name', 'at', 'files', 'relations', 'audit')}
        stored['reader'] = reference.get('reader')
        stored['unlisted'] = reference.get('unlisted', [])
        stored['listed'] = reference.get('listed', [])
        if reference.get('context') is not None:
            stored['context'] = reference['context']
        if reference.get(PHRASES) is True:
            stored[PHRASES] = True
        document = {'kind': KIND, 'format': FORMAT, 'root': root, 'savedAt': now(), 'reference': stored}
        try:
            # ASCII escapes keep undecodable file names (surrogates) representable.
            text = json.dumps(document, separators=(',', ':')).encode('ascii')
        except (TypeError, ValueError):
            return say('the baseline could not be serialized')
        if len(text) > MAX_EXPANDED:
            return say('baseline above the {cap}', cap=EXPANDED_CAP)
        # Written only if `load` would accept it: no saved reference is born invalid, and the validator stays strict.
        # The document in memory is checked, not its text parsed back: JSON keeps the exact types and finite numbers
        # `_validated` requires.
        try:
            _validated(document, root)
        except Invalid as exc:
            return say('the baseline would not pass validation when loaded ({reason})', reason=of(exc))
        data = gzip.compress(text, compresslevel=1, mtime=0)
        if len(data) > MAX_STORED:
            return say('baseline above the {cap}', cap=STORED_CAP)
        try:
            directory = self._directory(create=True)
        except OSError as exc:
            return LINKED_STORE if exc.errno in {errno.ELOOP, errno.ENOTDIR} else say('failed to prepare the references folder ({cause})', cause=_cause(exc))
        temporary, created = f'.{secrets.token_hex(8)}.tmp', False
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            created = True
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(descriptor, view):]
            finally:
                os.close(descriptor)
            # rename(2) replaces the entry itself: a link at the final name is never followed.
            os.replace(temporary, self.name(root), src_dir_fd=directory, dst_dir_fd=directory)
            created = False
        except OSError as exc:
            return say('write failure ({cause})', cause=_cause(exc))
        finally:
            if created:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except OSError:
                    pass
            os.close(directory)
        return None

    def delete(self, root):
        """None when no saved reference of `root` remains; else the reason."""
        try:
            directory = self._directory(create=False)
        except FileNotFoundError:
            return None
        except OSError as exc:
            return LINKED_STORE if exc.errno in {errno.ELOOP, errno.ENOTDIR} else _cause(exc)
        try:
            # unlink removes a link itself, never its target.
            os.unlink(self.name(root), dir_fd=directory)
        except FileNotFoundError:
            pass
        except OSError as exc:
            return _cause(exc)
        finally:
            os.close(directory)
        return None
