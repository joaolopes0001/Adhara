import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  changedSpan,
  compareObservations,
  diffLines,
  editableCount,
  flowOf,
  hunks,
  lineColumn,
  lineStart,
  markRows,
  notEditable,
  ownerRoot,
  placeAt,
  previousText,
  settleUnknown,
  shouldReread,
} from '../../src/editing';
import { ApiError } from '../../src/api';
import type { FileNode, Issue, Root } from '../../src/types';

// The pure rules of editing (src/editing.ts), without a browser: the line comparison and its budget, the
// cursor at a line, the undo pair, the outcome of an unknown save, the flow of each refusal code, what the
// window knows is not editable, and the comparison of observations by stable key.

test('editing logic: the line comparison counts lines added and removed, keeps the order and falls back to one block past its budget', () => {
  const same = diffLines('a\nb\n', 'a\nb\n');
  expect([same.added, same.removed, same.replaced]).toEqual([0, 0, false]);
  expect(hunks(same)).toEqual([]);

  const one = diffLines('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nD\ne\nf\ng\n');
  expect([one.added, one.removed]).toEqual([1, 1]);
  // Removed before added, two lines of context, numbers in each text.
  expect(hunks(one)).toEqual([
    [
      { kind: 'same', text: 'b', before: 2, after: 2 },
      { kind: 'same', text: 'c', before: 3, after: 3 },
      { kind: 'removed', text: 'd', before: 4 },
      { kind: 'added', text: 'D', after: 4 },
      { kind: 'same', text: 'e', before: 5, after: 5 },
      { kind: 'same', text: 'f', before: 6, after: 6 },
    ],
  ]);

  // A line inserted and one removed far apart: two groups.
  const lines = Array.from({ length: 30 }, (_, index) => `linha ${index}`);
  const moved = [...lines.slice(0, 3), 'nova', ...lines.slice(3, 25), ...lines.slice(26)];
  const two = diffLines(lines.join('\n'), moved.join('\n'));
  expect([two.added, two.removed]).toEqual([1, 1]);
  expect(hunks(two)).toHaveLength(2);

  // Only additions at the end, and only removals.
  expect(diffLines('a\n', 'a\nb\nc\n')).toMatchObject({ added: 2, removed: 0, replaced: false });
  expect(diffLines('a\nb\nc\n', 'a\n')).toMatchObject({ added: 0, removed: 2, replaced: false });

  // Past the budget, the changed middle is one block removed and one added, and it says so.
  const before = Array.from({ length: 300 }, (_, index) => `a${index}`).join('\n');
  const after = Array.from({ length: 300 }, (_, index) => `b${index}`).join('\n');
  const block = diffLines(`x\n${before}\ny`, `x\n${after}\ny`, 100);
  expect([block.added, block.removed, block.replaced]).toEqual([300, 300, true]);
  expect(block.lines[0]).toEqual({ kind: 'same', text: 'x', before: 1, after: 1 });
  expect(block.lines.at(-1)).toEqual({ kind: 'same', text: 'y', before: 302, after: 302 });
  // Within the budget the same texts are compared line by line.
  expect(diffLines(`x\n${before}\ny`, `x\n${after}\ny`).replaced).toBe(false);
});

test('editing logic: a 5,000-line file with one line changed compares at once, and a whole rewrite stays within the budget', () => {
  const text = Array.from({ length: 5000 }, (_, index) => `Linha ${index + 1} do texto.`).join(
    '\n',
  );
  const changed = text.replace('Linha 4000 do texto.', 'Linha 4000 corrigida.');
  let started = performance.now();
  const small = diffLines(text, changed);
  const smallMs = performance.now() - started;
  expect([small.added, small.removed]).toEqual([1, 1]);
  // Two lines far apart, the first and the last: still line by line, not one block.
  const ends = changed
    .replace('Linha 1 do texto.', 'Primeira.')
    .replace('Linha 5000 do texto.', 'Última.');
  const far = diffLines(text, ends);
  expect([far.added, far.removed, far.replaced]).toEqual([3, 3, false]);
  expect(hunks(far)).toHaveLength(3);
  const rewritten = text.replaceAll('do texto', 'reescrita');
  started = performance.now();
  const large = diffLines(text, rewritten);
  const largeMs = performance.now() - started;
  expect(large.replaced).toBe(true);
  expect([large.added, large.removed]).toEqual([5000, 5000]);
  test.info().annotations.push({
    type: 'medida',
    description: `diff de 5.000 linhas: 1 linha mudada ${smallMs.toFixed(1)} ms; tudo reescrito ${largeMs.toFixed(1)} ms`,
  });
  expect(smallMs).toBeLessThan(200);
  expect(largeMs).toBeLessThan(500);
});

