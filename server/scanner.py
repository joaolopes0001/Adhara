"""Read-only, bounded filesystem -> architecture model. No model inference."""
from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import stat
import traceback
from array import array
from bisect import bisect_left, bisect_right
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from statistics import median_low
from urllib.parse import unquote, urlsplit

try:
    from .scope import Declaration, validate_scope
    from .texts import of, say
except ImportError:
    from scope import Declaration, validate_scope
    from texts import of, say

EXCLUDED = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.cache', '.next', '.local-state', '.tmp-suites', '.pytest_cache', 'coverage'}
TEXT = {'.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml'}
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_FILES = 20000
# Opened roots per reading: the workspace, the CLI and imported reports share this limit.
MAX_ROOTS = 12
# Past MAX_FILES the walk goes on with names only (no node, no file opened) so that
# a reference into the unread part is checked by existence: up to this many elements per reading.
MAX_LOOKUP = 200_000
MAX_BYTES = 1024 * 1024
MAX_TEXT_TOTAL = 32 * 1024 * 1024
MAX_EDGES = 100_000
ENTRY = {'AGENTS.md', 'CLAUDE.md'}
HIGH_FANOUT = 12
DOCUMENTS = {'.md', '.markdown', '.txt'}
MAX_CANDIDATES = 20
# frontmatter-name: a wikilink `[[x]]` resolved by the one file whose frontmatter declares `name: x`.
# root-dot: a `./x` path mention (backticks or prose) found from the opened root, not from its file.
RESOLUTION_MODES = ('file', 'frontmatter-name', 'skill', 'root', 'root-dot', 'skill-basename', 'skill-suffix', 'basename', 'suffix')
MARKDOWN = {'.md', '.markdown'}
# Frontmatter header bound, delimiters included: past it (or without a closing line) there is none.
FRONTMATTER_MAX_LINES = 200
FRONTMATTER_MAX_BYTES = 16 * 1024
# Plain YAML scalars that denote null, not a name. Numbers and booleans keep their written text.
YAML_NULL = {'~', 'null', 'Null', 'NULL'}
# `file.ext::id` (a test id): the address is the shortest prefix ending in an extension.
TEST_ID = re.compile(r'(.*?\.[^\W_]+)::')
EXTENSION = re.compile(r'\.[^\W_]+$')
# A missing destination whose written form is listed for its syntax is a name, not a
# broken path: unresolved-name. Wiki, @import, manifest and declared stay broken.
NAME_FORMS = {'path': {'name', 'word'}, 'markdown': {'word'}, 'markdown-reference': {'word'}}
# A destination missing after every step is probed above the outermost opened root of its
# source (existence only, never content): at most this many ancestors, stopping at one with .git.
PROBE_LEVELS = 3
# Written syntax that is not a reference: no edge, placeholder or finding, counted in stats.ignored.
IGNORED_REASONS = ('variable', 'template', 'elision', 'code', 'manifest-key', 'fenced', 'cut', 'txt', 'too-long')
# A written reference longer than this (bytes) is not resolved: no path is that long, and a
# hostile line would otherwise cost one lstat per component of every prefix.
MAX_REFERENCE_BYTES = 4096  # the address a reference names (PATH_MAX)
MAX_WRITTEN_BYTES = 64 * 1024  # the reference as written, anchor and line address included
# Headers of the Markdown the reader knows but did not analyse, read only for a bare wikilink:
# a first block, more only after `---`, all of them within this reading budget of their own.
MAX_HEADER_BYTES = 8 * 1024 * 1024
HEADER_FIRST_BLOCK = 512
HEADER_CLOSE = re.compile(rb'\n---[ \t]*\r?\n')
# JSON keys read as file references, only in files of kind manifest and in these manifests of
# other tools (their kind does not change).
MANIFEST_KEYS = {'path', 'file', 'entry', 'entrypoint', 'source', 'target', 'skills', 'instructions', 'memory', 'manifest'}
# Explicit references a manifest with `"linkedRelationships": true` compares with its relationships,
# outside fenced code blocks. The values of the checking manifest itself are never its links.
LINK_SYNTAX = frozenset({'markdown', 'markdown-reference', 'wiki', 'path', 'import', 'manifest'})
KEYED_MANIFESTS = {'marketplace.json', 'gemini-extension.json'}
# A fenced block of these languages (or without one) holds the commands an agent runs.
SHELL_LANGUAGES = {'sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'sh-session', 'shell-session', 'powershell', 'pwsh', 'fish'}
FENCE = re.compile(r' {0,3}(`{3,}|~{3,})(.*)')
# Literal template markers as a whole word of a path component: YYYY, AAAA, NN…, XX….
TEMPLATE = re.compile(r'(?<![^\W_])(?:YYYY|AAAA|N{2,}|X{2,})(?![^\W_])')
ELISION_START = re.compile(r'(?:…|\.\.\.)/')
ELISION_PARTS = {'…', '...'}
# `file.ext:41`, `:41-42`, `:2,6-9`: a line address after a file name, dropped like `::id`.
LINE_EXTENSIONS = 'md|markdown|json|yaml|yml|toml|txt|py|sh|ts|js'
# The address is matched as one character class and checked part by part (`line_address`):
# a nested repetition would keep one backtracking state per part of a hostile `:1,1,1,…`.
LINE_SUFFIX = re.compile(rf'(.*\.(?:{LINE_EXTENSIONS})):([\d,-]+)')
# A prose path cut by a glob, a placeholder or a variable (`ls ./out/*.md`) is not extracted.
PROSE_CUT = frozenset('*<$[{')
# Messages of `broken` and `unresolved-name`, the findings of a missing destination. An absence
# that is not verifiable (`unverified`) or found above the root (`outside-root`) also carries
# `legacyId`, the id it has as `broken` or `unresolved-name`, computed from these messages.
LEGACY_MESSAGES = {'broken': 'Target not found: {raw}',
                   'unresolved-name': 'A name written without a folder matches no inventoried file: {raw}. '
                                      'It may be a runtime artifact, an example or a placeholder; it is not treated as a broken path.'}
# The inventory limit of a root, by (the count left out is a minimum, entry or skill files were left out).
INVENTORY_LIMIT = {
    (False, False): 'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; '
                    'folders not read: {unread}; items left out of the inventory: {omitted}. '
                    'The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. '
                    'Open a subfolder for a complete scan.',
    (True, False): 'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; '
                   'folders not read: {unread}; items left out of the inventory: at least {omitted}. '
                   'The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. '
                   'Open a subfolder for a complete scan.',
    (False, True): 'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; '
                   'folders not read: {unread}; items left out of the inventory: {omitted}. '
                   'Entry or skill files (AGENTS.md, CLAUDE.md, SKILL.md) left out: {entries}, such as {example}. '
                   'The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. '
                   'Open a subfolder for a complete scan.',
    (True, True): 'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; '
                  'folders not read: {unread}; items left out of the inventory: at least {omitted}. '
                  'Entry or skill files (AGENTS.md, CLAUDE.md, SKILL.md) left out: {entries}, such as {example}. '
                  'The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. '
                  'Open a subfolder for a complete scan.',
}
# Outcomes that keep a reference whose written form is doubtful (variable, template, elision,
# fenced code): its destination exists or a declaration absorbs it. Any other outcome would be
# a finding (or an edge to nowhere) about text that is not a reference, so it is ignored.
KEEP = {'resolved', 'unscanned', 'declared'}
# One placeholder serves several references: the strongest status stays.
PLACEHOLDER_RANK = {'declared': 0, 'unverified': 1, 'missing': 2}


class Candidates(list):
    """Candidates listed (at most MAX_CANDIDATES: the inventoried ones first, by path, then those seen
    only by name) with how many there are in all (`total`) and how many lie past the inventory (`hidden`)."""

    def __init__(self, listed, total, hidden):
        super().__init__(listed)
        self.total, self.hidden = total, hidden


EXCERPT = 500  # characters of the evidence of a reference


def excerpt(stripped, at, size):
    """The evidence of a reference written at `at` (`size` characters) in a line without its outer
    whitespace: the line itself up to EXCERPT characters; past that, a window of at most EXCERPT
    characters, `…` on each cut end, that starts up to 200 characters before the reference and
    holds all of it when it fits. Cost bounded by EXCERPT, never by the line."""
    if len(stripped) <= EXCERPT:
        return stripped
    at = min(max(at, 0), len(stripped))
    start = max(0, at - 200)
    if at + size > start + EXCERPT - 2:
        start = min(at, max(0, at + size - (EXCERPT - 2)))
    end = start + EXCERPT - (start > 0)
    if end < len(stripped):
        end -= 1
    return ('…' if start > 0 else '') + stripped[start:end] + ('…' if end < len(stripped) else '')


# A reference definition line: `[label]: destination`, then nothing or what starts as a title
# (`"`, `'` or `(`, which may hold escapes or go on to the next line). Running text after the
# destination (`[guide]: read it first.`) makes it prose, not a definition.
DEFINITION = re.compile(r'\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+["\'(].*)?\s*')
# A link destination as written after `](`, on that line or the next: what the manifest check looks for
# when the extractor read no link (a link text over several lines, a destination on the next line).
WRITTEN_DESTINATION = re.compile(r'\]\(\s*(?:<([^<>\n]+)>|((?:[^\s()]|\([^()]*\))+))')
# An inline link or image, as in CommonMark (one nested pair of parentheses allows guide_(v2).md). Every
# repeated class stops at the next opener of its own kind (bracket texts exclude '[', <destinations> exclude
# '<', titles their own delimiter): otherwise each '[', '<' or quote rescans the rest of the line, and one
# long hostile line costs minutes.
INLINE_LINK = re.compile(r'!?\[[^\[\]]*\]\(\s*(?:<([^<>]+)>|((?:[^\s()]|\([^()]*\))+))(?:\s+(?:"[^"\n]*"|\'[^\'\n]*\'|\([^()\n]*\)))?\s*\)')


def link_label(text):
    """A reference link label as CommonMark matches it: inner whitespace collapsed, case ignored."""
    return ' '.join(text.split()).casefold()


def line_address(text):
    """`41`, `41-42`, `2,6-9`: a line address after a file name."""
    return all(re.fullmatch(r'\d+(?:-\d+)?', part) for part in text.split(','))


def printable(text):
    """`text` with any lone surrogate (a JSON escape such as \\udcff) written as its escape: always valid UTF-8."""
    return text.encode('utf-8', 'backslashreplace').decode('utf-8')


def utf8(text):
    try:
        text.encode('utf-8')
    except UnicodeEncodeError:
        return False
    return True


def too_long(raw):
    """A written reference left out before any resolution (counted as `too-long`): its address above
    MAX_REFERENCE_BYTES (Linux's PATH_MAX), or the whole text, anchor and line address included, above
    MAX_WRITTEN_BYTES. A long anchor of a legitimate link stays a reference."""
    if len(raw) <= MAX_REFERENCE_BYTES // 4:
        return False
    return len(raw.encode('utf-8', 'surrogatepass')) > MAX_WRITTEN_BYTES or address_bytes(raw) > MAX_REFERENCE_BYTES


def address_bytes(raw):
    """Bytes of the address a written reference names: without its anchor (#), query (?), test id (::)
    or line address (:41), percent escapes decoded. The anchor of a legitimate link may be long;
    the address is what resolution walks. A lone surrogate counts as its bytes and is reported later."""
    address = raw.strip().split('#', 1)[0].split('?', 1)[0].split('::', 1)[0]
    head, colon, tail = address.rpartition(':')
    if colon and tail and line_address(tail):
        address = head
    return len(unquote(address).encode('utf-8', 'surrogatepass'))


def code_wikilink(address):
    """A wikilink address (trimmed, before `#`) with the look of code: shell test, regex class, template.

    A date or a number (`[[2026-11-11]]`) is a note name. The rule is soft: code-like text that
    resolves is still a relation; only what would not resolve is ignored.
    """
    first = address.split(None, 1)[0] if address.strip() else ''
    return (any(char in address for char in '$"=<>{}`\\^') or re.fullmatch(r':\w+:', address) is not None
            or not any(char.isalnum() for char in address)
            # A shell test (`[[ ! -e x ]]`, `[[ -d dir ]]`) or a list of quoted keys (`df[['a','b']]`).
            or first == '!' or re.fullmatch(r'-[A-Za-z]', first) is not None or ("'" in address and ',' in address))


def soft_reason(raw, fence, form, code=False):
    """Why a reference may be text that is not a reference; it is ignored unless its outcome is in KEEP."""
    written = raw.split('#')[0]
    if code:
        return 'code'
    if '$' in raw:
        return 'variable'
    if TEMPLATE.search(written):
        return 'template'
    if any(part in ELISION_PARTS for part in written.split('/')[1:]):
        return 'elision'
    if fence == 'other' or (fence == 'shell' and form != 'path'):
        return 'fenced'
    return None


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


@contextmanager
def pinned_directory(path):
    """Descriptor of the absolute directory `path`, opened component by component from `/`.

    Each component is opened with O_NOFOLLOW relative to the descriptor of its parent,
    so a component that is (or is swapped for) a symbolic link raises OSError, and what
    is opened below the yielded descriptor stays inside the directory that was checked.
    The caller checks that `path` is absolute and normalized. The descriptor is closed on exit.
    """
    directory = os.open('/', DIRECTORY_FLAGS)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory
    finally:
        os.close(directory)


@contextmanager
def open_regular_file(path):
    """Open a regular file without following changed symlinks or blocking on FIFOs."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError(say('The file must have a normalized absolute path.'))
    with pinned_directory(path.parent) as directory:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError(say('Listed, but not read: it is not a regular file.'))
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            yield stream
    finally:
        os.close(descriptor)


def json_string_locations(text):
    """Yield string values with their JSON route and exact character offset."""
    decoder = json.JSONDecoder()
    cursor = 0

    def whitespace():
        nonlocal cursor
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1

    def value(route):
        nonlocal cursor
        whitespace()
        if text[cursor] == '{':
            cursor += 1
            whitespace()
            while text[cursor] != '}':
                key, cursor = decoder.raw_decode(text, cursor)
                whitespace()
                cursor += 1  # colon; caller has already validated the JSON
                yield from value((*route, key))
                whitespace()
                if text[cursor] != ',':
                    break
                cursor += 1
                whitespace()
            cursor += 1
        elif text[cursor] == '[':
            cursor += 1
            whitespace()
            index = 0
            while text[cursor] != ']':
                yield from value((*route, index))
                index += 1
                whitespace()
                if text[cursor] != ',':
                    break
                cursor += 1
                whitespace()
            cursor += 1
        else:
            offset = cursor
            item, cursor = decoder.raw_decode(text, cursor)
            if isinstance(item, str):
                yield route, item, offset

    yield from value(())


def within(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def below(path: str, root: str):
    """POSIX path of a normalized absolute id strictly below root, else None (lexical, no I/O)."""
    prefix = root if root.endswith('/') else root + '/'
    return path[len(prefix):] if path.startswith(prefix) else None


def identity(*parts):
    return hashlib.sha256('\0'.join(map(str, parts)).encode()).hexdigest()[:20]


def kind(path, parts=None):
    """Physical kind. `parts` are the components seen from the opened root (its own
    name included), so directories above the root never classify a copy differently."""
    if path.name in ENTRY:
        return 'entry'
    if path.name == 'SKILL.md':
        return 'skill'
    if path.name in {'agent-architecture.json', '.mcp.json', 'plugin.json', 'manifest.json'}:
        return 'manifest'
    if any(p.lower() in {'memory', 'memoria', 'memória', 'memories'} for p in (path.parts if parts is None else parts)):
        return 'memory'
    return 'file'


# Body of a YAML quoted scalar up to its closing quote (or the end of the line). The
# alternatives start with different characters and nothing follows the repetition, so a
# match never backtracks: linear even on a hostile line of backslashes or quotes.
QUOTED_BODY = {'"': re.compile(r'(?:[^"\\]|\\.)*'), "'": re.compile(r"(?:[^']|'')*")}
FLOW_SIGNIFICANT = re.compile(r'["\'\[\]{}#]')
MAX_FLOW_DEPTH = 64


def _advance(text, quote, depth):
    """Follow a YAML quoted scalar or flow collection through `text`, from state (quote, depth).

    Returns (quote, depth, end): `end` is the index just after the character that closes
    the value, or None when the value continues on the next line. A flow collection
    nested deeper than MAX_FLOW_DEPTH is malformed for this reader: (None, -1, None).
    """
    index = 0
    while True:
        if quote is not None:
            index = QUOTED_BODY[quote].match(text, index).end()
            if index >= len(text) or text[index] != quote:
                return quote, depth, None  # continues on the next line (a final `\` escapes the break)
            index, quote = index + 1, None
            if not depth:
                return None, 0, index
            continue
        found = FLOW_SIGNIFICANT.search(text, index)
        if found is None:
            return None, depth, None
        char, at = found[0], found.start()
        index = at + 1
        if char in '[{':
            depth += 1
            if depth > MAX_FLOW_DEPTH:
                return None, -1, None
        elif char in ']}':
            depth -= 1
            if depth <= 0:
                return None, 0, index
        elif char == '#':
            if at == 0 or text[at - 1] in ' \t':
                return None, depth, None  # a comment runs to the end of the line
        else:
            # Inside a flow collection a quote opens a scalar only where an item starts:
            # after `[`, `{`, `,` or `:` (spaces aside) or at the start of a line.
            back = at - 1
            while back >= 0 and text[back] in ' \t':
                back -= 1
            if back < 0 or text[back] in '[{,:':
                quote = char


def _unescape(match, invalid):
    if match[1] not in '\\"/':
        invalid.append(match[1])
    return match[1]


def _scalar(value):
    """Text of a scalar written on one line after `name:`, or None (empty, null, collection, block, multiline)."""
    if not value:
        return None
    first = value[0]
    if first in '"\'':
        _, _, end = _advance(value[1:], first, 0)
        if end is None:
            return None
        rest = value[1 + end:]
        trailing = rest.lstrip(' \t')
        if trailing and not (trailing[0] == '#' and len(trailing) < len(rest)):
            return None
        text = value[1:end]
        if first == "'":
            text = text.replace("''", "'")
        elif '\\' in text:
            # Only \\, \" and \/ are understood; any other escape leaves the file without identity.
            invalid = []
            text = re.sub(r'\\(.)', lambda match: _unescape(match, invalid), text)
            if invalid:
                return None
        return text.strip(' \t') or None
    # Indicators that cannot start a plain scalar: collections, block scalars, anchors, aliases, tags.
    if first in '[]{}#&*!|>%@`,' or (first in '-?:' and (len(value) == 1 or value[1] in ' \t')):
        return None
    comment = re.search(r'[ \t]#', value)
    text = (value[:comment.start()] if comment else value).strip(' \t')
    # `name: a: b` is not a scalar in YAML.
    if re.search(r':(?:[ \t]|$)', text) or text in YAML_NULL:
        return None
    return text or None


def declared_name(text):
    """Identity declared by a Markdown frontmatter (`name:`), or None. Never raises.

    Minimal and bounded reader of untrusted input, not a YAML parser; rules in docs/modelo-e-leitura.md,
    section "Wikilinks e identidade declarada". Quoted values and flow collections that continue on later
    lines are followed, so a `name:` inside them is never a key.
    """
    head = text[:FRONTMATTER_MAX_BYTES + 1]  # characters never outnumber bytes
    size = 0
    if head.startswith('\ufeff'):
        head, size = head[1:], 3
    lines = head.split('\n', FRONTMATTER_MAX_LINES)
    if lines[0].rstrip(' \t') != '---':
        return None
    size += len(lines[0].encode())
    state, names = None, []
    for line in lines[1:FRONTMATTER_MAX_LINES]:
        size += 1 + len(line.encode())
        if size > FRONTMATTER_MAX_BYTES:
            return None
        if line.rstrip(' \t') == '---':
            return names[0] if state is None and len(names) == 1 else None
        if state is not None:
            quote, depth, end = _advance(line, *state)
            if depth < 0:
                return None
            state = None if end is not None else (quote, depth)
            continue
        if not line or line[0] in ' \t#':
            continue  # nested key, continuation of a plain or block scalar, comment
        colon = re.search(r':(?=[ \t]|$)', line)
        if colon is None:
            continue
        key, value = line[:colon.start()], line[colon.end():].strip(' \t')
        if value[:1] in {'"', "'", '[', '{'}:
            quote, depth, end = _advance(value[1:], value[0], 0) if value[0] in '"\'' else _advance(value, None, 0)
            if depth < 0:
                return None
            if end is None:
                state = (quote, depth)
        if key == 'name':
            names.append(_scalar(value) if state is None else None)
    return None


def references(text, suffix, manifest=True, ignored=None):
    """Explicit Markdown destinations, reference links, wiki links, @imports and paths.

    Bare filenames in prose are intentionally not guessed. With `manifest`, the paths of a
    JSON manifest come out too (syntax 'manifest'). Yields (raw, syntax, line, evidence);
    `extract` adds the fenced-block context. The scanner calls `extract`; this is the
    extractor's test entry.
    """
    for raw, source, line, evidence, _, _ in extract(text, suffix, manifest, ignored):
        yield raw, source, line, evidence


def fence_contexts(lines):
    """Context of each line of a Markdown text: None, 'shell', 'other' or 'fence' (the fence lines).

    Fence rules: docs/modelo-e-leitura.md, section "Sintaxe que não é referência" (`fenced`). A fence
    that never closes is no block, so it never silences the rest. Linear: for each character and indent
    limit, the longest closer after each line is known in advance, and a block is entered only when it closes.
    """
    count = len(lines)
    closers = [None] * count
    for index, line in enumerate(lines):
        stripped = line.strip()
        if len(stripped) >= 3 and stripped[0] in '`~' and stripped.count(stripped[0]) == len(stripped):
            expanded = line.expandtabs(4)
            closers[index] = (stripped[0], len(stripped), len(expanded) - len(expanded.lstrip()))
    # An opening has 0 to 3 spaces of indent, so a closer counts for the limits 3 to 6.
    longest = {(char, limit): [0] * (count + 1) for char in '`~' for limit in range(3, 7)}
    for index in range(count - 1, -1, -1):
        for values in longest.values():
            values[index] = values[index + 1]
        if closers[index]:
            char, size, indent = closers[index]
            for limit in range(max(3, indent), 7):
                values = longest[(char, limit)]
                values[index] = max(values[index], size)
    contexts = [None] * count
    index = 0
    while index < count:
        marker = FENCE.fullmatch(lines[index])
        if marker:
            char, size = marker[1][0], len(marker[1])
            limit = len(lines[index]) - len(lines[index].lstrip(' ')) + 3
        if marker and not (char == '`' and '`' in marker[2]) and longest[(char, limit)][index + 1] >= size:
            info = marker[2].strip().split(None, 1)
            language = info[0].strip('{}.').lower() if info else ''
            context = 'shell' if not language or language in SHELL_LANGUAGES else 'other'
            contexts[index] = 'fence'
            index += 1
            while not (closers[index] and closers[index][0] == char and closers[index][1] >= size and closers[index][2] <= limit):
                contexts[index] = context
                index += 1
            contexts[index] = 'fence'
        index += 1
    return contexts


def extract(text, suffix, manifest=True, ignored=None):
    """(raw, syntax, line, evidence, fence, code) for each reference of a text.

    `fence` is None outside a fenced code block of a Markdown file, 'shell' inside a
    shell block (or one without a language) and 'other' inside a block of another
    language; `code` marks a wikilink with the look of code. The scanner decides what a
    reference there becomes. What this function leaves out is counted in `ignored`:
    `cut`, `too-long`, `manifest-key` (`manifest` false) and `txt` (a `.txt` is data:
    only Markdown links, reference links and @imports count).
    """
    ignored = {} if ignored is None else ignored

    def skip(reason):
        ignored[reason] = ignored.get(reason, 0) + 1

    lower = suffix.lower()
    data = lower == '.txt'
    lines = text.splitlines()
    contexts = fence_contexts(lines) if lower in MARKDOWN else None
    # Reference definitions, as in CommonMark: a line holding only a label, a destination and at
    # most a title; the label is matched case-folded with its inner whitespace collapsed, and the
    # first definition of a label wins. One inside a fenced block is an example: it names its own
    # destination, under the rules of the block, but defines nothing.
    definitions, own = {}, {}
    for n, line in enumerate(lines, 1):
        m = DEFINITION.fullmatch(line)
        if m:
            own[n] = m[2] or m[3]
            if not (contexts and contexts[n - 1]):
                definitions.setdefault(link_label(m[1]), own[n])
    for n, line in enumerate(lines, 1):
        context = contexts[n - 1] if contexts else None
        if context == 'fence':
            continue
        seen = set()
        found = []
        for m in INLINE_LINK.finditer(line):
            found.append((m[1] or m[2], 'markdown', m.start(1) if m[1] else m.start(2)))
        # A definition line names its own destination, even when an earlier definition of
        # the same label is the one its uses follow; its label is not a use.
        definition = DEFINITION.fullmatch(line) if n in own else None
        if definition:
            found.append((own[n], 'markdown-reference', definition.start(2) if definition[2] else definition.start(3)))
        for m in re.finditer(r'(?<!!)\[([^\[\]]+)\](?:\[([^\[\]]*)\])?(?!\()', line):
            if definition and m.start() == definition.start(1) - 1:
                continue
            label = link_label(m[2] or m[1])
            if label in definitions:
                found.append((definitions[label], 'markdown-reference', m.start()))
        codes = set()
        for m in re.finditer(r'\[\[([^\[\]|]+)(?:\|[^\[\]]+)?\]\]', line):
            content = m[1]
            # `[[guia\|alias]]` in a table: the backslash escapes the pipe, it is not part of the name.
            if content.endswith('\\') and len(m[0]) > len(content) + 4:
                content = content[:-1]
            content = content.strip()
            if not content:
                continue
            if code_wikilink(content.split('#')[0].strip()):
                codes.add(content)
            found.append((content, 'wiki', m.start(1)))
        for m in re.finditer(r'`([^`\n]+)`', line):
            raw = m[1].strip()
            at = m.start(1) + len(m[1]) - len(m[1].lstrip())
            if too_long(raw):
                skip('too-long')
                continue
            if re.search(r'\s', raw):
                # `../x.md §3.2`: a file path followed by a section marker names that file.
                # Only the section marker allows a second token (`python3 x.py --flag` is a command).
                parts = raw.split(None, 1)
                if len(parts) != 2 or not parts[1].startswith('§'):
                    continue
                raw = parts[0]
            # A test id (`dir/test_x.py::TestA::t_b`) names its file; resolve() drops the id.
            # No branch of the name form admits whitespace: splitting it off first keeps one long
            # hostile span (`a.md#a.md#… x`) linear instead of quadratic backtracking.
            # A line address (`x.md:41`, `x.py:2,6-9`) names its file, like a test id.
            named = re.fullmatch(rf'[^\s]+\.(?:{LINE_EXTENSIONS})(?:#[^\s]+|::[^\s]+|:([\d,-]+))?', raw)
            if named and named[1] is not None and not line_address(named[1]):
                named = None
            if named or (re.match(r'^(?:\./|\.\./|~/|/)', raw) and not re.search(r'[=*{}<>]', raw)):
                found.append((raw, 'path', at))
        for m in re.finditer(r'(?:^|\s)@((?:[\w.~/-]+/)?[\w.-]+\.(?:md|txt|json))', line):
            found.append((m[1], 'import', m.start(1)))
        # Unquoted explicit relative/home/absolute paths, outside Markdown spans. A match
        # never starts inside a path token: after `.`, `../x.md` would yield `./x.md`.
        # A leading elision (`…/a/b.py`, `.../a/b.py`) is part of the written path.
        url_spans = [m.span() for m in re.finditer(r'\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s<>`]+', line)]
        for m in re.finditer(r'(?<![\w`(/.])((?:…|\.\.\.)/[\w./-]+|(?:\./|\.\./|~/)[\w./-]+|/[\w.-]+/[\w./-]+)', line):
            if any(start <= m.start() < end for start, end in url_spans):
                continue
            if too_long(m[1]):
                skip('too-long')
                continue
            if not any(m[1] in raw for raw, _, _ in found):
                raw = m[1].rstrip('.,;:')
                # Cut by a glob, a placeholder or a variable (`ls ./out/*.md`): the match ends
                # before a file name. One that ends with an extension is a file (`./a.md[1]`).
                if line[m.end():m.end() + 1] in PROSE_CUT and not re.search(r'\.\w+$', raw):
                    if not data:
                        skip('cut')
                    continue
                found.append((raw, 'path', m.start(1)))
        stripped = line.strip() if found else ''
        lead = len(line) - len(line.lstrip()) if found else 0
        for raw, source, at in found:
            if raw not in seen:
                seen.add(raw)
                if data and source in {'wiki', 'path'}:
                    skip('txt')
                    continue
                yield raw, source, n, excerpt(stripped, at - lead, len(raw)), context, source == 'wiki' and raw in codes
    if lower == '.json':
        try:
            json.loads(text)
        except ValueError:
            return
        newlines = [match.start() for match in re.finditer('\n', text)]
        for route, value, offset in json_string_locations(text):
            key = next((part for part in reversed(route) if isinstance(part, str)), '')
            if key in MANIFEST_KEYS and value and not value.startswith('-'):
                if not manifest:
                    skip('manifest-key')
                    continue
                # `key: value`, through the same window as a line: a long value stays within EXCERPT.
                yield value, 'manifest', bisect_right(newlines, offset) + 1, excerpt(f'{key}: {value}', len(key) + 2, len(value)), None, False


def structural_observations(edges, signal, endpoints=frozenset()):
    """Bounded O(V + E) structural signals of explicit references, never runtime claims.

    Returns counts for stats.structure. A file citing itself is counted, not signalled.
    A relationship of a manifest is no citation: its declared edge and the evidence of its
    `source` and `target` values (`endpoints`: (origin, line, raw) of those values) never count
    as a location of a repeated reference. They still count for cycles (whose evidence may be one of
    them) and fan-out.
    """
    adjacency, reverse, pairs = {}, {}, {}
    for edge in edges:
        if edge['kind'] == 'scope':
            continue
        source, target = edge['source'], edge['target']
        adjacency.setdefault(source, set()).add(target)
        adjacency.setdefault(target, set())
        reverse.setdefault(target, set()).add(source)
        reverse.setdefault(source, set())
        pairs.setdefault((source, target), []).append(edge)
    structure = {'cycles': 0, 'selfReferences': sum(source in targets for source, targets in adjacency.items()),
                 'repeatedReferences': 0, 'highFanout': 0, 'fanoutThreshold': HIGH_FANOUT, 'maxFanout': None}
    for (source, target), references_ in pairs.items():
        # Different relation kinds/declarations can intentionally share a target.
        # Count distinct evidence locations, not duplicate extractor detections.
        counted = [edge for edge in references_
                   if edge['kind'] != 'declared' and (edge['origin'], edge['line'], edge.get('raw')) not in endpoints]
        locations = {(edge['origin'], edge['line']) for edge in counted}
        if len(locations) >= 2:
            structure['repeatedReferences'] += 1
            first = counted[0]
            signal('repeated-reference', say('Reference repeated in {count} evidence locations: {source} → {target}. It may be intentional; it does not prove runtime noise.',
                                              count=len(locations), source=Path(source).name, target=target), first['origin'], first['line'], len(locations), to=target)
    for source, targets in adjacency.items():
        if targets and (structure['maxFanout'] is None or (-len(targets), source) < (-structure['maxFanout']['count'], structure['maxFanout']['node'])):
            structure['maxFanout'] = {'node': source, 'count': len(targets)}
        if len(targets) >= HIGH_FANOUT:
            structure['highFanout'] += 1
            signal('high-fanout', say('Concentration of references: {count} distinct explicit targets (threshold: {threshold}). Review the organization; a count does not prove inefficiency.',
                                       count=len(targets), threshold=HIGH_FANOUT), source, None, len(targets))

    # Iterative Kosaraju avoids Python recursion limits on long instruction chains.
    seen, finished = set(), []
    for start in adjacency:
        if start in seen:
            continue
        seen.add(start)
        stack = [(start, iter(adjacency[start]))]
        while stack:
            current, neighbors = stack[-1]
            neighbor = next(neighbors, None)
            if neighbor is None:
                finished.append(current)
                stack.pop()
            elif neighbor not in seen:
                seen.add(neighbor)
                stack.append((neighbor, iter(adjacency[neighbor])))
    assigned = set()
    for start in reversed(finished):
        if start in assigned:
            continue
        component, pending = set(), [start]
        assigned.add(start)
        while pending:
            current = pending.pop()
            component.add(current)
            for neighbor in reverse[current]:
                if neighbor not in assigned:
                    assigned.add(neighbor)
                    pending.append(neighbor)
        if len(component) < 2:
            continue
        structure['cycles'] += 1
        anchor = min(component)
        target = min(adjacency[anchor] & component)
        evidence = pairs[(anchor, target)][0]
        files = [Path(node).name for node in sorted(component)[:5]]
        sample = ', '.join(files) + (', …' if len(component) > 5 else '')
        signal('cycle', say('Structural cycle: {count} files in a group with a way back through explicit references ({sample}). It does not prove repetition when an agent runs.',
                             count=len(component), sample=sample), evidence['origin'], evidence['line'], len(component), files=files)
    return structure


def account_home():
    """The home folder of the account running the reader, from the password database (not $HOME), or None."""
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError, OSError):
        return None


class InvalidInput(ValueError):
    """What was asked cannot be read as asked (roots, scope, control files, arguments): the caller's to fix."""


class ReaderError(Exception):
    """A defect during a reading. Carries only the exception type and where it was raised (file:line of
    the innermost frame in server/), never a document's content."""

    def __init__(self, exc):
        frames = traceback.extract_tb(exc.__traceback__)
        own = [frame for frame in frames if os.path.dirname(os.path.abspath(frame.filename)) == SERVER_DIR] or frames
        self.kind = type(exc).__name__
        self.where = f'{os.path.basename(own[-1].filename)}:{own[-1].lineno}' if own else 'unknown'
        super().__init__(f'{self.kind} in {self.where}')


def scan(root_strings, scope=None):
    """Scan roots. `scope` (a loaded JSON object, e.g. from --scope) replaces embedded declarations.

    A problem with what was asked raises InvalidInput (OSError for a root that cannot be resolved);
    any other failure during the reading is a defect of the reader, raised as ReaderError.
    """
    try:
        scope = validate_scope(scope) if scope is not None else None
    except ValueError as exc:
        raise InvalidInput(of(exc)) from None
    roots = list(dict.fromkeys(str(Path(p).expanduser().resolve(strict=True)) for p in root_strings))
    if len(roots) > MAX_ROOTS:
        raise InvalidInput(say('Open at most {max} folders per workspace.', max=MAX_ROOTS))
    for p in roots:
        if not utf8(p):
            shown = p.encode('utf-8', 'surrogateescape').decode('utf-8', 'backslashreplace')
            raise InvalidInput(say('Folder with a name that is not valid UTF-8: {path}', path=shown))
        if not Path(p).is_dir():
            raise InvalidInput(say('Not a folder: {path}', path=p))
    try:
        return read(roots, scope)
    except Exception as exc:
        raise ReaderError(exc) from exc


def read(roots, scope):
    """The reading of validated roots (absolute, resolved, distinct directories) with a validated scope."""
    root_paths = [Path(p) for p in roots]
    nodes, edges, issues, signals, texts, objects = {}, [], [], [], {}, []
    pending_text = []
    total_bytes = 0
    edge_keys, cut_keys = set(), set()  # cut_keys: distinct relations left out by MAX_EDGES
    def issue(code, message, node=None, line=None, **details):
        # Optional structured details never enter the id formula used by the interface.
        issues.append({'id': identity(code, message, node, line), 'code': code, 'message': message, 'node': node, 'line': line, **details})
    def signal(code, message, node=None, line=None, count=None, **details):
        # `count` (destinations, evidence locations or files) orders review lists; it never enters the id.
        # `details`: `to`, the destination of a repeated reference; `files`, the names a cycle lists (at most five).
        signals.append({'id': identity(code, message, node, line), 'code': code, 'message': message, 'node': node, 'line': line, 'count': count, **details})
    def add_node(p, typ=None, status='resolved'):
        key = str(p)
        memberships = [r for r in roots if within(p, Path(r))]
        owner = max(memberships, key=len) if memberships else None
        if key not in nodes:
            outer = min(memberships, key=len) if memberships else None
            nodes[key] = {'id': key, 'path': key, 'name': p.name or key, 'relative': str(p.relative_to(owner)) if owner else key,
                          'kind': typ or kind(p, (os.path.basename(outer), *(below(key, outer) or '').split('/')) if outer else None),
                          'status': status, 'root': owner, 'roots': memberships}
        return key
    def add_edge(source, target, typ, line=0, evidence='', raw='', origin=None, resolved_by=None, declared=None):
        key = (source, target, typ, line, origin or source, raw if typ == 'declared' else '')
        if key in edge_keys:
            return
        if len(edges) >= MAX_EDGES:
            cut_keys.add(key)
            return
        edge_keys.add(key)
        edges.append({'id': identity(*key), 'source': source, 'target': target, 'kind': typ,
                      'line': line, 'evidence': evidence, 'raw': raw, 'origin': origin or source, 'confidence': 'deterministic',
                      'resolvedBy': resolved_by, **({'declared': {'kind': declared['kind'], 'pattern': declared['pattern']}} if declared else {})})
    def walk_error(exc):
        issue('unreadable', str(exc), exc.filename)
    per_root_budget = max(1, MAX_FILES // max(1, len(root_paths)))
    # Past the inventory budget, a names-only walk. Each element not inventoried is kept as a name
    # in its folder (folder strings are shared, so a large folder costs one string per name), and
    # each regular file by name -> folder(s); full paths are built only when a reference asks.
    # Folders are keyed relative to the roots' common folder (`base`): '' is base itself, 'a/b'
    # a folder below it, so the absolute prefix is not repeated in every key. With one root (or a
    # folder of the outermost one) an inventoried folder's key is its record's `relative` string.
    lookup_dirs, lookup_names, lookup_top = {}, {}, set()
    # Folder key -> the (name, flags) of its listing that neither the inventory nor the index
    # recorded, because MAX_LOOKUP ran out while the folder was being walked.
    unlisted = {}
    # Folder key -> the flags of the names of its listing that are not valid UTF-8 (left out of the model).
    illegible = {}
    unlistable = set()  # folders whose listing failed (an `unreadable` observation on the folder)
    truncated_roots = []
    lookup = {'count': 0, 'complete': True, 'size': 0}
    root_set = set(roots)
    base = os.path.commonpath(roots) if roots else '/'
    base_text = '' if base == '/' else base

    def folder_key(folder):
        """The index key of an absolute folder ('' for base), or None outside base."""
        if folder == base:
            return ''
        return folder[len(base_text) + 1:] if folder.startswith(base_text + '/') else None

    def child_key(folder, name):
        return f'{folder}/{name}' if folder else name

    def lookup_path(folder, name):
        """The absolute path of `name` in the folder keyed `folder`."""
        return f'{base_text}/{folder}/{name}' if folder else f'{base_text}/{name}'

    def owners(path):
        return [r for r in roots if path == r or below(path, r) is not None]

    def holds(folder, name):
        """Whether the names-only walk saw `name` in the folder keyed `folder` (one name is kept bare, more in a set)."""
        found = lookup_dirs.get(folder)
        return found is not None and (found == name if type(found) is str else name in found)

    def lookup_put(folder, name):
        found = lookup_dirs.get(folder)
        if found is None:
            lookup_dirs[folder] = name
        elif type(found) is str:
            lookup_dirs[folder] = {found, name}
        else:
            found.add(name)

    def held(folder):
        """How many names the names-only walk keeps in `folder` (its direct elements left out)."""
        found = lookup_dirs.get(folder)
        return 0 if found is None else 1 if type(found) is str else len(found)

    def lookup_drop(folder, name):
        found = lookup_dirs.get(folder)
        if type(found) is str:
            if found == name:
                del lookup_dirs[folder]
        elif found is not None:
            found.discard(name)

    def in_lookup(path):
        folder = folder_key(os.path.dirname(path))
        return folder is not None and holds(folder, os.path.basename(path))

    def lookup_folders(name):
        """Folder keys (shared strings) where the names-only walk saw a regular file `name`, in walk order."""
        found = lookup_names.get(name)
        folders = () if found is None else (found,) if type(found) is str else found[1:]
        return [folder for folder in folders if holds(folder, name)]

    def lookup_add(name, folder):
        """Index a regular file by name; returns the name object to keep, shared by every homonym.

        A name seen once maps to its folder; seen again, to a list headed by one copy of the name
        that every later homonym reuses (90,000 `index.md` cost one string, not 90,000).
        """
        found = lookup_names.get(name)
        if found is None:
            lookup_names[name] = folder
        elif type(found) is str:
            lookup_names[name] = [name, found, folder]
        else:
            found.append(folder)
            return found[0]
        return name

    def lookup_files_named(name):
        """Paths of the regular files called `name` seen only by the names-only walk, in walk order."""
        return [lookup_path(folder, name) for folder in lookup_folders(name)]

    def listing_of(folder, cut):
        """Sorted (name, flags) of a folder (flags: 1 directory, 2 symbolic link) and the flags of its
        names that are not valid UTF-8, or None when unreadable.

        Such a name cannot enter the model (ids and JSON are UTF-8): it is reported as unreadable on its
        folder and left out of the inventory and of the names-only index, and counts as left out.
        """
        listing, bad = [], []
        try:
            with os.scandir(folder) as handle:
                for entry in handle:
                    name = entry.name
                    try:
                        link = entry.is_symlink()
                    except OSError:
                        link = False
                    try:
                        is_dir = entry.is_dir()  # follows a link: an excluded name is skipped even as a link
                    except OSError:
                        is_dir = False
                    try:
                        name.encode('utf-8')
                    except UnicodeEncodeError:
                        shown = name.encode('utf-8', 'surrogateescape').decode('utf-8', 'backslashreplace')
                        issue('unreadable', say('A name that is not valid UTF-8, left out of the scan: {name}', name=shown), folder)
                        if cut:
                            lookup['complete'] = False
                        bad.append(2 if link else 1 if is_dir else 0)
                        continue
                    if not (is_dir and name in EXCLUDED):
                        listing.append((name, 2 if link else 1 if is_dir else 0))
        except OSError as exc:
            walk_error(exc)
            unlistable.add(folder)
            if cut:
                lookup['complete'] = False  # Past the budget, an unlisted folder hides what the index would hold.
            return None, None
        listing.sort()
        return listing, bad

    def walk(root):
        """Breadth-first inventory of one root: every element of depth d before those of d + 1;
        within a level, folders in path order and names in order. Past the budget, names only."""
        truncated = False
        root_start = len(nodes)
        parent, name = folder_key(os.path.dirname(str(root))), os.path.basename(str(root))
        if str(root) not in nodes and parent is not None and holds(parent, name):
            # Seen by name past the budget of an enclosing root, inventoried now as this root.
            lookup_drop(parent, name)
            lookup['size'] -= 1
        # A level holds the records of inventoried folders (no copy of their path) and the keys
        # of folders seen only by name (the same string the index keeps).
        level = [nodes[add_node(root, 'directory')]]
        while level:
            following = []
            for item in level:
                if type(item) is dict:
                    folder = item['id']
                    at = '' if folder == base else item['relative'] if item['root'] == base else folder_key(folder)
                else:
                    at = item
                    folder = f'{base_text}/{at}' if at else base
                listing, bad = listing_of(folder, truncated)
                if listing is None:
                    continue
                if folder in nodes:
                    nodes[folder]['listing'] = 'complete'  # listed; the final state is set after the walk
                unlisted.pop(at, None)  # listed again by a later root: this walk decides
                if bad:
                    illegible[at] = bad  # set, not added: a folder listed by two roots counts its names once
                for index, (name, flags) in enumerate(listing):
                    key = os.path.join(folder, name)
                    link, directory = flags == 2, flags == 1
                    if key in nodes:
                        # Inventoried by an earlier root; its folder is walked again for what lies below.
                        if directory:
                            following.append(nodes[key])
                        continue
                    if not truncated and (len(nodes) >= MAX_FILES or len(nodes) - root_start >= per_root_budget):
                        truncated = True
                        truncated_roots.append(str(root))
                    seen = holds(at, name)
                    if not truncated:
                        if seen:
                            # Seen by an earlier root past its budget, inventoried by this one.
                            lookup_drop(at, name)
                            lookup['size'] -= 1
                        p = Path(key)
                        if link:
                            add_node(p, 'symlink', 'skipped')
                            issue('symlink', say('Symbolic link listed without following its target.'), key)
                            continue
                        node_key = add_node(p, 'directory' if directory else None)
                        if directory:
                            following.append(nodes[node_key])
                        elif p.suffix.lower() in TEXT:
                            pending_text.append(p)
                        continue
                    if seen:
                        if directory:
                            following.append(child_key(at, name))
                        continue
                    if lookup['count'] >= MAX_LOOKUP:
                        # The walk stops in the middle of this folder: the rest of its listing is
                        # left out, and so is whatever lies below those names (unknown, not counted).
                        lookup['complete'] = False
                        unlisted[at] = listing[index:]
                        return
                    lookup['count'] += 1
                    lookup['size'] += 1
                    if not (link or directory):
                        name = lookup_add(name, at)
                    lookup_put(at, name)
                    if link:
                        continue
                    if directory:
                        following.append(child_key(at, name))  # the key of its own entries, one string
                        if folder in root_set:
                            lookup_top.add(key)
            level = following
    for root in root_paths:
        start = len(nodes)
        walk(root)
        if str(root) not in truncated_roots:
            # A complete inventory is listed depth-first (each folder's names as one block,
            # folders in path order): entries, objects and convention edges follow the order of
            # `nodes`, so this order keeps node order and ids stable for the same tree.
            def depth_first(key, root=str(root)):
                relative = below(key, root)
                if relative is None:
                    return (0,)
                parent, _, name = relative.rpartition('/')
                return (1, tuple(parent.split('/')) if parent else (), name)
            keys = list(nodes)
            ordered = keys[:start] + sorted(keys[start:], key=depth_first)
            if ordered != keys:
                records = dict(nodes)
                nodes.clear()
                nodes.update((key, records[key]) for key in ordered)
    inventory_complete = not truncated_roots
    # Directory listings: complete, partial (part of the direct children left out) or unread
    # (none inventoried and some on disk, or never listed); omitted counts below each folder.
    in_direct = {}
    for key in nodes:
        parent = os.path.dirname(key)
        parent = nodes[parent]['id'] if parent in nodes else parent  # the node's own string, not a second copy
        in_direct[parent] = in_direct.get(parent, 0) + 1
    # A folder cut when MAX_LOOKUP ran out: the rest of its listing that is still outside the model
    # (a nested root walked later may have inventoried a name) is left out like the index's names.
    # So are the names that are not valid UTF-8 (one element each: what lies below one is not counted),
    # kept apart because the limit did not leave them out.
    cut_short = {}
    for at, rest in unlisted.items():
        folder = f'{base_text}/{at}' if at else base
        left = [flags for name, flags in rest if os.path.join(folder, name) not in nodes and not holds(at, name)]
        if left:
            cut_short[at] = left
    omitted_below = {}  # folder key -> elements left out below it
    limit_below = {}  # folder key -> the part of them the limit left out
    minimum_below = set()  # folder keys with a folder of illegible name below: what is inside it is not counted
    for folder in dict.fromkeys([*lookup_dirs, *cut_short, *illegible]):
        by_limit = held(folder) + len(cut_short.get(folder, ()))
        bad = illegible.get(folder, ())
        if not (by_limit or bad):
            continue
        outer, current = folder_key(min(owners(f'{base_text}/{folder}' if folder else base), key=len)), folder
        while True:
            omitted_below[current] = omitted_below.get(current, 0) + by_limit + len(bad)
            limit_below[current] = limit_below.get(current, 0) + by_limit
            if 1 in bad:
                minimum_below.add(current)
            if current == outer:
                break
            current = current.rpartition('/')[0]
    for key, record in nodes.items():
        if record['kind'] != 'directory':
            continue
        at = folder_key(key)
        by_limit, bad = held(at) + len(cut_short.get(at, ())), len(illegible.get(at, ()))
        never = 'listing' not in record  # never listed: the listing failed, or the walk stopped before it
        record['listing'] = 'unread' if never or ((by_limit or bad) and not in_direct.get(key)) else 'partial' if by_limit or bad else 'complete'
        record['omitted'] = omitted_below.get(at, 0)
        if record['listing'] != 'complete':
            # Why part of it is out: the inventory limit, or what the reader could not read (names, listing).
            record['leftOutBy'] = [cause for cause, applies in (('limit', by_limit or (never and key not in unlistable)),
                                                                ('unreadable', bad or key in unlistable)) if applies]
        if at in minimum_below:
            record['omittedMinimum'] = True
    # Top-level folders of each root: inventoried elements below them and elements on disk.
    top_level = []
    for root in roots:
        inside, names = {}, set()
        for key, record in nodes.items():
            if key == root or root not in record['roots']:
                continue
            first, _, rest = below(key, root).partition('/')
            if rest:
                inside[first] = inside.get(first, 0) + 1
            elif record['kind'] == 'directory':
                names.add(first)
        names.update(os.path.basename(key) for key in lookup_top if os.path.dirname(key) == root and in_lookup(key))
        for name in sorted(names):
            count = inside.get(name, 0)
            top_level.append({'root': root, 'name': name, 'inventoried': count, 'onDisk': count + omitted_below.get(child_key(folder_key(root), name), 0)})
    # A name seen past the budget and inventoried later by a nested root is no longer a lookup.
    lookup_skill_dirs = {Path(os.path.dirname(path)) for path in lookup_files_named('SKILL.md')}
    lookup_files = sum(len(lookup_folders(name)) for name in lookup_names)
    # What a cut folder left out, and each illegible name, counts with the index's names (flags 0: neither folder nor link).
    cut_omitted = sum(len(left) for left in [*cut_short.values(), *illegible.values()])
    lookup_files += sum(1 for left in [*cut_short.values(), *illegible.values()] for flags in left if flags == 0)
    # Instruction and skill files the names-only walk saw: the cut may have left them out.
    entries_omitted = sorted(path for name in ('AGENTS.md', 'CLAUDE.md', 'SKILL.md') for path in lookup_files_named(name))
    for root in truncated_roots:
        # Only what the limit left out: a folder out of the reading for a name or a listing it could not read is not counted here.
        folders = [nodes[key]['listing'] for key in nodes if nodes[key]['kind'] == 'directory' and root in nodes[key]['roots']
                   and 'limit' in nodes[key].get('leftOutBy', ())]
        partial, unread = folders.count('partial'), folders.count('unread')
        minimum = not lookup['complete']
        mine = [path for path in entries_omitted if below(path, root) is not None]
        # `minimum` is a fact for the interface, which words the cut in its own numbers.
        issue('limit', say(INVENTORY_LIMIT[minimum, bool(mine)], root=root, budget=per_root_budget, partial=partial, unread=unread,
                            omitted=limit_below.get(folder_key(root), 0), minimum=minimum,
                            **({'entries': len(mine), 'example': below(mine[0], root)} if mine else {})), root)
    del in_direct, omitted_below, limit_below, minimum_below, unlisted, illegible, cut_short  # walk bookkeeping, not needed past this point
    # Instruction files and manifests get the text budget first, then Markdown, then other text.
    priorities = {'entry': 0, 'manifest': 1, 'skill': 2, 'memory': 3}
    budget = {}  # owner root -> {count, bytes, byTopLevel} of the files left out by the text budget

    def left_out(p, size):
        """A text listed but not read: one finding per file above MAX_BYTES, one per root for the budget."""
        record = nodes[str(p)]
        if size > MAX_BYTES:
            record['skippedBy'] = 'size'
            issue('limit', say('File listed, but not analyzed: text size limit.'), str(p))
            return
        record['skippedBy'] = 'budget'
        owner = record['root']
        item = budget.setdefault(owner, {'count': 0, 'bytes': 0, 'byTopLevel': {}})
        item['count'] += 1
        item['bytes'] += size
        relative = below(str(p), owner) or ''
        top = relative.split('/', 1)[0] if '/' in relative else '.'
        item['byTopLevel'][top] = item['byTopLevel'].get(top, 0) + 1
    for p in sorted(pending_text, key=lambda p: (priorities.get(nodes[str(p)]['kind'], 4 if p.suffix.lower() in MARKDOWN else 5), len(p.parts), str(p))):
        nodes[str(p)]['analysis'] = 'skipped'
        try:
            with open_regular_file(p) as stream:
                available = MAX_TEXT_TOTAL - total_bytes
                size = os.fstat(stream.fileno()).st_size
                if size > MAX_BYTES or size > available:
                    # Size already known from fstat: mass stays visible without reading.
                    nodes[str(p)]['bytes'] = size
                    left_out(p, size)
                    continue
                data = stream.read(min(MAX_BYTES, available) + 1)
            if len(data) > min(MAX_BYTES, available):
                left_out(p, len(data))
                continue
            # Universal newlines: \r\n and \r count as one line break, so line numbers match an editor's.
            text = data.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
            total_bytes += len(data)
            texts[str(p)] = text
            nodes[str(p)]['analysis'] = 'parsed'
            nodes[str(p)]['bytes'] = len(data)
            # Raw bytes as read: the same definition as the hashes of the inventory and the snapshot.
            nodes[str(p)]['sha256'] = hashlib.sha256(data).hexdigest()
            nodes[str(p)]['lines'] = text.count('\n') + 1
            heading = re.search(r'^#\s+(.+)', text, re.M)
            if heading:
                nodes[str(p)]['title'] = heading[1][:160]
            if p.suffix.lower() in MARKDOWN:
                name = declared_name(text)
                if name is not None:
                    nodes[str(p)]['declaredName'] = name
        except (OSError, UnicodeError, ValueError) as exc:
            nodes[str(p)]['skippedBy'] = 'unreadable'
            issue('unreadable', say('Could not analyze: {reason}', reason=of(exc)), str(p))
    for owner in roots:
        if owner in budget:
            item = budget[owner]
            item['byTopLevel'] = dict(sorted(item['byTopLevel'].items()))
            issue('limit', say('Text budget of the scan reached: text files listed but not analyzed: {count} ({bytes} bytes). '
                                'References and findings inside them are not in this scan; '
                                'each one has analysis “skipped” and the full list is in the audit report.', count=item['count'], bytes=item['bytes']),
                  owner, **item)
    # Resolution appends missing/external nodes to the model. Those placeholders
    # must never become evidence that a later wiki destination exists.
    inventoried_paths = frozenset(nodes)

    # Frontmatter names of the Markdown the reader knows but did not analyse, read from the header alone on the
    # first bare wikilink of a root, before any file-name rule (even one that then resolves it): once per root.
    headers, hidden_names = {}, {}
    header_use = {'files': 0, 'bytes': 0, 'complete': True}

    def header_name(path):
        """declared_name of a file's header, None without one, or False when the header was not read.

        Read by descriptor without a buffer: one small first block, and more (up to the frontmatter
        bound, stopping at its closing line) only when the file starts with `---`. Every byte counts
        against MAX_HEADER_BYTES; past it, headers are not read (False).
        """
        if path not in headers:
            headers[path] = False
            left = MAX_HEADER_BYTES - header_use['bytes']
            try:
                with open_regular_file(path) as stream:
                    descriptor = stream.fileno()
                    size = os.fstat(descriptor).st_size  # a file read to its end leaves nothing unknown
                    if left < 8 and size > left:
                        header_use['complete'] = False
                        return False
                    data = os.read(descriptor, min(HEADER_FIRST_BLOCK, left, max(size, 1)))
                    header_use['files'] += 1
                    header_use['bytes'] += len(data)
                    if not data.startswith((b'---', b'\xef\xbb\xbf---')):
                        headers[path] = None
                        return None
                    while len(data) < FRONTMATTER_MAX_BYTES + 4 and not HEADER_CLOSE.search(data, 3) and len(data) < size:
                        left = MAX_HEADER_BYTES - header_use['bytes']
                        if left <= 0:
                            header_use['complete'] = False
                            return False
                        chunk = os.read(descriptor, min(4096, FRONTMATTER_MAX_BYTES + 4 - len(data), left))
                        if not chunk:
                            break
                        header_use['bytes'] += len(chunk)
                        data += chunk
                try:
                    text = data.decode('utf-8')
                except UnicodeDecodeError as exc:
                    if exc.start < len(data) - 3:
                        raise
                    text = data[:exc.start].decode('utf-8')  # a character cut by the bound, past the header
                headers[path] = declared_name(text.replace('\r\n', '\n').replace('\r', '\n'))
            except (OSError, UnicodeError, ValueError):
                headers[path] = False
        return headers[path]

    def hidden_declarers(owner):
        """({name: [paths]}, complete) of the Markdown under `owner` whose frontmatter was not read."""
        if owner not in hidden_names:
            prefix, names, complete = owner + '/', {}, True
            paths = [key for key, record in nodes.items() if record.get('analysis') not in {None, 'parsed'}
                     and Path(key).suffix.lower() in MARKDOWN and key.startswith(prefix)]
            paths += sorted(path for name in lookup_names if os.path.splitext(name)[1].lower() in MARKDOWN
                            for path in lookup_files_named(name) if path.startswith(prefix))
            for path in paths:
                name = header_name(path)
                if name is False:
                    complete = False
                elif name is not None:
                    names.setdefault(name, []).append(path)
            hidden_names[owner] = ({name: sorted(found) for name, found in names.items()}, complete)
        return hidden_names[owner]

    def known(path):
        """Exists below an opened root (inventoried or seen by the names-only walk), same exclusions."""
        return path in inventoried_paths or in_lookup(path)
    lookup_entries = {}

    def lookup_entry(owner, name):
        """Sorted folder keys (the walk's own strings) of the regular files called `name` seen only by name inside `owner`."""
        if (owner, name) not in lookup_entries:
            at = folder_key(owner)
            prefix = at + '/'
            lookup_entries[(owner, name)] = sorted(folder for folder in lookup_folders(name) if not at or folder == at or folder.startswith(prefix))
        return lookup_entries[(owner, name)]

    def tail_of(folder, root, size):
        """The last `size` components of the folder keyed `folder` below the root keyed `root`, or None when fewer."""
        if root:
            if not folder.startswith(root + '/'):
                return None  # the root itself: no component below it
            relative = folder[len(root) + 1:]
        elif not folder:
            return None
        else:
            relative = folder
        parts = relative.rsplit('/', size)
        return relative if len(parts) == size else relative[len(parts[0]) + 1:] if len(parts) > size else None

    def lookup_tails(owner, name, size):
        """For references of `size` folder components and the name `name`: the indexes of the
        homonyms that have that many folders, ordered by their last `size` folders (ties in folder order).

        Only the indexes are kept (4 bytes each), built once per (root, name, size); a reference
        is then a bisect range whose keys are computed on the fly, however many homonyms.
        """
        if (owner, name, size) not in lookup_entries:
            folders, root = lookup_entry(owner, name), folder_key(owner)
            keys = [tail_of(folder, root, size) for folder in folders]
            order = sorted((index for index, key in enumerate(keys) if key is not None), key=keys.__getitem__)
            lookup_entries[(owner, name, size)] = array('I', order)
        return lookup_entries[(owner, name, size)]

    def lookup_matches(owner, ref):
        """(count, paths up to MAX_CANDIDATES) of the files seen only by name whose path is `ref` or ends in /ref."""
        directory, _, name = ref.rpartition('/')
        folders = lookup_entry(owner, name)
        if not directory:
            return len(folders), [lookup_path(folder, ref) for folder in folders[:MAX_CANDIDATES]]
        size, root = directory.count('/') + 1, folder_key(owner)
        order = lookup_tails(owner, name, size)

        def key(index):
            return tail_of(folders[index], root, size)
        lo, hi = bisect_left(order, directory, key=key), bisect_right(order, directory, key=key)
        return hi - lo, [lookup_path(folders[order[index]], name) for index in range(lo, min(hi, lo + MAX_CANDIDATES))]
    wiki_index, name_index, suffix_index, skill_dirs = {}, {}, {}, set()
    for n, record in nodes.items():
        path = Path(n)
        if path.suffix == '.md':
            # Visual ownership may move to an opened child root, but the file
            # remains a candidate inside each containing root's document scope.
            for root in record['roots']:
                wiki_index.setdefault((root, path.stem), []).append(path)
        if 'declaredName' in record:
            # Same scope as the file-name index: one entry per containing root, O(files x roots).
            for root in record['roots']:
                name_index.setdefault((root, record['declaredName']), []).append(n)
        if record['kind'] == 'skill':
            skill_dirs.add(path.parent)
        if record['status'] == 'resolved' and record['kind'] != 'directory':
            # Every trailing segment run, once per containing root: O(files x depth),
            # so basename/suffix lookups are constant time even for 20,000 files.
            for root in record['roots']:
                parts = path.relative_to(root).parts
                for index in range(len(parts)):
                    suffix_index.setdefault((root, '/'.join(parts[index:])), []).append(n)
    for declarers in name_index.values():
        declarers.sort()
    skill_dirs |= lookup_skill_dirs
    # Declarations: --scope replaces embedded ones; each root otherwise uses its own.
    declarations, scope_source, scope_patterns = {}, None, []
    if scope is not None:
        shared = Declaration(scope)
        declarations = dict.fromkeys(roots, shared)
        scope_source, scope_patterns = 'flag', shared.patterns
    for root in roots:
        manifest_path = str(Path(root) / 'agent-architecture.json')
        if manifest_path not in texts:
            continue
        try:
            manifest = json.loads(texts[manifest_path])
        except (ValueError, RecursionError):
            continue  # Reported once by the manifest pass below.
        if not isinstance(manifest, dict) or 'scope' not in manifest:
            continue
        try:
            embedded = validate_scope(manifest['scope'])
        except ValueError as exc:
            issue('manifest', say('Invalid scope declaration, ignored: {reason}', reason=of(exc)), manifest_path)
            continue
        if scope is None:
            declarations[root] = Declaration(embedded, root)
            scope_source = 'manifest'
            scope_patterns += declarations[root].patterns
    def containing(roots_):
        return sorted(roots_, key=len, reverse=True)
    absorbed_files, declared_starts = set(), {}
    if declarations:
        for n, record in list(nodes.items()):
            if record['status'] != 'resolved' or record['kind'] == 'directory':
                continue
            absorbed = started = False
            for root in containing(record['roots']):
                declaration = declarations.get(root)
                if declaration is None:
                    continue
                relative = below(n, root)
                index = None if absorbed else declaration.first(declaration.absorbing, [relative])
                if index is not None:
                    declaration.patterns[index]['files'] += 1
                    absorbed_files.add(n)
                    absorbed = True
                index = None if started else declaration.first(declaration.starting, [relative])
                if index is not None:
                    declaration.patterns[index]['files'] += 1
                    declared_starts[n] = 'declared-entry' if declaration.patterns[index]['kind'] == 'entries' else 'implicit-load'
                    started = True
    def absorb(source, clean, p):
        """Earliest declared pattern matching the written reference or its file-relative path."""
        written = None
        if not clean.startswith(('/', '~')):
            normalized = posixpath.normpath(clean)
            if normalized not in {'.', '..'} and not normalized.startswith('../'):
                written = normalized
        for root in containing(nodes[source]['roots']):
            declaration = declarations.get(root)
            if declaration is None:
                continue
            index = declaration.first(declaration.absorbing, [written, below(str(p), root)])
            if index is not None:
                return declaration.patterns[index]
        return None
    status_cache = {}
    specific_roots = sorted(roots, key=len, reverse=True)
    def placeholder_status(p):
        target = str(p)  # keyed by the string: a cached Path would keep its parsed parts alive
        if target not in status_cache:
            owner = next((r for r in specific_roots if target == r or below(target, r) is not None), None)
            if owner is None:
                status_cache[target] = 'external'
                return 'external'
            # Only components below the most specific opened root count: that root was
            # walked even when it lives under build/ or dist/ (or under an excluded
            # folder of an outer root), and roots are resolved, so links above it are gone.
            # A path through a folder the reader does not read is `unscanned`. Each component
            # is checked by lstat, never following a link; any other OSError counts as absent,
            # so one written name (ENAMETOOLONG above 255 bytes) never aborts the scan;
            # Path.exists() raises it before 3.12.
            relative = below(target, owner) or ''
            parts = relative.split('/') if relative else []
            status, current = 'unscanned', owner
            if not any(part in EXCLUDED for part in parts):
                for part in parts:
                    current = os.path.join(current, part)
                    try:
                        mode = os.lstat(current).st_mode
                    except PermissionError:
                        # Not searchable. A folder the reader listed whole still tells what is in
                        # it: a name it did not list is absent; one it listed goes on.
                        listed = nodes.get(os.path.dirname(current), {}).get('listing') == 'complete'
                        if not listed:
                            break
                        if current not in inventoried_paths:
                            status = 'missing'
                            break
                        if nodes[current]['kind'] == 'symlink':
                            break
                        continue
                    except OSError:
                        status = 'missing'
                        break
                    if stat.S_ISLNK(mode):
                        break
            status_cache[target] = status
        return status_cache[target]
    skill_cache = {}
    def nearest_skill(folder, source):
        if folder not in skill_cache:
            outer = Path(min(nodes[source]['roots'], key=len))
            skill_cache[folder] = next((d for d in [folder, *folder.parents] if within(d, outer) and d in skill_dirs), None) if within(folder, outer) else None
        return skill_cache[folder]
    # The probe above the opened root runs only inside a repository (docs/modelo-e-leitura.md, section
    # "Resolução em cascata"). The home folder and those above it are never a repository for it: with
    # dotfiles under Git, a folder opened below the home would test any file of the home. Both $HOME and
    # the account's own folder count: HOME is often redirected (isolated instances).
    homes = set()
    for find in (Path.home, account_home):
        try:
            found = find()
        except (RuntimeError, KeyError, OSError):
            continue
        if found:
            homes.add(os.path.realpath(found))
    ancestors_of, probe_stats = {}, []
    for root in roots:
        chain, current, stop = [], os.path.dirname(root), 'none'
        while current not in {'', '/'} and len(chain) < PROBE_LEVELS:
            chain.append(current)
            if os.path.lexists(os.path.join(current, '.git')):
                stop = 'home' if any(home == current or below(home, current) is not None for home in homes) else 'git'
                break
            current = os.path.dirname(current)
        ancestors_of[root] = chain if stop == 'git' else []
        if not any(other != root and below(root, other) is not None for other in roots):
            levels = len(ancestors_of[root])
            probe_stats.append({'root': root, 'levels': levels, 'stop': stop, 'repository': '/'.join(['..'] * levels) or None, 'probes': 0})
    probe_cache, probe_counts = {}, {}

    def probe(source, ref):
        """{path, ancestor, levels, relative} of the nearest tested ancestor holding `ref`, or None.

        Existence only, by lstat, never content. `ref` is a normalized relative path without `..`
        or `~`; the candidate stays below the ancestor, no component between the ancestor and the
        destination may be a symbolic link, and a path inside an opened root is never a result.
        """
        outer = min(nodes[source]['roots'], key=len)
        if (outer, ref) not in probe_cache:
            probe_cache[(outer, ref)] = None
            clean = posixpath.normpath(ref)
            if not ancestors_of[outer] or clean.startswith(('/', '~')) or '..' in clean.split('/'):
                return None
            probe_counts[outer] = probe_counts.get(outer, 0) + 1
            for levels, ancestor in enumerate(ancestors_of[outer], 1):
                candidate = posixpath.join(ancestor, clean)
                if below(candidate, ancestor) is None or owners(candidate):
                    continue
                current, linked, present = ancestor, False, True
                for part in clean.split('/'):
                    current = posixpath.join(current, part)
                    if os.path.islink(current):
                        linked = True
                        break
                    if not os.path.lexists(current):
                        present = False  # One missing component ends the walk: cost bounded by what exists.
                        break
                if not linked and present:
                    probe_cache[(outer, ref)] = {'path': candidate, 'ancestor': ancestor, 'levels': levels,
                                                 'repository': ancestors_of[outer][-1], 'relative': posixpath.relpath(candidate, outer)}
                    break
        return probe_cache[(outer, ref)]

    def self_named(source, ref):
        """A reference that starts with the name of the source's outermost root (`project/a/b.md`, written
        from the folder above it) tried from that root, after every step failed: (target, 'root') or (None, None)."""
        outer = min(nodes[source]['roots'], key=len)
        first, _, rest = ref.partition('/')
        if rest and first == os.path.basename(outer) and known(posixpath.join(outer, rest)):
            return posixpath.join(outer, rest), 'root'
        return None, None

    def cascade(source, folder, ref, directory, dot=False):
        """Steps 2-4 for an unanchored reference whose file-relative target is missing.

        A `./` path mention (`dot`) that retreats only tries the opened roots (root-dot). Every step
        consults the inventory and the names-only index, so a destination past the
        inventory budget is found by existence (an `unscanned` placeholder).
        """
        skill = None if dot else nearest_skill(folder, source)
        if skill is not None and skill != folder and known(str(skill / ref)):
            return str(skill / ref), 'skill', None
        for root in containing(nodes[source]['roots']):
            if known(str(Path(root) / ref)):
                return str(Path(root) / ref), 'root-dot' if dot else 'root', None
        if directory or dot:
            return None, None, None
        owner = nodes[source]['root']
        _, listed = suffix_options(owner, ref)
        # Name/suffix step: candidates under the nearest skill (the source folder
        # included) come first, so a name copied into another skill is no ambiguity.
        # Several there remain ambiguous, listing candidates of the whole root. Each
        # (root, reference) is computed once; the skill's own candidates are ranges.
        if skill is not None:
            local = skill_options(owner, ref, str(skill))
            if len(local) == 1:
                return local[0], 'skill-suffix' if '/' in ref else 'skill-basename', None
            if local:
                return None, None, listed
        if listed.total == 1:
            return listed[0], 'suffix' if '/' in ref else 'basename', None
        return None, None, listed if listed.total else None
    def unread_step(source, folder, ref, dot):
        """The first path a cascade step tried (skill, opened roots, the root's own name) that goes
        through a folder the reader does not read, or None. Those steps consult only the inventory
        and the names-only index, which never hold what lies there."""
        steps = []
        skill = None if dot else nearest_skill(folder, source)
        if skill is not None and skill != folder:
            steps.append(str(skill / ref))
        steps += [str(Path(root) / ref) for root in containing(nodes[source]['roots'])]
        outer = min(nodes[source]['roots'], key=len)
        first, _, rest = ref.partition('/')
        if not dot and rest and first == os.path.basename(outer):
            steps.append(posixpath.join(outer, rest))
        return next((step for step in steps if placeholder_status(Path(step)) == 'unscanned'), None)
    resolution_cache, option_cache, hidden_counts = {}, {}, {}

    def suffix_options(owner, ref):
        """(inventoried, listed) of the name/suffix step in a root, once per (root, reference).

        `inventoried` is sorted; `listed` is the Candidates (at most MAX_CANDIDATES, with the total
        that counts the files seen only by name), shared by every use.
        """
        if ('suffix', owner, ref) not in option_cache:
            inventoried = sorted(suffix_index.get((owner, ref), []))
            count, paths = lookup_matches(owner, ref)
            shown = inventoried[:MAX_CANDIDATES]
            option_cache[('suffix', owner, ref)] = (inventoried, Candidates(shown + paths[:MAX_CANDIDATES - len(shown)], len(inventoried) + count, count))
        return option_cache[('suffix', owner, ref)]

    def skill_options(owner, ref, skill):
        """Candidates of the name/suffix step under one skill folder (inventoried and seen by name)."""
        if ('skill', owner, ref, skill) not in option_cache:
            inventoried, _ = suffix_options(owner, ref)
            prefix = skill + '/'
            local = inventoried[bisect_left(inventoried, prefix):bisect_left(inventoried, skill + '0')]
            name = ref.rsplit('/', 1)[-1]
            folders, at = lookup_entry(owner, name), folder_key(skill)
            tail = '/' + ref
            for folder in folders[bisect_left(folders, at):bisect_left(folders, at + '0')] if at else folders:
                path = lookup_path(folder, name)
                if (not at or folder == at or folder.startswith(at + '/')) and (path[len(owner) + 1:] == ref or path.endswith(tail)):
                    local.append(path)
            option_cache[('skill', owner, ref, skill)] = local
        return option_cache[('skill', owner, ref, skill)]

    def wiki_options(owner, name):
        """(inventoried set, lookup folders, listed) of the Markdown files called `name`.md in a root, once per (root, name)."""
        if ('wiki', owner, name) not in option_cache:
            inventoried = sorted({str(path) for path in wiki_index.get((owner, name), []) if known(str(path))})
            folders = lookup_entry(owner, name + '.md')
            shown = inventoried[:MAX_CANDIDATES]
            more = [lookup_path(folder, name + '.md') for folder in folders[:MAX_CANDIDATES - len(shown)]]
            option_cache[('wiki', owner, name)] = (set(inventoried), folders, Candidates(shown + more, len(inventoried) + len(folders), len(folders)))
        return option_cache[('wiki', owner, name)]

    def frontmatter_declarers(owner, name):
        """(sorted declarers of `name`, complete): analysed ones and, by their header, the Markdown not analysed."""
        if ('name', owner, name) not in option_cache:
            hidden, complete = hidden_declarers(owner)
            shown = name_index.get((owner, name), [])
            option_cache[('name', owner, name)] = (sorted(shown + hidden[name]) if name in hidden else shown, complete)
        return option_cache[('name', owner, name)]

    def hidden_count(candidates):
        """Candidates past the inventory, counted once per (shared) candidate list."""
        key = id(candidates)
        if key not in hidden_counts or hidden_counts[key][0] is not candidates:
            hidden_counts[key] = (candidates, sum(candidate not in inventoried_paths for candidate in candidates))
        return hidden_counts[key][1]

    def resolve(source, raw, typ, line=None, evidence=None, quiet=False):
        """Return (target, resolvedBy, declaration, outcome, candidates, form, extra) or None when ignored.

        outcome: resolved | unscanned | external | declared | missing | unverified |
        outside-root | ambiguous. form: path | name | word (see NAME_FORMS). extra:
        {reason} of unverified, {path, ancestor, levels, relative} of outside-root.
        No placeholder is created here (`settle` does it), so a reference the caller
        ignores leaves no trace in the model.
        """
        raw = raw.strip()
        if too_long(raw):
            return None  # Counted as `too-long` by the caller; never resolved.

        def invalid(message):
            if quiet:
                return  # the JSON reference pass already reported this value
            anchored_ = raw.startswith(('file:', '/', './', '../', '~'))
            written = 'path' if anchored_ or '/' in raw else 'name' if EXTENSION.search(raw.split('#')[0]) else 'word'
            issue('invalid-reference', message, source, line, target=printable(raw),
                  **({'evidence': printable(evidence)} if evidence is not None else {}), syntax=typ, form=written)
        if not utf8(raw):
            # Only a JSON escape (`\udcff`) gives such a text: no file can have that name.
            invalid(say('Reference with a character that is not valid UTF-8: {raw}', raw=printable(raw)))
            return None
        # Markdown destinations use URI syntax: //host/path is a network URL.
        if typ in {'markdown', 'markdown-reference'} and raw.startswith('//'):
            return None
        # A test id after a file name (`tests/test_x.py::TestA::t_b`) is not part of the
        # address; dropping it first also keeps `app.py::main` from looking like a URI scheme.
        # A line address (`x.md:41`, `x.py:2,6-9`) goes the same way. A leading elision
        # (`…/a/b.py`) is dropped: the rest resolves as an unanchored reference.
        # Edges and findings keep the reference as written.
        named = TEST_ID.match(raw) if '::' in raw else None
        address = named[1] if named else raw
        lined = LINE_SUFFIX.fullmatch(address) if ':' in address else None
        address = lined[1] if lined and line_address(lined[2]) else address
        elided = ELISION_START.match(address)
        address = address[elided.end():] if elided else address
        if not address or address.startswith('#') or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', address) and not address.startswith('file:'):
            return None
        try:
            clean = unquote(urlsplit(address).path) if address.startswith('file:') else unquote(address.split('#')[0].split('?')[0])
        except ValueError:
            invalid(say('Invalid file URI: {raw}', raw=raw))
            return None
        if not clean or any(c in clean for c in ('*', '{', '}', '<', '>')):
            return None
        if '\x00' in clean:
            invalid(say('The reference contains an invalid NUL character.'))
            return None
        # Every cascade step derives from the source directory (skill and root
        # ancestors included), so the directory remains a complete cache key.
        # A file: URI is anchored while the same bare path may descend the cascade;
        # a `./` path mention also tries the opened roots, a `./` Markdown link does not.
        folder = Path(source).parent
        ref = posixpath.normpath(clean)
        # `./../x` climbs out of the file's folder: anchored like `../x`, never tried from the root.
        dot = typ == 'path' and clean.startswith('./') and ref != '..' and not ref.startswith('../')
        # `./scripts/x.sh` where `scripts/` is next to the file: the folder is local, the absence a
        # break there. Such a mention does not retreat to the root, so it is anchored like a link.
        dot = dot and not ('/' in ref and known(str(folder / ref.split('/', 1)[0])))
        cache_key = (str(folder), clean, typ == 'wiki', raw.startswith('file:'), dot)
        if cache_key in resolution_cache:
            return resolution_cache[cache_key]
        try:
            p = Path(clean).expanduser()
        except RuntimeError:
            invalid(say('Could not resolve the home folder: {raw}', raw=raw))
            return None
        anchored = raw.startswith('file:') or p.is_absolute() or clean.startswith(('./', '../'))
        if not p.is_absolute():
            p = folder / p
        # Lexical normalization avoids following any symlink during resolution.
        p = Path(os.path.abspath(p))
        # An unanchored path that climbs out of its folder is parent-relative in effect.
        anchored = anchored or ref in {'.', '..'} or ref.startswith('../')
        # Written form, which decides the code of a missing destination: path (anchored or
        # with a directory), bare name with an extension, or bare word without one.
        form = 'path' if anchored or '/' in clean or clean.startswith('~') else 'name' if EXTENSION.search(clean) else 'word'
        mode, target, candidates = None, None, None
        # A wikilink without a directory names the identity a file declares in its frontmatter, before any
        # file-name rule (docs/modelo-e-leitura.md, section "Wikilinks e identidade declarada").
        bare_wiki = typ == 'wiki' and not anchored and '/' not in clean
        declarers, hidden_complete = frontmatter_declarers(nodes[source]['root'], clean) if bare_wiki else (None, True)
        if declarers:
            if len(declarers) == 1:
                mode, target = 'frontmatter-name', declarers[0]
            else:
                candidates = declarers  # sorted once below the index; issues copy at most MAX_CANDIDATES
        elif str(p) in inventoried_paths:
            mode, target = 'file', str(p)
        elif typ == 'wiki':
            # `[[/]]` names the filesystem root, which has no name to add .md to.
            if not p.suffix and p.name:
                direct = str(p.with_suffix('.md'))
                # Anchored or with a folder, the address is checked on disk too when the index is
                # incomplete: its existence never depends on the names-only walk.
                found_direct = known(direct) or (not lookup['complete'] and placeholder_status(Path(direct)) == 'unscanned')
                # A directory-qualified address is explicit. Never repair a stale
                # address by silently redirecting it to an unrelated same-name file.
                if '/' not in clean and not anchored:
                    inventoried, folders, listed = wiki_options(nodes[source]['root'], clean)
                    parent = folder_key(str(p.parent))
                    at = bisect_left(folders, parent) if parent is not None else len(folders)
                    counted = direct in inventoried or (at < len(folders) and folders[at] == parent)
                    if found_direct and not counted:
                        listed = Candidates(sorted(listed + [direct]), listed.total + 1, listed.hidden + (direct not in inventoried_paths))
                    if listed.total == 1:
                        target = listed[0]
                        mode = 'file' if target == direct else 'basename'
                    elif listed.total > 1:
                        candidates = listed
                elif found_direct:
                    mode, target = 'file', direct
        status = None
        cascaded = typ != 'wiki' and (not anchored or dot)
        if mode is None and candidates is None:
            status = placeholder_status(p)
            # Existing-but-unscanned and external results never descend the cascade.
            if status == 'missing' and cascaded:
                target, mode, candidates = cascade(source, folder, ref, clean.endswith('/'), dot)
                if mode is None and candidates is None and not dot:
                    target, mode = self_named(source, ref)
                if mode is None and candidates is None:
                    # A step whose path goes through a folder the reader does not read (excluded,
                    # a symbolic link, not searchable) cannot affirm the absence: `unscanned`, as the
                    # same reference written in that step's own folder.
                    hidden = unread_step(source, folder, ref, dot)
                    if hidden is not None:
                        status, p = 'unscanned', Path(hidden)
        if candidates is not None:
            # Counted once per result: how many candidates there are and how many lie past the inventory.
            listed = candidates if isinstance(candidates, Candidates) else Candidates(candidates[:MAX_CANDIDATES], len(candidates), hidden_count(candidates))
            result = (None, None, None, 'ambiguous', listed, form, {'hidden': listed.hidden, 'total': listed.total})
        elif mode is not None:
            # Found past the inventory budget: it exists, but was not read.
            result = (target, mode, None, 'resolved' if target in inventoried_paths else 'unscanned', None, form, None)
        else:
            declaration = absorb(source, clean, p) if status == 'missing' and declarations else None
            outcome, extra, target = ('declared' if declaration else status), None, str(p)
            if outcome == 'missing':
                # Absence is affirmed only where the reader saw everything the rule looks at. An
                # anchored address, or a wikilink with a folder, was checked on disk: the names-only
                # index only matters to what the cascade or the name search would find.
                # A `./` mention retreats only to an opened root other than its own folder: written
                # in the root itself, the one place it names was checked on disk.
                retreats = not dot or any(os.path.join(root, ref) != str(p) for root in nodes[source]['roots'])
                if (cascaded and retreats or bare_wiki) and not lookup['complete']:
                    outcome, extra = 'unverified', {'reason': 'lookup'}
                elif not hidden_complete:
                    outcome, extra = 'unverified', {'reason': 'frontmatter'}
                elif cascaded:
                    found = probe(source, ref)
                    if found:
                        outcome, extra, target = 'outside-root', found, found['path']
            result = (target, None, declaration, outcome, None, form, extra)
        resolution_cache[cache_key] = result
        return result

    def settle(result):
        """The target of a result, creating the placeholder of a destination that is not an inventoried file."""
        target, outcome = result[0], result[3]
        if target is None or outcome == 'resolved':
            return target
        status = placeholder_status(Path(target)) if outcome == 'outside-root' else outcome
        if target not in nodes:
            add_node(Path(target), 'unresolved', status)
        elif nodes[target]['kind'] == 'unresolved':
            # One placeholder serves several references: any unabsorbed one keeps it missing.
            current = nodes[target]['status']
            if current in PLACEHOLDER_RANK and status in PLACEHOLDER_RANK and PLACEHOLDER_RANK[status] > PLACEHOLDER_RANK[current]:
                nodes[target]['status'] = status
        return target

    ignored = dict.fromkeys(IGNORED_REASONS, 0)

    def usable(raw, result, fence=None, count=True, code=False):
        """The result, or None for text that is not a reference (counted in `ignored`)."""
        if result is None or result[3] in KEEP:
            return result
        reason = soft_reason(raw.strip(), fence, result[5], code)
        if reason:
            ignored[reason] += count
            return None
        return result
    unresolved_names = 0

    def reach(result):
        """Where a reference may lead, for the manifest check, as (kind, value):

        ('file', path): the file or placeholder the reader resolved it to; ('region', (path, folder)): a path
        that, read as text, falls in a folder the reader does not read (an excluded name, a folder it could
        not list), so that only a file under that folder may be it; ('candidates', paths): the candidates of
        an ambiguity the reader lists whole; ('suffix', (path, rest)): a path through a folder link, never
        followed, so that it may be any file whose path ends with the part below the link; ('any', None): a
        file the reader knows nothing about (a symbolic link to a file, an absence not verifiable, more
        candidates than listed); ('none', None): text that is no reference to a file.
        """
        if not result:
            return 'none', None
        target, outcome, candidates = result[0], result[3], result[4]
        if outcome == 'ambiguous':
            return ('candidates', frozenset(candidates)) if len(candidates) == candidates.total else ('any', None)
        if outcome == 'unverified':
            return 'any', None
        if target in nodes and nodes[target]['kind'] == 'symlink':
            return 'any', None  # never followed: the file behind it is not known
        if outcome == 'unscanned' and not known(target):
            # Up to the deepest inventoried folder: a folder link on the way keeps what is below it (the
            # file is one whose path ends so); otherwise the first component below it is where the reading
            # stopped, a folder read as text.
            child, folder = target, os.path.dirname(target)
            while True:
                record = nodes.get(folder)
                if record and record['kind'] == 'symlink':
                    rest = below(target, folder)
                    # Only when no other symbolic link the reader lists may lie on that part (a file or a
                    # folder link ending like a leading part of it): through one, the file may be any.
                    parts = rest.split('/')
                    for size in range(1, len(parts) + 1):
                        lead = '/'.join(parts[:size])
                        if any(other != folder and ends_with(other, lead) for other in symlink_names().get(parts[size - 1], ())):
                            return 'any', None
                    return 'suffix', (target, rest)
                if record and record['kind'] == 'directory':
                    return 'region', (target, child)
                if os.path.dirname(folder) == folder:
                    return 'any', None
                child, folder = folder, os.path.dirname(folder)
        return 'file', target
    # For the manifests that declare `"linkedRelationships": true`. `links`: the first explicit link (outside
    # fenced blocks) of each source to each file it names, source -> {target: (line, raw, evidence, syntax)},
    # kept apart from `edges` so that the relation cap never hides one. `doubt`: per source, where its other
    # explicit links may lead, about which no missing link is affirmed. `linked`: the manifests themselves.
    # `endpoints`: (origin, line, raw) of the relationship `source`/`target` values of every
    # agent-architecture.json, never repetitions.
    links, doubt, linked, endpoints = {}, {}, [], set()

    symlinks = []

    def symlink_names():
        """Name -> paths of the symbolic links the reader lists, built once (all are listed before any reference)."""
        if not symlinks:
            names = {}
            for key, record in nodes.items():
                if record['kind'] == 'symlink':
                    names.setdefault(os.path.basename(key), []).append(key)
            symlinks.append(names)
        return symlinks[0]

    def doubt_of(source, kind, value):
        entry = doubt.setdefault(source, {'any': False, 'paths': set(), 'regions': set(), 'suffixes': set()})
        if kind == 'any':
            entry['any'] = True
        elif kind == 'candidates':
            entry['paths'].update(value)
        elif kind == 'region':
            entry['regions'].add(value[1])
        elif kind == 'suffix':
            entry['suffixes'].add(value[1])
    for source, text in texts.items():
        try:
            keyed = nodes[source]['kind'] == 'manifest' or Path(source).name in KEYED_MANIFESTS
            for raw, typ, line, evidence, fence, code in extract(text, Path(source).suffix, keyed, ignored):
                if too_long(raw):
                    ignored['too-long'] += 1
                    continue
                result = usable(raw, resolve(source, raw, typ, line, evidence), fence, code=code)
                if not result:
                    continue
                target, mode, declaration, outcome, candidates, form, extra = result
                details = {'evidence': evidence, 'syntax': typ, 'form': form}
                link = typ in LINK_SYNTAX and fence is None
                lead = reach(result) if link else ('none', None)
                if lead[0] in {'any', 'candidates', 'region', 'suffix'}:
                    doubt_of(source, *lead)
                link = lead[0] in {'file', 'region'}
                if outcome == 'ambiguous':
                    hidden, total = extra['hidden'], extra['total']
                    message = (say('Ambiguous wiki reference: {raw}', raw=raw) if typ == 'wiki' else
                               say('Ambiguous reference: {raw} ({total} candidates in the inventory; none was chosen).', raw=raw, total=total) if not hidden else
                               say('Ambiguous reference: {raw} ({total} candidates, {hidden} beyond the inventory; none was chosen).', raw=raw, total=total, hidden=hidden))
                    issue('ambiguous', message, source, line, target=raw, candidates=list(candidates[:MAX_CANDIDATES]),
                          candidatesTotal=total, **details)
                    continue
                target = settle(result)
                if link:
                    links.setdefault(source, {}).setdefault(target, (line, raw, evidence, typ))
                count = len(edges)
                add_edge(source, target, typ, line, evidence, raw, resolved_by=mode, declared=declaration)
                # The code of a missing destination with this form; also the basis of legacyId.
                legacy = 'unresolved-name' if form in NAME_FORMS.get(typ, ()) else 'broken'
                if outcome == 'missing' and legacy == 'unresolved-name':
                    # After the cascade and the declared scope: the placeholder stays missing.
                    unresolved_names += len(edges) > count
                    issue('unresolved-name', say(LEGACY_MESSAGES[legacy], raw=raw), source, line, target=raw, **details)
                elif outcome == 'missing':
                    issue('broken', say(LEGACY_MESSAGES[legacy], raw=raw), source, line, target=raw, **details)
                elif outcome == 'declared':
                    declaration['references'] += 1
                elif outcome in {'unverified', 'outside-root'}:
                    legacy_id = identity(legacy, say(LEGACY_MESSAGES[legacy], raw=raw), source, line)
                    if outcome == 'outside-root':
                        # Where it was found, without an absolute path: the ancestor by name and relative to the root.
                        levels = extra['levels']
                        above = '/'.join(['..'] * levels)
                        where = {'raw': raw, 'repository': os.path.basename(extra['repository']), 'ancestor': os.path.basename(extra['ancestor']),
                                 'above': above, 'levels': levels, 'relative': extra['relative']}
                        issue('outside-root',
                              say('The reference {raw} does not resolve inside the open folder, but the target exists in the same repository '
                                   '(that of {repository}, with .git), outside the open folder: in the ancestor '
                                   '{ancestor} ({above}, {levels} level above the open folder), '
                                   'at {relative}. If this folder is used on its own, the reference is broken; '
                                   'if it is used inside the repository, open its root.', **where) if levels == 1 else
                              say('The reference {raw} does not resolve inside the open folder, but the target exists in the same repository '
                                   '(that of {repository}, with .git), outside the open folder: in the ancestor '
                                   '{ancestor} ({above}, {levels} levels above the open folder), '
                                   'at {relative}. If this folder is used on its own, the reference is broken; '
                                   'if it is used inside the repository, open its root.', **where),
                              source, line, target=raw, **details, ancestor=extra['ancestor'], levels=levels, legacyId=legacy_id)
                    elif extra['reason'] == 'lookup':
                        issue('unverified', say('Unverifiable absence: {raw}. The inventory and the existence index reached their limit '
                                                 '({files} and {lookup} items), and the target may be in the part not listed; open a subfolder for a complete scan.',
                                                 raw=raw, files=MAX_FILES, lookup=MAX_LOOKUP),
                              source, line, target=raw, **details, reason='lookup', legacyId=legacy_id)
                    else:
                        issue('unverified', say('Unverifiable absence: [[{raw}]]. The header of some Markdown file of this root that was not analyzed could not be read, '
                                                 'and it may declare that name in the frontmatter (name:).', raw=raw),
                              source, line, target=raw, **details, reason='frontmatter', legacyId=legacy_id)
        except RecursionError:
            nodes[source]['analysis'] = 'partial'
            issue('limit', say('Partial analysis: the JSON exceeded the depth limit of the parser.'), source)
            continue
        if Path(source).name == 'agent-architecture.json':
            try:
                manifest = json.loads(text)
                if not isinstance(manifest, dict):
                    raise ValueError(say('The root of the manifest must be an object.'))
                strings = list(json_string_locations(text))
                locations = {route: offset for route, _, offset in strings}
                newlines = [match.start() for match in re.finditer('\n', text)]
                # The `source` and `target` values of a relationship are its ends, not citations of the
                # manifest: the JSON reference pass still resolves them (a missing one stays `broken`), but
                # their evidence never counts as a repeated reference.
                endpoints.update((source, bisect_right(newlines, offset) + 1, value) for route, value, offset in strings
                                 if len(route) == 3 and route[0] == 'relationships' and type(route[1]) is int and route[2] in {'source', 'target'})
                if not isinstance(manifest.get('objects', []), list) or not isinstance(manifest.get('relationships', []), list):
                    raise ValueError(say('objects and relationships must be lists.'))
                members = set()  # the files the objects name
                for obj in manifest.get('objects', []):
                    if not isinstance(obj, dict) or not isinstance(obj.get('path'), str):
                        raise ValueError(say('Logical object without a valid path.'))
                    # The JSON reference pass above already reported this value's issues.
                    found = usable(obj['path'], resolve(source, obj['path'], 'manifest', quiet=True), count=False)
                    target = settle(found) if found else None
                    if target:
                        objects.append({'id': identity(source, obj['path']), 'name': printable(str(obj.get('name', Path(target).stem))), 'type': printable(str(obj.get('type', 'document'))), 'node': target, 'manifest': source})
                        members.add(target)
                # Each relationship, for the check: with both ends named (a file the reader resolved, or a path
                # read as text), compared both ways; otherwise not compared, with why, and the pairs its ends
                # may stand for, where no link is reported as undeclared.
                compared, unchecked, suspended = [], [], Suspension()
                for index, rel in enumerate(manifest.get('relationships', [])):
                    if not isinstance(rel, dict) or not isinstance(rel.get('source'), str) or not isinstance(rel.get('target'), str):
                        raise ValueError(say('Relationship without a valid source/target.'))
                    # Absent type means references; any non-text value (number, object, list,
                    # null) is refused here, before it can become an edge `raw` or a hash key.
                    if not isinstance(rel.get('type', 'references'), str):
                        raise ValueError(say('Relationship with an invalid type: it must be text.'))
                    a = usable(rel['source'], resolve(source, rel['source'], 'manifest', quiet=True), count=False)
                    b = usable(rel['target'], resolve(source, rel['target'], 'manifest', quiet=True), count=False)
                    start = settle(a) if a and b else None
                    end = settle(b) if start else None
                    offset = locations[('relationships', index, 'source')]
                    line = bisect_right(newlines, offset) + 1
                    evidence = f'{rel["source"]} → {rel["target"]} ({printable(rel.get("type", "references"))})'
                    if start and end:
                        # resolvedBy describes the target, as on extracted edges; absorption
                        # was already counted for the same value by the JSON reference pass.
                        add_edge(start, end, 'declared', line, evidence, printable(rel.get('type', 'references')), origin=source,
                                 resolved_by=b[1], declared=b[2])
                    starts, ends = reach(a), reach(b)
                    named = {'file', 'region'}
                    if starts[0] in named and ends[0] in named:
                        compared.append((start, end, line, rel['source'], rel['target'], evidence))
                        continue
                    file_of = lambda lead: (lead[1][0] if lead[0] in {'region', 'suffix'} else lead[1]) if lead[0] in named else None  # noqa: E731
                    if 'none' in {starts[0], ends[0]}:
                        reason = 'not-a-file'  # no file pair to stand for
                    else:
                        reason = 'unresolved-end' if starts[0] in named or ends[0] in named else 'unresolved-ends'
                        suspended.add(starts, ends)
                    unchecked.append((line, rel['source'], rel['target'], evidence, reason, file_of(starts), file_of(ends)))
                # Only a manifest read whole gets here; `true` itself, never a truthy value, turns the check on.
                if manifest.get('linkedRelationships') is True:
                    linked.append((source, members, compared, unchecked, suspended))
            # A manifest nested past the parser's depth never gets here: the reference pass above
            # parsed the same text from a deeper frame, and its RecursionError skips this file.
            except (ValueError, TypeError) as exc:
                issue('manifest', say('Invalid manifest: {reason}', reason=of(exc)), source)
    written_cache = {}

    def written_destinations(source):
        """Paths a source names in the place of a link destination (`](path)`, the path possibly on the
        next line), outside fenced blocks, read as text: from the folder of the source and, unanchored, from
        each opened root that contains it. Catches the links the extractor does not read (a link text over
        several lines, a destination or title on another line), so that the check does not affirm a missing
        link there. No resolution, no placeholder: only the check reads it."""
        if source not in written_cache:
            text, found = texts.get(source, ''), set()
            lines = text.splitlines(keepends=True)
            contexts = fence_contexts([line.rstrip('\r\n') for line in lines]) if Path(source).suffix.lower() in MARKDOWN else None
            starts = [0]
            for line in lines:
                starts.append(starts[-1] + len(line))
            folder = os.path.dirname(source)
            for match in WRITTEN_DESTINATION.finditer(text):
                if contexts and contexts[min(bisect_right(starts, match.start()) - 1, len(contexts) - 1)]:
                    continue
                written = unquote((match[1] or match[2]).split('#')[0].split('?')[0]).strip()
                if not written or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', written) or '\x00' in written:
                    continue
                if written.startswith('/'):
                    found.add(posixpath.normpath(written))
                    continue
                found.add(posixpath.normpath(posixpath.join(folder, written)))
                if not written.startswith(('./', '../')):
                    found.update(posixpath.normpath(posixpath.join(root, written)) for root in nodes[source]['roots'])
            written_cache[source] = found
        return written_cache[source]
    mirror_checks(linked, links, doubt, nodes, issue, written_destinations)
    # Resolution indexes and caches are not needed past this point.
    for table in (lookup_entries, option_cache, resolution_cache, hidden_counts, status_cache, skill_cache, headers,
                  hidden_names, wiki_index, name_index, suffix_index, lookup_dirs, lookup_names):
        table.clear()
    # Known conventions are labelled separately; they do not imply execution.
    entries = [n for n in nodes if nodes[n]['kind'] == 'entry']
    entries_by_directory = {}
    for entry in entries:
        entries_by_directory.setdefault(Path(entry).parent, []).append(entry)
    for child in entries:
        for ancestor in Path(child).parent.parents:
            parents = entries_by_directory.get(ancestor)
            if parents:
                for parent in parents:
                    add_edge(parent, child, 'scope', evidence=say('Convention: instructions file in an ancestor folder. It does not affirm the precedence of a runtime.'))
                break
    for n in list(nodes.values()):
        if n['kind'] == 'skill':
            objects.append({'id': identity(n['id'], 'skill'), 'name': n.get('title', Path(n['path']).parent.name), 'type': 'skill', 'node': n['id'], 'manifest': None})
    root_info = []
    for root in roots:
        parents = [r for r in roots if r != root and within(Path(root), Path(r))]
        parent = max(parents, key=len) if parents else None
        root_info.append({'path': root, 'name': Path(root).name, 'parent': parent,
                          'level': len(Path(root).relative_to(parent).parts) if parent else 0,
                          'entries': [e for e in entries if root in nodes[e]['roots']]})
        # Never affirmed when the names-only walk saw an entry under the root, nor when the
        # declared scope starts the reading there (entries or implicitLoads).
        if not any(root in nodes[e]['roots'] for e in entries) and not any(
                below(path, root) is not None and os.path.basename(path) in ENTRY for path in entries_omitted) and not any(
                root in nodes[n]['roots'] for n in declared_starts):
            issue('no-entry', say('No AGENTS.md or CLAUDE.md in {root}.', root=root), root)
    if cut_keys:
        issue('limit', say('Limit of {max} relations reached: relations beyond it left out of the scan: {omitted}; '
                            'reachability, the signals and the resolution counts are computed without them.', max=MAX_EDGES, omitted=len(cut_keys)))
    # Structural signals are review aids, kept out of issues: none of them is a defect.
    structure = structural_observations(edges, signal, endpoints)
    for item in scope_patterns:
        if not item['references'] and not item['files']:
            origin = str(Path(item['root']) / 'agent-architecture.json') if 'root' in item else roots[0] if roots else None
            issue('scope-unused-pattern', say('Scope pattern without effect ({kind}: {pattern}): no reference absorbed and no inventoried file matched. Review or remove the declaration.',
                                               kind=item['kind'], pattern=item['pattern']),
                  origin, None, pattern=item['pattern'], scopeKind=item['kind'])
    # A root read in part (inventory cut, text not analysed or unreadable, relations cut): an
    # unreached document there may be reached by what was not read, so `unreachable` is no fact.
    partial_roots = set(truncated_roots) | (set(roots) if cut_keys else set())
    for record in nodes.values():
        if record.get('analysis') in {'skipped', 'partial'}:
            partial_roots.update(record['roots'])
    for item in issues:
        if item['code'] == 'unreadable' and item['node']:
            partial_roots.update(owners(item['node']))
    reach = reachability(nodes, edges, inventoried_paths, declared_starts, absorbed_files, issue, partial_roots)
    resolution = dict.fromkeys((*RESOLUTION_MODES, 'unresolved'), 0)
    unscanned = 0
    for edge in edges:
        if edge['kind'] != 'scope':
            resolution[edge['resolvedBy'] or 'unresolved'] += 1
            unscanned += nodes[edge['target']]['status'] == 'unscanned'
    # Part of `unresolved`: edges whose missing destination was written as a bare name.
    resolution['unresolvedNames'] = unresolved_names
    # Across modes: edges to a destination that exists on disk but was not read (`unscanned`),
    # among them those found past the inventory budget, which would otherwise look missing.
    resolution['unscanned'] = unscanned
    return {'roots': root_info, 'nodes': list(nodes.values()), 'edges': edges, 'objects': objects,
            'issues': issues, 'signals': signals, 'scope': {'source': scope_source, 'patterns': scope_patterns},
            # files: inventoried files that exist (as `find -type f`): no directory, symlink or
            # reference placeholder; the placeholders are unresolvedTargets.
            'stats': {'files': sum(n['kind'] not in {'directory', 'symlink', 'unresolved'} for n in nodes.values()),
                      'unresolvedTargets': sum(n['kind'] == 'unresolved' for n in nodes.values()),
                      'parsed': len(texts), 'edges': len(edges), 'entries': len(entries),
                      'resolution': resolution, 'structure': structure, 'reachability': reach,
                      # complete: no root hit the inventory budget; lookupComplete: the names-only walk past it
                      # did not hit MAX_LOOKUP either (else `omitted` is a lower bound).
                      'inventory': {'complete': inventory_complete, 'lookupComplete': lookup['complete'], 'omitted': lookup['size'] + cut_omitted,
                                    'omittedFiles': lookup_files, 'byTopLevel': top_level,
                                    'entriesOmitted': {'count': len(entries_omitted), 'paths': entries_omitted}},
                      'ignored': ignored, 'probe': {'maxLevels': PROBE_LEVELS, 'ancestors': [{**item, 'probes': probe_counts.get(item['root'], 0)} for item in probe_stats]},
                      # complete: no relation was left out by MAX_EDGES; omitted: distinct relations left out.
                      'relations': {'complete': not cut_keys, 'omitted': len(cut_keys), 'max': MAX_EDGES},
                      # Headers of Markdown not analysed, read for bare wikilinks (complete: within MAX_HEADER_BYTES).
                      'headers': {**header_use, 'max': MAX_HEADER_BYTES}},
            'policy': {'excluded': sorted(EXCLUDED), 'maxNodes': MAX_FILES, 'maxLookup': MAX_LOOKUP, 'maxFileBytes': MAX_BYTES, 'maxTextBytes': MAX_TEXT_TOTAL, 'ai': False}}


# Why a relationship of a manifest with linkedRelationships was not compared (manifest-unchecked).
UNCHECKED = {
    'source-not-read': 'the source file was not read whole (size, inventory limit, folder not read or type not analyzed)',
    'unresolved-end': 'one end does not resolve to a definite file (symbolic link, unverifiable absence or several candidates); '
                      'no link with its other end is reported as missing from the manifest',
    'unresolved-ends': 'neither end resolves to a definite file (symbolic link, unverifiable absence or several candidates); '
                       'no link it could be is reported as missing from the manifest',
    'not-a-file': 'one end is not a file path (address, anchor, placeholder, variable, wildcard or a path too long)',
    'manifest-end': 'one end is an agent-architecture.json, which is not a node of another manifest',
    'unresolved-link': 'the source has a link the reader did not resolve (symbolic link, unverifiable absence or candidates beyond those listed), and it may be the one of this relation',
    'ambiguous-link': 'the source has an ambiguous reference, and the target is among the candidates',
    'unread-folder-link': 'the source has a link to a folder the reader does not read, and the target is in it',
    'unextracted-link': 'the source writes the path of the target as a link target in a form the reader does not extract (link text over several lines, target or title on another line)',
}


def manifest_file(path):
    return os.path.basename(path) == 'agent-architecture.json'


def within_any(path, folders):
    """Whether `path` is one of `folders` or below one of them (lexical, over its ancestors)."""
    while True:
        if path in folders:
            return True
        parent = os.path.dirname(path)
        if parent == path:
            return False
        path = parent


def ends_with(path, rest):
    return path == rest or path.endswith('/' + rest)


def tails(path):
    """The trailing parts of a path, shortest first: '/r/a/b.md' -> 'b.md', 'a/b.md', 'r/a/b.md'."""
    parts = path.split('/')
    return ['/'.join(parts[index:]) for index in range(len(parts) - 1, 0, -1)] + ([path] if parts[0] else [])


class Ends:
    """Where an end of the relationships not compared may be: any file, these files, or a file whose path ends with one of these parts."""

    def __init__(self):
        self.any, self.files, self.suffixes = False, set(), set()

    def add(self, matcher):
        kind, value = matcher
        if kind == 'any':
            self.any = True
        elif kind == 'files':
            self.files.update(value)
        else:
            self.suffixes.add(value)

    def matches(self, path):
        return self.any or path in self.files or bool(self.suffixes) and any(tail in self.suffixes for tail in tails(path))


class Suspension:
    """The link pairs that the relationships not compared may stand for, where no link is reported as undeclared.

    An end is a set of files (one the reader resolved, the candidates of an ambiguity), the part below a
    folder link (any file whose path ends so) or any file. A pair is covered by a relationship whose two ends
    may be its two files. Indexed by an end that is a set of files, else by the part below the folder link,
    looked up over the trailing parts of the link's path: a link is checked in time proportional to the
    depth of its paths, whatever the number of relationships; two ends that may be any file cover every link.
    """

    def __init__(self):
        self.by_start, self.by_end, self.by_start_part, self.end_parts, self.everything = {}, {}, {}, set(), False

    @staticmethod
    def matcher(lead):
        kind, value = lead
        if kind in {'file', 'region'}:
            return 'files', frozenset((value[0] if kind == 'region' else value,))
        if kind == 'candidates':
            return 'files', value
        if kind == 'suffix':
            return 'suffix', value[1]
        return 'any', None

    def add(self, starts, ends):
        start, end = self.matcher(starts), self.matcher(ends)
        if start[0] == 'files':
            for each in start[1]:
                self.by_start.setdefault(each, Ends()).add(end)
        elif end[0] == 'files':
            for each in end[1]:
                self.by_end.setdefault(each, Ends()).add(start)
        elif start[0] == 'suffix':
            self.by_start_part.setdefault(start[1], Ends()).add(end)
        elif end[0] == 'suffix':
            self.end_parts.add(end[1])  # any source
        else:
            self.everything = True

    def covers(self, start, end):
        return (self.everything or start in self.by_start and self.by_start[start].matches(end)
                or end in self.by_end and self.by_end[end].matches(start)
                or bool(self.by_start_part) and any(tail in self.by_start_part and self.by_start_part[tail].matches(end) for tail in tails(start))
                or bool(self.end_parts) and any(tail in self.end_parts for tail in tails(end)))


def mirror_checks(linked, links, doubt, nodes, issue, written):
    """`manifest-mismatch` and `manifest-unchecked` of the manifests that declare `"linkedRelationships": true`.

    Rules: docs/modelo-e-leitura.md, section "Manifesto e links: `linkedRelationships`". `linked` holds, for
    each manifest read whole, (manifest, object files, relationships with both ends named, relationships not
    compared with why, and the pairs those may stand for); `links` the first explicit link outside fenced
    blocks of each source to each file it names, wherever the relation cap fell; `doubt` where the other
    links of a source may lead; `written` the paths a source writes as a link destination that the
    extractor did not read. What the reader did not resolve never becomes a mismatch: it is a
    `manifest-unchecked`, with the reason.
    """
    for manifest, members, compared, unchecked, suspended in linked:
        declared, said = set(), set()

        def not_compared(line, written_start, written_end, evidence, reason, start, end):
            key = (start or written_start, end or written_end)
            if key in said:
                return
            said.add(key)
            pair = f'{printable(written_start)} → {printable(written_end)}'
            issue('manifest-unchecked', say('Manifest relation not checked against the links: {pair}. Reason: {reason}.', pair=pair, reason=say(UNCHECKED[reason])),
                  manifest, line, target=pair, reason=reason, evidence=evidence,
                  **({'from': start} if start else {}), **({'to': end} if end else {}), manifest=manifest)
        for start, end, line, written_start, written_end, evidence in compared:
            if (start, end) in declared:
                continue
            declared.add((start, end))
            if manifest_file(start) or manifest_file(end):
                not_compared(line, written_start, written_end, evidence, 'manifest-end', start, end)
                continue
            if end in links.get(start, ()) or nodes[start].get('status') in {'missing', 'declared'}:
                continue  # mirrored; or a source that does not exist, already said (broken, declared-external)
            doubts = doubt.get(start, {'any': False, 'paths': (), 'regions': (), 'suffixes': ()})
            reason = ('source-not-read' if nodes[start].get('analysis') != 'parsed' else
                      'unresolved-link' if doubts['any'] or doubts['suffixes'] and any(tail in doubts['suffixes'] for tail in tails(end)) else
                      'ambiguous-link' if end in doubts['paths'] else
                      'unread-folder-link' if doubts['regions'] and within_any(end, doubts['regions']) else
                      'unextracted-link' if end in written(start) else None)
            if reason:
                not_compared(line, written_start, written_end, evidence, reason, start, end)
                continue
            pair = f'{printable(written_start)} → {printable(written_end)}'
            issue('manifest-mismatch', say('Manifest relation without a link in the source file: {pair}. With linkedRelationships, '
                                            'each relation has an explicit link from the source file to the target, outside a code block.', pair=pair),
                  manifest, line, target=pair, absent='link', evidence=evidence, **{'from': start, 'to': end, 'manifest': manifest})
        for item in unchecked:
            not_compared(*item)
        for start in sorted(members):
            if manifest_file(start):
                continue
            for end, (line, raw, evidence, syntax) in links.get(start, {}).items():
                if (end == start or end not in members or manifest_file(end) or (start, end) in declared
                        or suspended.covers(start, end)):
                    continue
                where = os.path.relpath(manifest, os.path.dirname(start))
                issue('manifest-mismatch', say('Link without a relation in the manifest {manifest}: {raw}. With linkedRelationships, '
                                                'each explicit link between two objects of the manifest is one of its relations.', manifest=where, raw=printable(raw)),
                      start, line, target=printable(raw), absent='relation', evidence=evidence, syntax=syntax,
                      **{'from': start, 'to': end, 'manifest': manifest})


def reachability(nodes, edges, inventoried, declared_starts, exempt_files, issue, partial_roots=frozenset()):
    """Directed BFS from entries over explicit references; candidates, never runtime claims.

    Annotates `hops` on reached nodes and reports unreached documents (docs/modelo-e-leitura.md, section
    "Alcançabilidade"). With any root in `partial_roots`, each `unreachable` carries `conclusive: false`.
    """
    starts = {n: 'convention' for n in sorted(inventoried) if nodes[n]['kind'] == 'entry' and nodes[n]['status'] == 'resolved'}
    for n in sorted(declared_starts):
        starts.setdefault(n, declared_starts[n])
    if not starts:
        return None
    adjacency, inbound = {}, {}
    for edge in edges:
        if edge['kind'] == 'scope':
            continue
        adjacency.setdefault(edge['source'], []).append(edge['target'])
        if edge['source'] != edge['target']:
            inbound.setdefault(edge['target'], set()).add(edge['source'])
    hops = dict.fromkeys(starts, 0)
    queue = deque(hops)
    while queue:
        current = queue.popleft()
        for target in adjacency.get(current, ()):
            if target not in hops and nodes[target]['status'] == 'resolved':
                hops[target] = hops[current] + 1
                queue.append(target)
    for n, count in hops.items():
        nodes[n]['hops'] = count
    referenced_directories = {target for source in hops for target in adjacency.get(source, ()) if nodes[target]['kind'] == 'directory'}
    documents, unreached, exempt = [], [], 0
    for n in sorted(inventoried):
        record = nodes[n]
        if record['status'] != 'resolved' or record['kind'] == 'directory' or Path(n).suffix.lower() not in DOCUMENTS:
            continue
        if n in starts:
            documents.append(n)
        elif n in exempt_files:
            exempt += 1
        else:
            documents.append(n)
            if n not in hops:
                unreached.append(n)
    orphans = islands = 0
    for n in unreached:
        sources = inbound.get(n, ())
        details = {'class': 'island' if sources else 'orphan', 'inbound': len(sources)}
        if sources:
            islands += 1
            message = say('No path by explicit reference from the entries considered: referenced only by files that have no path either: {inbound}. '
                           'Candidate for review: the file can still be found by search, and the tool does not observe execution.', inbound=len(sources))
        else:
            orphans += 1
            message = say('No path by explicit reference from the entries considered: no other file references it. '
                           'Candidate for review: the file can still be found by search, and the tool does not observe execution.')
        # Lexical walk up to the outermost containing root; ids are normalized absolute paths.
        outer, current = min(nodes[n]['roots'], key=len), os.path.dirname(n)
        while current not in referenced_directories and current != outer and len(current) > len(outer):
            current = os.path.dirname(current)
        if current in referenced_directories:
            details['referencedAncestor'] = current
        if partial_roots.intersection(nodes[n]['roots']):
            details['conclusive'] = False
            # `partial` is a fact for the interface: which reading leaves the finding open.
            message = say('{finding} Not conclusive: the scan of this root is partial (inventory cut, text not analyzed or relations cut).',
                           finding=message, partial='root')
        elif partial_roots:
            # A file of a root read in part may cite it across roots (`../A/x.md`).
            details['conclusive'] = False
            message = say('{finding} Not conclusive: the scan of another root of the workspace is partial, and a file of it may reference this one.',
                           finding=message, partial='other-root')
        issue('unreachable', message, n, None, **details)
    reached = [hops[n] for n in documents if n in hops]
    # A convention entry that a declared pattern also matches keeps `convention` as its
    # source and names the declared kind too: the audit mass sums declared entries.
    return {'starts': [{'node': n, 'source': source, **({'declared': declared_starts[n]} if source != declared_starts.get(n, source) else {})}
                       for n, source in starts.items()],
            'documents': len(documents), 'reachable': len(reached), 'unreachable': len(unreached),
            'orphans': orphans, 'islands': islands, 'exempt': exempt,
            'hops': {'max': max(reached) if reached else None, 'median': median_low(reached) if reached else None}}


def find_path(model, start, end, direction='directed', conventions=False):
    ids = {n['id'] for n in model['nodes']}
    if start not in ids or end not in ids:
        raise ValueError(say('Select two files of the workspace.'))
    if direction not in {'directed', 'undirected'}:
        raise ValueError(say('Invalid direction.'))
    adjacency = {}
    for edge in model['edges']:
        if edge['kind'] == 'scope' and not conventions:
            continue
        adjacency.setdefault(edge['source'], []).append((edge['target'], edge['id'], False))
        if direction == 'undirected':
            adjacency.setdefault(edge['target'], []).append((edge['source'], edge['id'], True))
    parents = {start: None}
    queue = deque([start])
    while queue:
        current = queue.popleft()
        if current == end:
            steps, node_ids = [], [end]
            while parents[current] is not None:
                previous, edge, reverse = parents[current]
                steps.append({'edge': edge, 'reverse': reverse})
                node_ids.append(previous)
                current = previous
            return {'found': True, 'nodes': node_ids[::-1], 'steps': steps[::-1]}
        for neighbor, edge, reverse in adjacency.get(current, []):
            if neighbor not in parents:
                parents[neighbor] = (current, edge, reverse)
                queue.append(neighbor)
    return {'found': False, 'nodes': [], 'steps': []}
