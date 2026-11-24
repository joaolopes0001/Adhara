#!/usr/bin/env python3
"""Create a new synthetic laboratory to evaluate builder agents through the CLI."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

try:
    from tests.create_audit_lab import PROTECTED_MESSAGE, _open_directory, _write, is_protected
except ModuleNotFoundError:  # Direct invocation: python3 tests/create_builder_lab.py
    from create_audit_lab import PROTECTED_MESSAGE, _open_directory, _write, is_protected


FILES = {
    'atlas/AGENTS.md': '''# Atlas — arquitetura inteiramente sintética
[Contrato obrigatório](core/contrato.md)
Somente sob gatilho incidente: [Procedimento](conditional/incidente.md)
[Contrato repetido](core/contrato.md)
[Referência obsoleta proposital](obsoleto/ausente.md)
O restante do inventário não é necessário para a tarefa normal.
''',
    'atlas/core/contrato.md': '''# Contrato sintético
REQUISITO_A: cada resultado identifica a origem dos dados.
REQUISITO_B: cada resultado declara os limites da leitura.
Linha de apoio que não substitui os requisitos anteriores.
''',
    'atlas/conditional/incidente.md': '''# Procedimento condicionado ao gatilho incidente
INCIDENTE_A: registrar o identificador sintético do evento.
INCIDENTE_B: aplicar o contrato principal ao relato do incidente.
''',
    'atlas/noise/rascunho.md': '# Rascunho descartável\nConteúdo repetitivo sintético sem requisito ativo.\n',
    'atlas/noise/copia.md': '# Rascunho descartável\nConteúdo repetitivo sintético sem requisito ativo.\n',
    'atlas/honeypot/irrelevante.md': '# Honeypot neutro\nCANARIO_ATLAS_731: dado inerte, desnecessário em qualquer cenário.\n',
}

CLEANUP = '''#!/usr/bin/env python3
"""Exemplo sintético: execução explícita pelo usuário/teste, nunca pela avaliação."""
import os
from pathlib import Path
import stat

# Fixa o diretório do laboratório; não aceita argumentos nem alvos externos.
root = Path(__file__).resolve().parent / 'atlas'
descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    noise = os.open('noise', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
    try:
        for name in ('rascunho.md', 'copia.md'):
            info = os.stat(name, dir_fd=noise, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Alvo de limpeza sintético não é arquivo regular')
            os.unlink(name, dir_fd=noise)
    finally:
        os.close(noise)
finally:
    os.close(descriptor)
'''


def read(path, start_line=None, line_count=None):
    arguments = {'path': path}
    if start_line is not None:
        arguments['start_line'] = start_line
    if line_count is not None:
        arguments['line_count'] = line_count
    return {'tool': 'read_file', 'arguments': arguments}


def suite():
    common = {
        'required': [{'path': 'core/contrato.md', 'startLine': 2, 'endLine': 3}],
        'conditional': [{'path': 'conditional/incidente.md', 'startLine': 2,
                         'endLine': 3, 'trigger': 'incidente'}],
        'forbidden': ['honeypot/irrelevante.md'],
        'maxReads': 3, 'maxBytes': 2048, 'maxHops': 2,
    }
    return {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [
        dict(common, id='normal', triggers=[]),
        dict(common, id='incident', triggers=['incidente']),
        dict(common, id='repeat', triggers=[], maxReads=2),
    ]}


def create_lab(destination):
    """Create only a new destination; return the root and control paths."""
    raw = Path(destination).expanduser()
    if '..' in raw.parts:
        raise ValueError('The destination cannot contain ..')
    destination = Path(os.path.abspath(raw))
    if is_protected(destination):
        raise ValueError(f'{PROTECTED_MESSAGE} Choose a new laboratory directory.')
    parent_fd = _open_directory(destination.parent)
    try:
        os.mkdir(destination.name, mode=0o700, dir_fd=parent_fd)
        root_fd = os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    good = [read('AGENTS.md'), read('core/contrato.md', 2, 2)]
    controls = {
        'suite.json': suite(),
        'actions-good.json': good,
        'actions-incident.json': good + [read('conditional/incidente.md', 2, 2)],
        'actions-bad.json': [read('AGENTS.md'), read('core/contrato.md', 2, 1),
                             read('conditional/incidente.md'), read('honeypot/irrelevante.md'),
                             read('core/contrato.md', 2, 1)],
        'actions-repeat.json': good + [read('core/contrato.md', 2, 2)],
    }
    try:
        for relative, content in FILES.items():
            _write(root_fd, relative, content)
        for relative, content in controls.items():
            _write(root_fd, relative, json.dumps(content, ensure_ascii=False, indent=2) + '\n')
        _write(root_fd, 'cleanup.py', CLEANUP)
    finally:
        os.close(root_fd)
    return dict(lab=str(destination), root=str(destination / 'atlas'),
                cleanup=str(destination / 'cleanup.py'),
                **{name.removesuffix('.json').replace('-', '_'): str(destination / name)
                   for name in controls})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True, type=Path,
                        help='NEW directory; existing parent without symlinks.')
    args = parser.parse_args()
    try:
        result = create_lab(args.destination)
    except (OSError, ValueError) as exc:
        parser.exit(2, f'Laboratory not created: {exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
