"""Structural audit report v2 and audit deltas for builder agents.

The report is written for an agent reading it in a bounded window: summary
first, detail under filter, nothing duplicated, paths relative to the opened
roots and a stable identity per finding so two copies of one tree compare.
Nothing here opens inspected files or executes their instructions; the
scanner and the snapshot builder do the bounded reads.
"""
from __future__ import annotations

from collections import Counter, deque
import copy
import json
import posixpath
import re
from pathlib import PurePosixPath

try:
    from . import doc_snapshot, suite_contract
    from .scanner import DOCUMENTS, MAX_ROOTS, NAME_FORMS, InvalidInput, below, scan
    from .scope import KINDS, _pattern, matches
    from .texts import is_text, of, say
except ImportError:
    import doc_snapshot
    import suite_contract
    from scanner import DOCUMENTS, MAX_ROOTS, NAME_FORMS, InvalidInput, below, scan
    from scope import KINDS, _pattern, matches
    from texts import is_text, of, say

REPORT_VERSION = 2
COMPARISON_VERSION = 1
MAX_PATH_STEPS = 50000
DEFAULT_TOP = 10
MAX_TOP = 100
MAX_IMPORTED_FINDINGS = 200000
SEVERITIES = ('error', 'incomplete', 'warning', 'info')
SEVERITY_RANK = {severity: rank for rank, severity in enumerate(SEVERITIES)}
# Every code the audit can emit: severity and meaning (also published by schema).
CODES = {
    'required-unreachable': ('error', 'Active requirement with no directed path by explicit reference from the entry (incomplete if the analysis is partial).'),
    'hop-budget-exceeded': ('error', 'Shortest path to the requirement exceeds maxHops (actual, maximum).'),
    'always-loaded-budget-exceeded': ('error', 'Suite entry, whole (wc -c), exceeds maxAlwaysLoadedBytes (actual, maximum).'),
    'entry-unavailable': ('error', 'Suite entry missing from the inventory (incomplete if the analysis is partial).'),
    'limit': ('incomplete', 'Inventory, text budget (per root; list in unanalyzed), size or relations.'),
    'unreadable': ('incomplete', 'Listed, but not read (permission, encoding or special type).'),
    'analysis-partial': ('incomplete', 'A limit or a read failure happened: the absence of a finding is not conclusive.'),
    'path-evidence-limit': ('incomplete', 'Budget of evidence steps exhausted; paths omitted.'),
    'requirement-stale': ('incomplete', 'contentHash differs from the current range; relocated says where the identical excerpt is.'),
    'requirement-unavailable': ('incomplete', 'Required range missing from the snapshot.'),
    'snapshot-partial': ('incomplete', 'The suite snapshot omitted allowed documents.'),
    'suite-snapshot-unavailable': ('incomplete', 'Snapshot of the first root unavailable: content of the requirements not verified (reason); maxAlwaysLoadedBytes uses the size from the inventory, when known.'),
    'broken': ('warning', 'Target missing after resolution and scope, written as a path (target; form in extraction).'),
    'ambiguous': ('warning', 'More than one candidate (target, candidates); info if a bare name.'),
    'outside-root': ('warning', 'Exists only above the opened root (target, ancestor, levels, legacyId).'),
    'invalid-reference': ('warning', 'Malformed reference (target).'),
    'manifest': ('warning', 'Invalid agent-architecture.json or embedded scope (ignored).'),
    'manifest-mismatch': ('warning', 'With linkedRelationships: true, a relation without a link from the source file (absent: link, on the line of the relation) '
                                     'or a link between two objects without a relation (absent: relation, on the line of the link); from, to, manifest.'),
    'no-entry': ('warning', 'Root without AGENTS.md or CLAUDE.md.'),
    'scope-unused-pattern': ('warning', 'Scope pattern without effect (pattern, scopeKind).'),
    'requirement-unbound': ('warning', 'Requirements without contentHash (count): a shift is not detected; use freeze.'),
    'policy-excluded': ('warning', 'The suite snapshot excluded sensitive paths by policy.'),
    'unreachable': ('info', 'Candidate: document with no path by explicit reference from the entries (class orphan|island, inbound); it affirms nothing about the runtime.'),
    'basename-resolved': ('info', 'Resolved by the only file with that name (target, resolvedTo, resolvedBy).'),
    'suffix-resolved': ('info', 'Resolved by the only file with that path suffix (target, resolvedTo, resolvedBy).'),
    'root-dot-resolved': ('info', './ mention resolved from the opened root (target, resolvedTo).'),
    'declared-external': ('info', 'Missing, absorbed by the scope (target, scopeKind, pattern): counted, not verified.'),
    'unresolved-name': ('info', 'Missing target written as a bare name (target; form in extraction): artifact, example, placeholder or a real break written only as a name.'),
    'unverified': ('info', 'Absence that cannot be affirmed (target, reason, legacyId).'),
    'manifest-unchecked': ('info', 'With linkedRelationships: relation not checked against the links, on its line (target, reason: source-not-read, unresolved-end, unresolved-ends, '
                                   'not-a-file, manifest-end, unresolved-link, ambiguous-link, unread-folder-link, unextracted-link; from, to when resolved, manifest).'),
    'symlink': ('info', 'Symbolic link listed without following the target.'),
}
# Written forms of a bare name: an ambiguity written so is info; with a folder it stays a warning.
NAME_ONLY = {'name', 'word'}
# compare-audit: a new finding of these codes fails `--fail-on any` whatever its severity
# (an ambiguity born after a change means someone created a homonym).
GATED_WHEN_NEW = {'ambiguous'}
# Resolution modes by name or suffix and their info code; the exact mode goes in resolvedBy.
BY_NAME = {'basename': 'basename-resolved', 'skill-basename': 'basename-resolved',
           'suffix': 'suffix-resolved', 'skill-suffix': 'suffix-resolved', 'root-dot': 'root-dot-resolved'}
