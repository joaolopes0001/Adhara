"""App-owned state (projects, notes, marks, the roots where editing is enabled) and transactional creation of new
architecture directories."""
import errno
import json
import os
import re
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

from creation_texts import DEFAULT_LANGUAGE, LANGUAGES, TEXTS
from scanner import DIRECTORY_FLAGS, MAX_ROOTS, extract, kind as file_kind, open_regular_file, pinned_directory, scan, within
import delta as readings
import editing
import expected as marks
from protected import MESSAGE as PROTECTED_MESSAGE, contains, default_state_dir, is_protected, protected_paths
from texts import is_text, of, plural, restored, say, unwire, wire

TYPES = {'agent', 'memory', 'tool', 'policy', 'workflow', 'document'}
# Paths of `stats.inventory.entriesOmitted` sent to the interface, which shows only the count;
# the CLI keeps all of them.
ENTRIES_OMITTED_SHOWN = 20
# Field of workspace.json with the last refused update of a saved reference per root (see `Workspace._persist`).
REFUSALS = 'referenceRefusals'
# Field of workspace.json with the roots where the user enabled editing: {root: {at, dev, ino}}.
EDITING = 'editing'


def _inside(path, root):
    """Whether the absolute `path` (a note key) is `root` or below it; lexical, like the ids of the reading."""
    return path == root or path.startswith(root if root.endswith('/') else root + '/')


def interface_stats(stats):
    """`stats` with `inventory.entriesOmitted.paths` cut to its first ENTRIES_OMITTED_SHOWN (`count` stays the total)."""
    omitted = stats['inventory'].get('entriesOmitted')
    if not omitted or len(omitted['paths']) <= ENTRIES_OMITTED_SHOWN:
        return stats
    inventory = {**stats['inventory'], 'entriesOmitted': {**omitted, 'paths': omitted['paths'][:ENTRIES_OMITTED_SHOWN]}}
    return {**stats, 'inventory': inventory}


def state_problem(directory, exc):
    """Why the app state could not be written, naming the state directory."""
    reason = (say('the directory does not exist') if exc.errno == errno.ENOENT
              else readings._cause(exc) if exc.errno else say('write failure'))
    return say('Could not write to the state directory of the app ({directory}): {reason}.', directory=directory, reason=reason)


def _refusals(value):
    """The valid entries of `referenceRefusals` in a loaded state: {root: {'reason': text, 'file': sha256, 'phrase'?}}.

    `phrase` is the reason as `texts.wire` writes it, so that the warning a restart brings back is worded in the
    language of the interface; an entry without one, or with an invalid one, keeps the reason as it was saved.
    """
    if not isinstance(value, dict):
        return {}
    return {root: {'reason': item['reason'], 'file': item['file'], **({'phrase': item['phrase']} if unwire(item.get('phrase')) is not None else {})}
            for root, item in value.items()
            if isinstance(root, str) and isinstance(item, dict) and isinstance(item.get('reason'), str)
            and len(item['reason']) <= 2000 and isinstance(item.get('file'), str) and readings.HEX64.fullmatch(item['file'])}


def _grants(value):
    """(valid grants, how many were dropped) of `editing` in a loaded state: {root: {'at': text, 'dev': int, 'ino': int}}.

    A grant is never repaired: a root that is not absolute and canonical, or a field of the wrong type, drops it.
    """
    if value is None:
        return {}, 0
    if not isinstance(value, dict):
        return {}, 1
    valid = {}
    for root, item in value.items():
        if (isinstance(root, str) and '\x00' not in root and os.path.isabs(root) and os.path.normpath(root) == root
                and isinstance(item, dict) and isinstance(item.get('at'), str) and len(item['at']) <= 64
                and all(type(item.get(field)) is int and item[field] >= 0 for field in ('dev', 'ino'))):
            valid[root] = {'at': item['at'], 'dev': item['dev'], 'ino': item['ino']}
    return valid, len(value) - len(valid)


def _grants_message(dropped):
    return plural(dropped, 'An invalid editing permission in the saved state was ignored.',
                  '{count} invalid editing permissions in the saved state were ignored.')


class StateWriteError(OSError):
    """A failed write of the app state; `message` says so and names the state directory."""

    def __init__(self, directory, cause):
        super().__init__(cause.errno, cause.strerror)
        self.message = state_problem(directory, cause)


