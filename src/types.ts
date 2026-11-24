import { t } from './i18n';
import type { ServerPhrase } from './serverText';
/**
 * `sha256`: raw bytes of an analysed text at the reading (same definition as fileSha256 of snapshot reads). `declaredName`: top-level `name:` of a Markdown frontmatter.
 * Directories: `listing` (`partial`: part of the direct children left out, by the inventory limit or a name that is not UTF-8; `unread`: none inventoried) and
 * `omitted` (elements on disk below the folder not inventoried; a lower bound when the names-only walk also hit its limit).
 * `skippedBy`: why a listed text was not analysed (`budget` of the reading, `size` of the file, `unreadable`).
 */
export type FileNode = {
  id: string;
  path: string;
  name: string;
  relative: string;
  kind: string;
  status: string;
  root: string | null;
  roots: string[];
  title?: string;
  lines?: number;
  analysis?: string;
  bytes?: number;
  sha256?: string;
  hops?: number;
  declaredName?: string;
  listing?: 'complete' | 'partial' | 'unread';
  omitted?: number;
  /** Why a folder that is not `complete` is not: the inventory limit, what the reader could not read in it, or both. */
  leftOutBy?: ('limit' | 'unreadable')[];
  /** `omitted` is a minimum: a folder whose name is not UTF-8 lies below, and what it holds is not counted. */
  omittedMinimum?: boolean;
  skippedBy?: 'budget' | 'size' | 'unreadable';
};
/**
 * Cascade step that resolved an edge target; null when the target was not resolved (missing, external, unscanned or declared).
 * `root-dot`: a `./x` mention (backticks or prose) found from the opened root. A step may also find a destination past the
 * inventory limit: the target is then an `unscanned` placeholder.
 */
export type ResolvedBy =
  | 'file'
  | 'skill'
  | 'root'
  | 'root-dot'
  | 'basename'
  | 'suffix'
  | 'skill-basename'
  | 'skill-suffix'
  | 'frontmatter-name';
export type ScopeKind = 'runtimeWorkspace' | 'localFiles' | 'entries' | 'implicitLoads';
export type Relation = {
  id: string;
  source: string;
  target: string;
  kind: string;
  line: number;
  evidence: string;
  raw: string;
  origin: string;
  confidence: string;
  resolvedBy: ResolvedBy | null;
  declared?: { kind: ScopeKind; pattern: string };
};
export type Root = {
  path: string;
  name: string;
  parent: string | null;
  level: number;
  entries: string[];
};
/** A saved project; `notes`: how many notes forgetting it with its notes would erase (see server/workspace.py). */
export type SavedCase = { path: string; name: string; available: boolean; notes: number };
/** What agent-architecture.json at a root holds now (`lists`: the kinds present in a valid `scope`). */
export type ScopeManifest = {
  state:
    | 'absent'
    | 'unreadable'
    | 'broken'
    | 'no-scope'
    | 'invalid-scope'
    | 'empty-scope'
    | 'scope';
  lists: ScopeKind[];
};
/**
 * One opened root whose agent-architecture.json could settle an observation: the owner project first,
 * then each enclosing open root. `pattern` is null when no v1 pattern fits only this case (`wildcard`:
 * a literal part has * or ?; `generic`: an unreachable file that is neither an agent nor a skill).
 * `kinds` are the declarations that fit (both absorbing kinds for a missing destination).
 */
export type ScopePlace = {
  root: string;
  basis:
    | 'folder'
    | 'root-file'
    | 'existing-folder'
    | 'directory'
    | 'agents'
    | 'skills'
    | 'wildcard'
    | 'generic';
  pattern: string | null;
  kinds: ScopeKind[];
  manifest: ScopeManifest;
};
/** Declared-scope suggestion of the API (`broken`, `unresolved-name`, `unreachable`; never `ambiguous`). */
export type ScopeSuggestion = { places: ScopePlace[] };
/**
 * `id` comes from the reader (it changes with the line). `key`, added by the API, is the stable identity
 * used to mark an observation as expected: code, path relative to its project, destination as written
 * and ordinal by line (the `aae audit` rule); absent outside the opened projects.
 */
