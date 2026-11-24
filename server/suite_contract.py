"""Suite contract (version 1): validation, identity hashes, read-free checks and freeze.

The structural audit (audit.py) applies a suite through suite_static_findings;
the hashes here (suiteHash, contractHash) are part of its report.
This module never opens files or executes instructions in inspected documents.
"""
import copy
import hashlib
import json
import re
from pathlib import PurePosixPath

try:
    from .doc_snapshot import policy_excluded_path, document_lines, excerpt_sha256
    from .scanner import InvalidInput
except ImportError:
    from doc_snapshot import policy_excluded_path, document_lines, excerpt_sha256
    from scanner import InvalidInput

MAX_SCENARIOS = 100
MAX_REQUIREMENTS = 1000
MAX_LINE = 1000000
MAX_RELOCATIONS = 5
# Relocation only knows a hash and a line count, so it hashes every window of
# that length once (cached per length). Both budgets keep hostile inputs bounded.
RELOCATION_MAX_WINDOWS = 2000000
RELOCATION_MAX_BYTES = 256 * 1024 * 1024


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _hex(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _integer(value, minimum=0, maximum=MAX_LINE):
    return type(value) is int and minimum <= value <= maximum


def _path(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 1024 or '\\' in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise InvalidInput('Use valid relative POSIX paths.')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != value or value == '.':
        raise InvalidInput('Paths must be normalized, relative and without directory traversal.')
    return value


def _keys(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise InvalidInput('Invalid contract: unknown fields or required fields missing.')


def validate_suite(value):
    """Validate and normalize the complete version-1 contract, rejecting typos.

    Optional fields are normalized only when present (entryInjected only when
    true), so a suite that omits them keeps the same suiteHash.
    """
    _keys(value, {'version', 'entry', 'entryInjected', 'scenarios'}, {'version', 'entry', 'scenarios'})
    if type(value['version']) is not int or value['version'] != 1:
        raise InvalidInput('Incompatible suite version; use version: 1.')
    if 'entryInjected' in value and type(value['entryInjected']) is not bool:
        raise InvalidInput('entryInjected must be a boolean.')
    entry = _path(value['entry'])
    scenarios = value['scenarios']
    if not isinstance(scenarios, list) or not 1 <= len(scenarios) <= MAX_SCENARIOS:
        raise InvalidInput('Use 1 to 100 scenarios.')
    result, ids, total = [], set(), 0
    for scenario in scenarios:
        _keys(scenario, {'id', 'triggers', 'required', 'conditional', 'forbidden', 'maxReads', 'maxBytes', 'maxHops', 'maxAlwaysLoadedBytes'}, {'id'})
        ident = scenario['id']
        if not isinstance(ident, str) or not 1 <= len(ident) <= 120 or ident in ids or any(ord(c) < 32 for c in ident):
            raise InvalidInput('Scenarios need unique IDs of up to 120 characters.')
        ids.add(ident)
        triggers = scenario.get('triggers', [])
        if not isinstance(triggers, list) or len(triggers) > 100 or any(not isinstance(t, str) or not 1 <= len(t) <= 120 for t in triggers) or len(set(triggers)) != len(triggers):
            raise InvalidInput('Triggers must be unique texts of up to 120 characters.')
        current = {'id': ident, 'triggers': sorted(triggers), 'required': [], 'conditional': [], 'forbidden': []}
        for group in ('required', 'conditional'):
            requirements = scenario.get(group, [])
            if not isinstance(requirements, list):
                raise InvalidInput('Requirements must be lists of line ranges.')
            total += len(requirements)
            if total > MAX_REQUIREMENTS:
                raise InvalidInput('Limit of 1,000 requirements per suite exceeded.')
            for req in requirements:
                allowed = {'path', 'startLine', 'endLine'} | ({'trigger'} if group == 'conditional' else set())
                _keys(req, allowed | {'contentHash'}, allowed)
                _path(req['path'])
                if not _integer(req['startLine'], 1) or not _integer(req['endLine'], req['startLine']):
                    raise InvalidInput('Invalid range; use positive, ordered lines, up to 1,000,000.')
                if 'contentHash' in req and not _hex(req['contentHash']):
                    raise InvalidInput('contentHash must be a lowercase hexadecimal SHA-256 (64 characters); generate it with the freeze command.')
                if group == 'conditional' and (not isinstance(req['trigger'], str) or not 1 <= len(req['trigger']) <= 120):
                    raise InvalidInput('A conditional requirement needs a valid trigger.')
                current[group].append(copy.deepcopy(req))
        forbidden = scenario.get('forbidden', [])
        if not isinstance(forbidden, list) or len(forbidden) > MAX_REQUIREMENTS:
            raise InvalidInput('Use up to 1,000 forbidden paths per scenario.')
        current['forbidden'] = sorted(set(_path(p) for p in forbidden))
        total += len(forbidden)
        if total > MAX_REQUIREMENTS:
            raise InvalidInput('Limit of 1,000 requirements per suite exceeded.')
        active = current['required'] + [r for r in current['conditional'] if r['trigger'] in triggers]
        inactive = [r for r in current['conditional'] if r['trigger'] not in triggers]
        for req in active:
            if req['path'] in forbidden or any(req['path'] == other['path'] and req['startLine'] <= other['endLine'] and other['startLine'] <= req['endLine'] for other in inactive):
                raise InvalidInput('Contradictory contract: lines required and forbidden at the same time.')
        for key in ('maxReads', 'maxBytes', 'maxHops', 'maxAlwaysLoadedBytes'):
            if key in scenario:
                if not _integer(scenario[key], 0, 1024 * 1024 * 1024):
                    raise InvalidInput('Budgets must be non-negative integers up to 1 GiB.')
                current[key] = scenario[key]
        result.append(current)
    normalized = {'version': 1, 'entry': entry, 'scenarios': result}
    if value.get('entryInjected') is True:
        normalized['entryInjected'] = True
    return normalized


def contract_hash(suite):
    """Location-independent identity: each requirement is only its contentHash.

    Scenario IDs, triggers, conditional triggers, forbidden paths, budgets,
    entry and entryInjected are kept. None while any requirement is unbound.
    """
    suite = validate_suite(suite)
    scenarios = []
    for scenario in suite['scenarios']:
        if any('contentHash' not in req for req in scenario['required'] + scenario['conditional']):
            return None
        view = {key: copy.deepcopy(value) for key, value in scenario.items() if key not in {'required', 'conditional'}}
        view['required'] = sorted(({'contentHash': req['contentHash']} for req in scenario['required']),
                                  key=lambda req: req['contentHash'])
        view['conditional'] = sorted(({'contentHash': req['contentHash'], 'trigger': req['trigger']} for req in scenario['conditional']),
                                     key=lambda req: (req['contentHash'], req['trigger']))
        scenarios.append(view)
    view = {'kind': 'contract', 'version': 1, 'entry': suite['entry'], 'scenarios': sorted(scenarios, key=lambda s: s['id'])}
    if suite.get('entryInjected'):
        view['entryInjected'] = True
    return _hash(view)


def load_suite(value):
    """Accept a bare suite or a freeze report whose status is pass (uses .suite)."""
    if isinstance(value, dict) and 'kind' in value:
        if value.get('kind') != 'freeze' or type(value.get('version')) is not int or value['version'] != 1:
            raise InvalidInput('Use a suite version: 1 or a freeze report version: 1 in --suite.')
        if value.get('status') != 'pass':
            raise InvalidInput('Freeze report not approved (status other than pass); resolve the findings and freeze again.')
        suite = validate_suite(value.get('suite'))
        identity = contract_hash(suite)
        if value.get('suiteHash') != _hash(suite) or identity is None or value.get('contractHash') != identity:
            raise InvalidInput('Inconsistent freeze report: the hashes do not match the suite, or a requirement has no contentHash.')
        return suite
    return validate_suite(value)


def _finding(code, message, severity='error', **details):
    return {'code': code, 'severity': severity, 'message': message, **details}


def _status(findings):
    if any(f['severity'] == 'error' for f in findings):
        return 'fail'
    if any(f['severity'] == 'incomplete' for f in findings):
        return 'inconclusive'
    return 'pass'


def _active(scenario):
    return scenario['required'] + [r for r in scenario['conditional'] if r['trigger'] in scenario['triggers']]


def _snapshot_lines(snapshot):
    """Verify every document's hash/size and return its line model and hashes."""
    documents = snapshot['documents']
    if len(documents) > 10000:
        raise InvalidInput('The snapshot exceeds the document limit.')
    lines, hashes = {}, {}
    for path, document in documents.items():
        _path(path)
        if not isinstance(document, dict) or not isinstance(document.get('text'), str):
            raise InvalidInput('Invalid document in the snapshot.')
        encoded = document['text'].encode('utf-8')
        digest = hashlib.sha256(encoded).hexdigest()
        if document.get('sha256') != digest or document.get('bytes') != len(encoded):
            raise InvalidInput('Inconsistent document hash or size in the snapshot.')
        lines[path] = document_lines(document['text'])
        hashes[path] = digest
    return lines, hashes


def _checked_snapshot(snapshot, suite):
    if not isinstance(snapshot, dict) or snapshot.get('entry') != suite['entry'] or not isinstance(snapshot.get('documents'), dict):
        raise InvalidInput('Invalid snapshot, or an entry incompatible with the suite.')
    return _snapshot_lines(snapshot)


def _completeness(snapshot):
    """Snapshot loss findings and whether absence of content is conclusive."""
    findings = []
    documents = snapshot['documents']
    if snapshot.get('scanPartial'):
        findings.append(_finding('scan-partial', 'The scanner left content without analysis; the observation is incomplete.', 'incomplete'))
    # Only explicit, policy-matching exclusions can be distinguished from loss.
    # A snapshot without that metadata, or with malformed metadata, stays conservatively incomplete.
    exclusions = snapshot.get('excludedPolicy', [])
    excluded_paths = set()
    if isinstance(exclusions, list):
        for excluded in exclusions:
            if not isinstance(excluded, dict) or excluded.get('reason') != 'sensitive-path':
                excluded_paths.clear()
                break
            try:
                path = _path(excluded.get('path'))
            except ValueError:
                excluded_paths.clear()
                break
            if path in documents or path in excluded_paths or not policy_excluded_path(path):
                excluded_paths.clear()
                break
            excluded_paths.add(path)
    omitted = snapshot.get('omitted', 0)
    if type(omitted) is not int or omitted < 0:
        raise InvalidInput('Invalid count of omissions in the snapshot.')
    if len(excluded_paths) > omitted:
        excluded_paths.clear()
    if excluded_paths:
        findings.append(_finding('policy-excluded', 'Files outside the reading policy were excluded; approval covers only the allowed corpus.', 'warning', count=len(excluded_paths)))
    if omitted > len(excluded_paths):
        findings.append(_finding('snapshot-partial', 'The snapshot omitted allowed documents; the observation is partial.', 'incomplete', count=omitted - len(excluded_paths)))
    return findings, bool(snapshot.get('scanPartial')) or omitted > len(excluded_paths)


class _Relocator:
    """Find where an exact line sequence lives now, knowing only its hash and length.

    Each window length is indexed once (hash -> places), so many requirements
    share one pass. Canaries are virtual documents and never hold requirements.
    """
    def __init__(self, snapshot, lines, complete):
        self.lines = {path: value for path, value in lines.items() if snapshot['documents'][path].get('canary') is not True}
        self.complete = complete
        self.indexes = {}
        self.windows = RELOCATION_MAX_WINDOWS
        self.bytes = RELOCATION_MAX_BYTES

    def _index(self, count):
        if count not in self.indexes:
            index, complete = {}, True
            for path in sorted(self.lines):
                lines = self.lines[path]
                if len(lines) < count:
                    continue
                sizes = [0]
                for line in lines:
                    sizes.append(sizes[-1] + len(line.encode('utf-8')))
                for start in range(1, len(lines) - count + 2):
                    cost = sizes[start - 1 + count] - sizes[start - 1]
                    if self.windows < 1 or self.bytes < cost:
                        complete = False
                        break
                    self.windows -= 1
                    self.bytes -= cost
                    index.setdefault(excerpt_sha256(lines, start, start + count - 1), []).append((path, start))
                if not complete:
                    break
            self.indexes[count] = (index, complete)
        return self.indexes[count]

    def find(self, req):
        count = req['endLine'] - req['startLine'] + 1
        index, complete = self._index(count)
        places = [{'path': path, 'startLine': start, 'endLine': start + count - 1} for path, start in index.get(req['contentHash'], [])]
        return places, complete and self.complete

    def details(self, req):
        places, complete = self.find(req)
        return {'relocated': places[:MAX_RELOCATIONS], 'relocatedTotal': len(places), 'relocationComplete': complete}


def _requirement_state(req, lines):
    """(available, identity) where identity is None (unbound), True or False."""
    available = req['path'] in lines and req['endLine'] <= len(lines[req['path']])
    if 'contentHash' not in req:
        return available, None
    return available, available and excerpt_sha256(lines[req['path']], req['startLine'], req['endLine']) == req['contentHash']


def _range(req):
    return {key: req[key] for key in ('path', 'startLine', 'endLine')}


STALE_MESSAGE = 'The current content of the range differs from the frozen contentHash; the requirement no longer designates the required excerpt. Review it and use freeze --relocate or --rebind.'
UNAVAILABLE_MESSAGE = 'Required range missing from the snapshot.'
UNBOUND_MESSAGE = 'Requirements without contentHash: a shift or an edit of the excerpt is not detected. Use freeze to bind them to the content.'
ALWAYS_LOADED_MESSAGE = 'The entry file exceeds the budget of always-loaded bytes declared in the scenario.'
ENTRY_UNAVAILABLE_MESSAGE = 'Entry file missing from the snapshot; the always-loaded bytes cannot be measured.'


def _always_loaded(snapshot, lines, entry):
    return snapshot['documents'][entry]['bytes'] if entry in lines else None


def suite_static_findings(snapshot, suite):
    """Read-free suite checks against a snapshot, for every scenario.

    Returns requirement-unavailable/requirement-stale per active requirement,
    one requirement-unbound per scenario with unbound active requirements,
    always-loaded-budget-exceeded per scenario and entry-unavailable once.
    Every finding about a scenario carries scenarioId.
    """
    suite = validate_suite(suite)
    lines, _ = _checked_snapshot(snapshot, suite)
    _, partial = _completeness(snapshot)
    relocator = _Relocator(snapshot, lines, not partial)
    always = _always_loaded(snapshot, lines, suite['entry'])
    findings = []
    for scenario in suite['scenarios']:
        unbound = 0
        for req in _active(scenario):
            available, identity = _requirement_state(req, lines)
            unbound += identity is None
            details = relocator.details(req) if identity is False else {}
            if not available:
                findings.append(_finding('requirement-unavailable', UNAVAILABLE_MESSAGE, 'incomplete', scenarioId=scenario['id'], **req, **details))
            elif identity is False:
                findings.append(_finding('requirement-stale', STALE_MESSAGE, 'incomplete', scenarioId=scenario['id'], **req, **details))
        if unbound:
            findings.append(_finding('requirement-unbound', UNBOUND_MESSAGE, 'warning', scenarioId=scenario['id'], count=unbound))
        if 'maxAlwaysLoadedBytes' in scenario and always is not None and always > scenario['maxAlwaysLoadedBytes']:
            findings.append(_finding('always-loaded-budget-exceeded', ALWAYS_LOADED_MESSAGE, scenarioId=scenario['id'],
                                     path=suite['entry'], actual=always, maximum=scenario['maxAlwaysLoadedBytes']))
    if always is None:
        findings.append(_finding('entry-unavailable', ENTRY_UNAVAILABLE_MESSAGE, 'incomplete', path=suite['entry']))
    return {'findings': findings, 'alwaysLoadedBytes': always}


def freeze(snapshot, suite, relocate=False, rebind=False):
    """Bind or verify every requirement's contentHash, including inactive ones.

    --relocate moves a stale requirement only to the single identical place in a
    complete snapshot; --rebind accepts the current range content afterwards.
    """
    suite = validate_suite(suite)
    lines, hashes = _checked_snapshot(snapshot, suite)
    _, partial = _completeness(snapshot)
    relocator = _Relocator(snapshot, lines, not partial)
    result = copy.deepcopy(suite)
    changes, findings = [], []
    for scenario in result['scenarios']:
        for group in ('required', 'conditional'):
            for index, req in enumerate(scenario[group]):
                where = {'scenarioId': scenario['id'], 'list': group, 'index': index}
                available, identity = _requirement_state(req, lines)
                if identity is None and available:
                    req['contentHash'] = excerpt_sha256(lines[req['path']], req['startLine'], req['endLine'])
                    changes.append({**where, 'action': 'bound', 'to': {'contentHash': req['contentHash']}})
                    continue
                if identity is None:
                    findings.append(_finding('requirement-unavailable', UNAVAILABLE_MESSAGE, 'incomplete', **where, **req))
                    continue
                if identity:
                    continue
                details = relocator.details(req)
                if relocate and details['relocationComplete'] and details['relocatedTotal'] == 1:
                    previous, target = _range(req), details['relocated'][0]
                    req.update(target)
                    try:
                        validate_suite(result)
                    except ValueError:
                        # A relocation must never produce a contradictory contract.
                        req.update(previous)
                        details['relocationRejected'] = 'contradiction'
                    else:
                        changes.append({**where, 'action': 'relocated', 'from': previous, 'to': dict(target)})
                        continue
                if rebind and available:
                    current = excerpt_sha256(lines[req['path']], req['startLine'], req['endLine'])
                    changes.append({**where, 'action': 'rebound', 'from': {'contentHash': req['contentHash']}, 'to': {'contentHash': current}})
                    req['contentHash'] = current
                    continue
                code, message = ('requirement-stale', STALE_MESSAGE) if available else ('requirement-unavailable', UNAVAILABLE_MESSAGE)
                findings.append(_finding(code, message, 'incomplete', **where, **req, **details))
    result = validate_suite(result)
    return {'version': 1, 'kind': 'freeze', 'status': _status(findings), 'suite': result, 'suiteHash': _hash(result),
            'contractHash': contract_hash(result), 'entry': result['entry'], 'snapshotHash': _hash(hashes),
            'snapshotPartial': partial, 'changes': changes, 'findings': findings,
            'limitations': ['contentHash binds the requirement to the exact bytes of the range; it does not judge whether the excerpt is the right oracle for the task.',
                            'Relocation needs the same sequence of lines in exactly one place of a complete snapshot; it never guesses edited excerpts.',
                            '--rebind accepts the current content without reviewing it: check the range before using the resulting suite.']}
