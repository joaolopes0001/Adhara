/**
 * Pure rules of document editing, without React, requests or interface text; `src/FileEditor.tsx` puts
 * them on the screen.
 */
import type { EditLimits, FileNode, Issue, Root } from './types';

export const REREAD_MS = 1000;
/**
 * Most lines added plus removed that `diffLines` aligns one by one; past it, the changed middle is one
 * replaced block, so a large change never freezes the screen. The work grows with the lines times this.
 */
export const DIFF_BUDGET = 1000;

export type DiffLine = {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** Line number in the text before (same, removed) and after (same, added). */
  before?: number;
  after?: number;
};
/** `replaced`: past the budget, the changed middle is one block removed and one added. */
export type Diff = { lines: DiffLine[]; added: number; removed: number; replaced: boolean };

type Step = 'same' | 'added' | 'removed';
/**
 * The shortest script of lines kept, added and removed from `a` to `b` (Myers, 1986), or null when it
 * needs more than `limit` additions and removals. Each round keeps only its 2d+1 furthest points, so the
 * memory is (limit+1)² numbers at most.
 */
function shortestScript(a: string[], b: string[], limit: number): Step[] | null {
  const n = a.length,
    m = b.length,
    max = Math.min(n + m, limit),
    offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  const rounds: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1]);
      let x = down ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) return script(rounds, d, n, m);
    }
    rounds.push(furthest.slice(offset - d, offset + d + 1));
  }
  return null;
}
/** Walks the rounds back from the end: each one added or removed a line, after a run of equal lines. */
function script(rounds: Int32Array[], last: number, n: number, m: number) {
  const steps: Step[] = [];
  let x = n,
    y = m;
  for (let d = last; d > 0; d--) {
    const previous = rounds[d - 1];
    const at = (k: number) => previous[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const fromK = down ? k + 1 : k - 1;
    const fromX = at(fromK),
      fromY = fromX - fromK;
    while (x > fromX && y > fromY) {
      steps.push('same');
      x--;
      y--;
    }
    steps.push(down ? 'added' : 'removed');
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    steps.push('same');
    x--;
    y--;
  }
  return steps.reverse();
}

/**
 * Line comparison of two texts with `\n`: the common start and end, then the shortest script of the middle
 * up to `budget`. Within a change, the removed lines come before the added ones, as a diff reads.
 */
export function diffLines(before: string, after: string, budget = DIFF_BUDGET): Diff {
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines: DiffLine[] = [];
  for (let index = 0; index < start; index++)
    lines.push({ kind: 'same', text: a[index], before: index + 1, after: index + 1 });
  const steps = shortestScript(a.slice(start, endA), b.slice(start, endB), budget);
  const replaced = !steps;
  const middle: DiffLine[] = [];
  let i = start,
    j = start;
  let added: DiffLine[] = [];
  const flush = () => {
    middle.push(...added);
    added = [];
  };
  for (const step of steps ??
    ([
      ...Array<Step>(endA - start).fill('removed'),
      ...Array<Step>(endB - start).fill('added'),
    ] as Step[])) {
    if (step === 'same') {
      flush();
      middle.push({ kind: 'same', text: a[i], before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (step === 'removed') {
      middle.push({ kind: 'removed', text: a[i], before: i + 1 });
      i++;
    } else {
      added.push({ kind: 'added', text: b[j], after: j + 1 });
      j++;
    }
  }
  flush();
  lines.push(...middle);
  for (let index = 0; index < a.length - endA; index++)
    lines.push({
      kind: 'same',
      text: a[endA + index],
      before: endA + index + 1,
      after: endB + index + 1,
    });
  return {
    lines,
    added: middle.filter((line) => line.kind === 'added').length,
    removed: middle.filter((line) => line.kind === 'removed').length,
    // A block replaced only when there was something on both sides to compare.
    replaced: replaced && endA > start && endB > start,
  };
}

/**
 * One row of the text shown with its changes: a line of the current text (`line`, its number), or a removed
 * line, without number. `changed` is the [start, end) of the part that differs from its pair.
 */
export type MarkRow =
  | { kind: 'same' | 'added'; text: string; line: number; changed?: [number, number] }
  | { kind: 'removed'; text: string; changed?: [number, number] }
  | { kind: 'block'; count: number };

/** The part of two lines that differs: after their common start and before their common end. */
export function changedSpan(a: string, b: string): [[number, number], [number, number]] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    [start, a.length - end],
    [start, b.length - end],
  ];
}

/**
 * The rows of the text with its changes: each run of removed lines followed by a run of added ones is
 * shown as pairs (the old line right above the new one, with the part that differs marked in both), then
 * what is left of either run. A comparison past the budget shows its removed middle as one block.
 */
export function markRows(diff: Diff): MarkRow[] {
  const rows: MarkRow[] = [];
  const lines = diff.lines;
  let index = 0;
  while (index < lines.length) {
    const item = lines[index];
    if (item.kind === 'same') {
      rows.push({ kind: 'same', text: item.text, line: item.after! });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === 'removed') removed.push(lines[index++]);
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === 'added') added.push(lines[index++]);
    if (diff.replaced && removed.length) {
      rows.push({ kind: 'block', count: removed.length });
      for (const each of added) rows.push({ kind: 'added', text: each.text, line: each.after! });
      continue;
    }
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const [old, now] = changedSpan(removed[k].text, added[k].text);
      rows.push({ kind: 'removed', text: removed[k].text, changed: old });
      rows.push({ kind: 'added', text: added[k].text, line: added[k].after!, changed: now });
    }
    for (const each of removed.slice(pairs)) rows.push({ kind: 'removed', text: each.text });
    for (const each of added.slice(pairs))
      rows.push({ kind: 'added', text: each.text, line: each.after! });
  }
  return rows;
}