export type Issue = {
  id: string;
  code: string;
  /** The reader's sentence, in English; `messagePhrase` is its phrase and parameters (see src/serverText.ts). */
  message: string;
  messagePhrase?: ServerPhrase;
  node: string | null;
  line: number | null;
  target?: string;
  /** Reference findings: the line as written, the citation syntax (edge kind) and the written form of the destination. */
  evidence?: string;
  syntax?: string;
  form?: 'path' | 'name' | 'word';
  /** `unverified` and `outside-root`: the reader id this reference had as `broken` or `unresolved-name`. */
  legacyId?: string;
  /** `unverified`: `lookup` (the existence index hit its limit) or `frontmatter` (Markdown not analysed may declare the name). */
  reason?: string;
  /** `outside-root`: the ancestor of the opened root where the destination exists, and how many levels above. */
  ancestor?: string;
  levels?: number;
  candidates?: string[];
  candidatesTotal?: number;
  /** `unreachable` in a reading whose relations were cut by the cap: not conclusive. */
  conclusive?: boolean;
  /** Text-budget `limit` of a root: files left out, their bytes and how many per top-level folder ('.' at the root). */
  count?: number;
  bytes?: number;
  byTopLevel?: Record<string, number>;
  class?: 'orphan' | 'island';
  inbound?: number;
  referencedAncestor?: string;
  pattern?: string;
  scopeKind?: ScopeKind;
  /**
   * `manifest-mismatch` (a manifest with `linkedRelationships: true`): what is absent, `link` (a relationship
   * without an explicit link of its source file; the observation is on the relationship line of the manifest)
   * or `relation` (an explicit link between two of its objects without a relationship; on the line of the
   * link). `from` and `to` are the files of the pair and `manifest` the manifest, as node ids.
   */
  absent?: 'link' | 'relation';
  from?: string;
  to?: string;
  manifest?: string;
  key?: string;
  suggestion?: ScopeSuggestion;
};
/** Structural review aid (cycle, repeated-reference, high-fanout); never counted as an issue. */
export type Signal = {
  id: string;
  code: string;
  message: string;
  messagePhrase?: ServerPhrase;
  node: string | null;
  line: number | null;
  count?: number | null;
  /** `repeated-reference`: the destination, as a node id. */
  to?: string;
  /** `cycle`: the names of its files the reader lists (at most five; `count` is how many there are). */
  files?: string[];
  key?: string;
};
/** An observation marked as expected, kept in the app state (never in the project): what it was and why. */
export type ExpectedMark = {
  code: string;
  path: string | null;
  target: string | null;
  reason: string;
  at: string;
};
export type ScopePattern = {
  kind: ScopeKind;
  pattern: string;
  references: number;
  files: number;
  root?: string;
};
export type Scope = { source: 'flag' | 'manifest' | null; patterns: ScopePattern[] };
export type Reachability = {
  starts: { node: string; source: 'convention' | 'declared-entry' | 'implicit-load' }[];
  documents: number;
  reachable: number;
  unreachable: number;
  orphans: number;
  islands: number;
  exempt: number;
  hops: { max: number | null; median: number | null };
};
/** `complete`: no root hit the inventory limit; `lookupComplete`: the names-only walk past it did not hit its own limit. */
export type Inventory = {
  complete: boolean;
  lookupComplete: boolean;
  omitted: number;
  omittedFiles: number;
  byTopLevel: { root: string; name: string; inventoried: number; onDisk: number }[];
  /** AGENTS.md, CLAUDE.md and SKILL.md seen only by the names-only walk: `count` is all of them; the interface model keeps the first 20 `paths`, in path order. */
  entriesOmitted?: { count: number; paths: string[] };
};
export type Stats = {
  files: number;
  /** Reference placeholders (missing, declared, external, unscanned, unverified), never counted as files. */
  unresolvedTargets?: number;
  parsed: number;
  edges: number;
  entries: number;
  /** Edges by resolution mode and `unresolved`; `unresolvedNames` and `unscanned` count across them. */
  resolution: Record<ResolvedBy | 'unresolved', number> & {
    unresolvedNames?: number;
    unscanned?: number;
  };
  inventory: Inventory;
  /** Written syntax that is not a reference, by reason (variable, template, elision, code, manifest-key, fenced, cut, txt, too-long). */
  ignored: Record<string, number>;
  /** `stop`: `git` (probed up to that ancestor), `none` (no repository above) or `home` (the `.git` is the home folder's or above it). */
  probe: {
    maxLevels: number;
    ancestors: {
      root: string;
      levels: number;
      stop: 'git' | 'none' | 'home';
      repository?: string | null;
      probes?: number;
    }[];
  } | null;
  /** `complete` false: `omitted` distinct relations were left out by the relation cap (`max`). */
  relations?: { complete: boolean; omitted: number; max: number };
  /** Headers of Markdown not analysed, read for bare wikilinks; `complete` false: the `max` bytes ran out. */
  headers?: { files: number; bytes: number; max: number; complete: boolean };
  structure: {
    cycles: number;
    selfReferences: number;
    repeatedReferences: number;
    highFanout: number;
    fanoutThreshold: number;
    maxFanout: { node: string; count: number } | null;
  };
  reachability: Reachability | null;
};
export type LogicalObject = {
  id: string;
  name: string;
  type: string;
  node: string;
  manifest: string | null;
};
export type Model = {
  delta: Delta | null;
  roots: Root[];
  savedCases: SavedCase[];
  nodes: FileNode[];
  edges: Relation[];
  objects: LogicalObject[];
  issues: Issue[];
  signals: Signal[];
  scope: Scope;
  notes: Record<string, string>;
  /** Marks of the opened projects: project root → stable key → mark. */
  expected: Record<string, Record<string, ExpectedMark>>;
  /** Opened projects where editing is on and would not be refused now: project root → since when. */
  editing: Record<string, { at: string }>;
  restoreErrors: string[];
  /** The phrase of each restore error made with parameters, in the same order (null for the others). */
  restoreErrorsPhrase?: (ServerPhrase | null)[];
  stats: Stats;
  policy: {
    excluded: string[];
    maxNodes: number;
    maxLookup?: number;
    maxFileBytes: number;
    maxTextBytes: number;
    ai: boolean;
  };
};
/** What `GET /api/session` says about editing: the editable extensions and the largest editable document. */
export type EditLimits = { extensions: string[]; maxBytes: number };
/** `POST /api/edit/read`: the text always with `\n` and without BOM; `sha256` and `bytes` of the raw bytes on disk. */
export type EditText = {
  path: string;
  text: string;
  sha256: string;
  bytes: number;
  eol: 'lf' | 'crlf';
  bom: boolean;
};
/** `POST /api/edit/save`: `unchanged`, nothing was written; `durable` false, written without the folder confirmed on disk. */
export type EditSaved = {
  path: string;
  sha256: string;
  bytes: number;
  previousSha256: string;
  unchanged: boolean;
  durable: boolean;
};
export type Trace = {
  found: boolean;
  nodes: string[];
  steps: { edge: string; reverse: boolean }[];
};
/**
 * A table of labels whose words are resolved each time one is read, in the active language. It reads like a
 * plain `Record<K, string>`: the keys are enumerable and `labels[key]` gives the current text.
 */