# --fail-on CODE also matches these codes, subtypes of it: a destination found only above the
# opened root (`outside-root`) is a broken reference for the opened root, and a gate on broken keeps it.
GATE_ALIASES = {'broken': ('broken', 'outside-root')}
# compare-audit meta-finding that --fail-on also accepts (any includes it: severity warning).
CONTEXT_CODE = 'audit-context-differs'
LIMITATIONS = [
    'Findings describe explicit references of the material analyzed; they do not observe execution or loading by an agent.',
    'A wikilink without a folder resolves first by the name: a file declares in its frontmatter (frontmatter-name; only a top-level name: with its value on the same line is read, up to 200 lines/16 KiB; it is not a YAML parser). Unanchored references resolve in cascade (file, skill folder, root, unique name/suffix, first under the source skill); each edge declares resolvedBy and the resolutions by name/suffix appear as info.',
    'Extracted: Markdown and wiki links, @import, manifest, anchored path and, in backticks, a name with an extension (or a path followed by §section); backticks with a folder without anchor or extension (cases/_template/) do not count. A missing target with the form of a path is broken; a bare name (backticks, prose, link without extension) is unresolved-name (info), a real break written only as a name included.',
    'Not a reference (metrics.ignored): variable ($), template marker (YYYY, NN, XX), elision in the middle, code wikilink, prose path cut by a glob, manifest key outside a manifest, in .txt everything but a Markdown link and @import, and, in a fenced block, what does not resolve (in a shell block or one without a language, a path with a folder still counts).',
    'Breadth-first inventory: past the limit, a names-only index checks existence; a target found there is unscanned (metrics.resolution.unscanned), never broken. With the index exhausted too, an absence becomes unverified (info). metrics.inventory says what was left out, by top-level folder.',
    'A missing target without an anchor is looked for (existence only) up to 3 ancestors above the opened root, stopping at the first with .git: found there, it becomes outside-root (warning), not broken.',
    'unreachable is a candidate for review (info): no path by explicit reference from the entries considered; the file can still be found by search. Declare entries and implicit loads of the runtime with --scope.',
    'A declared scope is a statement of the author: absorptions are counted (declared-external, scope.patterns) and dead patterns reported, but not verified.',
    'Structural signals (cycles, repetitions, concentration of references) are metrics in metrics.structure, not findings nor proof that operation got worse.',
    'Mass is cost in bytes delivered (and the risk of a cut by the ceiling of the runtime loader); it is not a token count.',
    'Suite paths use explicit references; scope conventions between ancestor AGENTS.md files stay out of the BFS.',
]
SUITE_LIMITATION = ('Content of the requirements (contentHash, lines) and the always-loaded budget (only the suite entry, without the entries of the scope) '
                    'are verified in the snapshot of the first root; with several roots, those findings hold only for it. Paths and hops are computed in each root.')
COMPARISON_LIMITATIONS = [
    'Findings match by id (code, root, relative path, target/requirement/pattern and ordinal), without line or message: editing another part of the file does not recreate findings.',
    'Renaming a file resolves the findings of the old name and creates those of the new one; the comparison does not recognize renames.',
    'scopeHash covers the effective scope (--scope or the one embedded in each root): changing the declaration yields audit-context-differs, and what it absorbs or exempts appears as resolved.',
    'Imported reports are statements of the producer; the comparison does not authenticate their origin.',
]


class _Frame:
    """Translate absolute model ids into (root index, relative POSIX path)."""

    def __init__(self, roots):
        self.roots = [root['path'] for root in roots]
        self.multi = len(self.roots) > 1
        self.order = sorted(range(len(self.roots)), key=lambda index: len(self.roots[index]), reverse=True)
        self.names = [root.get('name') or '.' for root in roots]

    def inside(self, absolute, index):
        root = self.roots[index]
        return '.' if absolute == root else below(absolute, root)

    def locate(self, absolute):
        """Most specific containing root, like the model's node owner; else (None, absolute)."""
        if absolute is None:
            return None, None
        for index in self.order:
            relative = self.inside(absolute, index)
            if relative is not None:
                return index, relative
        return None, absolute

    def relative(self, absolute, base):
        """Relative to `base` when inside it, else to its own root."""
        inside = self.inside(absolute, base) if base is not None else None
        return inside if inside is not None else self.locate(absolute)[1]

    def put(self, item, field, absolute, base):
        """Relative to `base` when inside it; else to its own root, naming that root with <field>Root."""
        if absolute is None:
            return
        relative = self.inside(absolute, base) if base is not None else None
        if relative is None:
            index, relative = self.locate(absolute)
            if self.multi and index is not None:
                item[field + 'Root'] = index
        item[field] = relative

    def ref(self, absolute, **extra):
        """{root?, path, ...} relative to the owning root; root only with several roots."""
        index, relative = self.locate(absolute)
        item = {'root': index} if self.multi and index is not None else {}
        item['path'] = relative
        item.update(extra)
        return item

    def message(self, text):
        if not isinstance(text, str):
            return text
        if is_text(text):
            # The same sentence, with its phrase kept: the roots are in the parameters, never in the phrase.
            return text.mapped(self.message)
        for index in self.order:
            root = self.roots[index]
            text = text.replace(root + '/', '')
            # A bare root (end of sentence included) becomes its name; /root2 or /root.bak are other paths.
            text = re.sub(re.escape(root) + r'(?![\w\-]|\.\w)', lambda _: self.names[index], text)
        return text


def _finding(code, message, root=None, path=None, line=None, severity=None, **details):
    return {'code': code, 'severity': severity or CODES[code][0], 'message': message,
            '_root': root, 'path': path, 'line': line, **details}


def _from_issue(issue, frame):
    code = issue['code']
    root, path = frame.locate(issue.get('node'))
    severity = CODES.get(code, ('warning',))[0]
    if code == 'ambiguous' and issue.get('form') in NAME_ONLY:
        severity = 'info'  # a bare name with several files is usually a mention; compare-audit still gates a new one
    item = _finding(code, frame.message(issue.get('message', '')), root, path, issue.get('line'), severity)
    for key, value in issue.items():
        if key in {'id', 'code', 'message', 'node', 'line'}:
            continue
        if key == 'candidates':
            # Candidates come from the source's own root, the frame of `path`.
            item[key] = [frame.relative(candidate, root) for candidate in value]
        elif key == 'referencedAncestor':
            frame.put(item, key, value, root)
        elif key in {'from', 'to', 'manifest'}:
            # Files of a manifest-mismatch: relative to the finding's root (<key>Root names another opened
            # root); a relationship end outside every opened root, with `..`, never absolute.
            if frame.locate(value)[0] is None and root is not None:
                item[key] = posixpath.relpath(value, frame.roots[root])
            else:
                frame.put(item, key, value, root)
        elif key == 'ancestor':
            # Above every opened root: relative to the finding's root (`..`, `../..`), never absolute.
            item[key] = posixpath.relpath(value, frame.roots[root]) if root is not None else value
        else:
            item[key] = copy.deepcopy(value)
    return item


