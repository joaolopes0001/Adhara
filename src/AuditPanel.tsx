import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  GitBranch,
} from 'lucide-react';
import type { Issue, Model, Root, Signal } from './types';
import { isUnresolved, scopeKinds, unresolvedReferenceCodes } from './types';
import type { CodeInfo, Tone } from './observations';
import {
  codeInfo,
  codeTitle,
  diagnose,
  groupMeaning,
  inconclusive,
  inconclusiveNote,
  issueInfo,
  joinList,
  nodeIndex,
  projectOf,
  projectPath,
  relationsAt,
  shortText,
  signalCaveat,
} from './observations';
import { Diagnosis } from './Diagnosis';
import {
  markOf,
  rememberedReason,
  settledDestinations,
  signalCodes as signalCodeSet,
  splitExpected,
} from './expected';
import { ExpectedButton, ExpectedForm, ExpectedNote } from './ExpectedMark';
import { partialReading } from './partialReading';
import { formatNumber, plural, rich, t, useI18n } from './i18n';

/**
 * What the audit lists: a level (the tone of the observations, every observation, or the structural signals) and
 * a type inside it (a code, `unresolvedFilter`, or '' for every type). An empty level opens on what asks for
 * action: problems, else warnings, else informative observations.
 */
export type AuditLevel = Tone | 'all' | 'signals';
export type AuditView = { level: AuditLevel | ''; type: string };
export const defaultAuditView: AuditView = { level: '', type: '' };
/** Not a model code: the references whose destination was not resolved, opened from the footer count. */
export const unresolvedFilter = 'unresolved-targets';
/** Value of the project filter that keeps every opened project. */
export const allProjects = '';

const tones: Tone[] = ['problem', 'warning', 'info'];
function levelName(level: AuditLevel) {
  switch (level) {
    case 'problem':
      return t('Problems');
    case 'warning':
      return t('Warnings');
    case 'info':
      return t('Info', { context: 'tab' });
    case 'all':
      return t('All');
    case 'signals':
      return t('Signals');
  }
}
/** One signal in words, by kind, in the order the signal list opens. */
const signalCodes = ['cycle', 'repeated-reference', 'high-fanout'];
const signalTitle = (code: string) => {
  switch (code) {
    case 'cycle':
      return t('Reference cycle');
    case 'repeated-reference':
      return t('Repeated reference');
    case 'high-fanout':
      return t('High fan-out');
    default:
      return undefined;
  }
};
const signalRank = new Map(signalCodes.map((code, index) => [code, index]));
const titleOf = (code: string) => signalTitle(code) ?? codeTitle(code) ?? codeInfo(code).title;
const absorbing = new Set(['runtimeWorkspace', 'localFiles']);
// Resolution modes the CLI audit reports as info findings (BY_NAME in server/audit.py).
const byNameModes = new Set(['basename', 'skill-basename', 'suffix', 'skill-suffix', 'root-dot']);
/** Files shown per page, and lines per file, before "Show more". */
const FILES = 20;
const ROWS = 10;

/** Findings `aae audit` adds to the model issues: name/suffix resolutions, declared absorptions and the partial-analysis notice. */
export function cliExtras(model: Model) {
  let byName = 0,
    absorbed = 0;
  for (const edge of model.edges) {
    // Declared manifest relationships repeat a value the JSON pass already extracted.
    if (edge.kind === 'scope' || edge.kind === 'declared') continue;
    if (edge.resolvedBy && byNameModes.has(edge.resolvedBy)) byName++;
    else if (edge.declared) absorbed++;
  }
  // The same rule as `analysis-partial` (src/partialReading.ts).
  return { byName, absorbed, partial: partialReading(model).partial ? 1 : 0 };
}

/**
 * The relation an observation is about: same origin, line and destination as written (`target` = edge `raw`),
 * so two references on one line never swap their evidence. An ambiguous reference has no relation. Without a
 * written destination (signals, limits), only the single relation of that line counts.
 */
export function observationEdge(model: Model, item: Issue | Signal) {
  if (!item.node || !item.line) return undefined;
  const onLine = relationsAt(model, item.node, item.line);
  // A relationship without its link, or not compared: the declared relation of that pair, on the manifest line
  // (the one of the line when the reader resolved no pair).
  if (
    (item.code === 'manifest-mismatch' && 'absent' in item && item.absent === 'link') ||
    item.code === 'manifest-unchecked'
  ) {
    const declared = onLine.filter((edge) => edge.kind === 'declared');
    const pair = 'from' in item && item.from && item.to;
    return pair
      ? declared.find((edge) => edge.source === item.from && edge.target === item.to)
      : declared.length === 1
        ? declared[0]
        : undefined;
  }
  const target = 'target' in item ? item.target : undefined;
  if (typeof target === 'string') return onLine.find((edge) => edge.raw === target);
  return onLine.length === 1 ? onLine[0] : undefined;
}

/** Whether an observation of `code` is of the chosen type ('' = every type of the level). */
function ofType(type: string, code: string) {
  return (
    !type || code === type || (type === unresolvedFilter && unresolvedReferenceCodes.has(code))
  );
}

type FileGroup = { key: string; node: string | null; root?: Root; items: (Issue | Signal)[] };

/**
 * Groups by project (the order of the opened roots; items outside them last), then by source file: the file with
 * most items first (signals: the file with the largest signal), each file in line order (signals: by kind, then
 * largest first). Items without a source file form the last group of their project.
 */
