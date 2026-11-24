"""The findings a baseline saved by the earlier server keeps, in Portuguese, and the same findings read now.

`findings_before_english.json` is what the earlier server saved in a baseline (`delta.read`, the
compact reading) for the synthetic projects `build` makes, under several forced limits (`CONFIGS`): each finding
with its `aae audit` id and its message in Portuguese, without a phrase, once (with the first limits that gave it).
The paths in it are written from a placeholder base.

    python3 -B tests/findings_before_english.py --pairs

reads the same projects, under the same limits, with the server of this repository, and prints, for each
recorded finding, the one of this reading with the same id: `before` as it was saved, `now` with its English
message and its phrase. tests/ui/server-text.spec.ts checks with them that the interface never reads the message
of a finding of such a baseline: in Portuguese its line is the one the earlier interface showed (the line of the
finding of this server, worded by the pack), and in English only what its fields say.

The fixtures are frozen recordings of the format saved before the server wrote in English;
they are not regenerated.
"""
import json
import os
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'findings_before_english.json'
BASE = '/aae-findings-before-english'  # the placeholder of the temporary base in the recorded paths
AT = '2026-11-17T10:00:00-03:00'
# Limits forced for a reading, by scanner constant: each one makes the reader write other sentences.
CONFIGS = {
    'normal': {},
    'bytes': {'MAX_BYTES': 200},
    'files': {'MAX_FILES': 60},
    'lookup': {'MAX_FILES': 60, 'MAX_LOOKUP': 70},
    'text': {'MAX_TEXT_TOTAL': 1500},
    'edges': {'MAX_EDGES': 12},
    'candidates': {'MAX_CANDIDATES': 1},
}


def build(base):
    """Projects under `base` (a repository: `.git` above them) whose reading has findings of many kinds and,
    under the limits of `CONFIGS`, the findings of each limit. Returns their paths."""
    base = Path(base)

    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(text, bytes):
            path.write_bytes(text)
        else:
            path.write_text(text, encoding='utf-8')
    write(base / '.git' / 'HEAD', 'ref: refs/heads/main\n')
    write(base / 'compartilhado' / 'acima.md', '# Acima\n')
    main = base / 'principal'
    write(main / 'AGENTS.md', '\n'.join([
        '# Principal',
        '[quebrado](docs/falta.md), `fantasma.md` e [[wiki-falta]]',
        '[ambíguo](comum.md) e [grande](grande.md) e [latin](docs/latin.md)',
        '`compartilhado/acima.md` fica acima do projeto',
        '[uri](file://%zz) e [link](atalho.md)',
        '[ruim](ruim/agent-architecture.json) e [cortado](cortado/agent-architecture.json) e [tipo](tipo/agent-architecture.json)',
        '[pacote](pacote/agent-architecture.json) e [skill](.claude/skills/uma/SKILL.md)',
        *[f'[documento {index}](docs/d{index}.md)' for index in range(8)], '']))
    for index in range(8):
        write(main / 'docs' / f'd{index}.md', f'# D{index}\n' + 'texto de apoio para o orçamento de leitura.\n' * 6)
    write(main / 'docs' / 'latin.md', b'caf\xe9\n')
    write(main / 'grande.md', '# Grande\n' + 'x' * 400 + '\n')
    write(main / 'x' / 'comum.md', 'x\n')
    write(main / 'y' / 'comum.md', 'y\n')
    write(main / 'ilha' / 'i1.md', '[i2](i2.md)\n')
    write(main / 'ilha' / 'i2.md', '[i1](i1.md)\n')
    write(main / 'solto.md', 'solto\n')
    os.symlink('docs/d0.md', main / 'atalho.md')
    write(main / '.claude' / 'skills' / 'uma' / 'SKILL.md', '---\nname: uma\n---\n`apoio.md`\n')
    write(main / '.claude' / 'skills' / 'uma' / 'fundo' / 'apoio.md', 'apoio\n')
    write(main / 'pacote' / 'a.md', '[b](b.md)\n')
    write(main / 'pacote' / 'b.md', 'b\n')
    write(main / 'pacote' / 'agent-architecture.json', json.dumps({
        'linkedRelationships': True, 'objects': [{'path': 'a.md'}, {'path': 'b.md'}],
        'relationships': [{'source': 'b.md', 'target': 'a.md'}]}))
    write(main / 'ruim' / 'agent-architecture.json', '{"objects": 3}')
    write(main / 'cortado' / 'agent-architecture.json', '{"objects": [')
    write(main / 'tipo' / 'agent-architecture.json', json.dumps({'relationships': [{'source': '.', 'target': 'a.md', 'type': 5}]}))
    # Folders the inventory limit cuts, with entry files in them.
    for folder in ('fundo', 'fundo/mais', 'outro'):
        write(main / 'arquivo' / folder / 'AGENTS.md', '# Sub\n')
        for index in range(12):
            write(main / 'arquivo' / folder / f'n{index}.txt', 'n\n')
    roots = [str(main)]
    # Scope declarations, each with what makes it invalid or a pattern without effect.
    scopes = [{'version': 1, 'runtimeWorkspace': ['nunca/']}, {'version': 1, 'entries': ['/absoluto/x.md']},
              {'version': 1, 'localFiles': ['a/../b']}, {'version': 1, 'a': [], 'b': [], 'c': [], 'd': [], 'e': [], 'f': []},
              {'version': 2}]
    for index, scope in enumerate(scopes):
        project = base / f'escopo{index}'
        write(project / 'AGENTS.md', '# Escopo\n[nota](nota.md) e [falta](sumiu.md)\n')
        write(project / 'nota.md', 'nota\n')
        write(project / 'agent-architecture.json', json.dumps({'version': 1, 'scope': scope}))
        roots.append(str(project))
    return roots