def _edge_findings(model, frame):
    """Info findings for explicit resolutions by name/suffix and for declared absorptions.

    Manifest relationship edges (kind declared) repeat a value already extracted by
    the JSON pass, so only extracted edges produce findings.
    """
    findings = []
    for edge in model['edges']:
        if edge['kind'] in {'scope', 'declared'}:
            continue
        root, path = frame.locate(edge['origin'])
        mode = edge.get('resolvedBy')
        if mode in BY_NAME:
            # The skill-scoped modes keep the code (and so the id) of the name/suffix step.
            code = BY_NAME[mode]
            if mode == 'root-dot':
                message = say('./ mention that does not exist from the folder of the file, resolved from the opened root; write the path without ./ if it is relative to the root, or fix it from the file.')
            elif mode.startswith('skill-'):
                message = say('Reference resolved by the only candidate under the folder of the source skill (homonyms outside it do not count); write the path from the file so as not to depend on the search by name.')
            elif code == 'basename-resolved':
                message = say('Reference resolved by the only candidate in the inventory; write the full path so as not to depend on the search by name.')
            else:
                message = say('Reference resolved by the only file with that path suffix; write the path from the file or from the root so as not to depend on the search.')
            item = _finding(code, message, root, path, edge['line'], target=edge['raw'])
            frame.put(item, 'resolvedTo', edge['target'], root)
            item['resolvedBy'] = mode
            findings.append(item)
        elif edge.get('declared'):
            findings.append(_finding('declared-external', say('Missing reference absorbed by the declared scope: counted as external to the package, not verified.'),
                                     root, path, edge['line'], target=edge['raw'],
                                     scopeKind=edge['declared']['kind'], pattern=edge['declared']['pattern']))
    return findings


def _step(edge, frame, base):
    step = {}
    frame.put(step, 'source', edge['source'], base)
    step.update(line=edge['line'], kind=edge['kind'], raw=edge['raw'], evidence=edge['evidence'])
    frame.put(step, 'target', edge['target'], base)
    step['resolvedBy'] = edge.get('resolvedBy')
    frame.put(step, 'origin', edge['origin'], base)
    return step


def _suite_paths(model, suite, frame, partial):
    """Minimal directed path per active requirement and root; findings and paths[]."""
    nodes = {node['id']: node for node in model['nodes']}
    adjacency = {}
    for edge in model['edges']:
        if edge['kind'] != 'scope':
            adjacency.setdefault(edge['source'], []).append(edge)
    findings, paths, emitted, omitted = [], [], 0, 0
    for index, root in enumerate(model['roots']):
        entry = str(PurePosixPath(root['path']) / suite['entry'])
        parents = {entry: None} if entry in nodes and nodes[entry]['status'] == 'resolved' else {}
        depths = {entry: 0} if parents else {}
        queue = deque(parents)
        while queue:
            source = queue.popleft()
            for edge in adjacency.get(source, []):
                target = edge['target']
                if target not in parents and target in nodes and nodes[target]['status'] == 'resolved':
                    parents[target] = (source, edge)
                    depths[target] = depths[source] + 1
                    queue.append(target)
        if not parents:
            findings.append(_finding('entry-unavailable', 'The suite entry is not available in the inventory analyzed.', index, suite['entry'],
                                     severity='incomplete' if partial else 'error'))
        for scenario in suite['scenarios']:
            for req in suite_contract._active(scenario):
                target = str(PurePosixPath(root['path']) / req['path'])
                found, steps, cursor = target in parents, [], target
                hops = depths.get(target)
                complete = found and emitted + hops <= MAX_PATH_STEPS
                if found and not complete:
                    omitted += 1
                if complete:
                    while parents[cursor] is not None:
                        cursor, edge = parents[cursor]
                        steps.append(_step(edge, frame, index))
                    steps.reverse()
                    emitted += len(steps)
                item = ({'root': index} if frame.multi else {})
                item.update(scenarioId=scenario['id'], **copy.deepcopy(req), found=found, hops=hops, steps=steps, stepsComplete=complete)
                paths.append(item)
                lines = {'startLine': req['startLine'], 'endLine': req['endLine']}
                if not found:
                    findings.append(_finding('required-unreachable', 'There is no directed path by explicit reference from the entry to the requirement.', index, req['path'],
                                             severity='incomplete' if partial else 'error', scenarioId=scenario['id'], **lines))
                elif 'maxHops' in scenario and hops > scenario['maxHops']:
                    findings.append(_finding('hop-budget-exceeded', 'The shortest path exceeds the hop budget of the scenario.', index, req['path'],
                                             scenarioId=scenario['id'], **lines, actual=hops, maximum=scenario['maxHops']))
    if omitted:
        findings.append(_finding('path-evidence-limit', 'Evidence budget reached; the paths indicated were omitted whole.',
                                 count=omitted, maximum=MAX_PATH_STEPS))
    return findings, paths


def _inventory_budget(model, suite):
    """always-loaded-budget-exceeded from the inventoried size of the first root's entry.

    Used only when the snapshot is unavailable: the scanner knows the size (stat or
    bytes read) even of an entry too large for the snapshot, so the budget is checked.
    """
    entry = str(PurePosixPath(model['roots'][0]['path']) / suite['entry']) if model['roots'] else None
    node = next((node for node in model['nodes'] if node['id'] == entry), None)
    size = node.get('bytes') if node and node['status'] == 'resolved' and node['kind'] not in {'directory', 'symlink'} else None
    if type(size) is not int:
        return []
    return [_finding('always-loaded-budget-exceeded', suite_contract.ALWAYS_LOADED_MESSAGE + ' Size from the inventory (wc -c); the snapshot was not available.',
                     0, suite['entry'], scenarioId=scenario['id'], actual=size, maximum=scenario['maxAlwaysLoadedBytes'])
            for scenario in suite['scenarios'] if 'maxAlwaysLoadedBytes' in scenario and size > scenario['maxAlwaysLoadedBytes']]