class Workspace:
    def __init__(self, state_dir):
        self.state_dir = Path(state_dir).expanduser().resolve()
        self._guard_state()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.state_file = self.state_dir / 'workspace.json'
        self.restore_errors = []
        try:
            state = json.loads(self.state_file.read_text(encoding='utf-8'))
        except OSError:
            state = {}
        except (ValueError, RecursionError):
            self.restore_errors.append(say('Could not parse the saved state.'))
            state = {}
        if not isinstance(state, dict):
            self.restore_errors.append(say('Invalid saved state; no folder was restored.'))
            state = {}
        roots = self._restore_paths(state.get('roots', []))
        saved = self._restore_paths(state.get('savedCases', []))
        notes = state.get('notes', {})
        expected, report = marks.restore(state.get('expected'))
        self.restore_errors.extend(marks.restore_messages(report))
        self.state = {**state, 'roots': roots, 'savedCases': list(dict.fromkeys(saved + roots)),
                      'notes': {key: value for key, value in notes.items() if isinstance(value, str)} if isinstance(notes, dict) else {},
                      'expected': expected}
        # An invalid refusal is dropped: it only brings back a warning.
        refusals = _refusals(state.get(REFUSALS))
        self.state.pop(REFUSALS, None)
        if refusals:
            self.state[REFUSALS] = refusals
        # Roots where editing was enabled: an invalid entry is dropped with a warning, never kept as it was.
        grants, dropped = _grants(state.get(EDITING))
        self.state.pop(EDITING, None)
        if grants:
            self.state[EDITING] = grants
        if dropped:
            self.restore_errors.append(_grants_message(dropped))
        valid, errors = self._available_roots(roots)
        self.restore_errors.extend(errors)
        self.state['roots'] = valid
        self.model = scan(valid)
        # References per root are saved in the state directory: restored cases compare with them already.
        self.store = readings.ReferenceStore(self.state_dir)
        self.references, self.current, self.delta, self.reference_status = {}, {}, None, {}
        self._take(self._reading(self.model))

    def _restore_paths(self, values):
        if not isinstance(values, list):
            self.restore_errors.append(say('Invalid saved list of folders.'))
            return []
        paths = []
        for value in values:
            try:
                path = self._path(value)
            except (OSError, ValueError):
                self.restore_errors.append(say('Invalid saved path ignored.'))
                continue
            if path not in paths:
                paths.append(path)
        return paths

    @staticmethod
    def _path(value, strict=False):
        if not isinstance(value, str) or not value.strip() or '\x00' in value:
            raise ValueError(say('Give a valid folder path.'))
        try:
            path = Path(value).expanduser()
            return str(path.resolve(strict=True)) if strict else os.path.abspath(path)
        except RuntimeError as exc:
            raise ValueError(say('Invalid folder path.')) from exc

    @staticmethod
    def _available(path):
        try:
            candidate = Path(path)
            return candidate.is_dir() and candidate.resolve(strict=True) == candidate
        except (OSError, RuntimeError):
            return False

    def _available_roots(self, roots):
        valid, errors = [], []
        for root in roots:
            if not self._available(root):
                errors.append(say('Folder unavailable: {path}', path=root))
            elif len(valid) >= MAX_ROOTS:
                errors.append(say('Limit of {max} open folders; project kept in the list: {path}', max=MAX_ROOTS, path=root))
            else:
                valid.append(root)
        return valid, errors

    def _guard_state(self):
        """Refuses to write the state if it is protected or if the configuration is broken (fails closed)."""
        if is_protected(self.state_dir):
            raise ValueError(say('The app state cannot be kept here. {reason}', reason=PROTECTED_MESSAGE))

    def save(self, state=None):
        self._guard_state()
        state = self.state if state is None else state
        try:
            fd, temp = tempfile.mkstemp(prefix='.workspace-', dir=self.state_dir)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as out:
                    json.dump(state, out, ensure_ascii=False, indent=2)
                os.replace(temp, self.state_file)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
        except OSError as exc:
            raise StateWriteError(self.state_dir, exc) from exc

    def _annotated(self):
        """(issues, signals, facts) of the current model with stable keys; computed once per model."""
        if getattr(self, '_annotation', (None,))[0] is not self.model:
            self._annotation = (self.model, *marks.annotate(self.model))
        return self._annotation[1:]

    def snapshot(self):
        issues, signals, _ = self._annotated()
        opened = [root['path'] for root in self.model['roots']]
        return {**self.model, 'issues': issues, 'signals': signals, 'stats': interface_stats(self.model['stats']),
                'notes': self.state.get('notes', {}), 'restoreErrors': self.restore_errors,
                'savedCases': [{'path': path, 'name': Path(path).name or path, 'available': self._available(path),
                                'notes': sum(1 for key in self._own_notes(path) if self.state['notes'][key])}
                               for path in self.state['savedCases']],
                'expected': self._expected(opened), 'editing': self._editing(), 'delta': self.delta}

    def _own_notes(self, path):
        """Keys of the notes of saved project `path` alone: on its files, but not on a file that also lies inside
        another saved project (a parent or a nested one), which keeps it. What forgetting with `notes` erases."""
        others = [case for case in self.state['savedCases'] if case != path]
        return [key for key in self.state.get('notes', {})
                if _inside(key, path) and not any(_inside(key, other) for other in others)]

    def _expected(self, opened):
        stored = self.state.get('expected', {})
        return {root: stored[root] for root in opened if stored.get(root)}

    def _editing(self):
        """The grants of the opened roots whose editing is not refused now: {root: {at}}."""
        return editing.honored(self.model, self.state.get(EDITING, {}), self._state_dirs())

    def _state_dirs(self):
        return [self.state_dir, default_state_dir()]

    def enable_editing(self, root):
        """Enable editing on the opened `root` until it is disabled or the project forgotten; returns {editing}.

        Only the app state changes. Enabling again replaces the grant, with the identity of the folder there now.
        """
        record = editing.grant(self.model, root, self._state_dirs())
        state = {**self.state, EDITING: {**self.state.get(EDITING, {}), root: {'at': readings.now(), **record}}}
        self.save(state)
        self.state = state
        return {'editing': self._editing()}

    def disable_editing(self, root):
        """Disable editing on `root`, opened or not; disabling what is not enabled is harmless and writes nothing."""
        if not isinstance(root, str):
            raise editing.Refusal('not-in-workspace', say('Give the path of a project.'))
        grants = self.state.get(EDITING, {})
        if root in grants:
            state = {key: value for key, value in self.state.items() if key != EDITING}
            rest = {key: value for key, value in grants.items() if key != root}
            if rest:
                state[EDITING] = rest
            self.save(state)
            self.state = state
        return {'editing': self._editing()}

    def edit_read(self, path):
        """Text of a document for editing, under the grant that applies to it (`editing.granting_root`)."""
        root = editing.granting_root(self.model, self.state.get(EDITING, {}), path)
        return editing.read_for_edit(self.model, root, path, self._state_dirs())

    def edit_save(self, path, base_sha256, text):
        """Save a document under the grant that applies to it; the core refuses unless the disk still has `base_sha256`.

        Takes the workspace lock itself, once per attempt; the caller must not hold it, or the other routes wait
        too. While another program (or another instance of the app) holds the folder lock, the workspace lock is
        released between attempts, so the other routes go on, and each attempt is a whole one: grant, model,
        protection and disk are checked again from the start. Up to `editing.LOCK_WAIT` seconds in all, with an
        interval that doubles from `editing.LOCK_RETRY` up to `editing.LOCK_RETRY_MAX`: many saves waiting in a
        large project would otherwise keep a core busy repeating whole attempts.
        """
        deadline = time.monotonic() + editing.LOCK_WAIT
        interval = editing.LOCK_RETRY
        while True:
            with self.lock:
                root = editing.granting_root(self.model, self.state.get(EDITING, {}), path)
                try:
                    return editing.save(self.model, root, path, base_sha256, text, self._state_dirs())
                except editing.FolderBusy:
                    if time.monotonic() >= deadline:
                        raise
            time.sleep(max(0.0, min(interval, deadline - time.monotonic())))
            interval = min(interval * 2, editing.LOCK_RETRY_MAX)

    def _reading(self, model):
        """(references, current, delta, fresh) for a new scan, without mutating the workspace or the disk.

        At the first reading of a root in this server process, its saved reference
        is loaded when valid (origin `persisted`, original time); otherwise this
        reading becomes the reference and is saved after the commit. Closing and
        reopening the root keeps it. Only `adopt_reference` advances it.
        `fresh` holds the store status of the roots whose reference was set here.
        """
        current = readings.read(model, readings.now())
        references, fresh = dict(self.references), {}
        for root, compact in current.items():
            if root in references:
                continue
            saved, problem, digest = self.store.load_file(root)
            if saved is not None:
                # Saved by other rules of reading: relations and findings may differ with no file changed.
                warnings = [] if saved['reader'] == readings.READER else [{'code': 'reference-reader-changed', 'message': readings.READER_CHANGED}]
                # An update of this root was refused while this very file was saved: it is the reference from before.
                # Any save since then wrote another file (`savedAt` changes), so a refusal left over never matches.
                refused = self.state.get(REFUSALS, {}).get(root)
                if refused and refused['file'] == digest:
                    warnings.append({'code': 'reference-update-not-saved', 'message':
                        say('The last update of this baseline was not saved in the state directory of the app ({directory}): '
                            '{reason}. The comparison uses the baseline saved before it; this warning leaves when a new baseline is saved.',
                            directory=self.state_dir, reason=restored(refused['reason'], refused.get('phrase')))})
                references[root], fresh[root] = saved, {'saved': True, 'warnings': warnings}
                continue
            references[root] = {**compact, 'origin': 'first-reading'}
            fresh[root] = {'saved': None, 'warnings': [{'code': 'reference-ignored', 'message':
                say('Saved baseline ignored: {reason}. This scan became the baseline.', reason=problem)}] if problem else []}
        return references, current, readings.compare(references, current, model), fresh

    def _take(self, reading):
        self.references, self.current, self.delta, fresh = reading
        self.reference_status.update(fresh)
        self._persist([root for root, status in fresh.items() if status['saved'] is None])

    def _persist(self, roots, update=False):
        """Save the references of `roots`; a failure keeps them in memory and becomes a warning of the delta.

        `update`: the user advanced the references (`adopt_reference`). A refused update leaves the earlier saved
        reference in place, which a restart brings back: the refusal is kept in the app state with the identity of
        that file, so the reference loaded then says why (`_reading`). Only an update writes the app state here.
        """
        store = Path(self.store.directory)
        # The app never writes inside an inspected root, even when it holds the state directory.
        inside = any(within(store, Path(root['path'])) for root in self.model['roots'])
        try:
            self._guard_state()
            blocked = None
        except ValueError as exc:
            blocked = of(exc)
        refusals, back = dict(self.state.get(REFUSALS, {})), {}
        for root in roots:
            problem = (say('the state directory is inside an open folder, where the app does not write')
                       if inside else blocked or self.store.save(root, self.references[root]))
            self.reference_status[root]['saved'] = problem is None
            refusals.pop(root, None)
            if problem is None:
                continue
            # What a restart would load: a valid earlier file comes back; otherwise the first reading is the reference.
            earlier, _, digest = self.store.load_file(root) if update else (None, None, None)
            if earlier is not None:
                back[root] = True
                refusals[root] = {'reason': str(problem), 'file': digest, **({'phrase': wire(problem)} if is_text(problem) else {})}
            self.reference_status[root]['warnings'].append({'code': 'reference-not-saved', 'message':
                say('Baseline not saved in the state directory of the app ({directory}): {reason}. '
                    'It holds only until the server restarts.', directory=self.state_dir, reason=problem)})
        kept = self._keep_refusals(refusals, write=update and not inside and blocked is None)
        for root in back:
            warning = self.reference_status[root]['warnings'][-1]
            warning['message'] = (
                say('{warning} Afterwards, the comparison goes back to the baseline saved before, with a warning.', warning=warning['message']) if kept else
                say('{warning} Afterwards, the comparison goes back to the baseline saved before, without a warning: '
                    'the reason could not be kept in the app state.', warning=warning['message']))
        readings.annotate(self.delta, self.reference_status)

    def _keep_refusals(self, refusals, write):
        """`refusals` in the app state; whether the state on disk holds them.

        Without `write`, only entries that no longer apply are dropped, in memory: the next save of the state writes
        it. A refusal that remains on disk is harmless, since it names a file that a later save replaced.
        """
        if refusals == self.state.get(REFUSALS, {}):
            return True
        state = {key: value for key, value in self.state.items() if key != REFUSALS}
        if refusals:
            state[REFUSALS] = refusals
        if not write:
            self.state = state  # only removals: without an update no refusal is added
            return False
        try:
            self.save(state)
        except (OSError, ValueError):
            return False
        self.state = state
        return True

    def adopt_reference(self):
        """Use the current reading of every opened root as its reference (explicit user action) and save it."""
        if not self.current:
            raise ValueError(say('Open a folder before setting the baseline.'))
        references = {**self.references, **{root: {**compact, 'origin': 'user'} for root, compact in self.current.items()}}
        self.references, self.delta = references, readings.compare(references, self.current, self.model)
        # A new reference replaces the warnings about the one it replaces.
        self.reference_status.update({root: {'saved': None, 'warnings': []} for root in self.current})
        self._persist(list(self.current), update=True)
        return self.snapshot()

    def _commit(self, model, saved, errors=None, changes=None):
        state = {**self.state, 'roots': [r['path'] for r in model['roots']], 'savedCases': saved, **(changes or {})}
        for field in (REFUSALS, EDITING):
            if field in state and not state[field]:
                del state[field]
        # Only a new scan is a new reading; forgetting a closed case keeps the delta.
        reading = self._reading(model) if model is not self.model else None
        self.save(state)
        self.state, self.model = state, model
        if reading is not None:
            self._take(reading)
        self.restore_errors = [] if errors is None else errors
        return self.snapshot()

    def open(self, path, replace=False):
        if not isinstance(replace, bool):
            raise ValueError(say('The option to replace the project must be a boolean.'))
        path = self._path(path, strict=True)
        previous, errors = self._available_roots([] if replace else [r['path'] for r in self.model['roots']])
        roots = list(dict.fromkeys(previous + [path]))
        model = scan(roots)
        saved = list(dict.fromkeys(self.state['savedCases'] + [path]))
        return self._commit(model, saved, errors)

    def close(self, path):
        path = self._path(path)
        roots = [r['path'] for r in self.model['roots'] if r['path'] != path]
        roots, errors = self._available_roots(roots)
        return self._commit(scan(roots), self.state['savedCases'], errors)

    def forget(self, path, notes=False, close=False):
        """Take a saved project out of the app: off the saved list, with its Changes baseline, its marks of
        "expected" and its editing permission. Nothing inside the project folder is touched.

        `close`: an open project is closed in the same step (otherwise it is refused).
        `notes`: its notes are erased too (`_own_notes`); without it they stay in the app state and come back
        when the same folder is added again.
        """
        if not isinstance(notes, bool):
            raise ValueError(say('The option to erase the notes must be a boolean.'))
        if not isinstance(close, bool):
            raise ValueError(say('The option to close the project must be a boolean.'))
        path = self._path(path)
        opened = [r['path'] for r in self.model['roots']]
        model, errors = self.model, None
        if path in opened:
            if not close:
                raise ValueError(say('Close the project before removing it from the saved list.'))
            roots, errors = self._available_roots([root for root in opened if root != path])
            model = scan(roots)
        expected = {root: entries for root, entries in self.state.get('expected', {}).items() if root != path}
        changes = {'expected': expected}
        if notes:
            erased = set(self._own_notes(path))
            changes['notes'] = {key: body for key, body in self.state['notes'].items() if key not in erased}
        # The refusal of a forgotten case goes with its reference.
        if path in self.state.get(REFUSALS, {}):
            changes[REFUSALS] = {root: item for root, item in self.state[REFUSALS].items() if root != path}
        # Forgetting also disables editing in the project; closing keeps it enabled.
        if path in self.state.get(EDITING, {}):
            changes[EDITING] = {root: item for root, item in self.state[EDITING].items() if root != path}
        snapshot = self._commit(model, [saved for saved in self.state['savedCases'] if saved != path], errors, changes)
        self.references.pop(path, None)
        self.reference_status.pop(path, None)
        problem = self.store.delete(path)
        if problem is None:
            return snapshot
        self.restore_errors = [say('Project forgotten, but its saved baseline was not deleted from the state directory '
                                   'of the app ({directory}: {reason}): {path}', directory=self.state_dir, reason=problem, path=path)]
        return self.snapshot()

    def refresh(self):
        roots, errors = self._available_roots([r['path'] for r in self.model['roots']])
        return self._commit(scan(roots), self.state['savedCases'], errors)

    def reorder(self, order):
        """Persist the new order of the opened roots; only an exact permutation of the opened ones is accepted.

        Reads the disk again (like `refresh`) rather than reordering the model in memory: the order of the
        roots defines the order of the nodes, of the `roots` of each node and of the findings, and a model
        reordered by hand would differ from what `scan` gives for the same order. The saved list
        (`savedCases`) does not change: it is the library, with its own order, that of opening.
        """
        current = [r['path'] for r in self.model['roots']]
        if not isinstance(order, list) or not all(isinstance(item, str) for item in order):
            raise ValueError(say('Give the ordered list of the paths of the open roots.'))
        for item in order:
            if not item.strip() or '\x00' in item or not os.path.isabs(item):
                raise ValueError(say('Invalid root path (use the absolute path of an open root): {path}', path=repr(item[:200])))
        if len(set(order)) != len(order):
            raise ValueError(say('The new order repeats a root.'))
        extra = [item for item in order if item not in current]
        if extra:
            raise ValueError(say('The new order names a folder that is not open: {path}', path=extra[0]))
        missing = [item for item in current if item not in order]
        if missing:
            raise ValueError(say('The new order leaves out an open root: {path}', path=missing[0]))
        if order == current:
            return self.snapshot()
        roots, errors = self._available_roots(order)
        return self._commit(scan(roots), self.state['savedCases'], errors)

    def note(self, node, body):
        if node not in {n['id'] for n in self.model['nodes']}:
            raise ValueError(say('File outside the workspace.'))
        if not isinstance(body, str) or len(body) > 20000:
            raise ValueError(say('A note must have up to 20,000 characters.'))
        state = {**self.state, 'notes': {**self.state['notes'], node: body}}
        self.save(state)
        self.state = state
        return {'saved': True}

    def expect(self, root, key, expected=True, reason=''):
        """Mark (or unmark) one observation of an opened root as expected; only the app state changes.

        Marking needs the observation in the current reading (or an existing mark, whose reason
        is updated); unmarking a key that is not marked is harmless. Returns the marks of the
        opened roots.
        """
        opened = [item['path'] for item in self.model['roots']]
        expected, reason = marks.validate(root, key, expected, reason, opened)
        stored = self.state.get('expected', {})
        entries = dict(stored.get(root, {}))
        if expected:
            facts = self._annotated()[2].get(root, {})
            fact = facts.get(key)
            if fact is None and key not in entries:
                raise ValueError(say('Observation not found in the current scan of this project. Rescan the projects and try again.'))
            if key not in entries and len(entries) >= marks.MAX_PER_ROOT:
                raise ValueError(marks.limit_message(sum(stored_key not in facts for stored_key in entries)))
            described = fact or {field: entries[key][field] for field in ('code', 'path', 'target')}
            entries[key] = {**described, 'reason': reason, 'at': readings.now()}
        elif key in entries:
            del entries[key]
        else:
            return {'expected': self._expected(opened)}
        changed = {**stored, root: entries}
        if not entries:
            del changed[root]
        state = {**self.state, 'expected': changed}
        self.save(state)
        self.state = state
        return {'expected': self._expected(opened)}

    def content(self, node):
        record = next((n for n in self.model['nodes'] if n['id'] == node), None)
        if not record or record['status'] != 'resolved' or record['kind'] == 'directory':
            raise ValueError(say('This item is not an available local file.'))
        path = Path(node)
        resolved = path.resolve(strict=True)
        if resolved != path or not any(within(resolved, Path(r['path'])) for r in self.model['roots']):
            raise ValueError(say('Target changed or outside the workspace. Rescan the folder.'))
        with open_regular_file(path) as stream:
            data = stream.read(1024 * 1024 + 1)
        if b'\x00' in data:
            raise ValueError(say('Binary file. The preview is available for text files.'))
        return {'text': data[:1024 * 1024].decode('utf-8', errors='replace'), 'truncated': len(data) > 1024 * 1024}


