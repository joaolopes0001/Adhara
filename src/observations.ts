import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import type { Issue, Model, Relation, Root, ScopeKind, ScopeManifest, ScopePlace } from './types';
import { dirname, within } from './scopeNavigation';
import { formatNumber, plural as pluralPhrase, rich, t } from './i18n';
import { earlierHere, messageText, serverFact } from './serverText';
import type { ServerPhrase } from './serverText';

/**
 * Single dictionary of observation codes (model issues and the `aae audit` findings compared in
 * "Changes"): short title, one sentence saying what the observation is in terms of the user's files, and a
 * tone. Used by the audit, the inspector, the item markers and the changes tool. The code itself stays a
 * secondary detail (tooltip), to match the CLI output. What each type means at length and what to do about it
 * lives in the usage guide (docs/guia-de-uso.md, "Observações"), not on screen. The words are written in
 * English where they are used and resolved when they are shown, so they follow the interface language.
 *
 * Tones are a reading aid, not a severity contract: `problem` is a reference or declaration to fix,
 * `warning` limits the reading or the configuration, `info` may be intentional and is never an error.
 */
export type Tone = 'problem' | 'warning' | 'info';
export type CodeInfo = { title: string; tone: Tone; meaning: string };

/** Tone of each code; the words (title and meaning) are resolved when they are used, in the active language. */
const codeTones: Record<string, Tone> = {
  broken: 'problem',
  ambiguous: 'warning',
  'outside-root': 'warning',
  unverified: 'info',
  'invalid-reference': 'problem',
  manifest: 'problem',
  'manifest-mismatch': 'warning',
  'manifest-unchecked': 'info',
  'no-entry': 'warning',
  'scope-unused-pattern': 'warning',
  limit: 'warning',
  unreadable: 'warning',
  'analysis-partial': 'warning',
  'unresolved-name': 'info',
  unreachable: 'info',
  symlink: 'info',
  'basename-resolved': 'info',
  'suffix-resolved': 'info',
  'root-dot-resolved': 'info',
  'declared-external': 'info',
};

/** Title and meaning of a known code in the active language, or undefined when the code is not known. */
function codeWords(code: string): { title: string; meaning: string } | undefined {
  switch (code) {
    case 'broken':
      return {
        title: t('Broken reference'),
        meaning: t(
          'The referenced file does not exist at the written path or in the other places the reader looks.',
        ),
      };
    case 'ambiguous':
      return {
        title: t('Ambiguous reference'),
        meaning: t(
          'What is written matches more than one file of the project, and the reader picks none.',
        ),
      };
    case 'outside-root':
      return {
        title: t('Target above the open project'),
        meaning: t(
          'The referenced file is not in the open project, but exists in a folder above it.',
        ),
      };
    case 'unverified':
      return {
        title: t('Unverified absence'),
        meaning: t(
          'The reader did not find the target, but did not read everything that could contain it; the absence is not certain.',
        ),
      };
    case 'invalid-reference':
      return {
        title: t('Invalid reference'),
        meaning: t('The reference is not a valid path, so no file can be found by it.'),
      };
    case 'manifest':
      return {
        title: t('Invalid manifest'),
        meaning: t(
          'agent-architecture.json has a part outside the expected format, which the scan ignored.',
        ),
      };
    case 'manifest-mismatch':
      return {
        title: t('Manifest does not match the links'),
        meaning: t(
          'A relation of agent-architecture.json has no link in the source file, or a link between its objects is missing from the relations.',
        ),
      };
    case 'manifest-unchecked':
      return {
        title: t('Unchecked relation'),
        meaning: t(
          'The reader did not compare this relation of agent-architecture.json with the links: something in it or in its source was not read or resolved.',
        ),
      };
    case 'no-entry':
      return {
        title: t('No entry point'),
        meaning: t('There is no AGENTS.md or CLAUDE.md in this open project.'),
      };
    case 'scope-unused-pattern':
      return {
        title: t('Scope pattern with no effect'),
        meaning: t('A pattern of the scope declaration absorbed no reference and matched no file.'),
      };
    case 'limit':
      return {
        title: t('Scan limit'),
        meaning: t(
          'Part of the material was not read because of a limit on items, text size or relations.',
        ),
      };
    case 'unreadable':
      return {
        title: t('Read failure'),
        meaning: t(
          'The item was listed but could not be read (permission, encoding or special type).',
        ),
      };
    case 'analysis-partial':
      return {
        title: t('Partial scan'),
        meaning: t(
          'A limit or a read failure occurred, and the absence of an observation is not conclusive.',
        ),
      };
    case 'unresolved-name':
      return {
        title: t('Referenced name with no file'),
        meaning: t(
          'A name written without a folder matches no file of the project; it may be intentional.',
        ),
      };
    case 'unreachable':
      return {
        title: t('No path by explicit reference'),
        meaning: t(
          'No sequence of explicit references leads from the project instructions to this file.',
        ),
      };
    case 'symlink':
      return {
        title: t('Symlink'),
        meaning: t('Symlink listed; the scan does not follow its target or read its content.'),
      };
    case 'basename-resolved':
      return {
        title: t('Resolved by unique name'),
        meaning: t(
          'The reference was resolved by the only file of the project with that name, not by the written path.',
        ),
      };
    case 'suffix-resolved':
      return {
        title: t('Resolved by unique suffix'),
        meaning: t(
          'The reference was resolved by the only file of the project that ends with the written path.',
        ),
      };
    case 'root-dot-resolved':
      return {
        title: t('./ mention resolved from the root'),
        meaning: t(
          'A ./ mention that does not exist from the folder of the file was found from the open project.',
        ),
      };
    case 'declared-external':
      return {
        title: t('Absorbed by the declared scope'),
        meaning: t(
          'The target does not exist in the project, and a pattern of the scope declaration absorbed it.',
        ),
      };
    default:
      return undefined;
  }
}

