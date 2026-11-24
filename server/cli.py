"""Read-only CLI for builders of file-based agents. JSON stdout is the contract."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import audit as audit_report, doc_snapshot, file_inventory, suite_contract
from .doc_snapshot import document_lines, excerpt_sha256
from .protected import sources as protected_sources
from .scanner import InvalidInput, ReaderError, open_regular_file

MAX_INPUT_BYTES = 8 * 1024 * 1024
EXIT_CODES = {'pass': 0, 'fail': 1, 'error': 2, 'inconclusive': 3}
VERSION = 'aae 3 (CLI contract v3: audit v2, schema v2; other reports v1)'
REPORT_VERSIONS = {'schema': 2, 'audit': 2, 'compare-audit': 1, 'freeze': 1, 'inventory': 1, 'protected': 1, 'error': 1}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise InvalidInput(message)


def control_path(filename):
    """Absolute, normalized path of a control file argument.

    `..` is resolved lexically, as the shell user expects of `sub/../x.json`. That is the path
    on disk only when what each `..` cancels is a real folder: a `..` right after a symbolic link
    is refused, and open_regular_file refuses a link in any component that is left.
    """
    text = os.path.expanduser(str(filename))
    kept = [] if text.startswith('/') else [part for part in os.getcwd().split('/') if part]
    for part in text.split('/'):
        if part in {'', '.'}:
            continue
        if part == '..':
            if kept and os.path.islink('/' + '/'.join(kept)):
                raise InvalidInput(f'Path with .. right after a symbolic link: {filename}. '
                                   'Control files do not follow links; use the real path.')
            if kept:
                kept.pop()
            continue
        kept.append(part)
    return Path('/' + '/'.join(kept))


def load_json(filename):
    """Bound control inputs; never follow symlinks or echo document contents."""
    path = control_path(filename)
    try:
        with open_regular_file(path) as stream:
            data = stream.read(MAX_INPUT_BYTES + 1)
    except ValueError:
        raise InvalidInput(f'The control JSON must be a regular file (not a folder, FIFO or device): {filename}') from None
    if len(data) > MAX_INPUT_BYTES:
        raise InvalidInput('Control JSON exceeds 8 MiB.')

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise InvalidInput('Control JSON contains a duplicate key.')
            result[key] = value
        return result

    def constant(_):
        raise InvalidInput('Control JSON contains a non-finite number.')

    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise InvalidInput('Invalid control JSON.') from None


def parser():
    result = Parser(description='Audit document architectures of file-based agents. JSON output; sources are read-only.')
    result.add_argument('--version', action='version', version=VERSION)
    commands = result.add_subparsers(dest='command', required=True, parser_class=Parser)
    commands.add_parser('protected', help='List the effective protected paths (variable and state files) with their source; error if the configuration is broken.')
    commands.add_parser('schema', help='JSON contract, a valid suite example and command options.')
    audit = commands.add_parser('audit', help='Structural audit v2: summary, findings with stable ids, declared scope and requirement reach.')
    audit.add_argument('--root', action='append', required=True)
    audit.add_argument('--suite')
    audit.add_argument('--scope', help='Scope JSON, version 1 (runtimeWorkspace, localFiles, entries, implicitLoads); replaces the embedded scope.')
    audit.add_argument('--summary', action='store_true', help='Omit findings and paths; keep summary, gate, metrics and findingsOmitted; lists that grow with the tree are cut to --top items, with a <list>Total count.')
    audit.add_argument('--code', action='append', default=[], help='List only findings with this code (repeatable; accepts commas).')
    audit.add_argument('--source', action='append', default=[], help='List only findings whose path matches the pattern (repeatable; same syntax as the scope).')
    audit.add_argument('--top', type=int, default=audit_report.DEFAULT_TOP, help='Items in summary.topSources/topTargets, 1 to 100.')
    audit.add_argument('--fail-on', action='append', default=[], help='Code (or any = warning/error) that makes the status fail; repeatable; accepts commas.')
    delta = commands.add_parser('compare-audit', help='New, resolved and persisting findings between two audit v2 reports (matched by id).')
    delta.add_argument('--before', required=True)
    delta.add_argument('--after', required=True)
    delta.add_argument('--fail-on', action='append', default=[], help='Code (or any) that, among the NEW findings, makes the status fail; a different context (suite, contract or effective scope) yields audit-context-differs, which --fail-on also accepts; any includes it.')
    freeze = commands.add_parser('freeze', help='Bind (or verify) each requirement to the current content with contentHash; prints the resulting suite without writing files.')
    freeze.add_argument('--root', action='append', required=True)
    freeze.add_argument('--suite', required=True)
    freeze.add_argument('--relocate', action='store_true', help='A stale requirement follows the identical excerpt only if it exists in exactly one place in the snapshot.')
    freeze.add_argument('--rebind', action='store_true', help='Accept the current content of the range of requirements that are still stale (after --relocate).')
    inventory = commands.add_parser('inventory', help='Hashes and sizes of the regular files under the roots, without content.')
    inventory.add_argument('--root', action='append', required=True)
    return result


def schema_contract():
    """Self-contained discovery for agents without access to project documentation."""
    commands = {}
    subcommands = next(action for action in parser()._actions if isinstance(action, argparse._SubParsersAction))
    for name, command in subcommands.choices.items():
        commands[name] = [
            {'flag': action.option_strings[0], 'required': action.required,
             'repeatable': isinstance(action, argparse._AppendAction),
             'takesValue': not isinstance(action, argparse._StoreTrueAction)}
            for action in command._actions if action.option_strings and '--help' not in action.option_strings]
    files = {'AGENTS.md': '# Entry\n[Policy](policy.md).\nOnly when urgent: [protocol](urgent.md).\n',
             'policy.md': 'Consult the policy on every task.\n',
             'urgent.md': 'Apply the protocol only while an urgency is active.\n',
             'honeypot.md': 'Neutral document outside the task.\n'}
    requirement = {'path': 'policy.md', 'startLine': 1, 'endLine': 1}
    conditional = {'path': 'urgent.md', 'startLine': 1, 'endLine': 1, 'trigger': 'urgency'}
    scenarios = [{'id': name, 'triggers': triggers, 'required': [dict(requirement)],
                  'conditional': [dict(conditional)], 'forbidden': ['honeypot.md'],
                  'maxReads': 3, 'maxBytes': 4096, 'maxHops': 1}
                 for name, triggers in [('routine', []), ('urgent', ['urgency'])]]
    frozen = {**requirement, 'contentHash': excerpt_sha256(document_lines(files['policy.md']), 1, 1)}
    return {
        'version': 2, 'kind': 'schema', 'status': 'pass', 'cliVersion': VERSION,
        'reportVersions': dict(REPORT_VERSIONS),
        'commands': commands, 'exitCodes': dict(EXIT_CODES),
        'errors': {'invalid-input': 'exit 2: invalid request (arguments, control JSON, roots, scope).',
                   'internal-error': 'exit 2: defect; type and file:line in the message and on stderr.'},
        'auditContract': {
            'command': 'audit --root PATH [--root OTHER] [--suite JSON] [--scope JSON] [--summary] [--code CODE]... [--source GLOB]... [--top N] [--fail-on CODE]...',
            'keyOrder': 'version, kind, status, roots, summary, gate?, filter?, findingsOmitted?, metrics, scope, suiteHash, contractHash, scopeHash, limitations, policy, analyzed, unanalyzed, paths, findings.',
            'paths': 'Absolute path only in roots[].path (roots[].parent is an index). path, entries, metrics, candidates and steps are relative to the owning root; root (index into roots) appears only with several roots.',
            'finding': '{id, code, severity, message, root?, path?, line?, target?, ...fields of the code}. Order: severity (error, incomplete, warning, info), path, line.',
            'fields': 'Reference: evidence, syntax, form; ambiguous: candidates (up to 20, stable order), candidatesTotal (total); unverified/outside-root: legacyId (id as broken or unresolved-name); unreachable: conclusive false on a partial read; limit (budget): count, bytes, byTopLevel. metrics.inventory {complete, lookupComplete, omitted, omittedFiles, byTopLevel [{name, inventoried, onDisk}], entriesOmitted {count, paths}}, metrics.relations {complete, omitted, max}, metrics.headers {files, bytes, max, complete}. Without --summary: analyzed [{path}] and unanalyzed [{path, bytes, reason}]. compare-audit: reclassified (legacyId, same path/line/target, broken|unresolved-name→unverified|outside-root; does not fail); --fail-on broken matches outside-root. manifest-mismatch: target is source → target as written (absent link) or the link as written (absent relation); from, to and manifest relative to the root of the finding (<field>Root in another root).',
            'severities': {'error': 'status fail, exit 1', 'incomplete': 'status inconclusive, exit 3', 'warning': 'does not change status', 'info': 'candidate or count; does not change status'},
            'codes': {code: f'{severity}: {meaning}' for code, (severity, meaning) in audit_report.CODES.items()},
            'summary': 'Always present, whole set: total, bySeverity, byCode (with info), topSources [{path, count, byCode}] and topTargets [{target, count, codes}] (error/incomplete/warning only; N = --top, default 10, max 100).',
            'filter': '--code and --source GLOB (repeatable, commas; GLOB in the scope syntax, over path) filter only findings and add filter {codes, sources, matched}; summary, metrics, status and gate cover the whole set. --summary omits findings, unanalyzed and paths (findingsOmitted) and cuts lists that grow with the tree to --top items (mass: largest first), with <list>Total.',
            'gate': '--fail-on CODE|any (repeatable, commas): a finding with that code in the whole set makes status fail (exit 1); any = any warning or error. gate {failOn, matched {code: n}}. Unknown code: exit 2 with the valid list.',
            'extraction': 'Extracted: Markdown and wiki links, @import, manifest (manifest file only), anchored path (./, ../, ~/, /) and, in backticks, a name with an extension (md, json, yaml, toml, txt, py, sh, ts, js; #anchor, ::id or :line) or a path followed by §section; in .txt, only links and @import. Ignored, by metrics.ignored key: variable ($), template (YYYY/NN/XX), elision, code (wiki-style links inside code), manifest-key, fenced (not resolved inside a fenced block), cut (prose cut by a glob), txt, too-long (address >4096 B or write >64 KiB). Missing: broken if it has / or an anchor, or a link to a name with an extension, wiki, @import or manifest; otherwise unresolved-name.',
            'resolution': '[[x]] without a folder: first the single Markdown with name: x in the frontmatter (frontmatter-name; exact; 2+: ambiguous). Not anchored: file, skill, root, unique name/suffix under the source skill (skill-basename/skill-suffix; 2+ there: ambiguous), then in the root (basename/suffix); ./x in backticks/prose also tries the root (root-dot). Beyond the limit: unscanned; no hit: probes 3 ancestors (outside-root).',
            'identity': 'id = 16 hex of the sha256 of (code, root index if several, relative path, target | scenarioId+path | pattern, ordinal per line). No absolute path, line number or message: equal across copies of a tree and after inserting lines.',
            'metrics': 'files (real files, like find -type f), unresolvedTargets, parsed, edges, entries, partial, resolution (edges per mode, unresolved; unresolvedNames and unscanned apart), structure, reachability, mass, inventory, relations, ignored (the 9 extraction keys) and probe {maxLevels, ancestors [{root, levels, stop, repository, probes: distinct references probed}]}.',
            'mass': 'entries [{path, bytes, source}]; alwaysLoaded {bytes, basis, files with source}: the suite entry (suite-entry) or AGENTS.md/CLAUDE.md at the root (convention), plus those matching the scope entries (declared-entry; basis +declared-entries). implicitLoads do not add up; maxAlwaysLoadedBytes measures only the suite entry. reachableByHops [{hops, files, bytes}]; documentsBytes. Bytes = wc -c, not tokens.',
            'suite': 'With --suite: paths[] (shortest directed path per active requirement, steps with evidence), required-unreachable and hop-budget-exceeded per root; on the first root snapshot, requirement-stale/unavailable/unbound, always-loaded-budget-exceeded, policy-excluded and snapshot-partial. Without a snapshot (suite-snapshot-unavailable), maxAlwaysLoadedBytes uses the entry size from the inventory.'},
        'scopeContract': {
            'input': '--scope JSON (outside the root) replaces, in every root, the scope key of the root agent-architecture.json (embedded declaration).',
            'example': {'version': 1, 'runtimeWorkspace': ['drafts/', 'inbox/**'], 'localFiles': ['config/*.local.json'],
                        'entries': ['.claude/agents/*.md'], 'implicitLoads': ['**/SKILL.md']},
            'patterns': 'POSIX relative to the root (no leading /, . or ..); * and ? do not cross /; ** matches zero or more segments (at the end, one or more: dir/** does not match dir); a trailing / matches the directory and all below it. Case-sensitive; up to 200 patterns of up to 300 characters; unknown fields refused.',
            'semantics': 'runtimeWorkspace and localFiles absorb a reference that would be broken or unresolved-name (it becomes declared-external, info) and exempt files from unreachable; entries and implicitLoads become reachability starting points, and only entries add to mass.alwaysLoaded. An ambiguous reference is never absorbed.',
            'accounting': 'scope.patterns counts references and files per pattern; a pattern with no effect yields scope-unused-pattern. The scope is the author\'s claim: counted, not verified.',
            'scopeHash': 'Hash of the effective scope: source (flag or manifest) and validated declaration (one per root, by index, if embedded); null only with no declaration.'},
        'changes': {'audit v1 -> v2': [
            'version 2 (no issues, codes without scanner-, info severity does not change status), relative paths, stable id, summary, flags --summary/--code/--source/--top/--fail-on/--scope; new unreachable, basename/suffix-resolved, declared-external and --suite findings; structure, resolution, reachability, mass in metrics.'],
            'audit v2: reference form and name in the skill': [
                'A missing bare name is unresolved-name (info); ::id dropped; resolution gains unresolvedNames, skill-basename, skill-suffix; a name/suffix under the source skill resolves despite homonyms (same id).'],
            'audit v2: declared identity, mass and files': [
                '[[x]] resolves first by the frontmatter name:; backtick path §section counts the path; prose does not extract ./x.md from ../x.md; metrics.files counts real files only (unresolvedTargets apart); mass.alwaysLoaded adds the scope entries.'],
            'audit v2: reads under a limit': [
                'New unverified, outside-root; findings with evidence, syntax, form; budget limit per root; unanalyzed; metrics inventory, ignored, probe.'],
            'audit v2: checkable manifest': [
                'New manifest-mismatch (warning) and manifest-unchecked (info, relation not checked, with reason) with linkedRelationships: true in agent-architecture.json; the relations of a manifest no longer count in metrics.structure.repeatedReferences; a link with a title in parentheses is now extracted.'],
            'CLI v2 -> v3': [
                'experiment, preview, replay, summarize, compare and compare-inventory are no longer commands (invalid-input, exit 2). schema v2 drops their contracts and examples (actionsContract, paths.wrapper, examples.actions, urgentActions and mcp); paths.suiteAndActions is now paths.suite, workflow.auditoria is workflow.audit and workflow.reforma is workflow.overhaul. The protected, audit, compare-audit, freeze and inventory reports are unchanged.']},
        'comparisonContract': {
            'compare-audit': 'Two complete audit v2 reports (no --summary), same number of roots, same filter. Matches findings by id: new (after), resolved (before), persisting (count), byCode. --fail-on covers only the new ones and accepts audit-context-differs (any includes it). Meta-findings: audit-context-differs (warning; different suiteHash, contractHash or scopeHash; scopeSource if the effective scope changed) and comparison-incomplete (exit 3; a partial or inconclusive side). hops lists requirements whose shortest path changed (by contentHash, otherwise path and lines).',
            'contractHash': 'SHA-256 of the normalized suite with each requirement by contentHash only (no path/lines; conditionals keep trigger), keeping scenarios, triggers, forbidden, budgets, entry and entryInjected. null if any requirement lacks contentHash. Compares revisions that only moved excerpts.'},
        'paths': {
            'cliOptions': '--root, --suite, --scope, --before and --after take paths on the caller\'s filesystem.',
            'suite': 'entry and path inside the suite JSON are relative to the first --root, POSIX, with no root/ prefix, no absolute paths, .., double slashes or trailing slash.'},
        'suiteContract': {
            'required': ['version', 'entry', 'scenarios'], 'version': 1, 'optional': ['entryInjected'],
            'scenarios': {'count': '1..100', 'required': ['id'],
                          'optional': ['triggers', 'required', 'conditional', 'forbidden', 'maxReads', 'maxBytes', 'maxHops', 'maxAlwaysLoadedBytes']},
            'requiredRange': {'path': 'relative string', 'startLine': 'integer >=1', 'endLine': 'integer >=startLine',
                              'contentHash': 'optional; lowercase hexadecimal SHA-256 of the excerpt, filled in by the freeze command'},
            'conditionalRange': 'The same range, plus trigger:string. Active only when trigger is in the scenario triggers list.',
            'forbidden': 'List of exact relative paths of honeypots or forbidden documents.',
            'budgets': 'maxReads/maxBytes/maxHops/maxAlwaysLoadedBytes are optional integers >=0. audit checks maxHops (structural reach) and maxAlwaysLoadedBytes; maxReads and maxBytes are validated and kept in the suite identity, and no command measures them.',
            'contentHash': 'SHA-256 of the UTF-8 bytes of lines startLine..endLine, with their terminators, as in str.splitlines(keepends=True). Do not compute it by hand: use freeze.',
            'identity': 'An active requirement whose contentHash differs from the snapshot yields requirement-stale (incomplete, exit 3) with relocated: up to 5 places where the identical excerpt is now; audit never follows the excerpt by itself. A requirement with no contentHash yields a requirement-unbound warning with count.',
            'entryInjected': 'Optional boolean, default false: the author declares that the runtime delivers the whole entry. Validated and kept in suiteHash and contractHash; it does not change the audit checks.',
            'maxAlwaysLoadedBytes': 'Always-loaded budget: whole size of the entry in the snapshot (wc -c), however much the agent reads; runtime loaders may truncate above a ceiling. Exceeding it yields always-loaded-budget-exceeded (exit 1) in audit --suite.',
            'suiteInput': '--suite of any command accepts a bare suite or a freeze report with status pass (uses .suite, checks its hashes); any other status is an input error (exit 2).',
            'unknownFields': 'Unknown fields, repeated IDs and contradictory requirements are refused.'},
        'freezeContract': {
            'command': 'freeze --root PATH --suite JSON [--relocate] [--rebind]; writes no files: redirect stdout.',
            'output': {'kind': 'freeze', 'status': 'pass | inconclusive', 'suite': 'resulting normalized suite', 'suiteHash': 'sha256', 'contractHash': 'sha256 or null',
                       'entry': 'suite entry', 'snapshotHash': 'sha256 of the snapshot documents', 'snapshotPartial': 'true blocks --relocate',
                       'changes': '[{scenarioId, list: required|conditional, index, action: bound|relocated|rebound, from?, to?}]', 'findings': 'remaining requirement-stale/requirement-unavailable'},
            'behavior': 'Without contentHash: binds every requirement, inactive conditionals included. With contentHash: verifies. --relocate moves a requirement only if the identical excerpt exists in exactly one place of a complete snapshot; --rebind accepts the current content of the range of still-stale requirements. pass only with all bound and valid; otherwise inconclusive (exit 3).'},
        'examples': {
            'files': files,
            'suite': {'version': 1, 'entry': 'AGENTS.md', 'scenarios': scenarios},
            'frozenRequirement': frozen,
            'cli': ['aae schema', 'aae audit --root /tmp/example/root --summary',
                    'aae audit --root /tmp/example/root --scope /tmp/example/run/scope.json --code broken --code ambiguous',
                    'aae freeze --root /tmp/example/root --suite /tmp/example/run/suite.json > /tmp/example/run/frozen.json',
                    'aae audit --root /tmp/example/root --suite /tmp/example/run/frozen.json > /tmp/example/run/before.json',
                    'aae compare-audit --before /tmp/example/run/before.json --after /tmp/example/run/after.json --fail-on any']},
        'workflow': {
            'audit': ['1. audit --root R --summary: status, summary (byCode, topSources, topTargets) and metrics.',
                          '2. broken concentrated in runtime folders or local files (topTargets): write a scope outside the root (runtimeWorkspace/localFiles; entries/implicitLoads for loads without a link), repeat with --scope, check scope.patterns.',
                          '3. audit ... --code broken --code ambiguous (--source GLOB for a folder): path, line, target and candidates.',
                          '4. audit ... --code unreachable: candidates with no path (orphan or island), to review.',
                          '5. audit ... --code unresolved-name: separate examples and artifacts from real breaks written only as a name.'],
            'overhaul': ['1. freeze --suite on the revision where the oracle was written; use the freeze as --suite; keep the oracle out of reach of the changes.',
                        '2. audit --suite FROZEN > before.json (without --summary).',
                        '3. Edit the copy.',
                        '4. audit --suite FROZEN > after.json; compare-audit --before before.json --after after.json [--fail-on any]: only what the edit introduced or resolved (a new ambiguous fails any, even a bare name).']},
        'limitations': ['The contract and examples do not prove oracle quality or model understanding.',
                        'contentHash detects a shift or edit of the required excerpt; it does not judge whether it is the right excerpt for the task.',
                        'audit measures the structure of explicit references, not what a consumer reads.']}


def dispatch(args):
    if args.command == 'schema':
        return schema_contract()
    if args.command == 'protected':
        listed = protected_sources()  # InvalidInput (broken configuration) becomes kind error, exit 2.
        return {'version': 1, 'kind': 'protected', 'status': 'pass',
                'sources': [{'source': source.name, 'present': source.present, 'entries': len(source.entries)} for source in listed],
                'entries': [{'path': str(entry), 'source': source.name} for source in listed for entry in source.entries]}
    if args.command == 'compare-audit':
        return audit_report.compare_audits(load_json(args.before), load_json(args.after), args.fail_on)
    if args.command == 'inventory':
        result = file_inventory.capture_inventory(args.root)
        return {**result, 'kind': 'inventory', 'status': 'inconclusive' if result.get('partial') else 'pass'}
    suite = suite_contract.load_suite(load_json(args.suite)) if args.suite else None
    if args.command == 'audit':
        scope = load_json(args.scope) if args.scope else None
        return audit_report.run(args.root, suite, scope, summary=args.summary, codes=args.code, sources=args.source,
                                top=args.top, fail_on=args.fail_on)
    _, snapshot = doc_snapshot.prepare(args.root, suite)
    return suite_contract.freeze(snapshot, suite, relocate=args.relocate, rebind=args.rebind)


def main(argv=None):
    try:
        result = dispatch(parser().parse_args(argv))
    except (InvalidInput, OSError, RecursionError) as exc:
        # Only what was asked: arguments, control files, roots and scope. OS error strings can include
        # arbitrary paths, but never file contents. A RecursionError comes from a control file too deep.
        message = str(exc) if isinstance(exc, InvalidInput) else 'Could not read the input; check paths, permissions and limits.'
        result = {'version': 1, 'kind': 'error', 'status': 'error', 'findings': [
            {'code': 'invalid-input', 'severity': 'error', 'message': message}]}
    except KeyboardInterrupt:
        result = {'version': 1, 'kind': 'error', 'status': 'inconclusive', 'findings': [
            {'code': 'interrupted', 'severity': 'warning', 'message': 'Run interrupted.'}]}
    except Exception as exc:  # A defect never leaves a traceback in place of the documented JSON and exit code.
        failure = exc if isinstance(exc, ReaderError) else ReaderError(exc)
        # One line on stderr: the type and where it was raised, never a document's content.
        print(f'aae: internal-error: {failure.kind} in {failure.where}', file=sys.stderr)
        result = {'version': 1, 'kind': 'error', 'status': 'error', 'findings': [
            {'code': 'internal-error', 'severity': 'error', 'message': f'Internal failure ({failure.kind} in {failure.where}); the read did not finish.'}]}
    text = json.dumps(result, ensure_ascii=False, allow_nan=False)
    try:
        text.encode('utf-8')
    except UnicodeEncodeError:
        text = json.dumps(result, ensure_ascii=True, allow_nan=False)  # a name that is not UTF-8 travels escaped
    print(text)
    return EXIT_CODES.get(result.get('status', 'pass'), 2)


if __name__ == '__main__':
    raise SystemExit(main())