VERBS = ('references', 'reads', 'uses', 'governs')
# A description is one line of the Map of the entry file, the line that says when to open the file.
DESCRIPTION_MAX = 200
# Backticks, brackets and the HTML signs would make reference syntax; `@path` is an import in an AGENTS.md.
DESCRIPTION_FORBIDDEN = frozenset('`[]<>@')
# Kinds of file the reader treats specially by name (scanner.kind): a node file of one of these kinds would be a
# second entry file in a subfolder (which a harness may also load as that folder's instructions) or a skill, which
# makes a logical object nobody drew. The reader decides, with its own spelling (case-sensitive), as for descriptions.
RESERVED_KINDS = {'entry': say('entry file'), 'skill': 'skill', 'manifest': say('manifest')}
# Unicode categories refused in a description: controls, line and paragraph separators and lone surrogates (which a
# JSON body may carry; the preview would show them and the creation could not write them as UTF-8).
DESCRIPTION_CATEGORIES = ('Cc', 'Zl', 'Zp', 'Cs')


def _description(item, slug, pointer):
    """The trimmed description of a node, or ValueError. `pointer` is the start of its Map line."""
    text = item.get('description', '')
    if not isinstance(text, str):
        raise ValueError(say('Description of {name}: it must be text.', name=slug))
    text = text.strip()
    if len(text) > DESCRIPTION_MAX:
        raise ValueError(say('Description of {name}: use up to {max} characters.', name=slug, max=DESCRIPTION_MAX))
    if any(ord(c) in marks.BIDI or unicodedata.category(c) in DESCRIPTION_CATEGORIES for c in text):
        raise ValueError(say('Description of {name}: use a single line, without control characters.', name=slug))
    if any(c in DESCRIPTION_FORBIDDEN for c in text):
        raise ValueError(say('Description of {name}: do not use backticks, brackets, @ or the signs < and >.', name=slug))
    # The reader decides: the Map line may hold one reference, the link of its own pointer.
    if text and len(list(extract(pointer + text, '.md'))) != 1:
        raise ValueError(say('Description of {name}: do not write a file path; '
                             'to link to another file, create a relation.', name=slug))
    return text