def _suite_static(snapshot, snapshot_error, suite, structural, model):
    """Content identity and always-loaded checks on the first root, deduplicated with the BFS findings."""
    if snapshot is None:
        if any(f['code'] == 'entry-unavailable' and f['_root'] == 0 for f in structural):
            return []  # Same cause: the entry is missing; the structural finding already says so.
        return [_finding('suite-snapshot-unavailable', 'Could not build the document snapshot of the first root; contentHash of the requirements was not verified. The always-loaded budget uses the size from the inventory, when known.',
                         reason=snapshot_error or 'snapshot missing')] + _inventory_budget(model, suite)
    try:
        static = suite_contract.suite_static_findings(snapshot, suite)['findings']
        completeness, _ = suite_contract._completeness(snapshot)
    except ValueError as exc:
        return [_finding('suite-snapshot-unavailable', 'Inconsistent document snapshot; contentHash of the requirements was not verified. The always-loaded budget uses the size from the inventory, when known.',
                         reason=str(exc))] + _inventory_budget(model, suite)
    unreachable = {(f['scenarioId'], f['path'], f['startLine'], f['endLine']): f for f in structural
                   if f['code'] == 'required-unreachable' and f['_root'] == 0}
    result = []
    # scan-partial repeats analysis-partial, which the structural audit already reports.
    for item in [f for f in completeness if f['code'] != 'scan-partial'] + static:
        details = {key: value for key, value in item.items() if key not in {'code', 'severity', 'message'}}
        if item['code'] == 'entry-unavailable' and any(f['code'] == 'entry-unavailable' and f['_root'] == 0 for f in structural):
            continue
        if item['code'] == 'requirement-unavailable':
            key = (item.get('scenarioId'), item.get('path'), item.get('startLine'), item.get('endLine'))
            if key in unreachable:
                # One missing requirement, one finding: keep the stronger code, fold the content details.
                unreachable[key].update(available=False, **{k: v for k, v in details.items() if k.startswith('relocat')})
                continue
        path = details.pop('path', None)
        result.append(_finding(item['code'], item['message'], 0 if path is not None else None, path, severity=item['severity'], **details))
    return result


# (code before, code now) of a reclassified finding: an absence that a reading affirmed and that
# another reading of the same reference finds not verifiable or above the opened root.
RECLASSIFICATIONS = frozenset((before, now) for before in ('broken', 'unresolved-name') for now in ('unverified', 'outside-root'))


def _legacy_code(item):
    """Code an unverified or outside-root finding would have as an affirmed absence, else None."""
    if item['code'] not in {'unverified', 'outside-root'} or 'legacyId' not in item or 'syntax' not in item:
        return None
    return 'unresolved-name' if item.get('form') in NAME_FORMS.get(item['syntax'], ()) else 'broken'


def _identity(findings, multi):
    """Stable id: no absolute path, line number or message; ordinal by line within a key.

    An unverified or outside-root finding also gets `legacyId`: the id it would have as
    broken or unresolved-name, ordered among the findings that have that code.
    """
    groups, legacy = {}, {}
    for position, item in enumerate(findings):
        if item.get('target') is not None:
            discriminator = 'target:' + str(item['target'])
        elif item.get('scenarioId') is not None:
            discriminator = 'requirement:' + str(item['scenarioId']) + '\0' + (item.get('path') or '')
        elif item.get('pattern') is not None:
            discriminator = 'pattern:' + str(item['pattern'])
        else:
            discriminator = ''
        root = item['_root'] if multi and item['_root'] is not None else ''
        key = (item['code'], root, item.get('path') or '', discriminator)
        order = item['line'] if item.get('line') is not None else item.get('startLine', -1)
        member = (order if isinstance(order, int) else -1, position, item)
        groups.setdefault(key, []).append(member)
        legacy.setdefault((_legacy_code(item) or item['code'], *key[1:]), []).append(member)
    for key, members in groups.items():
        for ordinal, (_, _, item) in enumerate(sorted(members, key=lambda member: member[:2])):
            item['id'] = suite_contract._hash([*key, ordinal])[:16]
    for key, members in legacy.items():
        if key[0] not in {'broken', 'unresolved-name'}:
            continue
        for ordinal, (_, _, item) in enumerate(sorted(members, key=lambda member: member[:2])):
            if _legacy_code(item):
                item['legacyId'] = suite_contract._hash([*key, ordinal])[:16]


def _public(item, multi):
    """Field order {id, code, severity, message, root?, path?, line?, target?, ...}; empty fields omitted."""
    result = {'id': item['id'], 'code': item['code'], 'severity': item['severity'], 'message': item['message']}
    if multi and item['_root'] is not None:
        result['root'] = item['_root']
    for key in ('path', 'line', 'target'):
        if item.get(key) is not None:
            result[key] = item[key]
    for key, value in item.items():
        if key not in result and key not in {'_root', 'path', 'line', 'target', 'id'}:
            result[key] = value
    return result


def _sort_key(item):
    line = item.get('line') if item.get('line') is not None else item.get('startLine', 0)
    root = item['_root'] if item['_root'] is not None else -1
    return (SEVERITY_RANK[item['severity']], root, item.get('path') or '', line if isinstance(line, int) else 0, item['code'], item['id'])