function labels<K extends string>(words: Record<K, () => string>): Record<K, string> {
  const table = {} as Record<K, string>;
  for (const key of Object.keys(words) as K[])
    Object.defineProperty(table, key, { enumerable: true, get: words[key] });
  return table;
}
export const kinds: Record<string, string> = labels({
  entry: () => t('Instructions'),
  skill: () => t('Skill'),
  manifest: () => t('Manifest'),
  memory: () => t('Memory'),
  file: () => t('File'),
  directory: () => t('Folder', { context: 'kind' }),
  unresolved: () => t('Reference'),
  symlink: () => t('Symlink'),
});
export const relations: Record<string, string> = labels({
  markdown: () => t('Markdown link'),
  'markdown-reference': () => t('Reference link'),
  wiki: () => 'Wikilink',
  path: () => t('Written path'),
  import: () => t('@ import'),
  manifest: () => t('Manifest metadata'),
  declared: () => t('Declared relation'),
  scope: () => t('Scope by convention'),
});
export const statuses: Record<string, string> = labels({
  resolved: () => t('Found'),
  missing: () => t('Missing'),
  external: () => t('Outside open projects'),
  unscanned: () => t('In unread folder'),
  skipped: () => t('Not followed'),
  declared: () => t('Declared outside the package'),
  unverified: () => t('Unverified'),
});
/** Placeholders created by references, not inventoried files: never listed as folder contents. */
export const outsideInventory = new Set(['missing', 'external', 'declared', 'unverified']);
/** Non-direct cascade steps, always shown on the relation instead of silently resolved. */
export const resolutions: Record<string, string> = labels({
  'frontmatter-name': () => t('by the name declared in the frontmatter'),
  skill: () => t("by the Skill's root"),
  root: () => t('by the open project'),
  'root-dot': () => t('by the open project (./ read from the root)'),
  basename: () => t('by unique name'),
  suffix: () => t('by unique suffix'),
  'skill-basename': () => t('by unique name in the Skill itself'),
  'skill-suffix': () => t('by unique suffix in the Skill itself'),
});
/** Why a non-direct cascade step is shown, in a sentence; undefined for a mode this interface does not know. */
function resolutionExplanation(mode: string) {
  switch (mode) {
    case 'frontmatter-name':
      return t(
        'Wikilink without a folder resolved by the only Markdown file that declares that name (name:) in its own frontmatter, before any search by file name: it is the identity declared by the target, not a guess by name.',
      );
    case 'skill':
      return t(
        "The path does not exist from the source file's folder; it was resolved from the folder of the nearest SKILL.md.",
      );
    case 'root':
      return t(
        "The path does not exist from the source file's folder; it was resolved from the open project that contains the source.",
      );
    case 'root-dot':
      return t(
        "A ./ mention (in backticks or in the text) that does not exist from the source file's folder; it was resolved from the open project, like a working directory. A ./ Markdown link has no such fallback.",
      );
    case 'basename':
      return t(
        'The path does not exist from the source nor from the open projects; a single file listed in the root of the source has that name. Check that it is the intended target.',
      );
    case 'suffix':
      return t(
        'The path does not exist from the source nor from the open projects; a single file listed in the root of the source ends with that path. Check that it is the intended target.',
      );
    case 'skill-basename':
      return t(
        'The path does not exist from the source nor from the open projects; a single file with that name exists inside the source Skill itself, even though there are namesakes in other Skills. Check that it is the intended target.',
      );
    case 'skill-suffix':
      return t(
        'The path does not exist from the source nor from the open projects; a single file inside the source Skill itself ends with that path, even though there are others in other Skills. Check that it is the intended target.',
      );
    default:
      return undefined;
  }
}
/** Label of a non-direct cascade step; a mode unknown to this interface gets a generic label instead of disappearing. */
export function resolutionLabel(mode: string | null | undefined) {
  if (!mode || mode === 'file') return null;
  return Object.hasOwn(resolutions, mode)
    ? resolutions[mode]
    : t('by an unrecognized mode ({mode})', { mode });
}
export function resolutionNote(mode: string) {
  return (
    (Object.hasOwn(resolutions, mode) ? resolutionExplanation(mode) : undefined) ??
    t(
      "Resolution mode not recognized by this version of the interface; the target did not come from the source file's folder. Check that it is the intended target.",
    )
  );
}
/** Extensions whose text is read for references (TEXT in server/scanner.py); other files are inventoried, never parsed. */
export const analyzedExtensions = ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml'];
/** One direction of a file's relations: distinct other ends, relations between different files, and self-references apart. */
export function relationTally(items: Relation[], outgoing: boolean) {
  const others = items.filter((edge) => edge.source !== edge.target);
  return {
    ends: new Set(others.map((edge) => (outgoing ? edge.target : edge.source))).size,
    relations: others.length,
    self: items.length - others.length,
  };
}
/** One name per scope kind, in the audit, the inspector and the declaration form. */
export const scopeKinds: Record<ScopeKind, string> = labels({
  runtimeWorkspace: () => t('Generated at runtime'),
  localFiles: () => t('Local file'),
  entries: () => t('Entry'),
  implicitLoads: () => t('Implicit load'),
});
/** Reference placeholders (missing, declared, external, unscanned): never counted or listed as files. */
export const isUnresolved = (node: FileNode) => node.kind === 'unresolved';
export const isFile = (node: FileNode) => node.kind !== 'directory' && node.kind !== 'unresolved';
/** How an unresolved destination is marked where it appears next to real files. */
export const unresolvedLabels: Record<string, string> = labels({
  missing: () => t('does not exist'),
  declared: () => t('declared outside the package'),
  external: () => t('outside open projects'),
  unscanned: () => t('in unread folder'),
  unverified: () => t('unverified'),
});
/* Titles, explanations and tones of observation codes: the dictionary in src/observations.ts. */
/** Observation codes about a reference whose destination was not resolved (the footer link opens them in the audit). */
export const unresolvedReferenceCodes = new Set([
  'broken',
  'unresolved-name',
  'ambiguous',
  'unverified',
  'outside-root',
]);