def blueprint(payload):
    """{relative path: text} of a new architecture: the nodes in form order, then AGENTS.md and CLAUDE.md.

    Only Markdown: the links are the one source of the relations (no manifest is written). The texts come
    from creation_texts in the requested language; the user's descriptions are concatenated, never passed
    through a template replacement.
    """
    if not isinstance(payload, dict):
        raise ValueError(say('JSON object expected.'))
    name = payload.get('name', '')
    if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', name):
        raise ValueError(say('Folder name: use letters, numbers, hyphen or underscore (up to 80 characters).'))
    language = payload.get('language', DEFAULT_LANGUAGE)
    if not isinstance(language, str) or language not in LANGUAGES:
        raise ValueError(say('Invalid language of the starting text: use "en" or "pt".'))
    texts = TEXTS[language]
    primitives = payload.get('primitives', [])
    relations = payload.get('relationships', [])
    if not isinstance(primitives, list) or not 1 <= len(primitives) <= 40:
        raise ValueError(say('Create 1 to 40 primitive nodes.'))
    objects = []
    seen = set()
    for item in primitives:
        if not isinstance(item, dict):
            raise ValueError(say('Invalid node.'))
        slug, typ = item.get('name', ''), item.get('type', '')
        if (not isinstance(slug, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}', slug) or slug in seen
                or not isinstance(typ, str) or typ not in TYPES):
            raise ValueError(say('Each node needs a unique, simple name and a valid type.'))
        seen.add(slug)
        path = f'{typ}/{slug}.md'
        reserved = RESERVED_KINDS.get(file_kind(Path(path)))
        if reserved:
            raise ValueError(say('Node name {name}: reserved, because the file {name}.md would be read as {kind}.', name=slug, kind=reserved))
        pointer = f'- [{slug}]({path}): '
        objects.append({'name': slug, 'type': typ, 'path': path, 'pointer': pointer,
                        'description': _description(item, slug, pointer)})
    by_name = {o['name']: o for o in objects}
    if not isinstance(relations, list) or len(relations) > 200:
        raise ValueError(say('Use up to 200 relations.'))
    lines = {o['path']: [] for o in objects}
    for rel in relations:
        if not isinstance(rel, dict) or not isinstance(rel.get('source'), str) or not isinstance(rel.get('target'), str) or rel.get('source') not in by_name or rel.get('target') not in by_name:
            raise ValueError(say('Relations must connect existing nodes.'))
        verb = rel.get('type', 'references')
        if not isinstance(verb, str) or verb not in VERBS:
            raise ValueError(say('Invalid relation type.'))
        source, target = by_name[rel['source']], by_name[rel['target']]
        # governs: the link is written in the governed file, pointing to its policy (only there:
        # a link in both files would be a cycle nobody drew).
        holder, linked = (target, source) if verb == 'governs' else (source, target)
        relative = os.path.relpath(linked['path'], Path(holder['path']).parent)
        lines[holder['path']].append(texts['relation'][verb].replace('{name}', linked['name']).replace('{path}', relative))
    files = {}
    for obj in objects:
        text = texts['node'][obj['type']].replace('{name}', obj['name'])
        if lines[obj['path']]:
            text += '\n' + texts['relations'] + '\n\n' + '\n'.join(lines[obj['path']]) + '\n'
        files[obj['path']] = text
    pointers = '\n'.join(o['pointer'] + (o['description'] or texts['pointer_gap']) for o in objects)
    # `{name}` before `{map}`: a placeholder written in a description stays text.
    files['AGENTS.md'] = texts['entry'].replace('{name}', name).replace('{map}', pointers)
    files['CLAUDE.md'] = texts['claude']
    return files


