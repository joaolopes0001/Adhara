"""The name/suffix step of the cascade looks under the source's own skill first.

Disposable trees only. Exactly one candidate under the nearest skill (the source folder
included) resolves to it as skill-basename/skill-suffix; none there falls back to the
whole root as before; two or more there stay ambiguous with every candidate of the root.
"""
import copy
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import audit, scanner

FILES = {
    'AGENTS.md': '# Entrada\n[A](skills/a/SKILL.md)\n[B](skills/b/SKILL.md)\n[C](skills/c/SKILL.md)\n[D](skills/d/SKILL.md)\n`checar.py`\n[Docs](docs/x.md)\n',
    'docs/x.md': '# Fora de skill\n`unico.md`\n',
    'docs/sub/unico.md': '# Único\n',
    'skills/a/SKILL.md': '# A\n`checar.py`\n`lib/run.sh`\n`so-aqui.md`\n[Guia](references/guia.md)\n',
    'skills/a/references/guia.md': '# Guia\n`checar.py`\n',
    'skills/a/scripts/checar.py': 'print(1)\n',
    'skills/a/tools/lib/run.sh': 'true\n',
    'skills/a/notas/so-aqui.md': '# Só nesta skill\n',
    'skills/b/SKILL.md': '# B\n`checar.py`\n',
    'skills/b/scripts/checar.py': 'print(2)\n',
    'skills/b/tools/lib/run.sh': 'true\n',
    'skills/c/SKILL.md': '# C, sem checar.py\n`checar.py`\n`lib/run.sh`\n',
    'skills/d/SKILL.md': '# D, dois dup.md\n`dup.md`\n',
    'skills/d/x/dup.md': '# X\n',
    'skills/d/y/dup.md': '# Y\n',
    'skills/e/dup.md': '# E\n',
}


class SkillFirstResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-skill-name-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'agent'
        for relative, text in FILES.items():
            (self.root / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.root / relative).write_text(text, encoding='utf-8')
        self.model = scanner.scan([str(self.root)])

    def path(self, relative):
        return str(self.root / relative)

    def edge(self, source, raw):
        return next(e for e in self.model['edges'] if e['source'] == self.path(source) and e['raw'] == raw)

    def ambiguous(self, source):
        return [(i['target'], [Path(c).relative_to(self.root).as_posix() for c in i['candidates']])
                for i in self.model['issues'] if i['code'] == 'ambiguous' and i['node'] == self.path(source)]

    def test_own_skill_candidate_wins_over_homonyms_in_other_skills(self):
        cases = {('skills/a/SKILL.md', 'checar.py'): ('skills/a/scripts/checar.py', 'skill-basename'),
                 ('skills/a/references/guia.md', 'checar.py'): ('skills/a/scripts/checar.py', 'skill-basename'),
                 ('skills/b/SKILL.md', 'checar.py'): ('skills/b/scripts/checar.py', 'skill-basename'),
                 ('skills/a/SKILL.md', 'lib/run.sh'): ('skills/a/tools/lib/run.sh', 'skill-suffix'),
                 # Unique in the whole root too: the label still says where it was found.
                 ('skills/a/SKILL.md', 'so-aqui.md'): ('skills/a/notas/so-aqui.md', 'skill-basename'),
                 ('docs/x.md', 'unico.md'): ('docs/sub/unico.md', 'basename')}
        for (source, raw), (target, mode) in cases.items():
            with self.subTest(source=source, raw=raw):
                edge = self.edge(source, raw)
                self.assertEqual((edge['target'], edge['resolvedBy']), (self.path(target), mode))

    def test_no_candidate_in_the_skill_or_outside_skills_keeps_the_root_search(self):
        self.assertEqual(self.ambiguous('skills/c/SKILL.md'), [
            ('checar.py', ['skills/a/scripts/checar.py', 'skills/b/scripts/checar.py']),
            ('lib/run.sh', ['skills/a/tools/lib/run.sh', 'skills/b/tools/lib/run.sh'])])
        self.assertEqual(self.ambiguous('AGENTS.md'), [('checar.py', ['skills/a/scripts/checar.py', 'skills/b/scripts/checar.py'])])

    def test_two_candidates_in_the_same_skill_stay_ambiguous_with_every_root_candidate(self):
        self.assertEqual(self.ambiguous('skills/d/SKILL.md'), [('dup.md', ['skills/d/x/dup.md', 'skills/d/y/dup.md', 'skills/e/dup.md'])])
        self.assertFalse(any(e['raw'] == 'dup.md' for e in self.model['edges']))

    def test_counts_and_info_findings_keep_code_and_id_with_the_exact_mode(self):
        resolution = self.model['stats']['resolution']
        self.assertEqual((resolution['skill-basename'], resolution['skill-suffix'], resolution['basename'], resolution['suffix']), (4, 1, 1, 0))
        report = audit.audit(self.model)
        named = {(f['path'], f['target']): (f['code'], f['resolvedBy'], f['resolvedTo']) for f in report['findings'] if f['code'].endswith('-resolved')}
        self.assertEqual(named[('skills/a/SKILL.md', 'lib/run.sh')], ('suffix-resolved', 'skill-suffix', 'skills/a/tools/lib/run.sh'))
        self.assertEqual(named[('skills/a/SKILL.md', 'checar.py')], ('basename-resolved', 'skill-basename', 'skills/a/scripts/checar.py'))
        self.assertEqual(named[('docs/x.md', 'unico.md')], ('basename-resolved', 'basename', 'docs/sub/unico.md'))
        self.assertEqual(report['metrics']['resolution']['skill-basename'], 4)
        # The label never enters the id: the same edge resolved by the plain step gives the same finding id.
        relabelled = copy.deepcopy(self.model)
        for edge in relabelled['edges']:
            if edge['resolvedBy'] in {'skill-basename', 'skill-suffix'}:
                edge['resolvedBy'] = edge['resolvedBy'][len('skill-'):]
        plain = audit.audit(relabelled)
        self.assertEqual([(f['id'], f['code']) for f in plain['findings']], [(f['id'], f['code']) for f in report['findings']])

    def test_cited_from_a_skill_without_the_name_like_alfa_d14(self):
        with tempfile.TemporaryDirectory(prefix='aae-skill-d14-') as folder:
            root = Path(folder)
            for relative, text in {'AGENTS.md': '[R](skills/resposta/SKILL.md)\n', 'skills/resposta/SKILL.md': '`criterios.md`\n',
                                   'skills/triagem/SKILL.md': '# T\n', 'skills/triagem/references/criterios.md': '# T\n',
                                   'skills/escalonamento/SKILL.md': '# E\n', 'skills/escalonamento/references/criterios.md': '# E\n'}.items():
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_text(text, encoding='utf-8')
            issues = [i for i in scanner.scan([str(root)])['issues'] if i['code'] == 'ambiguous']
            self.assertEqual([(i['target'], len(i['candidates'])) for i in issues], [('criterios.md', 2)])


if __name__ == '__main__':
    unittest.main()