/** Difference between a fixed reference reading of each opened root and the current reading; references are saved in the app state. */
export type DeltaFile = {
  path: string;
  relative: string;
  root: string;
  bytes?: number | null;
  basis?: 'sha256' | 'size';
  before?: number | null;
  after?: number | null;
};
/** Evidence, resolution and edge id exist only for relations of the current reading (added ones). */
export type DeltaRelation = {
  origin: string;
  source: string;
  target: string;
  raw: string;
  kind: string;
  line: number;
  targetStatus: string | null;
  edge?: string;
  evidence?: string;
  resolvedBy?: string | null;
  declared?: { kind: ScopeKind; pattern: string };
};
export type DeltaFinding = {
  id: string;
  code: string;
  severity: string;
  message: string;
  /** The phrase of `message`, when it has parameters. */
  messagePhrase?: ServerPhrase;
  /**
   * A resolved finding of a baseline saved before the server wrote English: `message` is the Portuguese of
   * then, never read; shown as it came in Portuguese, and not in another language (src/serverText.ts).
   */
  earlier?: boolean;
  /** `unreachable`: as in the observation (`Issue`). */
  class?: 'orphan' | 'island';
  inbound?: number;
  conclusive?: boolean;
  /** `limit` of the text budget: the files it left out and their bytes. */
  count?: number;
  bytes?: number;
  path?: string;
  line?: number;
  target?: string;
  node: string | null;
};
/**
 * `persisted`: loaded from the app state at the first reading of this server; `referenceSaved`: on disk, valid after a restart.
 * `context`: whether the reference was read with the same opened roots, in the same order (`same`); otherwise relations
 * and observations of this root are not compared (`changed`, or `unknown` for a reference that does not record them).
 */