const hasCode = (code: string) => Object.hasOwn(codeTones, code);
/** Entry of a code; a code unknown to this interface gets a generic entry instead of disappearing. */
export const codeInfo = (code: string): CodeInfo => {
  const words = hasCode(code) ? codeWords(code) : undefined;
  return words
    ? { ...words, tone: codeTones[code] }
    : {
        title: t('Observation'),
        tone: 'warning',
        meaning: t('Observation code that this version of the interface does not recognize.'),
      };
};
/**
 * Entry of every known code, by code: the shape this dictionary always had. Each read resolves the words in
 * the active language (the entries are getters), so it also serves code that reads it outside a component.
 */
export const observationCodes: Record<string, CodeInfo> = {};
for (const code of Object.keys(codeTones))
  Object.defineProperty(observationCodes, code, { enumerable: true, get: () => codeInfo(code) });

/** An ambiguity written as a bare name (no folder) may well be several files of the same name: informative. */
const ambiguousName = (): CodeInfo => ({
  title: t('Name with several possible files'),
  tone: 'info',
  meaning: t(
    'A name written without a folder matches several files of the project, and the reader picks none.',
  ),
});
/** Entry of one observation: as `codeInfo`, with the tone of an ambiguity decided by how it was written. */
export function issueInfo(item: { code: string; form?: string }): CodeInfo {
  return item.code === 'ambiguous' && (item.form === 'name' || item.form === 'word')
    ? ambiguousName()
    : codeInfo(item.code);
}
/** Short name of a code in the active language, or undefined when this interface does not know it. */
export const codeTitle = (code: string | null | undefined) =>
  typeof code === 'string' && hasCode(code) ? codeWords(code)?.title : undefined;

/** The name of a tone: Problem, Warning, Info. */
export function toneLabel(tone: Tone) {
  return tone === 'problem' ? t('Problem') : tone === 'warning' ? t('Warning') : t('Info');
}
const toneRank: Record<Tone, number> = { problem: 0, warning: 1, info: 2 };
/** The strongest tone among the codes or observations (problem before warning before info). */
export function strongestTone(items: (string | { code: string; form?: string })[]): Tone {
  return items
    .map((item) => (typeof item === 'string' ? codeInfo(item) : issueInfo(item)).tone)
    .reduce<Tone>((best, tone) => (toneRank[tone] < toneRank[best] ? tone : best), 'info');
}
/**
 * Whether an item with these observations shows a marker (tree, Structure, Home, the badge of a map card):
 * only with a problem or a warning. Informative ones alone show none; they stay in the inspector, the Audit
 * and the filter of the tree.
 */
export const showsMarker = (items: Issue[]) => strongestTone(items) !== 'info';
/** The count of a tone: "1 problem", "3 warnings", "2 info". */
export const countTone = (tone: Tone, n: number) =>
  tone === 'problem'
    ? pluralPhrase(n, '{count} problem', '{count} problems')
    : tone === 'warning'
      ? pluralPhrase(n, '{count} warning', '{count} warnings')
      : pluralPhrase(n, '{count} info', '{count} info');
/** Items of a list written as a sentence: "a", "a and b", "a, b and c". */
export function joinList(items: string[]) {
  return items.length < 2
    ? (items[0] ?? '')
    : t('{items} and {last}', { items: items.slice(0, -1).join(', '), last: items.at(-1)! });
}
/** Observations of one type in an item: same code and title (an ambiguity by name apart from one by path). */
export type ObservationGroup = { key: string; info: CodeInfo; items: Issue[] };
/**
 * The observations of an item grouped by type: problems first, then warnings, then informative ones, and
 * within a tone by the first line; each group keeps the order of `items` (line order).
 */