function fileGroups(items: (Issue | Signal)[], signalView: boolean, roots: Root[]) {
  const rank = new Map(roots.map((root, index) => [root.path, index]));
  const groups = new Map<string, FileGroup>();
  for (const item of items) {
    const key = item.node ?? `\n${projectOf(roots, item.node)?.path ?? ''}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else
      groups.set(key, { key, node: item.node, root: projectOf(roots, item.node), items: [item] });
  }
  const largest = (group: FileGroup) =>
    Math.max(...group.items.map((item) => (item as Signal).count ?? 0));
  for (const group of groups.values())
    group.items.sort((a, b) =>
      signalView
        ? (signalRank.get(a.code) ?? 99) - (signalRank.get(b.code) ?? 99) ||
          ((b as Signal).count ?? 0) - ((a as Signal).count ?? 0) ||
          (a.line ?? 0) - (b.line ?? 0)
        : (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code),
    );
  return [...groups.values()].sort(
    (a, b) =>
      (rank.get(a.root?.path ?? '') ?? roots.length) -
        (rank.get(b.root?.path ?? '') ?? roots.length) ||
      Number(!a.node) - Number(!b.node) ||
      (signalView ? largest(b) - largest(a) : b.items.length - a.items.length) ||
      (a.node ?? '').localeCompare(b.node ?? ''),
  );
}

/** How the footer count (distinct unresolved destinations) relates to the references the audit lists. */
function unresolvedNote(
  destinations: Map<string, number>,
  references: Map<string, number>,
  settled: number,
) {
  const total = [...destinations.values()].reduce((sum, value) => sum + value, 0);
  const of = (map: Map<string, number>, key: string) => map.get(key) ?? 0;
  const statuses = [
    of(destinations, 'missing') &&
      plural(of(destinations, 'missing'), '{count} does not exist', '{count} do not exist'),
    of(destinations, 'external') &&
      t('{count} outside open projects', { count: of(destinations, 'external') }),
    of(destinations, 'declared') &&
      plural(
        of(destinations, 'declared'),
        '{count} declared outside the package',
        '{count} declared outside the package',
      ),
    of(destinations, 'unscanned') &&
      t('{count} in unread folder', { count: of(destinations, 'unscanned') }),
    of(destinations, 'unverified') &&
      plural(of(destinations, 'unverified'), '{count} unverified', '{count} unverified'),
  ].filter(Boolean);
  // Codes that only some readings have are named only when present.
  const listed = [
    of(references, 'broken') &&
      plural(of(references, 'broken'), '{count} missing', '{count} missing'),
    of(references, 'unresolved-name') &&
      plural(
        of(references, 'unresolved-name'),
        '{count} name without a file',
        '{count} names without a file',
      ),
    of(references, 'outside-root') &&
      t('{count} above the open project', { count: of(references, 'outside-root') }),
    of(references, 'unverified') &&
      plural(of(references, 'unverified'), '{count} unverified', '{count} unverified', {
        context: 'reference',
      }),
    of(references, 'ambiguous') &&
      plural(of(references, 'ambiguous'), '{count} ambiguous', '{count} ambiguous'),
  ];
  const parts = listed.filter(Boolean).join(', ');
  const referenceTotal = [...references.values()].reduce((sum, value) => sum + value, 0);
  const statusList = statuses.join(', ');
  return [
    total
      ? statuses.length
        ? plural(
            total,
            'Footer: {count} distinct target ({statuses}).',
            'Footer: {count} distinct targets ({statuses}).',
            { statuses: statusList },
          )
        : plural(total, 'Footer: {count} distinct target.', 'Footer: {count} distinct targets.')
      : '',
    referenceTotal
      ? of(references, 'ambiguous')
        ? plural(
            referenceTotal,
            'Audit: {count} reference ({parts}, no target chosen).',
            'Audit: {count} references ({parts}, no target chosen).',
            { parts },
          )
        : plural(
            referenceTotal,
            'Audit: {count} reference ({parts}).',
            'Audit: {count} references ({parts}).',
            { parts },
          )
      : '',
    settled
      ? plural(
          settled,
          '{count} target whose references were all marked as expected stays out of the count and the list (see Expected).',
          '{count} targets whose references were all marked as expected stay out of the count and the list (see Expected).',
        )
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Audit tool. It opens on what asks for action: tabs by level with their counts (problems, warnings, informative
 * observations, and the structural signals apart), the type chosen inside the level, then one collapsed group per
 * source file (the first one open; 20 files and 10 lines per file at a time) and one short line per observation
 * (`L12 · what is written · type`). The line opens the same facts as the inspector, with the actions; what a type
 * means is said once, above the list or in the open line. How the counts are made stays in one collapsed section.
 */
export default function AuditPanel({
  model,
  view,
  setView,
  project,
  setProject,
  onOpen,
  onSelect,
  onExpected,
  chosenIn,
}: {
  model: Model;
  view: AuditView;
  setView: (value: AuditView) => void;
  /** Path of the only project shown, or `allProjects`. */
  project: string;
  setProject: (value: string) => void;
  onOpen: (item: Issue | Signal) => void;
  onSelect: (id: string) => void;
  /** Marks (`expected`) or unmarks one observation of a project; rejects with the message of the API. */
  onExpected: (root: string, key: string, expected: boolean, reason?: string) => Promise<void>;
  /** The reading `view` was chosen in: a different one at mount gets the opening rule (see below). */
  chosenIn?: Model;
}) {
  // The words are resolved while rendering; the tool renders again when the language changes.
  const { language } = useI18n();
  const nodes = nodeIndex(model);
  // Marked items leave the list and the counts; they are listed apart, under "Expected".
  const split = splitExpected(model);
  // A project filter applies with two or more projects open, and only while it names one of them.
  const several = model.roots.length > 1;
  const only = several ? model.roots.find((root) => root.path === project) : undefined;
  const inProject = (path: string | null | undefined) =>
    !only || projectOf(model.roots, path)?.path === only.path;
  const issuesHere = useMemo(
    () => split.issues.filter((item) => inProject(item.node)),
    [split.issues, only],
  );
  const signalsHere = useMemo(
    () => split.signals.filter((item) => inProject(item.node)),
    [split.signals, only],
  );
  const perTone = useMemo(() => {
    const counts: Record<Tone, number> = { problem: 0, warning: 0, info: 0 };
    for (const item of issuesHere) counts[issueInfo(item).tone]++;
    return counts;
  }, [issuesHere]);
  // Without observations (all of them marked, or none), every level: the marked ones are listed below.
  const level: AuditLevel = view.level || tones.find((tone) => perTone[tone] > 0) || 'all';
  // A chosen level (or type) that a new reading, another project or a mark leaves empty gives way to the
  // opening rule again. Choosing (here, "View limits" or the footer) never resets by itself.
  // Mounted after the reading changed off the screen (another tool, closed panel): checked at once.
  const seen = useRef({ model: chosenIn ?? model, project: only?.path });
  useEffect(() => {
    const before = seen.current;
    seen.current = { model, project: only?.path };
    if (before.model === model && before.project === only?.path) return;
    if (!view.level && !view.type) return;
    const pool: (Issue | Signal)[] =
      level === 'signals'
        ? signalsHere
        : issuesHere.filter((item) => level === 'all' || issueInfo(item).tone === level);
    if (!pool.some((item) => ofType(view.type, item.code))) setView(defaultAuditView);
  });
  const signalView = level === 'signals';
  const inLevel = (item: Issue) => level === 'all' || issueInfo(item).tone === level;
  const levelPool: (Issue | Signal)[] = useMemo(
    () => (signalView ? signalsHere : issuesHere.filter(inLevel)),
    [signalView, signalsHere, issuesHere, level],
  );
  const items = useMemo(
    () => levelPool.filter((item) => ofType(view.type, item.code)),
    [levelPool, view.type],
  );
  // The types of the level that have occurrences, with their count; the chosen one even at zero.
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of levelPool) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    const order = signalView
      ? [...counts.keys()].sort((a, b) => (signalRank.get(a) ?? 99) - (signalRank.get(b) ?? 99))
      : [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    const list: [string, string, number][] = order.map((code) => {
      const sample = levelPool.find((item) => item.code === code)!;
      // Named as its lines name it; the code's own title only when its lines have two names.
      const titles = signalView
        ? new Set<string>()
        : new Set(
            levelPool
              .filter((item) => item.code === code)
              .map((item) => issueInfo(item as Issue).title),
          );
      const title = signalView
        ? titleOf(code)
        : titles.size === 1
          ? issueInfo(sample as Issue).title
          : codeInfo(code).title;
      return [code, title, counts.get(code) ?? 0];
    });
    const references = levelPool.filter((item) => unresolvedReferenceCodes.has(item.code)).length;
    if (level === 'all' && (references || view.type === unresolvedFilter))
      list.push([unresolvedFilter, t('References with no target found'), references]);
    if (view.type && !list.some(([code]) => code === view.type))
      list.push([view.type, titleOf(view.type), 0]);
    return list;
  }, [levelPool, level, signalView, view.type, language]);
  // The meaning of the type, said once above the list when the list has one type; otherwise in the open line.
  const infos = signalView
    ? []
    : [...new Map(items.map((item) => [issueInfo(item as Issue).title, issueInfo(item as Issue)]))];
  const single: CodeInfo | undefined =
    infos.length === 1
      ? infos[0][1]
      : !signalView && view.type && view.type !== unresolvedFilter && !items.length
        ? codeInfo(view.type)
        : undefined;
  const meaning = single && groupMeaning(single, items as Issue[]);
  // What each kind of signal does not prove, once above the list, for the kinds it shows.
  const caveats = signalView
    ? signalCodes.filter((code) => items.some((item) => item.code === code))
    : [];
  const groups = useMemo(
    () => fileGroups(items, signalView, model.roots),
    [items, signalView, model.roots],
  );
  // Open files, pages of files and of lines: back to the defaults (the first file open) when the selection changes.
  const viewKey = `${level}\n${view.type}\n${only?.path ?? ''}`;
  type Paging = { key: string; open: Set<string>; files: number; rows: Record<string, number> };
  const [paging, setPaging] = useState<Paging>({
    key: '',
    open: new Set(),
    files: FILES,
    rows: {},
  });
  const current: Paging =
    paging.key === viewKey
      ? paging
      : { key: viewKey, open: new Set(groups[0] ? [groups[0].key] : []), files: FILES, rows: {} };
  const update = (change: Partial<Paging>) => setPaging({ ...current, ...change });
  const toggleFile = (key: string) => {
    const open = new Set(current.open);
    if (open.has(key)) open.delete(key);
    else open.add(key);
    update({ open });
  };
  // The line whose facts are open (one at a time), its declaration, and the form of a mark (project and key).
  const [openId, setOpenId] = useState('');
  const [scopeFor, setScopeFor] = useState('');
  const [marking, setMarking] = useState('');
  // The last marking said in words when drawn, so it follows a change of language.
  const [status, setStatus] = useState<{ say: () => string }>();
  // Reasons typed in a form closed by the declaration, kept until it opens again.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // A confirmation speaks of the reading it was given in: a new reading or another selection clears it.
  // Not on a change of view that the mark itself causes (the last of a level): the confirmation stays.
  useEffect(() => setStatus(undefined), [model.issues, model.signals]);
  // The sections of marks (collapsed by default), opened by their count in the header, and where to scroll.
  const [sections, setSections] = useState({ expected: false, orphans: false });
  const [scrollTo, setScrollTo] = useState('');
  const content = useRef<HTMLDivElement>(null);
  // Observations of the "Expected" section opened to their facts, by id.
  const [explained, setExplained] = useState<Set<string>>(() => new Set());
  const toggleExplained = (id: string) =>
    setExplained((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  useEffect(() => {
    if (!scrollTo) return;
    const target = content.current?.querySelector(scrollTo);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    setScrollTo('');
  });
  const expectedItems = (signalView ? split.expectedSignals : split.expectedIssues).filter(
    (item) =>
      inProject(item.node) &&
      (signalView || inLevel(item as Issue)) &&
      ofType(view.type, item.code),
  );
  const orphans = split.orphans.filter(
    (orphan) =>
      signalCodeSet.has(orphan.mark.code) === signalView &&
      ofType(view.type, orphan.mark.code) &&
      (!only || orphan.root.path === only.path),
  );
  /** The count in the header opens its section and scrolls to it, widening the selection if it hides it. */
  function showSection(section: 'expected' | 'orphans') {
    const hidden = section === 'expected' ? !expectedItems.length : !orphans.length;
    if (hidden) {
      const issues =
        section === 'expected'
          ? split.expectedIssues.length > 0
          : split.orphans.some((orphan) => !signalCodeSet.has(orphan.mark.code));
      setView({ level: issues ? 'all' : 'signals', type: '' });
      setProject(allProjects);
    }
    setSections((previous) => ({ ...previous, [section]: true }));
    setScrollTo(section === 'expected' ? '.audit-expected:not(.audit-orphans)' : '.audit-orphans');
  }
  const expectedTotal = split.expectedIssues.length + split.expectedSignals.length;
  const reach = model.stats.reachability;
  const { source, patterns } = model.scope;
  const roots = new Set(patterns.map((pattern) => pattern.root).filter(Boolean));
  const absorbed = patterns.filter((pattern) => absorbing.has(pattern.kind));
  const starting = patterns.filter((pattern) => !absorbing.has(pattern.kind));
  const unused = patterns.filter((pattern) => !pattern.references && !pattern.files).length;
  const name = (id: string) => projectPath(model.roots, id);
  const extras = useMemo(() => cliExtras(model), [model]);
  // The footer counts distinct destinations; the audit lists references, each with its line.
  // Destinations whose references are all marked as expected leave the count, as in the footer.
  const [placeholders, settled] = useMemo(() => {
    const settled = settledDestinations(model);
    const byStatus = new Map<string, number>();
    for (const node of model.nodes)
      if (isUnresolved(node) && !settled.has(node.id))
        byStatus.set(node.status, (byStatus.get(node.status) ?? 0) + 1);
    return [byStatus, settled.size] as const;
  }, [model]);
  const references = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of split.issues)
      if (unresolvedReferenceCodes.has(item.code))
        counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    return counts;
  }, [split.issues]);
  const unreachable = split.issues.some((item) => item.code === 'unreachable');
  const unresolvedText = unresolvedNote(placeholders, references, settled);
  const notes = [
    extras.byName &&
      plural(
        extras.byName,
        '{count} resolution by unique name or suffix',
        '{count} resolutions by unique name or suffix',
      ),
    extras.absorbed &&
      plural(
        extras.absorbed,
        '{count} reference absorbed by the declared scope',
        '{count} references absorbed by the declared scope',
      ),
  ].filter(Boolean) as string[];
  const observed = issuesHere.length;
  // Only levels with observations (and the chosen one), then every observation.
  const levels: AuditLevel[] = [
    ...tones.filter((tone) => perTone[tone] > 0 || level === tone),
    'all',
  ];
  const levelCount = (value: AuditLevel) =>
    value === 'all' ? observed : value === 'signals' ? signalsHere.length : perTone[value as Tone];
  const choose = (value: AuditLevel) => {
    setView({ level: value, type: '' });
    setOpenId('');
    setStatus(undefined);
  };
  const shown = groups.slice(0, current.files);
  /** Keeps the keyboard in the list once React has drawn it (a "Show more" that leaves, a form that closes). */
  const focusLater = (...selectors: string[]) =>
    requestAnimationFrame(() => {
      for (const selector of selectors) {
        const target = content.current?.querySelector<HTMLElement>(selector);
        if (target) return target.focus();
      }
    });
  const tabs: AuditLevel[] = [
    ...(observed ? levels : []),
    ...(signalsHere.length ? (['signals'] as AuditLevel[]) : []),
  ];
  // One tab stop: the selected tab (the first one when none is); arrows, Home and End move and select.
  const tabStop = tabs.includes(level) ? level : tabs[0];
  function tabKey(event: KeyboardEvent) {
    const index = tabs.indexOf(tabStop);
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    choose(next);
    focusLater(`.audit-levels [data-level="${next}"]`);
  }
  return (
    <div className="audit-content" ref={content}>
      <div className="audit-summary">
        <div
          className="audit-levels"
          role="tablist"
          aria-label={t('Observation level')}
          onKeyDown={tabKey}
        >
          {(observed ? levels : []).map((value) => (
            <button
              key={value}
              role="tab"
              data-level={value}
              aria-selected={level === value}
              tabIndex={tabStop === value ? 0 : -1}
              className={`audit-level${level === value ? ' active' : ''}${value !== 'all' ? ` tone-${value}` : ''}`}
              onClick={() => choose(value)}
            >
              {levelName(value)}{' '}
              <span className="audit-level-count">{formatNumber(levelCount(value))}</span>
            </button>
          ))}
          {signalsHere.length > 0 && (
            <button
              role="tab"
              data-level="signals"
              aria-selected={signalView}
              tabIndex={tabStop === 'signals' ? 0 : -1}
              className={`audit-level signals${signalView ? ' active' : ''}`}
              onClick={() => choose('signals')}
            >
              <GitBranch size={13} aria-hidden="true" />
              {levelName('signals')}{' '}
              <span className="audit-level-count">{formatNumber(signalsHere.length)}</span>
            </button>
          )}
        </div>
        {(expectedTotal > 0 || split.orphans.length > 0) && (
          <span className="audit-marks">
            {expectedTotal > 0 && (
              <button
                className="audit-expected-total"
                title={t('Opens the Expected section')}
                onClick={() => showSection('expected')}
              >
                {plural(expectedTotal, '{count} expected', '{count} expected')}
              </button>
            )}
            {expectedTotal > 0 && split.orphans.length > 0 && ' · '}
            {split.orphans.length > 0 && (
              <button
                className="audit-expected-total"
                title={t(
                  'Marks whose observation is not in the last scan: opens the section, where they can be removed',
                )}
                onClick={() => showSection('orphans')}
              >
                {t('{count} without a matching observation', { count: split.orphans.length })}
              </button>
            )}
          </span>
        )}
        {(observed > 0 || signalView || several) && (
          <div className="audit-choices">
            {!(observed > 0 || signalView) ? null : types.length > 1 || view.type ? (
              <select
                aria-label={signalView ? t('Signal type') : t('Observation type')}
                value={view.type}
                onChange={(e) => {
                  setView({ level, type: e.target.value });
                  setOpenId('');
                  setStatus(undefined);
                }}
              >
                <option value="">
                  {signalView ? t('All signals') : t('All types')} ({formatNumber(levelPool.length)}
                  )
                </option>
                {types.map(([code, title, n]) => (
                  <option key={code} value={code}>
                    {title} ({formatNumber(n)})
                  </option>
                ))}
              </select>
            ) : (
              types[0] && <strong className="audit-type-name">{types[0][1]}</strong>
            )}
            {several && (
              <select
                aria-label={t('Audit project')}
                value={only?.path ?? allProjects}
                onChange={(e) => {
                  setProject(e.target.value);
                  setStatus(undefined);
                }}
              >
                <option value={allProjects}>{t('All projects')}</option>
                {model.roots.map((root) => (
                  <option key={root.path} value={root.path} title={root.path}>
                    {t('Only {name}', { name: root.name })}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {status && (
          <p className="audit-expected-status" role="status">
            {status.say()}
          </p>
        )}
      </div>
      {meaning && <p className="audit-type-meaning">{meaning}</p>}
      {signalView && (
        <div className="audit-type-meaning">
          <p>{t('Outside the observation count; they do not prove repetition at runtime.')}</p>
          {caveats.map((code) => (
            <p key={code}>
              <strong>{signalTitle(code)}:</strong> {signalCaveat(code)?.toLowerCase()}
            </p>
          ))}
        </div>
      )}
      {!observed && !signalView ? (
        <p className="empty-small audit-empty">
          {only
            ? t('No observations in {name}.', { name: only.name })
            : t('No observations in this scan.')}
          {expectedItems.length ? ` ${stayBelow(expectedItems.length)}` : ''}
        </p>
      ) : (
        !items.length && (
          <p className="empty-small audit-empty">
            {signalView
              ? t('No structural signals in this selection.')
              : t('No observations of this type.')}
            {expectedItems.length ? ` ${stayBelow(expectedItems.length)}` : ''}
          </p>
        )
      )}
      <div className="audit-observations">
        {shown.map((group, index) => {
          const root = group.root;
          const newProject = several && (index === 0 || root?.path !== shown[index - 1].root?.path);
          const open = current.open.has(group.key);
          const limit = current.rows[group.key] ?? ROWS;
          return (
            <div key={group.key} className="audit-file">
              {newProject && (
                <div
                  className="audit-project"
                  title={root ? t('Project: {path}', { path: root.path }) : undefined}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  <strong>
                    {root ? root.name : t('Outside open projects', { context: 'audit' })}
                  </strong>
                  {root && !only && (
                    <button onClick={() => setProject(root.path)}>{t('Only this project')}</button>
                  )}
                  {only && (
                    <button onClick={() => setProject(allProjects)}>{t('All projects')}</button>
                  )}
                </div>
              )}
              <div className="observation-group audit-file-group" data-audit-file={group.key}>
                <button
                  className="observation-group-head"
                  aria-expanded={open}
                  title={group.node ?? undefined}
                  onClick={() => toggleFile(group.key)}
                >
                  {open ? (
                    <ChevronDown size={14} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={14} aria-hidden="true" />
                  )}
                  <FileText size={13} aria-hidden="true" />
                  <strong>{group.node ? name(group.node) : t('No source file')}</strong>
                  <span className="observation-group-count">
                    · {formatNumber(group.items.length)}
                  </span>
                </button>
                {open && (
                  <>
                    <ol>
                      {group.items.slice(0, limit).map((item) => {
                        const info = signalView ? undefined : issueInfo(item as Issue);
                        const detail = openId === item.id;
                        const where = item.node
                          ? `${name(item.node)}${item.line ? `:${item.line}` : ''}`
                          : '';
                        const subject = describe(item, where);
                        const formKey = root && item.key ? `${root.path}\n${item.key}` : '';
                        const text = shortText(item, model);
                        const unsure = inconclusive(item);
                        const type = info ? info.title : titleOf(item.code);
                        const row = `[data-audit-id="${CSS.escape(item.id)}"]`;
                        const form = formKey && marking === formKey && (
                          <ExpectedForm
                            subject={subject}
                            initial={drafts[formKey] ?? rememberedReason(root!.path, item.key!)}
                            onDraft={(reason) => setDrafts({ ...drafts, [formKey]: reason })}
                            onCancel={() => {
                              // Cancelled, the reason is dropped; only the declaration keeps it.
                              setDrafts(({ [formKey]: _dropped, ...rest }) => rest);
                              setMarking('');
                              focusLater(`${row} .expected-button`);
                            }}
                            onSubmit={async (reason) => {
                              await onExpected(root!.path, item.key!, true, reason);
                              setMarking('');
                              setOpenId('');
                              setStatus({
                                say: () =>
                                  t('Marked as expected: {subject}.', {
                                    subject: describe(item, where),
                                  }),
                              });
                              // The line leaves the list: the next line, else the file, else the tabs.
                              const next = group.items[group.items.indexOf(item) + 1];
                              focusLater(
                                ...(next
                                  ? [
                                      `[data-audit-id="${CSS.escape(next.id)}"] .file-observation-open`,
                                    ]
                                  : []),
                                `[data-audit-file="${CSS.escape(group.key)}"] .observation-group-head`,
                                '.audit-levels [tabindex="0"]',
                                '.audit-summary select',
                              );
                            }}
                          />
                        );
                        return (
                          <li
                            key={item.id}
                            className={`file-observation audit-row-item${detail ? ' open' : ''}`}
                            data-audit-id={item.id}
                          >
                            <div
                              className={`file-observation-row audit-line${info ? ` tone-${info.tone}` : ' signal'}`}
                            >
                              {!info && <GitBranch size={13} aria-hidden="true" />}
                              {item.node ? (
                                <button
                                  className="file-observation-line"
                                  title={
                                    item.line
                                      ? t('Open {path} at line {line}', {
                                          path: item.node,
                                          line: String(item.line),
                                        })
                                      : t('Open {path}', { path: item.node })
                                  }
                                  aria-label={
                                    item.line
                                      ? t('Go to line {line} of {name}', {
                                          line: String(item.line),
                                          name: name(item.node),
                                        })
                                      : t('Open {name}', { name: name(item.node) })
                                  }
                                  onClick={() => onOpen(item)}
                                >
                                  {item.line ? `L${item.line}` : <FileText size={12} />}
                                </button>
                              ) : (
                                <span className="file-observation-line" aria-hidden="true">
                                  —
                                </span>
                              )}
                              <button
                                className="file-observation-open"
                                aria-expanded={detail}
                                aria-label={
                                  detail
                                    ? t('Close detail: {subject}', {
                                        subject: withNote(subject, unsure),
                                      })
                                    : t('View detail: {subject}', {
                                        subject: withNote(subject, unsure),
                                      })
                                }
                                title={text || type}
                                onClick={() => {
                                  setOpenId(detail ? '' : item.id);
                                  setMarking('');
                                }}
                              >
                                {text ? (
                                  <span
                                    className={
                                      'target' in item && item.target !== undefined
                                        ? 'file-observation-target'
                                        : 'file-observation-text'
                                    }
                                  >
                                    {text}
                                  </span>
                                ) : null}
                                {unsure && (
                                  <small className="file-observation-type inconclusive">
                                    {inconclusiveNote()}
                                  </small>
                                )}
                                {(!single || !text) && (
                                  <small
                                    className="file-observation-type"
                                    title={t('Code in aae audit: {code}', { code: item.code })}
                                  >
                                    {type}
                                  </small>
                                )}
                                {detail ? (
                                  <ChevronDown size={13} aria-hidden="true" />
                                ) : (
                                  <ChevronRight size={13} aria-hidden="true" />
                                )}
                              </button>
                            </div>
                            {detail && (
                              <div className="occurrence-detail">
                                {signalView ? (
                                  <>
                                    {formKey && (
                                      <div className="diagnosis-actions">
                                        <ExpectedButton
                                          subject={subject}
                                          open={marking === formKey}
                                          onClick={() =>
                                            setMarking(marking === formKey ? '' : formKey)
                                          }
                                        />
                                      </div>
                                    )}
                                    {form}
                                  </>
                                ) : (
                                  <Diagnosis
                                    diagnosis={diagnose(
                                      model,
                                      item as Issue,
                                      observationEdge(model, item),
                                    )}
                                    source={item.node ?? undefined}
                                    version={item.node ? nodes.get(item.node)?.sha256 : undefined}
                                    onSelect={onSelect}
                                    meaning={!single}
                                    scope={{
                                      open: scopeFor === item.id,
                                      // One form at a time: the declaration closes the mark, and back.
                                      onToggle: () => {
                                        setScopeFor(scopeFor === item.id ? '' : item.id);
                                        setMarking('');
                                      },
                                    }}
                                    actions={
                                      formKey && (
                                        <ExpectedButton
                                          subject={subject}
                                          open={marking === formKey}
                                          onClick={() => {
                                            setMarking(marking === formKey ? '' : formKey);
                                            setScopeFor('');
                                          }}
                                        />
                                      )
                                    }
                                  >
                                    {form}
                                  </Diagnosis>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                    {group.items.length > limit && (
                      <button
                        className="observation-more"
                        onClick={() => {
                          update({ rows: { ...current.rows, [group.key]: limit + ROWS } });
                          if (limit + ROWS >= group.items.length)
                            focusLater(
                              `[data-audit-id="${CSS.escape(group.items[limit].id)}"] .file-observation-open`,
                            );
                        }}
                      >
                        {rich('Show {count} more<span> · {left} left</span>', {
                          count: Math.min(ROWS, group.items.length - limit),
                          left: group.items.length - limit,
                          span: (chunks) => <span>{chunks}</span>,
                        })}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        {groups.length > current.files && (
          <button
            className="observation-more audit-more-files"
            onClick={() => {
              update({ files: current.files + FILES });
              if (current.files + FILES >= groups.length)
                focusLater(
                  `[data-audit-file="${CSS.escape(groups[current.files].key)}"] .observation-group-head`,
                );
            }}
          >
            {rich('Show {count} more files<span> · {left} left</span>', {
              count: Math.min(FILES, groups.length - current.files),
              left: groups.length - current.files,
              span: (chunks) => <span>{chunks}</span>,
            })}
          </button>
        )}
      </div>
      <details className="audit-counting">
        <summary>{t('How these numbers are counted')}</summary>
        {(notes.length > 0 || extras.partial > 0 || split.expectedIssues.length > 0) && (
          <p className="audit-cli-note">
            {rich('The <code>aae audit</code> counts {total}: {list}.', {
              total: model.issues.length + extras.byName + extras.absorbed + extras.partial,
              list: joinList(
                [
                  split.issues.length === 1
                    ? t('this observation')
                    : t('these {count} observations', { count: split.issues.length }),
                  split.expectedIssues.length &&
                    plural(
                      split.expectedIssues.length,
                      '{count} marked as expected in this app',
                      '{count} marked as expected in this app',
                    ),
                  ...notes,
                  extras.partial && t('1 partial scan warning'),
                ].filter(Boolean) as string[],
              ),
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        )}
        {unresolvedText && <p className="unresolved-note">{unresolvedText}</p>}
        {unreachable && (
          <p className="reachability-note">
            {reach
              ? plural(
                  reach.starts.length,
                  'No path: from {count} starting point ({causes}).',
                  'No path: from {count} starting points ({causes}).',
                  {
                    causes: [
                      reach.orphans && plural(reach.orphans, '{count} orphan', '{count} orphans'),
                      reach.islands &&
                        plural(reach.islands, '{count} in an island', '{count} in islands'),
                      reach.exempt &&
                        plural(
                          reach.exempt,
                          '{count} exempt by the declared scope',
                          '{count} exempt by the declared scope',
                        ),
                    ]
                      .filter(Boolean)
                      .join(', '),
                  },
                )
              : t('No entry point: reachability was not computed.')}
          </p>
        )}
      </details>
      {source && (
        <details className="audit-scope">
          <summary>
            {[
              source === 'flag'
                ? t('Declared scope by --scope')
                : roots.size > 1
                  ? t('Declared scope in {count} manifests', { count: roots.size })
                  : t('Declared scope in agent-architecture.json'),
              plural(patterns.length, '{count} pattern', '{count} patterns'),
              // Absorption only when some pattern absorbs; starting points counted in their own words.
              absorbed.length
                ? t('absorbs {references} and {files}', {
                    references: plural(
                      absorbed.reduce((sum, pattern) => sum + pattern.references, 0),
                      '{count} reference',
                      '{count} references',
                    ),
                    files: plural(
                      absorbed.reduce((sum, pattern) => sum + pattern.files, 0),
                      '{count} file',
                      '{count} files',
                    ),
                  })
                : '',
              starting.length
                ? plural(
                    starting.reduce((sum, pattern) => sum + pattern.files, 0),
                    '{count} file declared as a starting point (entry or implicit load)',
                    '{count} files declared as starting points (entries or implicit loads)',
                  )
                : '',
              unused ? t('{count} with no effect', { count: unused }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </summary>
          <ul>
            {patterns.map((pattern, index) => (
              <li
                key={index}
                className={!pattern.references && !pattern.files ? 'unused' : undefined}
              >
                <span className="audit-tag">{scopeKinds[pattern.kind]}</span>
                <code>{pattern.pattern}</code>
                <span>
                  {absorbing.has(pattern.kind)
                    ? t('{references} · {files}', {
                        references: plural(
                          pattern.references,
                          '{count} reference absorbed',
                          '{count} references absorbed',
                        ),
                        files: plural(pattern.files, '{count} file', '{count} files'),
                      })
                    : plural(
                        pattern.files,
                        '{count} file as a starting point',
                        '{count} files as starting points',
                      )}
                  {!pattern.references && !pattern.files ? ` · ${t('no effect')}` : ''}
                </span>
                {roots.size > 1 && pattern.root && (
                  <small title={pattern.root}>{pattern.root.split('/').at(-1)}</small>
                )}
              </li>
            ))}
          </ul>
          <p>
            {t(
              'Absorbed references do not produce “Broken reference”: they appear in the relations as declared scope and are counted here. The declaration does not prove that these files will exist at runtime.',
            )}
          </p>
        </details>
      )}
      {expectedItems.length > 0 && (
        <details
          className="audit-expected"
          open={sections.expected}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (open !== sections.expected)
              setSections((previous) => ({ ...previous, expected: open }));
          }}
        >
          <summary>
            <BadgeCheck size={13} aria-hidden="true" />
            {t('Expected ({count})', { count: expectedItems.length })}
          </summary>
          {expectedItems.map((item) => {
            const root = projectOf(model.roots, item.node)!;
            const where = `${several ? `${root.name}/` : ''}${projectPath(model.roots, item.node!)}${item.line ? `:${item.line}` : ''}`;
            const subject = describe(item, where);
            const text = shortText(item, model);
            // The diagnosis, and so "Declare in project", stays available after marking.
            const explainId = `expected:${item.id}`;
            const open = !signalCodeSet.has(item.code) && explained.has(explainId);
            return (
              <div className="audit-expected-item" key={item.id} data-audit-id={explainId}>
                <button
                  className="audit-row expected"
                  title={t('Source file: {path}', {
                    path: `${item.node}${item.line ? `:${item.line}` : ''}`,
                  })}
                  onClick={() => onOpen(item)}
                >
                  <BadgeCheck size={14} aria-hidden="true" />
                  <span>
                    <b>
                      {signalCodeSet.has(item.code) ? titleOf(item.code) : issueInfo(item).title}
                    </b>
                    {text ? ` · ${text}` : ''}
                    <small>{where}</small>
                  </span>
                  <em className="expected-chip">{t('expected')}</em>
                  <ChevronRight size={14} />
                </button>
                <div className="audit-expected-actions">
                  <ExpectedNote
                    mark={markOf(model, item)!}
                    subject={subject}
                    onUndo={async () => {
                      await onExpected(root.path, item.key!, false);
                      setStatus({
                        say: () => t('Unmarked: {subject}.', { subject: describe(item, where) }),
                      });
                      focusLater('.audit-expected summary', '.audit-levels [tabindex="0"]');
                    }}
                  />
                  {!signalCodeSet.has(item.code) && (
                    <button
                      className="audit-explain"
                      aria-expanded={open}
                      aria-label={
                        open
                          ? t('Hide detail: {subject}', { subject })
                          : t('View detail: {subject}', { subject })
                      }
                      onClick={() => toggleExplained(explainId)}
                    >
                      {open ? t('Hide') : t('View detail')}
                    </button>
                  )}
                </div>
                {open && (
                  <div className="audit-diagnosis">
                    <Diagnosis
                      diagnosis={diagnose(model, item as Issue, observationEdge(model, item))}
                      source={item.node ?? undefined}
                      version={item.node ? nodes.get(item.node)?.sha256 : undefined}
                      onSelect={onSelect}
                      meaning
                      scope={{
                        open: scopeFor === explainId,
                        onToggle: () => setScopeFor(scopeFor === explainId ? '' : explainId),
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </details>
      )}
      {orphans.length > 0 && (
        <details
          className="audit-expected audit-orphans"
          open={sections.orphans}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (open !== sections.orphans)
              setSections((previous) => ({ ...previous, orphans: open }));
          }}
        >
          <summary>
            <BadgeCheck size={13} aria-hidden="true" />
            {t('Marks without an observation ({count})', { count: orphans.length })}
          </summary>
          <p className="audit-note">
            {t(
              'In the last scan, no observation has the key of these marks: the written target, the file or the observation type changed, or it was resolved. They are not deleted on their own; remove the ones that no longer make sense.',
            )}
          </p>
          {orphans.map(({ root, key, mark }) => {
            const subject = describeIn(
              titleOf(mark.code),
              mark.target,
              `${several ? `${root.name}/` : ''}${mark.path ?? root.name}`,
            );
            return (
              <div className="audit-expected-item orphan" key={`${root.path}\n${key}`}>
                <p className="audit-orphan">
                  <b>{titleOf(mark.code)}</b>
                  <small title={t('Project: {path}', { path: root.path })}>
                    {several ? `${root.name}/` : ''}
                    {mark.path ?? root.name}
                    {mark.target ? (
                      <>
                        {' '}
                        → <code>{mark.target}</code>
                      </>
                    ) : null}
                  </small>
                </p>
                <ExpectedNote
                  mark={mark}
                  subject={subject}
                  undo={t('Remove mark')}
                  onUndo={async () => {
                    await onExpected(root.path, key, false);
                    setStatus({
                      say: () =>
                        t('Mark removed: {subject}.', {
                          subject: describeIn(
                            titleOf(mark.code),
                            mark.target,
                            `${several ? `${root.name}/` : ''}${mark.path ?? root.name}`,
                          ),
                        }),
                    });
                  }}
                />
              </div>
            );
          })}
        </details>
      )}
    </div>
  );
}

/** Title with the destination as written, and where it is: "Broken reference (x.md) in AGENTS.md:3". */
function describeIn(title: string, target: string | null | undefined, where: string) {
  const what = target ? t('{title} ({target})', { title, target }) : title;
  return where ? t('{what} in {where}', { what, where }) : what;
}

/** Accessible description of one item: title in words, destination as written and where it is. */
function describe(item: Issue | Signal, where: string) {
  const title = 'form' in item && item.form ? issueInfo(item).title : titleOf(item.code);
  return describeIn(title, 'target' in item ? item.target : undefined, where);
}

/** "{count} marked as expected stays below": what an empty list says about the marked ones. */
function stayBelow(count: number) {
  return plural(
    count,
    '{count} marked as expected stays below.',
    '{count} marked as expected stay below.',
  );
}

function withNote(subject: string, unsure: boolean) {
  return unsure ? t('{subject}, {note}', { subject, note: inconclusiveNote() }) : subject;
}