def _summary(findings, top, multi):
    by_severity = dict.fromkeys(SEVERITIES, 0)
    codes = Counter()
    sources, targets = {}, {}
    for item in findings:
        by_severity[item['severity']] += 1
        codes[item['code']] += 1
        if item['severity'] == 'info':
            continue
        if item.get('path') is not None:
            source = sources.setdefault((item['_root'] if multi else None, item['path']), Counter())
            source[item['code']] += 1
        if item.get('target') is not None:
            target = targets.setdefault(str(item['target']), Counter())
            target[item['code']] += 1
    def ranked(counter):
        return dict(sorted(counter.items(), key=lambda pair: (-pair[1], pair[0])))
    top_sources = []
    for (root, path), counter in sorted(sources.items(), key=lambda pair: (-sum(pair[1].values()), pair[0][0] if pair[0][0] is not None else -1, pair[0][1]))[:top]:
        entry = {'root': root} if root is not None else {}
        entry.update(path=path, count=sum(counter.values()), byCode=ranked(counter))
        top_sources.append(entry)
    top_targets = [{'target': target, 'count': sum(counter.values()), 'codes': sorted(counter)}
                   for target, counter in sorted(targets.items(), key=lambda pair: (-sum(pair[1].values()), pair[0]))[:top]]
    return {'total': len(findings), 'bySeverity': by_severity, 'byCode': ranked(codes), 'top': top,
            'topSources': top_sources, 'topTargets': top_targets}


def _mass(model, suite, frame):
    nodes = {node['id']: node for node in model['nodes']}
    reach = model['stats'].get('reachability') or {}
    starts = reach.get('starts', [])
    declared = {start['node'] for start in starts if start['source'] == 'declared-entry'}
    entries = [frame.ref(node_id, bytes=nodes[node_id].get('bytes'), source='convention' if nodes[node_id]['kind'] == 'entry' else 'declared-entry')
               for node_id in sorted(n for n, node in nodes.items() if node['status'] == 'resolved' and (node['kind'] == 'entry' or n in declared))]
    # Always loaded: the suite (or convention) entry of each root plus the scope's `entries`.
    # implicitLoads are loaded on a trigger and never sum here.
    files, seen = [], set()

    def add(node_id, source):
        if node_id in seen or node_id not in nodes or nodes[node_id]['status'] != 'resolved' or nodes[node_id]['kind'] == 'directory':
            return
        seen.add(node_id)
        files.append(frame.ref(node_id, bytes=nodes[node_id].get('bytes'), source=source))
    for root in model['roots']:
        for name in ([suite['entry']] if suite else ['AGENTS.md', 'CLAUDE.md']):
            add(str(PurePosixPath(root['path']) / name), 'suite-entry' if suite else 'convention')
    for node_id in sorted(start['node'] for start in starts if 'declared-entry' in {start['source'], start.get('declared')}):
        add(node_id, 'declared-entry')
    basis = ('suite-entry' if suite else 'root-level-entries') + ('+declared-entries' if any(item['source'] == 'declared-entry' for item in files) else '')
    always = {'bytes': sum(item['bytes'] or 0 for item in files), 'basis': basis, 'files': files}
    if any(item['bytes'] is None for item in files):
        always['complete'] = False
    levels = {}
    for node in nodes.values():
        if 'hops' in node and node['kind'] != 'directory':
            level = levels.setdefault(node['hops'], {'hops': node['hops'], 'files': 0, 'bytes': 0})
            level['files'] += 1
            level['bytes'] += node.get('bytes') or 0
    documents = sum(node.get('bytes') or 0 for node in nodes.values()
                    if node['status'] == 'resolved' and node['kind'] not in {'directory', 'symlink'}
                    and PurePosixPath(node['id']).suffix.lower() in DOCUMENTS)
    return {'entries': entries, 'alwaysLoaded': always, 'reachableByHops': [levels[key] for key in sorted(levels)], 'documentsBytes': documents}


def _metrics(model, suite, frame, partial):
    stats = model['stats']
    structure = copy.deepcopy(stats.get('structure'))
    if structure and structure.get('maxFanout'):
        structure['maxFanout'] = frame.ref(structure['maxFanout']['node'], count=structure['maxFanout']['count'])
    reachability = copy.deepcopy(stats.get('reachability'))
    if reachability:
        reachability['starts'] = [frame.ref(start['node'], source=start['source']) for start in reachability['starts']]
    metrics = {'files': stats['files'], 'unresolvedTargets': stats.get('unresolvedTargets'), 'parsed': stats['parsed'], 'edges': stats['edges'], 'entries': stats['entries'], 'partial': partial,
               'resolution': copy.deepcopy(stats.get('resolution')), 'structure': structure, 'reachability': reachability,
               'mass': _mass(model, suite, frame)}
    inventory = copy.deepcopy(stats.get('inventory'))
    if inventory is not None:
        inventory['byTopLevel'] = [_rooted(item, frame) for item in inventory.get('byTopLevel', [])]
        if inventory.get('entriesOmitted'):
            inventory['entriesOmitted']['paths'] = [frame.ref(path) for path in inventory['entriesOmitted']['paths']]
        metrics['inventory'] = inventory
    if stats.get('headers') is not None:
        metrics['headers'] = copy.deepcopy(stats['headers'])
    if stats.get('relations') is not None:
        metrics['relations'] = copy.deepcopy(stats['relations'])
    if stats.get('ignored') is not None:
        metrics['ignored'] = copy.deepcopy(stats['ignored'])
    if stats.get('probe') is not None:
        metrics['probe'] = {'maxLevels': stats['probe'].get('maxLevels'),
                            'ancestors': [_rooted(item, frame) for item in stats['probe'].get('ancestors', [])]}
    return metrics


def _rooted(item, frame):
    """A stats item that names an opened root by absolute path: the root index with several roots, nothing with one."""
    result = {key: value for key, value in item.items() if key != 'root'}
    if frame.multi and item.get('root') in frame.roots:
        result = {'root': frame.roots.index(item['root']), **result}
    return result


def _unanalyzed(model, frame):
    """Every text listed but not analysed (reason budget, size or unreadable): the list the `limit` counts add up to."""
    return [frame.ref(node['id'], bytes=node.get('bytes'), reason=node.get('skippedBy', 'unreadable'))
            for node in sorted(model['nodes'], key=lambda node: node['id']) if node.get('analysis') == 'skipped']