def read(server, base):
    """{config: {root (placeholder base): [compact finding]}} of the projects of `build` under `base`, read by the
    server at `server` (a folder with `server/`), as a baseline keeps them."""
    sys.path.insert(0, str(Path(server) / 'server'))
    import delta
    import scanner
    roots = build(base)
    defaults = {name: getattr(scanner, name) for limits in CONFIGS.values() for name in limits}
    result = {}
    try:
        for config, limits in CONFIGS.items():
            for name, value in {**defaults, **limits}.items():
                setattr(scanner, name, value)
            compact = delta.read(scanner.scan(roots), AT)
            result[config] = {root.replace(base, BASE): [json.loads(json.dumps(item).replace(base, BASE)) for item in compact[root]['audit']['findings']]
                              for root in roots}
    finally:
        for name, value in defaults.items():  # the limits of the reader, whatever happened
            setattr(scanner, name, value)
    return result


def isolated(action):
    """`action` on a temporary base folder, deleted after."""
    with tempfile.TemporaryDirectory(prefix='aae-findings-') as temporary:
        return action(str(Path(temporary).resolve() / 'base'))


def pairs():
    """[{config, root, before, now}] for each recorded finding, `now` the finding of this reading with its id."""
    recorded = json.loads(FIXTURE.read_text(encoding='utf-8'))
    now = isolated(lambda base: read(HERE.parent, base))
    found = []
    for item in recorded['findings']:
        match = next((each for each in now[item['config']][item['root']] if each['id'] == item['finding']['id']), None)
        if match is not None and 'messagePhrase' in match:
            match = {**match, 'messagePhrase': json.loads(match['messagePhrase'])}
        found.append({'config': item['config'], 'root': item['root'], 'before': item['finding'], 'now': match})
    return found


def distinct(findings):
    """[{config, root, finding}] of `read`, each finding once: by root, id and message, with the first limits that gave it."""
    seen, result = set(), []
    for config, roots in findings.items():
        for root, items in roots.items():
            for item in items:
                if (root, item['id'], item['message']) not in seen:
                    seen.add((root, item['id'], item['message']))
                    result.append({'config': config, 'root': root, 'finding': item})
    return result


if __name__ == '__main__':
    # Never the home folder or the protected paths of whoever runs it.
    home = tempfile.TemporaryDirectory(prefix='aae-findings-home-')
    os.environ['HOME'] = home.name
    os.environ.pop('AAE_PROTECTED_PATHS', None)
    sys.dont_write_bytecode = True
    if sys.argv[1:2] == ['--pairs'] and len(sys.argv) == 2:
        json.dump(pairs(), sys.stdout, ensure_ascii=False)
    elif sys.argv[1:2] == ['--record'] and len(sys.argv) == 3:
        findings = distinct(isolated(lambda base: read(sys.argv[2], base)))
        json.dump({'findings': findings}, sys.stdout, ensure_ascii=False, indent=1, sort_keys=True)
        sys.stdout.write('\n')
    else:
        raise SystemExit('usage: findings_before_english.py --pairs | --record FOLDER')