export function groupObservations(items: Issue[]): ObservationGroup[] {
  const groups = new Map<string, ObservationGroup>();
  for (const item of items) {
    const info = issueInfo(item);
    // The key does not hold the title: it must stay the same when the language changes.
    const byName = item.code === 'ambiguous' && (item.form === 'name' || item.form === 'word');
    const key = `${item.code}\n${byName ? 'name' : ''}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { key, info, items: [item] });
  }
  return [...groups.values()].sort(
    (a, b) =>
      toneRank[a.info.tone] - toneRank[b.info.tone] ||
      (a.items[0].line ?? 0) - (b.items[0].line ?? 0),
  );
}
/** The types of some observations, each once: "broken reference (2), referenced name with no file". */
function typeList(items: Issue[]) {
  const byTitle = new Map<string, number>();
  for (const item of items) {
    const title = issueInfo(item).title;
    byTitle.set(title, (byTitle.get(title) ?? 0) + 1);
  }
  return [...byTitle]
    .map(([title, n]) => `${title.toLowerCase()}${n > 1 ? ` (${formatNumber(n)})` : ''}`)
    .join(', ');
}
/**
 * The words of a marker (tooltip and accessible name), on the base of its number, the problems and the
 * warnings: "1 problem, 2 warnings: broken reference, ambiguous reference (2)"; the informative ones
 * after them, apart and never in the number ("· 1 info: name with several possible files"). `project`:
 * the marker of a whole project (Home), which says where it counts.
 */
export function describeMarker(items: Issue[], project = false) {
  const alerts = items.filter((item) => issueInfo(item).tone !== 'info');
  const info = items.filter((item) => issueInfo(item).tone === 'info');
  const counts = (['problem', 'warning'] as const)
    .map((tone) => [tone, alerts.filter((item) => issueInfo(item).tone === tone).length] as const)
    .filter(([, n]) => n > 0)
    .map(([tone, n]) => countTone(tone, n))
    .join(', ');
  const list = typeList(alerts);
  const head = project
    ? t('{counts} in the files of this project: {list}', { counts, list })
    : t('{counts}: {list}', { counts, list });
  return info.length
    ? t('{alerts} · {info}', {
        alerts: head,
        info: t('{counts}: {list}', {
          counts: countTone('info', info.length),
          list: typeList(info),
        }),
      })
    : head;
}
/** Observations of each item (file or folder), in line order; `issues` defaults to all of the reading. */
export function observationsByNode(model: Model, issues: Issue[] = model.issues) {
  const map = new Map<string, Issue[]>();
  for (const item of issues)
    if (item.node) {
      const list = map.get(item.node);
      if (list) list.push(item);
      else map.set(item.node, [item]);
    }
  for (const list of map.values()) list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return map;
}

// Indexes of one reading, built once per model array: diagnoses are rendered for many observations.
const nodeIndexes = new WeakMap<Model['nodes'], Map<string, Model['nodes'][number]>>();
const lineIndexes = new WeakMap<Relation[], Map<string, Relation[]>>();
export function nodeIndex(model: Model) {
  let index = nodeIndexes.get(model.nodes);
  if (!index) {
    index = new Map(model.nodes.map((node) => [node.id, node]));
    nodeIndexes.set(model.nodes, index);
  }
  return index;
}
/** Relations whose evidence is at this line of this file (origin and line). */
export function relationsAt(model: Model, origin: string, line: number) {
  let index = lineIndexes.get(model.edges);
  if (!index) {
    index = new Map();
    for (const edge of model.edges) {
      const key = `${edge.origin}\n${edge.line}`;
      const list = index.get(key);
      if (list) list.push(edge);
      else index.set(key, [edge]);
    }
    lineIndexes.set(model.edges, index);
  }
  return index.get(`${origin}\n${line}`) ?? [];
}

/** The most specific opened root that contains `path` (the project of an item). */
export function projectOf(roots: Root[], path: string | null | undefined) {
  if (!path) return undefined;
  let best: Root | undefined;
  for (const root of roots)
    if (within(path, root.path) && (!best || root.path.length > best.path.length)) best = root;
  return best;
}
/**
 * A path as shown next to its project: relative to the project root, prefixed with the root name when it
 * belongs to another opened root, and absolute when it is outside every opened root.
 */
export function projectPath(roots: Root[], path: string, base?: Root) {
  const root = projectOf(roots, path);
  if (!root) return path;
  const relative = path === root.path ? root.name : path.slice(root.path.length + 1);
  return base && base.path !== root.path && path !== root.path
    ? `${root.name}/${relative}`
    : relative;
}
/** Lexical relative path from a folder to a file, as a reference written in that folder would be. */
function relativeFrom(folder: string, path: string) {
  const from = folder.split('/').filter(Boolean),
    to = path.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/') || '.';
}
/** Lexical normalization of `a/./b/../c`, as the reader normalizes a destination before looking it up. */
function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.split('/'))
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  return '/' + parts.join('/');
}

/** Lexical normalization of a relative path, keeping leading `..` (as `posixpath.normpath`). */
function normalizeRelative(path: string) {
  const parts: string[] = [];
  for (const part of path.split('/'))
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  return parts.join('/') || '.';
}

/**
 * How a reference was written, by relation kind (the same edge `kind` as the inspector lists). Shown next to
 * the line only when the kind changes how the reader looks the destination up (`citationMatters`).
 */
const citationKind = (kind: string) => {
  switch (kind) {
    case 'markdown':
      return t('Markdown link', { context: 'citation' });
    case 'markdown-reference':
      return t('Markdown reference link');
    case 'wiki':
      return 'wikilink [[…]]';
    case 'path':
      return t('path mention (in backticks or in the text)');
    case 'import':
      return t('@ import', { context: 'citation' });
    case 'manifest':
      return t('manifest field');
    case 'declared':
      return t('relation declared in the manifest');
    default:
      return undefined;
  }
};
/** A Markdown link is the plain reading; the other kinds have rules of their own (docs/modelo-e-leitura.md). */
const citationMatters = (kind: string) => kind !== 'markdown' && kind !== 'markdown-reference';
const LINE_EXTENSIONS = 'md|markdown|json|yaml|yml|toml|txt|py|sh|ts|js';
const testId = /^(.*?\.[\p{L}\p{N}]+)::/u;
const lineSuffix = new RegExp(`^(.*\\.(?:${LINE_EXTENSIONS})):([\\d,-]+)$`);
/**
 * The address a written reference names, as the reader looks it up (server/scanner.py, `resolve`): without a
 * test id (`x.py::T`), a line address (`x.md:41`, `x.py:2,6-9`), a leading elision (`…/a/b.md`), an `#anchor`
 * or a `?query`. The written text itself stays as written wherever it is shown.
 */
export function address(raw: string) {
  let text = raw.trim();
  const named = text.includes('::') ? testId.exec(text) : null;
  if (named) text = named[1];
  const lined = text.includes(':') ? lineSuffix.exec(text) : null;
  if (lined && lined[2].split(',').every((part) => /^\d+(?:-\d+)?$/.test(part))) text = lined[1];
  text = text.replace(/^(?:…|\.\.\.)\//, '');
  return text.replace(/[#?].*$/, '');
}
/** `%xx` decoded as the reader decodes a destination (`unquote`); text that is not valid UTF-8 stays as written. */
function unquote(text: string) {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return text;
  }
}
/** The extension of the last name, as Python's `PurePath.suffix` (`.2-notas` in `v1.2-notas`; none in `.env`). */
function suffixOf(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : '';
}
/**
 * Written forms that only resolve from the source folder (or are absolute): no cascade. As the reader, a path
 * that climbs out of its folder once normalized (`sub/../../x`) is anchored too.
 */
function anchored(path: string) {
  if (/^(\.\.?\/|~|\/|file:)/.test(path)) return true;
  const ref = normalizeRelative(path);
  return ref === '.' || ref === '..' || ref.startsWith('../');
}

/** A path inside a sentence about the case, shown as code. */
const pathCode = (path: string) => createElement('code', null, path);
export type Diagnosis = {
  code: string;
  info: CodeInfo;
  /** What is written at the line: the destination as written and the line text when the model has it. */
  written?: { target?: string; line?: number; snippet?: string };
  /** How the reference was written, only when that changes the reading. */
  citation?: string;
  /** Where the reader looked, in one sentence, always taken from the model or the reader rule. */
  searched?: ReactNode;
  candidates?: { id: string; label: string; suggestion: string }[];
  /** How many candidates the reader found: the model lists at most 20 of them. */
  candidatesTotal?: number;
  /** How many of them lie past the inventory (seen by name only, never read), when the reader says so. */
  candidatesHidden?: number;
  declaredName?: string;
  /** The nearest ancestor folder referenced by a reachable file (unreachable documents). */
  ancestor?: { id: string; label: string };
  /** The reader message, for the codes whose specifics only it says and the line does not show in full. */
  message?: string;
  /** The reader's own caveat, as a fact: an `unreachable` that a partial reading makes not conclusive. */
  inconclusive?: string;
  /**
   * Where a declared scope would settle the observation (API suggestion): the owner project first, then each
   * enclosing open root, with the root name and, when agent-architecture.json is invalid there, its observation.
   */
  scope?: { places: (ScopePlace & { name: string; owner: boolean; manifestIssue?: Issue })[] };
};
/**
 * Codes whose facts the diagnosis computes itself, or whose reader message only repeats the title and the
 * meaning: the message is never shown in the facts.
 */
const computed = new Set([
  'broken',
  'unresolved-name',
  'ambiguous',
  'outside-root',
  'unverified',
  'unreachable',
  'symlink',
  'no-entry',
  'manifest-mismatch',
  'manifest-unchecked',
]);
/**
 * Why a relationship of a manifest with linkedRelationships was not compared with the links (the `reason`);
 * undefined for a reason this interface does not know.
 */
const uncheckedReason = (reason: string) => {
  switch (reason) {
    case 'source-not-read':
      return t(
        'The reader did not read the whole source file (size, inventory limit, unread folder or type not parsed).',
      );
    case 'unresolved-end':
      return t(
        'One end of the relation does not resolve to a definite file (symlink, unverifiable absence or several candidates); no link with its other end is reported as missing from the manifest.',
      );
    case 'unresolved-ends':
      return t(
        'Neither end of the relation resolves to a definite file; no link it could be is reported as missing from the manifest.',
      );
    case 'not-a-file':
      return t(
        'One end of the relation is not a file path (address, anchor, placeholder, variable, wildcard or a path too long).',
      );
    case 'manifest-end':
      return t(
        'One end of the relation is an agent-architecture.json, which is not a node of another manifest.',
      );
    case 'unresolved-link':
      return t(
        'The source file has a link the reader did not resolve (symlink, unverifiable absence or candidates beyond those listed), and it may be the one of this relation.',
      );
    case 'ambiguous-link':
      return t(
        'The source file has an ambiguous reference, and the target is among the candidates.',
      );
    case 'unread-folder-link':
      return t(
        'The source file has a link to a folder the reader does not read, and the target is in it.',
      );
    case 'unextracted-link':
      return t(
        'The source file writes the path of the target as a link target in a form the reader does not extract (link text over several lines, target or title on another line).',
      );
    default:
      return undefined;
  }
};
/**
 * A line text this short fits the row of the narrowest panel (the inspector of a folder holds about 49
 * characters): longer, the row may cut it, and the facts repeat it whole.
 */
const ROW_FITS = 40;
/** Codes a declaration can settle: a missing destination is absorbed, an unreachable file becomes a start. */
const scopeSettles = new Set(['broken', 'unresolved-name', 'unreachable']);
/**
 * What to write in agent-architecture.json, given what it holds now: create the file, add the `scope` key, replace
 * the value of an empty or invalid `scope`, add the pattern to an existing list or add the list. `snippet` is null
 * when the file must be fixed first (invalid JSON or unreadable). Only the whole file is a JSON document by itself.
 */
export type ScopeEdit = {
  mode: 'create' | 'add-key' | 'replace-value' | 'add-pattern' | 'add-list' | 'fix';
  snippet: string | null;
};
export function scopeEdit(kind: ScopeKind, pattern: string, manifest: ScopeManifest): ScopeEdit {
  const list = `${JSON.stringify(kind)}: [${JSON.stringify(pattern)}]`;
  const value = `{\n  "version": 1,\n  ${list}\n}`;
  switch (manifest.state) {
    case 'absent':
      return {
        mode: 'create',
        snippet: `{\n  "scope": {\n    "version": 1,\n    ${list}\n  }\n}`,
      };
    case 'no-scope':
      return { mode: 'add-key', snippet: `"scope": ${value}` };
    case 'empty-scope':
    case 'invalid-scope':
      return { mode: 'replace-value', snippet: value };
    case 'scope':
      return manifest.lists.includes(kind)
        ? { mode: 'add-pattern', snippet: JSON.stringify(pattern) }
        : { mode: 'add-list', snippet: list };
    default:
      return { mode: 'fix', snippet: null };
  }
}

/** "inconclusive" of an `unreachable` that a partial scan makes not conclusive (the `conclusive` field). */
export const inconclusive = (item: { code: string; conclusive?: boolean }) =>
  item.code === 'unreachable' && item.conclusive === false;
/** Short mark on the line of a not conclusive observation. */
export const inconclusiveNote = () => t('inconclusive: partial scan');
/**
 * What a type means, said once above its occurrences, with the reader's caveat when some of them are not
 * conclusive: the header never affirms what the reader did not.
 */
export function groupMeaning(info: CodeInfo, items: { code: string; conclusive?: boolean }[]) {
  const n = items.filter(inconclusive).length;
  if (!n) return info.meaning;
  return n === items.length
    ? t('{meaning} Inconclusive: partial scan.', { meaning: info.meaning })
    : t('{meaning} Inconclusive in {n} of {total}: partial scan.', {
        meaning: info.meaning,
        n,
        total: items.length,
      });
}

/**
 * The inventory limit as a server that wrote Portuguese said it, read as the interface of that version read it
 * (its expression, unchanged): a finding of a baseline saved then keeps that line in Portuguese. Never past
 * the length that server could write, on which the expression would take long.
 */
const SAVED_LIMIT =
  /^Limite de inventário atingido em .*? \((\d+) elementos por raiz[^)]*\): (\d+) pasta\(s\) lida\(s\) em parte e (\d+) não lida\(s\), com( no mínimo)? (\d+) elemento\(s\) fora do inventário\. (?:(\d+) arquivo\(s\) de entrada ou de skill \(AGENTS\.md, CLAUDE\.md, SKILL\.md\) ficaram fora, como (.*?)\. (?=O corte afeta))?/s;
const SAVED_LIMIT_LENGTH = 8192;
type LimitItem = { message?: string; messagePhrase?: ServerPhrase | null; earlier?: boolean };
/**
 * The numbers of an inventory limit, from the facts the reader sends with the message (the parameters of its
 * phrase: `budget`, `partial`, `unread`, `omitted`, `minimum` and, when entry or Skill files were left out,
 * `entries` and `example`); null when the message is not that one. A finding of a baseline saved before the
 * server wrote English has them in its Portuguese sentence only (`SAVED_LIMIT`), read in Portuguese only.
 */
function limitFacts(item: LimitItem) {
  if (earlierHere(item)) {
    const saved =
      typeof item.message === 'string' && item.message.length <= SAVED_LIMIT_LENGTH
        ? SAVED_LIMIT.exec(item.message)
        : null;
    if (!saved) return null;
    const [, budget, partial, unread, atLeast, omitted, entries, example] = saved;
    return {
      budget: Number(budget),
      partial: Number(partial),
      unread: Number(unread),
      omitted: Number(omitted),
      atLeast: !!atLeast,
      entries: Number(entries ?? 0),
      example: example ?? '',
    };
  }
  const fact = (name: string) => serverFact(item, name);
  const [budget, partial, unread, omitted] = ['budget', 'partial', 'unread', 'omitted'].map(fact);
  if (
    typeof budget !== 'number' ||
    typeof partial !== 'number' ||
    typeof unread !== 'number' ||
    typeof omitted !== 'number'
  )
    return null;
  return {
    budget,
    partial,
    unread,
    omitted,
    atLeast: fact('minimum') === true,
    entries: Number(fact('entries') ?? 0),
    example: String(fact('example') ?? ''),
  };
}
/** The inventory limit of a project: the short line, and what only the facts of the inspector say. */
function inventoryLimit(item: LimitItem) {
  const facts = limitFacts(item);
  if (!facts) return null;
  const { budget, partial, unread, omitted, atLeast, entries, example } = facts;
  const parts = [
    Number(partial) &&
      pluralPhrase(Number(partial), '{count} folder partly read', '{count} folders partly read'),
    Number(unread) &&
      (Number(partial)
        ? pluralPhrase(Number(unread), '{count} unread', '{count} unread')
        : pluralPhrase(Number(unread), '{count} unread folder', '{count} unread folders')),
    atLeast
      ? pluralPhrase(
          Number(omitted),
          'at least {count} item left out',
          'at least {count} items left out',
        )
      : pluralPhrase(Number(omitted), '{count} item left out', '{count} items left out'),
  ].filter(Boolean);
  return {
    row: t('Limit of {budget} items per project: {parts}', {
      budget: Number(budget),
      parts: parts.join(', '),
    }),
    rest: entries
      ? pluralPhrase(
          Number(entries),
          '{count} entry or Skill file was left out, such as {example}.',
          '{count} entry or Skill files were left out, such as {example}.',
          { example },
        )
      : '',
  };
}
/** What a line of the Audit, of the inspector or of Changes needs from an observation, a signal or a finding. */
type SignalLine = {
  code: string;
  message: string;
  messagePhrase?: ServerPhrase | null;
  /** A finding of a baseline saved before the server wrote English (src/serverText.ts). */
  earlier?: boolean;
  count?: number | null;
  to?: string;
  files?: string[];
};
/** The signal of the reader in its facts (never read out of its message): count and destination, size and threshold, files of a cycle. */
function signalText(model: Model | undefined, item: SignalLine) {
  const show = (path: string) => (model ? projectPath(model.roots, path) : path);
  if (item.code === 'repeated-reference' && typeof item.to === 'string')
    return t('{count} times → {target}', { count: item.count ?? '?', target: show(item.to) });
  if (item.code === 'high-fanout' && item.count) {
    const threshold = model?.stats.structure?.fanoutThreshold;
    return threshold
      ? t('{count} targets (threshold {threshold})', { count: item.count, threshold })
      : t('{count} targets', { count: item.count });
  }
  if (item.code === 'cycle' && Array.isArray(item.files) && item.count)
    // The reader lists at most five names: the others are an ellipsis, as in its message.
    return pluralPhrase(item.count, '{count} file: {files}', '{count} files: {files}', {
      files: [...item.files, ...(item.count > item.files.length ? ['…'] : [])].join(', '),
    });
  return messageText(item);
}
/** What each kind of signal does not prove, said once above the signals of that kind. */
export const signalCaveat = (code: string) => {
  switch (code) {
    case 'repeated-reference':
      return t('May be intentional; does not prove runtime noise.');
    case 'high-fanout':
      return t('A count does not prove inefficiency.');
    case 'cycle':
      return t('Does not prove repetition when an agent runs.');
    default:
      return undefined;
  }
};
/** Codes of the structural signals (never observations). */
const signalKinds = new Set(['repeated-reference', 'high-fanout', 'cycle']);
/**
 * The short text of one line (Audit, inspector, Changes): what is written (the destination as written),
 * or the fact of the case when nothing is written; empty when the type and the file already say it all.
 */
export function shortText(
  item: SignalLine & {
    target?: string;
    class?: string;
    inbound?: number;
    pattern?: string;
    bytes?: number;
  },
  model?: Model,
) {
  if (signalKinds.has(item.code)) return signalText(model, item);
  if (item.target !== undefined && item.target !== null) return item.target;
  if (item.code === 'unreachable')
    return item.class === 'island'
      ? pluralPhrase(
          item.inbound || 0,
          'island · {count} file with no path references it',
          'island · {count} files with no path reference it',
        )
      : t('orphan · no file references it');
  if (item.code === 'scope-unused-pattern' && item.pattern) return item.pattern;
  if (item.code === 'symlink' || item.code === 'no-entry') return '';
  if (item.code === 'limit') {
    const limit = inventoryLimit(item);
    if (limit) return limit.row;
    // A text budget saved before the server wrote English, in another language than its own: its counts.
    if (
      item.earlier &&
      !earlierHere(item) &&
      typeof item.count === 'number' &&
      typeof item.bytes === 'number'
    )
      return pluralPhrase(
        item.count,
        '{count} text file listed but not analyzed ({bytes} bytes)',
        '{count} text files listed but not analyzed ({bytes} bytes)',
        { bytes: item.bytes },
      );
  }
  return messageText(item);
}

/** Nodes joined as "a and b and c", each pair by the same phrase. */
function andList(nodes: ReactNode[]) {
  return nodes.reduce((all, one) => rich('{first} and {second}', { first: all, second: one }));
}

export function diagnose(model: Model, item: Issue, relation?: Relation): Diagnosis {
  const info = issueInfo(item);
  const nodes = nodeIndex(model);
  const base = projectOf(model.roots, item.node);
  const show = (path: string) => projectPath(model.roots, path, base);
  const source = nodes.get(item.node ?? '')?.path ?? item.node ?? '';
  const sourceDir = dirname(source);
  const result: Diagnosis = { code: item.code, info };
  if (!computed.has(item.code)) {
    // The line shows the reader message (or its facts): the facts repeat only what the line may cut.
    const limit = item.code === 'limit' ? inventoryLimit(item) : null;
    const message = messageText(item);
    if (limit) {
      // The row may cut the numbers: the facts say them whole, with what only they say.
      result.message = `${limit.row}.${limit.rest ? ` ${limit.rest}` : ''}`;
    } else if (shortText(item, model) !== message || message.length > ROW_FITS)
      result.message = message;
  }
  // Never for an ambiguity, which a declaration never absorbs, nor for the other codes.
  if (item.suggestion?.places?.length && scopeSettles.has(item.code) && base)
    result.scope = {
      places: item.suggestion.places.map((place) => ({
        ...place,
        name: model.roots.find((root) => root.path === place.root)?.name ?? place.root,
        owner: place.root === base.path,
        manifestIssue: model.issues.find(
          (issue) =>
            issue.code === 'manifest' && issue.node === `${place.root}/agent-architecture.json`,
        ),
      })),
    };
  // Any relation of the same line carries that line's text (the reader stores the line as the evidence).
  const sameLine =
    relation ?? (item.node && item.line ? relationsAt(model, item.node, item.line)[0] : undefined);
  if (item.target !== undefined || item.line)
    result.written = {
      target: item.target,
      line: item.line ?? undefined,
      snippet: sameLine?.evidence || item.evidence || undefined,
    };
  const target = item.target ?? '';
  // The address as the reader looks it up: line address and anchor dropped, `%xx` decoded.
  const written = unquote(address(target));
  const kind = relation?.kind ?? item.syntax;
  if (kind && citationMatters(kind) && item.target !== undefined)
    result.citation = citationKind(kind) ?? kind;
  if (item.code === 'broken' || item.code === 'unresolved-name') {
    // The placeholder the reader created is the address from the folder of the file, line address and
    // anchor already dropped; without a relation, the same address computed here.
    const placeholder = relation
      ? (nodes.get(relation.target)?.path ?? relation.target)
      : normalize(`${sourceDir}/${written}`);
    const at = pathCode(show(placeholder));
    // The skill step of the cascade: from the nearest ancestor folder with a SKILL.md, when that folder is not
    // the source's own folder (docs/modelo-e-leitura.md, "Resolução em cascata").
    const nearestSkill = model.nodes
      .filter((node) => node.kind === 'skill')
      .map((node) => dirname(node.path))
      .filter((dir) => sourceDir === dir || sourceDir.startsWith(dir + '/'))
      .sort((a, b) => b.length - a.length)[0];
    const inSkill = nearestSkill !== undefined && nearestSkill !== sourceDir;
    const ref = normalizeRelative(written);
    // A `./` path mention also tries each opened root that contains the file, unless its first folder exists
    // next to the file; `./../x` climbs out and stays anchored. A `./` Markdown link is anchored.
    const dot =
      kind === 'path' && written.startsWith('./') && ref !== '..' && !ref.startsWith('../');
    if (kind === 'wiki') {
      // As the reader: `.md` is tried, and a bare name searched, only when the name has no extension.
      const plain = !suffixOf(written);
      const tag = { at, declared: pathCode(`name: ${written}`) };
      result.searched =
        written.includes('/') || anchored(written)
          ? plain
            ? rich("Looked only in {at} (with .md), the path from this file's folder.", tag)
            : rich("Looked only in {at}, the path from this file's folder.", tag)
          : plain
            ? rich(
                'Looked for a project file that declares {declared}, then {at} (with .md) and, last, a single project Markdown file with that name.',
                tag,
              )
            : rich('Looked for a project file that declares {declared}, then {at}.', tag);
    } else if (dot) {
      const first = ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : '';
      const beside = first ? nodes.get(`${sourceDir}/${first}`) : undefined;
      // The reader also knows names past the inventory: only a complete listing of the folder rules one out.
      const folder = nodes.get(sourceDir);
      const listed =
        folder?.listing === 'complete' ||
        (model.stats.inventory?.complete !== false &&
          folder?.listing !== 'partial' &&
          folder?.listing !== 'unread');
      const roots = model.roots
        .filter((root) => within(source, root.path))
        .map((root) => `${root.path}/${ref}`)
        .filter((path) => path !== placeholder);
      // Only an inventoried folder proves the folder is there: a placeholder of a destination (missing,
      // declared, not read) is not one, and the reader then also tried the opened roots.
      const real = beside && beside.kind !== 'unresolved' ? beside : undefined;
      result.searched =
        real?.kind === 'directory'
          ? rich('Looked only in {at}: the folder {first}/ exists next to this file.', {
              at,
              first,
            })
          : real || (first && !listed)
            ? rich("Looked in {at} (from this file's folder).", { at })
            : !roots.length
              ? rich('Looked in {at}.', { at })
              : rich(
                  "Looked in {at} (from this file's folder) and in {roots} (from the open project).",
                  {
                    at,
                    roots: andList(roots.map((path) => pathCode(show(path)))),
                  },
                );
    } else if (anchored(written))
      result.searched = rich('Looked only in {at} (anchored path).', { at });
    else
      // A reference to a folder (`folder/`) skips the name step of the cascade.
      result.searched = written.endsWith('/')
        ? inSkill
          ? rich(
              "Looked in {at} from this file's folder, then from the Skill's folder and from the open project.",
              { at },
            )
          : rich("Looked in {at} from this file's folder, then from the open project.", { at })
        : inSkill
          ? rich(
              "Looked in {at} from this file's folder, then by the Skill's folder, by the open project and by a unique name or suffix in the project.",
              { at },
            )
          : rich(
              "Looked in {at} from this file's folder, then by the open project and by a unique name or suffix in the project.",
              { at },
            );
  }
  if (item.code === 'ambiguous' && item.node) {
    const listed = item.candidates ?? [];
    const total = Math.max(item.candidatesTotal ?? 0, listed.length);
    // Candidates seen by name only, past the inventory: the reader says how many (the `hidden` of its message).
    const hidden = Number(serverFact(item, 'hidden') ?? 0);
    const wiki = kind === 'wiki';
    // Every listed candidate declares the cited name: conclusive only when the list is complete.
    const declaring =
      !!listed.length && listed.every((id) => nodes.get(id)?.declaredName === written);
    if (wiki && !result.citation) result.citation = citationKind('wiki');
    const declared = pathCode(`name: ${written}`);
    if (declaring && total === listed.length) {
      result.declaredName = written;
      result.searched =
        total === 1
          ? rich('{count} project file declares {declared} in the frontmatter.', {
              count: total,
              declared,
            })
          : rich('{count} project files declare {declared} in the frontmatter.', {
              count: total,
              declared,
            });
    } else if (declaring)
      result.searched = rich(
        '{total} project files match this name; the {listed} listed ones declare {declared} in the frontmatter.',
        { total, listed: listed.length, declared },
      );
    else if (wiki)
      result.searched = pluralPhrase(
        total,
        '{count} project file matches this name.',
        '{count} project files match this name.',
      );
    else {
      // Step 1 of the cascade, from the reader rule: an unanchored reference that reaches the name step
      // did not exist from the folder of its file (docs/modelo-e-leitura.md, "Resolução em cascata").
      const at = pathCode(show(normalize(`${sourceDir}/${written}`)));
      result.searched =
        total === 1
          ? rich(
              "Does not exist at {at} (from this file's folder); {count} project file matches what is written.",
              { at, count: total },
            )
          : rich(
              "Does not exist at {at} (from this file's folder); {count} project files match what is written.",
              { at, count: total },
            );
    }
    if (hidden)
      result.searched = createElement(
        Fragment,
        null,
        result.searched,
        ' ',
        pluralPhrase(
          hidden,
          '{count} of them was not listed, not read.',
          '{count} of them were not listed, not read.',
        ),
      );
    result.candidates = listed.map((id) => ({
      id,
      label: show(id),
      suggestion: relativeFrom(sourceDir, id),
    }));
    result.candidatesTotal = total;
    if (hidden) result.candidatesHidden = hidden;
  }
  if (item.code === 'outside-root' && item.node) {
    // Where the reader found it: the relation's destination (decoded, as on disk), relative to the outermost
    // opened root that contains the file, and the repository the reader probed up to (`stats.probe`).
    const edge =
      relation ??
      (item.line
        ? relationsAt(model, item.node, item.line).find((each) => each.raw === item.target)
        : undefined);
    const found = edge ? (nodes.get(edge.target)?.path ?? edge.target) : undefined;
    const outer = model.roots
      .filter((root) => within(source, root.path))
      .sort((a, b) => a.path.length - b.path.length)[0];
    const probed = model.stats.probe?.ancestors.find((each) => each.root === outer?.path);
    let repository = outer?.path ?? '';
    for (let level = 0; level < (probed?.levels ?? 0); level++) repository = dirname(repository);
    if (found && outer && probed?.levels && within(found, repository)) {
      const facts = {
        at: pathCode(relativeFrom(outer.path, found)),
        repository: pathCode(repository),
        count: item.levels ?? 1,
      };
      result.searched =
        facts.count === 1
          ? rich(
              'Exists {count} level above the open project, at {at}, in the repository {repository} (with .git); the scan only checked that it exists.',
              facts,
            )
          : rich(
              'Exists {count} levels above the open project, at {at}, in the repository {repository} (with .git); the scan only checked that it exists.',
              facts,
            );
    }
    // Without those facts in the model, the reader's own words.
    else result.message = messageText(item);
  }
  if (item.code === 'manifest-mismatch' && item.from && item.to) {
    // The pair the reader compared, from the structured fields (never from the message).
    const from = pathCode(show(item.from)),
      to = pathCode(show(item.to));
    result.searched =
      item.absent === 'link'
        ? rich(
            'The manifest declares {from} → {to}, but the reader found no explicit link to the target in {from} (a code block does not count).',
            { from, to },
          )
        : item.manifest
          ? rich(
              '{from} has an explicit link to {to}, both are objects of {manifest}, and none of its relations goes from one to the other.',
              { from, to, manifest: pathCode(show(item.manifest)) },
            )
          : rich(
              '{from} has an explicit link to {to}, both are objects of a manifest, and none of its relations goes from one to the other.',
              { from, to },
            );
  }
  // The reason as the reader gives it; an unknown one is not guessed.
  if (item.code === 'manifest-unchecked' && item.reason) {
    const reason = uncheckedReason(item.reason);
    if (reason) result.searched = reason;
  }
  if (item.code === 'unverified')
    result.searched =
      item.reason === 'frontmatter'
        ? t('Some unread Markdown file of this project may declare that name in the frontmatter.')
        : t(
            'The listing and the existence index reached the limit; the target may be in the unlisted part.',
          );
  if (item.code === 'unreachable' && item.node) {
    const root = projectOf(model.roots, item.node);
    const starts = (model.stats.reachability?.starts ?? []).filter(
      (start) => root && within(start.node, root.path),
    ).length;
    result.searched = pluralPhrase(
      starts,
      'Followed the references from {count} starting point of the project and did not get here.',
      'Followed the references from {count} starting points of the project and did not get here.',
    );
    if (inconclusive(item))
      // The reader says which scan leaves it open (the `partial` of its message): another opened root, or this one.
      result.inconclusive =
        serverFact(item, 'partial') === 'other-root'
          ? t(
              'Inconclusive: the scan of another open project is partial, and a file in it may reference this one.',
            )
          : t(
              'Inconclusive: the scan of this project is partial (items not listed, text not read or relations cut).',
            );
    if (item.referencedAncestor)
      result.ancestor = { id: item.referencedAncestor, label: show(item.referencedAncestor) };
  }
  return result;
}
