"""English text the server writes for a person, kept with the phrase and the parameters it was made from.

`say('Target not found: {raw}', raw='docs/x.md')` is a `str`: the sentence the CLI, the audit report and the log
write. The app API sends `phrase` and `params` next to it (`spelled`), for the interface to translate. A parameter
is written as it is, never interpreted: a path with `{`, `%` or quotes stays whole. How to write one:
CONTRIBUTING.md, section "Texto do servidor".
"""
from __future__ import annotations

import re

PLACEHOLDER = re.compile(r'\{([A-Za-z]\w*)\}')
# A stored phrase (app state, saved reference) is untrusted when read back: bounded before it is used.
MAX_DEPTH = 4
MAX_PARAMS = 32
MAX_LENGTH = 8192


class Text(str):
    """The English sentence of `phrase` with its `params` filled in."""

    def __new__(cls, phrase, params=None):
        params = dict(params or {})
        self = super().__new__(cls, PLACEHOLDER.sub(lambda match: str(params[match[1]]) if match[1] in params else match[0], phrase))
        self.phrase, self.params = phrase, params
        return self

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self

    def __reduce__(self):
        return Text, (self.phrase, self.params)

    def mapped(self, change):
        """The same phrase with `change` applied to each text parameter (a text inside it, to its own)."""
        if hasattr(self, 'number'):
            return self
        return Text(self.phrase, {name: value.mapped(change) if is_text(value) else change(value) if isinstance(value, str) else value
                                  for name, value in self.params.items()})


def say(phrase, /, **params):
    """The sentence of `phrase`, each `{name}` replaced by its parameter."""
    return Text(phrase, params)


def plural(count, one, other, /, **params):
    """`one` when `count` is 1, else `other`; `{count}` is the count."""
    return Text(one if count == 1 else other, {'count': count, **params})


def number(value):
    """An integer with thousands separators, as a parameter: `5,000` here, `5.000` in a Portuguese interface."""
    result = Text(f'{value:,}')
    result.number = value
    return result


def is_text(value):
    """Whether `value` was made by `say` (by its fields: the server is imported both as a package and flat)."""
    return isinstance(value, str) and isinstance(getattr(value, 'phrase', None), str) and isinstance(getattr(value, 'params', None), dict)


def of(exc):
    """What an exception says: the text it was raised with, else its message."""
    return exc.args[0] if len(exc.args) == 1 and is_text(exc.args[0]) else str(exc)


def wire(value):
    """{phrase, params?} of a text, as the API and the app state write it; a text parameter is written alike,
    a `number` as {number}, and an `earlier` sentence with it ({phrase, earlier})."""
    if type(getattr(value, 'number', None)) is int:
        return {'number': value.number}
    params = {name: wire(item) if is_text(item) else item if item is None or type(item) in (bool, int, float) else str(item)
              for name, item in value.params.items()}
    saved = getattr(value, 'earlier', None)
    return {'phrase': str(value.phrase), **({'params': params} if params else {}), **({'earlier': saved} if type(saved) is str else {})}


def unwire(value, depth=0):
    """The text of a `wire` read back from disk, or None when it is not one (wrong types, too deep, too long)."""
    if type(value) is dict and set(value) == {'number'} and type(value['number']) is int and depth:
        return number(value['number'])
    if type(value) is not dict or set(value) - {'phrase', 'params'} or depth > MAX_DEPTH:
        return None
    phrase, params = value.get('phrase'), value.get('params', {})
    if type(phrase) is not str or len(phrase) > MAX_LENGTH or type(params) is not dict or len(params) > MAX_PARAMS:
        return None
    restored = {}
    for name, item in params.items():
        if type(name) is not str or len(name) > 100:
            return None
        if type(item) is dict:
            item = unwire(item, depth + 1)
            if item is None:
                return None
        elif not (item is None or type(item) in (bool, int) or (type(item) is str and len(item) <= MAX_LENGTH)
                  or (type(item) is float and item == item and abs(item) != float('inf'))):
            return None
        restored[name] = item
    return Text(phrase, restored)


EARLIER = 'reason recorded by an earlier version of the app'


def earlier(sentence):
    """The text for a sentence saved without its phrase (in Portuguese, by an earlier server): EARLIER, carrying
    the saved sentence (`wire`) for a Portuguese interface to show as it came. Nothing reads the saved sentence."""
    text = say(EARLIER)
    text.earlier = sentence
    return text


def restored(sentence, value):
    """The text `value` wires, when it reads exactly as `sentence` (saved with it); else `earlier(sentence)`."""
    found = unwire(value)
    return found if found is not None and str(found) == sentence else earlier(sentence)


def spelled(data, skip=frozenset()):
    """An API answer with the phrase of each text next to it: `message` gets `messagePhrase`.

    Only a text with parameters gets one: without them the sentence is its own phrase. A list of texts gets
    a list alike (`restoreErrors` and `restoreErrorsPhrase`), with None for an item without parameters.
    `skip` names keys whose values hold no text (the nodes and relations of a model), not walked.
    """
    if type(data) is list:
        return [spelled(item, skip) for item in data]
    if type(data) is not dict:
        return data
    result = {}
    for key, value in data.items():
        if type(value) is dict or (type(value) is list and key not in skip):
            result[key] = spelled(value, skip)
            if type(value) is list and any(is_text(item) and item.params for item in value):
                result[f'{key}Phrase'] = [wire(item) if is_text(item) and item.params else None for item in value]
        else:
            result[key] = value
            if is_text(value) and value.params:
                result[f'{key}Phrase'] = wire(value)
    return result