def create_directory(payload):
    files = blueprint(payload)
    parent = Path(Workspace._path(payload.get('parent'), strict=True))
    if not parent.is_dir():
        raise ValueError(say('The parent folder does not exist.'))
    protected = protected_paths()
    destination = parent / payload['name']
    if contains(protected, parent) or contains(protected, destination):
        raise ValueError(PROTECTED_MESSAGE)
    # Pin the parent and every ancestor without following links. Validation and
    # writes must not be separated by a path-based open that can be redirected.
    with pinned_directory(parent) as parent_fd:
        # Exclusive mkdir never overwrites any existing entry, including links.
        os.mkdir(destination.name, mode=0o700, dir_fd=parent_fd)
        created = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        directories = {}
        written = []
        try:
            root_fd = os.open(destination.name, DIRECTORY_FLAGS, dir_fd=parent_fd)
            directories['.'] = root_fd
            opened = os.fstat(root_fd)
            if (opened.st_dev, opened.st_ino) != (created.st_dev, created.st_ino):
                raise ValueError(say('The target changed during creation.'))
            if os.listdir(root_fd):
                raise ValueError(say('The target stopped being empty during creation.'))
            for name, content in files.items():
                relative = Path(name)
                folder = str(relative.parent)
                if folder not in directories:
                    os.mkdir(folder, dir_fd=root_fd)
                    directories[folder] = os.open(folder, DIRECTORY_FLAGS, dir_fd=root_fd)
                descriptor = os.open(relative.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o666, dir_fd=directories[folder])
                written.append((directories[folder], relative.name))
                with os.fdopen(descriptor, 'w', encoding='utf-8') as out:
                    out.write(content)
            current = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (created.st_dev, created.st_ino):
                raise ValueError(say('The target changed during creation.'))
            for folder, descriptor in directories.items():
                current = os.stat(folder, dir_fd=root_fd, follow_symlinks=False)
                opened = os.fstat(descriptor)
                if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                    raise ValueError(say('The target changed during creation.'))
            current_parent = parent.stat(follow_symlinks=False)
            opened_parent = os.fstat(parent_fd)
            if parent.resolve(strict=True) != parent or (current_parent.st_dev, current_parent.st_ino) != (opened_parent.st_dev, opened_parent.st_ino):
                raise ValueError(say('The parent folder changed during creation.'))
        except Exception:
            # Never recursively remove a pathname after checking its identity:
            # a replacement directory could arrive between the check and delete.
            # Remove only files created through our pinned descriptors; rmdir
            # cannot erase another owner's nonempty replacement. Concurrent
            # tampering may leave a partial directory for manual inspection.
            for descriptor, name in reversed(written):
                try:
                    os.unlink(name, dir_fd=descriptor)
                except OSError:
                    pass
            for folder in reversed(directories):
                if folder != '.':
                    try:
                        os.rmdir(folder, dir_fd=directories['.'])
                    except OSError:
                        pass
            try:
                current = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                    os.rmdir(destination.name, dir_fd=parent_fd)
            except OSError:
                pass
            raise
        finally:
            for descriptor in directories.values():
                os.close(descriptor)
    return str(destination)