/** The changed lines with `context` lines around them, one group per stretch; unchanged texts give none. */
export function hunks(diff: Diff, context = 2): DiffLine[][] {
  const keep = new Set<number>();
  diff.lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let near = index - context; near <= index + context; near++) keep.add(near);
  });
  const groups: DiffLine[][] = [];
  let previous = -2;
  diff.lines.forEach((line, index) => {
    if (!keep.has(index)) return;
    if (index !== previous + 1) groups.push([]);
    groups.at(-1)!.push(line);
    previous = index;
  });
  return groups;
}

/** Offset where `line` (1-based) starts; past the last line, the end of the text. Lines are counted by `\n`. */
export function lineStart(text: string, line: number) {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}
/** Line and column (1-based) of an offset, counting `\n` as the preview does. */
export function lineColumn(text: string, offset: number) {
  let line = 1,
    start = 0;
  for (let at = text.indexOf('\n'); at >= 0 && at < offset; at = text.indexOf('\n', at + 1)) {
    line++;
    start = at + 1;
  }
  return { line, column: offset - start + 1 };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Where the destination of a reference is written on its line, as [start, end) ranges, at the place its
 * syntax gives it. The model keeps one reference per destination and line, without its column: when the
 * syntax does not single it out (a written path, a manifest value, the same syntax twice), every
 * occurrence is marked. None when the line no longer has it (the file changed after the reading) or never
 * wrote it (the use of a reference link).
 */
export function targetRanges(text: string, target: string, syntax = ''): [number, number][] {
  if (!target || syntax === 'declared' || syntax === 'scope') return [];
  // What comes before and after the destination in each syntax (as the reader extracts it).
  const around: Record<string, [string, string]> = {
    markdown: [String.raw`\]\(\s*<?`, String.raw`(?=>|\)|\s)`],
    'markdown-reference': [String.raw`\]:\s*<?`, String.raw`(?=>|\s|$)`],
    wiki: [String.raw`\[\[\s*`, String.raw`(?=\s*(?:\\?\||\]\]))`],
    import: [String.raw`(?:^|\s)@`, String.raw`(?![\w./~-])`],
  };
  const find = ([before, after]: [string, string]) =>
    [...text.matchAll(new RegExp(`${before}(${escaped(target)})${after}`, 'g'))].map((match) => {
      const start = match.index! + match[0].length - match[1].length;
      return [start, start + target.length] as [number, number];
    });
  const placed = around[syntax] ? find(around[syntax]) : [];
  return placed.length ? placed : find(['', '']);
}
/**
 * Where the editor puts the cursor for a line of `text`: only the destination written on it selected,
 * when the line has it (the first place its syntax gives); else the start of the line, with nothing
 * selected. Never the whole line, which the first key would erase.
 */
export function placeAt(text: string, line: number, target = '', syntax = '') {
  const start = lineStart(text, Math.max(1, line));
  const end = text.indexOf('\n', start);
  const ranges = targetRanges(text.slice(start, end < 0 ? text.length : end), target, syntax);
  return ranges.length
    ? { start: start + ranges[0][0], end: start + ranges[0][1] }
    : { start, end: start };
}

/** A text as the server gave it, with the hash of its bytes on disk: the window never computes a hash. */
export type Known = { text: string; sha256: string };
/**
 * The text a save replaced, when the window knows it: the pair received from the server whose hash is
 * the `previousSha256` of the answer. Without such a pair there is no undo.
 */
export function previousText(known: Known[], previousSha256: string) {
  return known.find((item) => item.sha256 === previousSha256)?.text;
}

/**
 * After an answer that says nothing (a network error, a server error, `unconfirmed`), what the disk says:
 * the text intended is there (`saved`), the disk still has the base (`not-saved`), or neither (`conflict`).
 */
export function settleUnknown(disk: Known, intended: string, baseSha256: string) {
  if (disk.text === intended) return 'saved' as const;
  if (disk.sha256 === baseSha256) return 'not-saved' as const;
  return 'conflict' as const;
}

/** What the screen does with a failed request: by its `code`, never by the status nor the text. */
export type Flow = 'conflict' | 'missing' | 'unknown' | 'not-granted' | 'session' | 'message';
export function flowOf(error: unknown): Flow {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (typeof status !== 'number') return 'unknown'; // no answer at all: a network error
  if (code === 'conflict') return 'conflict';
  if (code === 'missing') return 'missing';
  if (code === 'unconfirmed') return 'unknown';
  if (code === 'edit-not-granted') return 'not-granted';
  if (code === 'session') return 'session';
  if (typeof code === 'string') return 'message';
  return status >= 500 ? 'unknown' : 'message';
}

/** Whether a save is followed by a reading: the last one of this window took up to 1 s, or there was none. */
export const shouldReread = (lastMs: number | undefined) =>
  lastMs === undefined || lastMs <= REREAD_MS;

/** The opened project a path belongs to: the most specific one that contains it. */
export function ownerRoot(roots: Root[], path: string) {
  let best: string | undefined;
  for (const root of roots)
    if (path.startsWith(`${root.path}/`) && (!best || root.path.length > best.length))
      best = root.path;
  return best;
}

/** Why the window already knows a file is not editable, before asking the server; null when it may be. */
export type NotEditable =
  | { reason: 'type'; extension: string }
  | { reason: 'size'; maxBytes: number }
  | { reason: 'symlink' }
  | { reason: 'status' };
export function notEditable(node: FileNode, limits: EditLimits): NotEditable | null {
  if (node.kind === 'symlink') return { reason: 'symlink' };
  if (node.status !== 'resolved' || node.kind === 'directory' || node.kind === 'unresolved')
    return { reason: 'status' };
  const dot = node.name.lastIndexOf('.');
  const extension = dot > 0 ? node.name.slice(dot).toLowerCase() : '';
  if (!limits.extensions.includes(extension)) return { reason: 'type', extension };
  if (node.bytes !== undefined && node.bytes > limits.maxBytes)
    return { reason: 'size', maxBytes: limits.maxBytes };
  return null;
}
/** Files of a project that turning editing on would make editable: its own Markdown files within the size. */
export function editableCount(roots: Root[], nodes: FileNode[], root: string, limits: EditLimits) {
  return nodes.filter((node) => ownerRoot(roots, node.path) === root && !notEditable(node, limits))
    .length;
}

/** Observations that a reading resolved and that it brought, in one file and in the others. */
export type ObservationChange = {
  resolved: Issue[];
  added: Issue[];
  resolvedElsewhere: number;
  addedElsewhere: number;
};
/**
 * The identity of an observation across readings: its stable key (code, path in its project, destination
 * as written and ordinal; not the line, so an observation whose line moved is the same one), else its id
 * (an observation outside the opened projects has no key).
 */
export const observationKey = (item: Issue) => item.key ?? `id:${item.id}`;
/** Compares the active observations of two readings by `observationKey`. */
export function compareObservations(before: Issue[], after: Issue[], path: string) {
  const identity = observationKey;
  const was = new Set(before.map(identity)),
    is = new Set(after.map(identity));
  const change: ObservationChange = {
    resolved: [],
    added: [],
    resolvedElsewhere: 0,
    addedElsewhere: 0,
  };
  for (const item of before)
    if (!is.has(identity(item))) {
      if (item.node === path) change.resolved.push(item);
      else change.resolvedElsewhere++;
    }
  for (const item of after)
    if (!was.has(identity(item))) {
      if (item.node === path) change.added.push(item);
      else change.addedElsewhere++;
    }
  return change;
}