test('editing logic: the rows of "Ver mudanças": a changed line is the old one right above the new one, with the part that differs; numbers are those of the text now; past the budget, one block', () => {
  // The first line removed, line 3 changed, a line added before the last one.
  const rows = markRows(diffLines('um\ndois\ntrês\nquatro\n', 'dois\nTRÊS\nquatro\nnovo\n'));
  expect(rows).toEqual([
    { kind: 'removed', text: 'um' },
    { kind: 'same', text: 'dois', line: 1 },
    { kind: 'removed', text: 'três', changed: [0, 4] },
    { kind: 'added', text: 'TRÊS', line: 2, changed: [0, 4] },
    { kind: 'same', text: 'quatro', line: 3 },
    { kind: 'added', text: 'novo', line: 4 },
    { kind: 'same', text: '', line: 5 },
  ]);
  // A trailing space: the space is what differs.
  expect(changedSpan('[a](b.md)', '[a](b.md) ')).toEqual([
    [9, 9],
    [9, 10],
  ]);
  expect(changedSpan('[Ausente](ausente.md)', '[Ausente](hostil.md)')).toEqual([
    [10, 17],
    [10, 16],
  ]);
  // Two removed and one added: one pair, then the rest.
  expect(markRows(diffLines('a\nb\nc', 'a\nB')).map((row) => row.kind)).toEqual([
    'same',
    'removed',
    'added',
    'removed',
  ]);
  // Past the budget: the removed middle is one block, the added lines stay, each with its number.
  const before = Array.from({ length: 30 }, (_, index) => `linha ${index}`).join('\n');
  const after = Array.from({ length: 30 }, (_, index) => `outra ${index}`).join('\n');
  const block = markRows(diffLines(before, after, 10));
  expect(block[0]).toEqual({ kind: 'block', count: 30 });
  expect(block.slice(1).every((row) => row.kind === 'added')).toBe(true);
  expect(block.at(-1)).toMatchObject({ line: 30 });
});

test('editing logic: positions count \\n, and a line is opened with only its written destination selected, never the whole line', () => {
  const text = '# Título\n\nVeja [o anexo](anexo.md) e `anexo.md`.\nFim';
  expect(lineStart(text, 1)).toBe(0);
  expect(lineStart(text, 3)).toBe(10);
  expect(lineStart(text, 99)).toBe(text.length);
  expect(lineColumn(text, 0)).toEqual({ line: 1, column: 1 });
  expect(lineColumn(text, 10)).toEqual({ line: 3, column: 1 });
  expect(lineColumn(text, text.length)).toEqual({ line: 4, column: 4 });
  // The Markdown link's destination, not the mention in backticks after it.
  const at = placeAt(text, 3, 'anexo.md', 'markdown');
  expect(text.slice(at.start, at.end)).toBe('anexo.md');
  expect(at.start).toBe(text.indexOf('(anexo.md') + 1);
  // A destination that is no longer on the line: the cursor at the start of the line, nothing selected.
  expect(placeAt(text, 3, 'outro.md', 'markdown')).toEqual({ start: 10, end: 10 });
  // Without a destination, the start of the line; past the end, the end of the text.
  expect(placeAt(text, 2)).toEqual({ start: 9, end: 9 });
  expect(placeAt(text, 40)).toEqual({ start: text.length, end: text.length });
  // A wikilink and an import.
  const wiki = placeAt('Ver [[nota|rótulo]] e @CLAUDE.md\n', 1, 'nota', 'wiki');
  expect([wiki.start, wiki.end]).toEqual([6, 10]);
  const at2 = placeAt('Ver [[nota|rótulo]] e @CLAUDE.md\n', 1, 'CLAUDE.md', 'import');
  expect([at2.start, at2.end]).toEqual([23, 32]);
});

test('editing logic: the undo pair, the unknown outcome and the flow of each refusal code', () => {
  // The previous text is only the pair whose hash the answer names.
  expect(previousText([{ text: 'antes', sha256: 'aa' }], 'aa')).toBe('antes');
  expect(previousText([{ text: 'antes', sha256: 'aa' }], 'bb')).toBeUndefined();

  // An unknown answer: the disk decides, never "not saved" without looking.
  expect(settleUnknown({ text: 'meu', sha256: 'cc' }, 'meu', 'aa')).toBe('saved');
  expect(settleUnknown({ text: 'base', sha256: 'aa' }, 'meu', 'aa')).toBe('not-saved');
  expect(settleUnknown({ text: 'outro', sha256: 'dd' }, 'meu', 'aa')).toBe('conflict');

  // By the code, never by the status: 409 means four things.
  const refusal = (code: string | undefined, status = 409) => new ApiError('x', status, code);
  expect(flowOf(refusal('conflict'))).toBe('conflict');
  expect(flowOf(refusal('missing'))).toBe('missing');
  expect(flowOf(refusal('unconfirmed'))).toBe('unknown');
  expect(flowOf(refusal('folder-changed'))).toBe('message');
  expect(flowOf(refusal('edit-not-granted', 403))).toBe('not-granted');
  expect(flowOf(refusal('protected', 403))).toBe('message');
  expect(flowOf(refusal('session', 403))).toBe('session');
  expect(flowOf(refusal('write-failed', 400))).toBe('message');
  // Without a code: a server error is unknown; an input error is its message; no answer is unknown.
  expect(flowOf(refusal(undefined, 500))).toBe('unknown');
  expect(flowOf(refusal(undefined, 400))).toBe('message');
  expect(flowOf(new TypeError('Failed to fetch'))).toBe('unknown');
  expect(flowOf(undefined)).toBe('unknown');

  // A save reads the projects again when the last reading took up to 1 s, or none was measured.
  expect(shouldReread(undefined)).toBe(true);
  expect(shouldReread(1000)).toBe(true);
  expect(shouldReread(1001)).toBe(false);
});