def _roots(model, frame):
    result = []
    for root in model['roots']:
        parent = frame.roots.index(root['parent']) if root.get('parent') in frame.roots else None
        entries = sorted(filter(None, (below(entry, root['path']) for entry in root['entries'])))
        result.append({'path': root['path'], 'name': root['name'], 'parent': parent, 'level': root['level'], 'entries': entries})
    return result


def _scope(model, frame):
    scope = model.get('scope') or {'source': None, 'patterns': []}
    patterns = []
    for pattern in scope['patterns']:
        item = {key: pattern[key] for key in ('kind', 'pattern', 'references', 'files')}
        if frame.multi and pattern.get('root') in frame.roots:
            item['root'] = frame.roots.index(pattern['root'])
        patterns.append(item)
    return {'source': scope['source'], 'patterns': patterns}


def _scope_hash(model, frame):
    """Hash of the effective declaration, or None when no root has one.

    The scanner keeps every validated pattern in declared order (kinds in KINDS
    order), so the declaration is rebuilt exactly: one shared by --scope, or one
    per root (by index, never the absolute path) when embedded. An embedded
    declaration without patterns has no effect and only marks the source.
    """
    scope = model.get('scope') or {}
    if scope.get('source') not in {'flag', 'manifest'}:
        return None
    def empty():
        return {'version': 1, **{kind: [] for kind in KINDS}}
    declarations = {}
    for item in scope.get('patterns', []):
        index = frame.roots.index(item['root']) if scope['source'] == 'manifest' and item.get('root') in frame.roots else None
        declarations.setdefault(index, empty())[item['kind']].append(item['pattern'])
    if scope['source'] == 'flag':
        return suite_contract._hash({'source': 'flag', 'declaration': declarations.get(None, empty())})
    return suite_contract._hash({'source': 'manifest', 'roots': [[index, declarations[index]] for index in sorted(declarations, key=lambda index: -1 if index is None else index)]})


def _cap(container, key, top, order=None):
    """--summary: keep `top` items of container[key] (sorted by `order`, else in stable order) and add <key>Total next to it."""
    items = container[key]
    kept = (sorted(items, key=order) if order else items)[:top]
    result = {}
    for name, value in container.items():
        result[name] = kept if name == key else value
        if name == key:
            result[key + 'Total'] = len(items)
    container.clear()
    container.update(result)


def _largest(item):
    """Larger bytes first; unknown size last; ties keep the path order."""
    return (item.get('bytes') is None, -(item.get('bytes') or 0))


def _capped_views(report, top):
    """Bound every list that grows with the tree, so --summary stays a few KB."""
    for root in report['roots']:
        _cap(root, 'entries', top)
    metrics = report['metrics']
    if metrics.get('reachability'):
        _cap(metrics['reachability'], 'starts', top)
    if metrics.get('inventory'):
        # Folders with the most elements left out first.
        _cap(metrics['inventory'], 'byTopLevel', top, lambda item: (item['inventoried'] - item['onDisk'], item.get('root', 0), item['name']))
        omitted = metrics['inventory'].get('entriesOmitted')
        if omitted:
            omitted['paths'] = omitted['paths'][:top]  # in path order; `count` stays the total
    mass = metrics['mass']
    _cap(mass, 'entries', top, _largest)
    _cap(mass['alwaysLoaded'], 'files', top, _largest)
    _cap(mass, 'reachableByHops', top)
    _cap(report['scope'], 'patterns', top)


def _codes(values, flag, allow_any=False, extra=()):
    """Repeatable flag values, comma lists accepted; unknown codes are input errors."""
    result = []
    for value in values or []:
        for code in str(value).split(','):
            code = code.strip()
            if code == 'any' and allow_any or code in CODES or code in extra:
                if code not in result:
                    result.append(code)
            else:
                valid = ', '.join((['any'] if allow_any else []) + sorted({*CODES, *extra}))
                raise InvalidInput(f'{flag}: unknown code {code!r}. Valid codes: {valid}.')
    return result


def view_options(summary=False, codes=None, sources=None, top=DEFAULT_TOP, fail_on=None):
    """Validate presentation flags before any scan."""
    if type(top) is not int or not 1 <= top <= MAX_TOP:
        raise InvalidInput(f'--top takes an integer from 1 to {MAX_TOP}.')
    patterns = []
    for value in sources or []:
        try:
            pattern = _pattern(value, '--source')
        except ValueError as exc:
            raise InvalidInput(of(exc)) from None
        if pattern not in patterns:
            patterns.append(pattern)
    return {'summary': bool(summary), 'codes': _codes(codes, '--code'), 'sources': patterns, 'top': top,
            'fail_on': _codes(fail_on, '--fail-on', allow_any=True)}


def _gate(findings, fail_on, always=()):
    """Explicit codes are always listed (0 included) and count every finding of the code (and of its
    subtypes in GATE_ALIASES); `any` adds the warning/error findings (and those of the codes in
    `always`), counting only those."""
    counts = Counter(item['code'] for item in findings)
    marked = [code for code in fail_on if code != 'any']
    matched = {code: sum(counts[alias] for alias in GATE_ALIASES.get(code, (code,))) for code in marked}
    if 'any' in fail_on:
        severe = Counter(item['code'] for item in findings if item['severity'] in {'warning', 'error'} or item['code'] in always)
        matched.update((code, severe[code]) for code in sorted(set(severe) - set(marked)))
    return {'failOn': list(fail_on), 'matched': matched}


def _selected(item, codes, sources):
    if codes and item['code'] not in codes:
        return False
    return not sources or (item.get('path') is not None and any(matches(pattern, item['path']) for pattern in sources))


