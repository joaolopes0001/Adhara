"""The "Onde alterar" map of AGENTS.md: it cites every code module and only paths that exist."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES = ('server/*.py', 'src/**/*.ts', 'src/**/*.tsx', 'scripts/*.py', 'scripts/*.mjs')


def files_column(text):
    """Paths between backticks in the Files column of the table of the "Onde alterar" section."""
    section = text.split('\n## Onde alterar\n', 1)[1].split('\n## ', 1)[0]
    rows = [line for line in section.splitlines() if line.startswith('| ') and not line.startswith('| ---')]
    cited = set()
    for row in rows[1:]:  # The first row is the header.
        cells = [cell.strip() for cell in row.strip().strip('|').split('|')]
        cited.update(re.findall(r'`([^`]+)`', cells[-1]))
    return cited


class DocsMapTests(unittest.TestCase):
    def setUp(self):
        self.cited = files_column((ROOT / 'AGENTS.md').read_text(encoding='utf-8'))

    def test_every_module_has_an_area(self):
        modules = {str(path.relative_to(ROOT)) for pattern in MODULES for path in ROOT.glob(pattern)}
        self.assertTrue(modules)
        self.assertEqual(sorted(modules - self.cited), [], 'módulos fora de AGENTS.md › Onde alterar')

    def test_every_cited_path_exists(self):
        self.assertTrue(self.cited)
        self.assertEqual(sorted(path for path in self.cited if not (ROOT / path).exists()), [],
                         'caminhos citados em AGENTS.md › Onde alterar que não existem')


if __name__ == '__main__':
    unittest.main()