test('editing logic: what is not editable before asking, the owner project and the files a permission allows', () => {
  const limits = { extensions: ['.markdown', '.md'], maxBytes: 262144 };
  const node = (path: string, extra: Partial<FileNode> = {}): FileNode => ({
    id: path,
    path,
    name: path.split('/').at(-1)!,
    relative: path,
    kind: 'file',
    status: 'resolved',
    root: '/p',
    roots: ['/p'],
    bytes: 10,
    ...extra,
  });
  expect(notEditable(node('/p/a.md'), limits)).toBeNull();
  expect(notEditable(node('/p/A.MARKDOWN'), limits)).toBeNull();
  expect(notEditable(node('/p/a.json'), limits)).toEqual({ reason: 'type', extension: '.json' });
  expect(notEditable(node('/p/Makefile'), limits)).toEqual({ reason: 'type', extension: '' });
  expect(notEditable(node('/p/.md'), limits)).toEqual({ reason: 'type', extension: '' });
  expect(notEditable(node('/p/a.md', { bytes: 262144 }), limits)).toBeNull();
  expect(notEditable(node('/p/a.md', { bytes: 262145 }), limits)).toEqual({
    reason: 'size',
    maxBytes: 262144,
  });
  expect(notEditable(node('/p/a.md', { kind: 'symlink' }), limits)).toEqual({ reason: 'symlink' });
  expect(notEditable(node('/p/a.md', { status: 'missing' }), limits)).toEqual({ reason: 'status' });

  const roots: Root[] = [
    { path: '/p', name: 'p', parent: null, level: 0, entries: [] },
    { path: '/p/sub', name: 'sub', parent: '/p', level: 1, entries: [] },
  ];
  expect(ownerRoot(roots, '/p/a.md')).toBe('/p');
  expect(ownerRoot(roots, '/p/sub/b.md')).toBe('/p/sub');
  expect(ownerRoot(roots, '/p/subx/b.md')).toBe('/p');
  expect(ownerRoot(roots, '/q/c.md')).toBeUndefined();
  // A nested project's files are its own: the outer permission does not count them.
  const nodes = [
    node('/p/a.md'),
    node('/p/b.json'),
    node('/p/sub/c.md'),
    node('/p/big.md', { bytes: 300000 }),
    node('/p/docs', { kind: 'directory' }),
  ];
  expect(editableCount(roots, nodes, '/p', limits)).toBe(1);
  expect(editableCount(roots, nodes, '/p/sub', limits)).toBe(1);
});

test('editing logic: observations compared by stable key, in the file and in the others', () => {
  const issue = (id: string, node: string, key?: string, line = 1): Issue => ({
    id,
    code: 'broken',
    message: '',
    node,
    line,
    key,
  });
  const before = [
    issue('1', '/a.md', 'k1', 5),
    issue('2', '/a.md', 'k2', 9),
    issue('3', '/b.md', 'k3'),
  ];
  // k2 moved to another line (same key): not new, not resolved.
  const after = [
    issue('4', '/a.md', 'k2', 7),
    issue('5', '/a.md', 'k4', 2),
    issue('6', '/c.md', 'k5'),
  ];
  const change = compareObservations(before, after, '/a.md');
  expect(change.resolved.map((item) => item.key)).toEqual(['k1']);
  expect(change.added.map((item) => item.key)).toEqual(['k4']);
  expect([change.resolvedElsewhere, change.addedElsewhere]).toEqual([1, 1]);
});

test('editing: no file of the interface sets HTML from text (innerHTML or dangerouslySetInnerHTML)', () => {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.(tsx?|jsx?)$/.test(name) &&
        /innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML/.test(
          readFileSync(path, 'utf8'),
        )
      )
        found.push(path);
    }
  };
  walk(join(process.cwd(), 'src'));
  expect(found).toEqual([]);
});
