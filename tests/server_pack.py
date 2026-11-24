"""The Portuguese of the server texts as the interface words them, for the tests.

`block()` reads the `ptBRServer` block at the end of src/i18n/pt-BR.ts and `interface()` the pack of the
interface above it; `pack()` is what a server phrase is looked up in (the block, then the interface pack,
which already has some of the same sentences). `portuguese()` applies the rule of src/serverText.ts: the
phrase of the pack with its parameters, a text parameter worded on its own, a number written for the
language, a sentence an earlier server saved (`earlier`) as it came, and English for what the pack does not have. A test that states the Portuguese a
person reads goes through here, so the pack is checked with the sentences the server really writes.
"""
import re
from functools import lru_cache
from pathlib import Path

PACK_FILE = Path(__file__).resolve().parent.parent / 'src' / 'i18n' / 'pt-BR.ts'
BLOCK = 'export const ptBRServer: Pack = {'
INTERFACE = 'export const ptBR: Pack = {'
PLACEHOLDER = re.compile(r'\{([A-Za-z]\w*)\}')
ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', "'": "'", '"': '"', '`': '`'}


def _strings(source):
    """Every string literal of a piece of TypeScript, in order, comments skipped."""
    position, found = 0, []
    while position < len(source):
        char = source[position]
        if source.startswith('//', position):
            position = source.find('\n', position) if '\n' in source[position:] else len(source)
        elif char in '\'"':
            value, position = [], position + 1
            while source[position] != char:
                if source[position] == '\\':
                    escape = source[position + 1]
                    if escape == 'u':
                        value.append(chr(int(source[position + 2:position + 6], 16)))
                        position += 6
                        continue
                    value.append(ESCAPES[escape])
                    position += 2
                else:
                    value.append(source[position])
                    position += 1
            found.append(''.join(value))
            position += 1
        else:
            position += 1
    return found


def _entries(start):
    """{English phrase: Portuguese} of the object literal that starts at `start`; a phrase written twice is an error."""
    source = PACK_FILE.read_text(encoding='utf-8')
    body = source[source.index(start) + len(start):]
    body = body[:body.index('\n};')]
    strings = _strings(body)
    if len(strings) % 2:
        raise ValueError(f'{start} is not a list of "phrase": "translation" entries')
    entries = dict(zip(strings[::2], strings[1::2]))
    if len(entries) != len(strings) // 2:
        raise ValueError(f'a phrase is written twice in {start}')
    return entries


@lru_cache(maxsize=1)
def block():
    """The server block of the pack."""
    return _entries(BLOCK)


@lru_cache(maxsize=1)
def interface():
    """The pack of the interface (the phrases of `t()`, `plural()` and `rich()`)."""
    return _entries(INTERFACE)


@lru_cache(maxsize=1)
def pack():
    """Where a server phrase is looked up: the server block, then the interface pack."""
    return {**interface(), **block()}


def _fill(template, values):
    return PLACEHOLDER.sub(lambda match: values[match[1]] if match[1] in values else match[0], template)


def _number(value):
    return f'{value:,}'.replace(',', '.')


def _worded(wire):
    if set(wire) == {'number'}:
        return _number(wire['number'])
    if isinstance(wire.get('earlier'), str):
        return wire['earlier']
    values = {name: _worded(value) if isinstance(value, dict) else str(value) for name, value in wire.get('params', {}).items()}
    return _fill(pack().get(wire['phrase'], wire['phrase']), values)


def portuguese(text, phrase=None):
    """What a Portuguese interface shows for a sentence of the server.

    `text` is a text of the server (`texts.say`), or the English sentence of an API answer with its `phrase`
    (the `<key>Phrase` next to it, None when the answer has none).
    """
    if phrase is None and getattr(text, 'phrase', None) is not None:
        if isinstance(getattr(text, 'number', None), int):
            return _number(text.number)
        phrase = _wire(text)
    if phrase is not None:
        return _worded(phrase)
    return pack().get(str(text), str(text))


def _wire(value):
    if isinstance(getattr(value, 'number', None), int):
        return {'number': value.number}
    if getattr(value, 'phrase', None) is not None:
        return {'phrase': value.phrase, 'params': {name: _wire(item) for name, item in value.params.items()},
                **({'earlier': value.earlier} if isinstance(getattr(value, 'earlier', None), str) else {})}
    return value


def english(phrase):
    """The English sentence a phrase of an API answer stands for: its parameters filled in, as the server writes it."""
    if set(phrase) == {'number'}:
        return f'{phrase["number"]:,}'
    values = {name: english(value) if isinstance(value, dict) else str(value) for name, value in phrase.get('params', {}).items()}
    return _fill(phrase['phrase'], values)