def audit(model, suite=None, *, summary=False, codes=None, sources=None, top=DEFAULT_TOP, fail_on=None):
    """Audit report v2 for a scanned model; with a suite, its documental snapshot is built here.

    scopeHash comes from the model: the declaration the scan applied (flag or embedded).
    """
    options = view_options(summary, codes, sources, top, fail_on)
    suite = suite_contract.validate_suite(suite) if suite is not None else None
    frame = _Frame(model['roots'])
    nodes = model['nodes']
    partial = any(issue['code'] in {'limit', 'unreadable'} for issue in model['issues']) or any(node.get('analysis') in {'partial', 'skipped'} for node in nodes)
    findings = [_from_issue(issue, frame) for issue in model['issues']]
    if partial:
        findings.append(_finding('analysis-partial', say('Partial inventory or analysis: the absence of findings or of paths is not conclusive.')))
    findings += _edge_findings(model, frame)
    paths = []
    if suite is not None:
        snapshot, snapshot_error = _snapshot(model, suite)
        structural, paths = _suite_paths(model, suite, frame, partial)
        findings += structural + _suite_static(snapshot, snapshot_error, suite, structural, model)
    _identity(findings, frame.multi)
    findings.sort(key=_sort_key)
    status = suite_contract._status(findings)
    gate = _gate(findings, options['fail_on']) if options['fail_on'] else None
    if gate and any(gate['matched'].values()):
        status = 'fail'
    report = {'version': REPORT_VERSION, 'kind': 'audit', 'status': status, 'roots': _roots(model, frame),
              'summary': _summary(findings, options['top'], frame.multi)}
    if gate:
        report['gate'] = gate
    listed = [item for item in findings if _selected(item, options['codes'], options['sources'])]
    if options['codes'] or options['sources']:
        report['filter'] = {'codes': options['codes'], 'sources': options['sources'], 'matched': len(listed)}
    if options['summary']:
        report['findingsOmitted'] = len(listed)
    report.update(metrics=_metrics(model, suite, frame, partial), scope=_scope(model, frame),
                  suiteHash=suite_contract._hash(suite) if suite else None,
                  contractHash=suite_contract.contract_hash(suite) if suite else None,
                  scopeHash=_scope_hash(model, frame),
                  limitations=LIMITATIONS + ([SUITE_LIMITATION] if suite else []),
                  policy=copy.deepcopy(model['policy']))
    if options['summary']:
        _capped_views(report, options['top'])
    else:
        report['analyzed'] = [frame.ref(node['id']) for node in sorted(model['nodes'], key=lambda node: node['id']) if node.get('analysis') == 'parsed']
        report['unanalyzed'] = _unanalyzed(model, frame)
        report['paths'] = paths
        report['findings'] = [_public(item, frame.multi) for item in listed]
    return report


def _snapshot(model, suite):
    """(snapshot, None) or (None, reason): a missing snapshot degrades the suite checks, never the audit."""
    try:
        # Resolved roots from the model: the snapshot reads the same first root the scan inventoried.
        return doc_snapshot.prepare([root['path'] for root in model['roots']], suite)[1], None
    except ValueError as exc:
        return None, str(exc)
    except OSError:
        return None, 'Could not read the first root for the snapshot.'


def run(roots, suite=None, scope=None, **view):
    """CLI entry: validate flags first, scan with the declared scope, then audit."""
    options = view_options(**view)
    model = scan(roots, scope=scope)
    return audit(model, suite, summary=options['summary'], codes=options['codes'],
                 sources=options['sources'], top=options['top'], fail_on=options['fail_on'])


def _hex(value, length):
    return isinstance(value, str) and re.fullmatch(f'[0-9a-f]{{{length}}}', value) is not None


def _imported(report, side):
    """Validate an imported audit report without trusting its producer."""
    if not isinstance(report, dict) or report.get('kind') != 'audit':
        raise InvalidInput(f'{side}: use a report produced by audit (kind: audit).')
    if type(report.get('version')) is not int or report['version'] != REPORT_VERSION:
        raise InvalidInput(f'{side}: compare-audit requires audit version: 2; v1 reports have no stable ids. Generate it again with this version.')
    # Membership tests on imported values must not raise TypeError (lists and objects are unhashable).
    if not isinstance(report.get('status'), str) or report['status'] not in {'pass', 'fail', 'inconclusive'}:
        raise InvalidInput(f'{side}: invalid status in the audit report.')
    if 'findings' not in report:
        raise InvalidInput(f'{side}: a --summary report has no findings; generate the audit without --summary to compare.')
    findings = report['findings']
    if not isinstance(findings, list) or len(findings) > MAX_IMPORTED_FINDINGS:
        raise InvalidInput(f'{side}: findings must be a bounded list.')
    ids = set()
    for item in findings:
        if (not isinstance(item, dict) or not _hex(item.get('id'), 16) or not isinstance(item.get('code'), str)
                or not 1 <= len(item['code']) <= 80 or not isinstance(item.get('severity'), str) or item['severity'] not in SEVERITY_RANK):
            raise InvalidInput(f'{side}: finding without a valid id, code or severity.')
        if item['id'] in ids:
            raise InvalidInput(f'{side}: repeated finding id.')
        ids.add(item['id'])
    if not isinstance(report.get('roots'), list) or not 1 <= len(report['roots']) <= MAX_ROOTS:
        raise InvalidInput(f'{side}: roots missing or invalid.')
    for key in ('suiteHash', 'contractHash', 'scopeHash'):
        if report.get(key) is not None and not _hex(report[key], 64):
            raise InvalidInput(f'{side}: invalid {key}.')
    metrics = report.get('metrics', {})
    if not isinstance(metrics, dict) or ('partial' in metrics and not isinstance(metrics['partial'], bool)):
        raise InvalidInput(f'{side}: invalid metrics.')
    selection = report.get('filter')
    if selection is not None and (not isinstance(selection, dict) or any(not isinstance(selection.get(key), list) or
                                                                         any(not isinstance(v, str) for v in selection[key]) for key in ('codes', 'sources'))):
        raise InvalidInput(f'{side}: invalid filter.')
    if not isinstance(report.get('paths', []), list) or any(not isinstance(item, dict) for item in report.get('paths', [])):
        raise InvalidInput(f'{side}: invalid paths.')
    return report


def _requirement_hops(report):
    result = {}
    for item in report.get('paths', []):
        scenario = item.get('scenarioId')
        if not isinstance(scenario, str):
            continue
        if isinstance(item.get('contentHash'), str):
            requirement = {'contentHash': item['contentHash']}
        else:
            requirement = {key: item.get(key) for key in ('path', 'startLine', 'endLine')}
        hops = item.get('hops')
        key = (item.get('root') if type(item.get('root')) is int else 0, scenario, json.dumps(requirement, sort_keys=True))
        result.setdefault(key, (requirement, hops if type(hops) is int else None))
    return result