export type DeltaRoot = {
  path: string;
  name: string;
  referenceAt: string;
  referenceOrigin: 'first-reading' | 'user' | 'persisted';
  referenceSaved: boolean;
  context: 'same' | 'changed' | 'unknown';
};
/** `reference-ignored`: an invalid saved file was ignored and this reading became the reference; `reference-not-saved`: kept in memory only; `reference-update-not-saved`: the earlier saved reference, after a refused update; `reference-context-changed` and `reference-context-unknown`: relations and observations of the root were not compared (see `DeltaRoot.context`). */
export type DeltaWarning = {
  root: string;
  /** `reference-reader-changed` is said once for every project it applies to, listed here; `root` is the first. */
  roots?: string[];
  code: string;
  message: string;
  messagePhrase?: ServerPhrase;
};
export type Delta = {
  version: number;
  reference: { at: string; uniform: boolean };
  current: { at: string };
  roots: DeltaRoot[];
  warnings: DeltaWarning[];
  limit: number;
  files: {
    added: DeltaFile[];
    removed: DeltaFile[];
    changed: DeltaFile[];
    totals: { added: number; removed: number; changed: number };
    unverified: number;
    /** In one reading only, whose folder the other reading did not list completely: neither added nor removed. */
    uncompared: number;
  };
  relations: {
    added: DeltaRelation[];
    removed: DeltaRelation[];
    totals: { added: number; removed: number };
    /** Of an origin file left out of the inventory of one of the readings. */
    uncompared: number;
    /** Of an origin file in both readings, analysed in one of them only (text budget, size limit). */
    unanalysed: number;
  };
  findings: {
    status: string;
    error?: string;
    errorPhrase?: ServerPhrase;
    new: DeltaFinding[];
    resolved: DeltaFinding[];
    persisting: number;
    totals: { new: number; resolved: number };
    /** Of a file left out of the inventory of one of the readings. */
    uncompared: number;
    /** Of a file in both readings, analysed in one of them only; never `limit` or `unreadable`. */
    unanalysed: number;
    byCode: Record<string, { new: number; resolved: number; persisting: number }>;
    context: {
      code: string;
      severity: string;
      message: string;
      messagePhrase?: ServerPhrase;
      root: string;
      sides?: string[];
      differs?: string[];
      scopeSource?: { before: string | null; after: string | null };
    }[];
  };
};
