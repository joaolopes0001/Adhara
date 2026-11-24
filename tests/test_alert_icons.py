"""No tone or state icon in the interface: an alert or a state is said by the colour of its words (SPECS,
visual identity).

A static check over every module of `src/`: no import of an alert icon, a check in a circle or a loading
icon from lucide-react, under any of its names, and no namespace import that could reach one. `Info` and
`Check` are the names with uses that are a control: those are listed below, per file, with how many and why,
so a new one fails until it is justified here. A check that marks a state ("Saved", "resolved", "Trace
found") is not one of them.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = sorted([*ROOT.glob('src/**/*.ts'), *ROOT.glob('src/**/*.tsx')])

# Icons that say "problem", "warning", "error", "refused" or "information" by their drawing. Each is also
# exported as `<Name>Icon` and `Lucide<Name>`.
ALERT_ICONS = {
    'AlertTriangle', 'TriangleAlert', 'CircleAlert', 'AlertCircle', 'OctagonAlert', 'AlertOctagon',
    'ShieldAlert', 'Info', 'BadgeAlert', 'BadgeInfo', 'MessageSquareWarning', 'MessageCircleWarning',
    'FileWarning', 'CircleX', 'XCircle', 'Ban', 'OctagonX', 'XOctagon', 'ShieldX',
    # A state by its drawing: done (a check in a circle) or working (a loading wheel).
    'CircleCheck', 'CheckCircle', 'CheckCircle2', 'CircleCheckBig', 'CheckCircleBig', 'Loader',
    'LoaderCircle', 'Loader2', 'LoaderPinwheel',
}
FORBIDDEN = {form for name in ALERT_ICONS for form in (name, f'{name}Icon', f'Lucide{name}')}

# Uses of `Info` that are a control, never a tone nor a fact: file, how many times the icon is rendered
# there, and why. A fact of a menu has no icon.
INFO_EXCEPTIONS = {
    'src/ScopeWorkspace.tsx': (1, 'the ⓘ button that opens the details of a view'),
    'src/App.tsx': (1, 'the icon of the "Estado" menu button of the bottom bar'),
}
# Uses of `Check` that are part of a control, never the mark of a state.
CHECK_EXCEPTIONS = {
    'src/Dialogs.tsx': (1, 'the icon of the "Create and open" button of the creation dialog'),
    'src/Diagnosis.tsx': (1, 'a copy button, which shows it copied'),
    'src/App.tsx': (2, 'a copy button, which shows it copied, and the icon of the "Save note" button'),
}
# Characters that would mark a tone or a state as text.
ALERT_CHARACTERS = '⚠ⓘ❗❌⛔✓✔✅'

IMPORT = re.compile(r"import\s+(type\s+)?([^;]*?)\s+from\s+['\"](lucide-react[^'\"]*)['\"]", re.S)


def lucide_imports(text):
    """(names imported from lucide-react, whether a namespace or default import is used)."""
    names, wide = set(), False
    for _type, clause, _module in IMPORT.findall(text):
        braces = re.search(r'\{([^}]*)\}', clause)
        if braces:
            for part in braces.group(1).split(','):
                part = part.strip()
                if part:
                    names.add(part.split(' as ')[0].replace('type ', '').strip())
        rest = re.sub(r'\{[^}]*\}', '', clause).strip(' ,')
        if rest:
            wide = True  # `import * as icons` or a default import: any icon could be reached through it.
    return names, wide


def icon_uses(text, name='Info'):
    """How many times the icon `name` is rendered or handed to a menu in a module."""
    return len(re.findall(rf'<{name}\b|\bicon:\s*{name}\b|\bicon=\{{{name}\}}', text))


def info_uses(text):
    return icon_uses(text, 'Info')


class AlertIconTests(unittest.TestCase):
    def test_sources_found(self):
        self.assertGreater(len(SOURCES), 20)

    def test_no_module_imports_an_alert_icon(self):
        found = []
        for path in SOURCES:
            names, wide = lucide_imports(path.read_text(encoding='utf-8'))
            rel = str(path.relative_to(ROOT))
            if wide:
                found.append(f'{rel}: namespace or default import of lucide-react')
            for name in sorted(names & FORBIDDEN):
                if name == 'Info' and rel in INFO_EXCEPTIONS:
                    continue
                found.append(f'{rel}: {name}')
        self.assertEqual(found, [], 'alert or state icons imported from lucide-react (say it by colour)')

    def test_info_and_check_only_where_listed_and_as_many_times(self):
        for name, exceptions in (('Info', INFO_EXCEPTIONS), ('Check', CHECK_EXCEPTIONS)):
            uses = {str(path.relative_to(ROOT)): icon_uses(path.read_text(encoding='utf-8'), name)
                    for path in SOURCES}
            self.assertEqual({rel: n for rel, n in uses.items() if n},
                             {rel: n for rel, (n, _why) in exceptions.items()},
                             f'a use of {name} that is not one of the listed controls')
            # Every other mention of the imported icon (passed to a variable, a map, a prop of another name)
            # would escape the count above: the identifier appears once in the import and once per use.
            for rel in exceptions:
                text = (ROOT / rel).read_text(encoding='utf-8')
                mentions = len(re.findall(rf'(?<![\w\'"]){name}\b(?![\'"])', text))
                self.assertEqual(mentions, 1 + icon_uses(text, name),
                                 f'{rel}: {name} used in a way the check does not see')

    def test_no_alert_character_or_class_in_the_sources(self):
        found = []
        for path in [*SOURCES, *ROOT.glob('src/**/*.css')]:
            for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                if any(char in line for char in ALERT_CHARACTERS) or re.search(
                    r'lucide-(triangle-alert|circle-alert|octagon-alert|shield-alert|badge-alert|circle-x|ban)\b',
                    line,
                ):
                    found.append(f'{path.relative_to(ROOT)}:{number}')
        self.assertEqual(found, [])

    def test_the_parser_sees_aliases_and_namespaces(self):
        # Negative cases of the check itself: what it must catch.
        names, wide = lucide_imports("import {\n  Folder,\n  AlertCircle as Warn,\n} from 'lucide-react';")
        self.assertIn('AlertCircle', names & FORBIDDEN)
        self.assertFalse(wide)
        self.assertTrue(lucide_imports("import * as icons from 'lucide-react';")[1])
        self.assertIn('TriangleAlertIcon', lucide_imports("import { TriangleAlertIcon } from 'lucide-react';")[0])
        self.assertEqual(info_uses("<Info size={12} />\nicon: Info,\nicon={Info}"), 3)
        self.assertEqual(icon_uses("<Check size={12} />\nicon: Check,\n<CheckCheck />", 'Check'), 2)
        self.assertIn('LoaderCircle', lucide_imports("import { LoaderCircle } from 'lucide-react';")[0] & FORBIDDEN)


if __name__ == '__main__':
    unittest.main()