def _scope_source(report):
    """Declared scope source of an imported report: flag, manifest or None (anything else is None)."""
    scope = report.get('scope')
    source = scope.get('source') if isinstance(scope, dict) else None
    return source if source in {'flag', 'manifest'} else None


def compare_audits(before, after, fail_on=None):
    """New, resolved and persisting findings between two audits, matched by id.

    --fail-on gates the new findings and, as a code of its own, audit-context-differs
    (`any` includes it): a changed effective scope can resolve findings by declaration.
    """
    fail_on = _codes(fail_on, '--fail-on', allow_any=True, extra=(CONTEXT_CODE,))
    before, after = _imported(before, '--before'), _imported(after, '--after')
    if len(before['roots']) != len(after['roots']):
        raise InvalidInput('Incompatible reports: different number of roots; the ids include the root index.')
    def selection(report):
        value = report.get('filter')
        return None if value is None else (sorted(value['codes']), sorted(value['sources']))
    if selection(before) != selection(after):
        raise InvalidInput('Incompatible reports: different --code/--source filters. Generate both with the same filter, or without one.')
    old = {item['id']: item for item in before['findings']}
    new = {item['id']: item for item in after['findings']}
    added = [copy.deepcopy(item) for item in after['findings'] if item['id'] not in old]
    resolved = [copy.deepcopy(item) for item in before['findings'] if item['id'] not in new]
    persisting = [item for item in after['findings'] if item['id'] in old]
    # A finding whose legacyId is the id of one that went away is the same reference under another
    # code (the before report affirmed the absence): reclassified, neither new nor resolved, never gated.
    # Only a transition this reader produces, for the same written reference in the same place:
    # a legacyId copied onto another finding is new, and the one that went away is resolved.
    gone = {item['id']: item for item in resolved}
    reclassified, matched_ids = [], set()
    for item in added:
        legacy = item.get('legacyId')
        if (isinstance(legacy, str) and legacy in gone and legacy not in matched_ids
                and (gone[legacy]['code'], item['code']) in RECLASSIFICATIONS
                and all(item.get(key) == gone[legacy].get(key) for key in ('root', 'path', 'line', 'target'))):
            matched_ids.add(legacy)
            reclassified.append({**item, 'previousId': legacy, 'previousCode': gone[legacy]['code']})
    if matched_ids:
        moved = {item['id'] for item in reclassified}
        added = [item for item in added if item['id'] not in moved]
        resolved = [item for item in resolved if item['id'] not in matched_ids]
    by_code = {}
    persisting = persisting + reclassified  # the same reference under a new code persists
    for label, items in (('new', added), ('resolved', resolved), ('persisting', persisting)):
        for item in items:
            by_code.setdefault(item['code'], {'new': 0, 'resolved': 0, 'persisting': 0})[label] += 1
    by_code = dict(sorted(by_code.items(), key=lambda pair: (-(pair[1]['new'] + pair[1]['resolved']), pair[0])))
    findings = []
    differs = [key for key in ('suiteHash', 'contractHash', 'scopeHash') if before.get(key) != after.get(key)]
    # A suite relocated under the same frozen contract (freeze --relocate) is the same oracle.
    if before.get('contractHash') is not None and before.get('contractHash') == after.get('contractHash'):
        differs = [key for key in differs if key != 'suiteHash']
    if differs:
        context = {'code': CONTEXT_CODE, 'severity': 'warning', 'differs': differs,
                   'message': say('Different audit context ({differs}): suite or scope findings may change because of the context, not of the revision.',
                                  differs=', '.join(differs))}
        if 'scopeHash' in differs:
            sources = {'before': _scope_source(before), 'after': _scope_source(after)}
            context['scopeSource'] = sources
            context['message'] = say('{note} Different effective scope (source before: {before}; after: {after}): '
                                     'part of the delta, resolved findings above all, may be an artifact of the scope declaration, not of the revision.',
                                     note=context['message'], before=sources['before'] or say('none'), after=sources['after'] or say('none'))
        findings.append(context)
    incomplete = [side for side, report in (('before', before), ('after', after))
                  if report['status'] == 'inconclusive' or report.get('metrics', {}).get('partial') is True]
    if incomplete:
        findings.append({'code': 'comparison-incomplete', 'severity': 'incomplete', 'sides': incomplete,
                         'message': say('Partial or inconclusive audit in {sides}: missing findings do not prove resolution.',
                                        sides=say('{before} and {after}', before=incomplete[0], after=incomplete[1]) if len(incomplete) == 2 else incomplete[0])})
    gate = _gate(added + [item for item in findings if item['code'] == CONTEXT_CODE], fail_on, GATED_WHEN_NEW) if fail_on else None
    status = 'inconclusive' if incomplete else 'pass'
    if gate and any(gate['matched'].values()):
        status = 'fail'
    result = {'version': COMPARISON_VERSION, 'kind': 'audit-comparison', 'status': status,
              'beforeStatus': before['status'], 'afterStatus': after['status']}
    if gate:
        result['gate'] = gate
    result.update(findings=findings, byCode=by_code, persisting=len(persisting), new=added, resolved=resolved, reclassified=reclassified)
    if before.get('paths') and after.get('paths'):
        old_hops, new_hops = _requirement_hops(before), _requirement_hops(after)
        changes = []
        for key in sorted(set(old_hops) | set(new_hops), key=lambda key: (key[0], key[1], key[2])):
            requirement = (new_hops.get(key) or old_hops.get(key))[0]
            previous, current = old_hops.get(key, (None, None))[1], new_hops.get(key, (None, None))[1]
            if key in old_hops and key in new_hops and previous == current:
                continue
            change = {'root': key[0]} if len(after['roots']) > 1 else {}
            change.update(scenarioId=key[1], requirement=requirement, before=previous, after=current)
            if key not in old_hops or key not in new_hops:
                change['absentIn'] = 'before' if key not in old_hops else 'after'
            changes.append(change)
        result['hops'] = changes
    result['limitations'] = COMPARISON_LIMITATIONS
    return result
